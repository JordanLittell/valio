#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { ValioClient, ValioHttpError, ValioUnavailableError } from './client.ts';
import { ClusterConfigError, DEFAULT_CLUSTER_PATH, findNode, loadClusterConfig, parseNodeId } from './config.ts';
import type { ClusterDescription, JsonValue, StatusResponse, UnavailableNodeStatus } from './types.ts';

const USAGE = `Usage: valio [--url URL | --node ID] [--cluster PATH] [--json] <command>

Commands:
  get <key>              Print the value stored at <key>
  set <key> <value...>   Store <value> at <key> (with --json, value is parsed as JSON)
  del <key>              Delete <key>
  list                   Print all keys and values (with --json, as a JSON object)
  clear                  Clear the store
  status                 Show the target node's status
  cluster describe       Print every node's status as JSON; unreachable nodes are marked unavailable

By default commands target every node in the cluster config, failing over to the
next node when one is unreachable. --url and --node pin the command to one node.

Options:
  --url URL       Pin to one server URL (default: $VALIO_URL, else the cluster config)
  --node ID       Pin to a node by id from the cluster config instead of --url
  --cluster PATH  Cluster config file (default: $VALIO_CLUSTER or ./cluster.json)
  --json          Parse set values as JSON / print list and status as JSON
  -h, --help      Show this help`;

const EXIT_OK = 0;
const EXIT_USER = 1;
const EXIT_UNAVAILABLE = 2;

const CLUSTER_OPERATIONS = ['describe'] as const;

class UsageError extends Error {}

function format(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

async function run(argv: string[]): Promise<number> {
  const { values: opts, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      node: { type: 'string' },
      cluster: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [command, ...args] = positionals;
  if (opts.help || command === undefined) {
    console.log(USAGE);
    return opts.help ? EXIT_OK : EXIT_USER;
  }

  const clusterPath = opts.cluster ?? process.env.VALIO_CLUSTER ?? DEFAULT_CLUSTER_PATH;

  if (command === 'cluster') {
    const [operation] = args;
    const supported = CLUSTER_OPERATIONS.join(', ');
    if (operation === undefined) {
      throw new UsageError(`missing cluster operation (supported: ${supported})\n\n${USAGE}`);
    }
    if (operation !== 'describe') {
      throw new UsageError(`unknown cluster operation: ${operation} (supported: ${supported})\n\n${USAGE}`);
    }
    requireArgs(args, 1, 'cluster describe');
    return describeCluster(clusterPath);
  }

  const client = new ValioClient(targetUrls(opts, clusterPath));

  switch (command) {
    case 'get': {
      const key = requireArgs(args, 1, 'get <key>')[0]!;
      const value = await client.get(key);
      if (value === undefined) {
        console.error(`not found: ${key}`);
        return EXIT_USER;
      }
      console.log(format(value));
      return EXIT_OK;
    }

    case 'set': {
      if (args.length < 2) throw new UsageError('usage: valio set <key> <value...>');
      const [key, ...rest] = args as [string, ...string[]];
      const raw = rest.join(' ');
      let value: JsonValue = raw;
      if (opts.json) {
        try {
          value = JSON.parse(raw) as JsonValue;
        } catch {
          throw new UsageError(`invalid JSON value: ${raw}`);
        }
      }
      await client.set(key, value);
      console.log('OK');
      return EXIT_OK;
    }

    case 'del': {
      const key = requireArgs(args, 1, 'del <key>')[0]!;
      if (!(await client.del(key))) {
        console.error(`not found: ${key}`);
        return EXIT_USER;
      }
      console.log('deleted');
      return EXIT_OK;
    }

    case 'list': {
      requireArgs(args, 0, 'list');
      const data = await client.list();
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        for (const key of Object.keys(data).sort()) {
          console.log(`${key}\t${format(data[key]!)}`);
        }
      }
      return EXIT_OK;
    }

    case 'clear': {
      requireArgs(args, 0, 'clear');
      await client.clear();
      console.log('OK');
      return EXIT_OK;
    }

    case 'status': {
      requireArgs(args, 0, 'status');
      const status = await client.status();
      if (opts.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log(
          [
            `id\t${status.id ?? 'standalone'}`,
            `url\t${status.url ?? client.base}`,
            `peers\t${status.peers.join(', ') || '-'}`,
            `pid\t${status.pid}`,
            `keys\t${status.keys}`,
            `uptime\t${formatUptime(status.uptimeMs)}`,
          ].join('\n'),
        );
      }
      return EXIT_OK;
    }

    default:
      throw new UsageError(`unknown command: ${command}\n\n${USAGE}`);
  }
}

function targetUrls(
  opts: { url?: string | undefined; node?: string | undefined; cluster?: string | undefined },
  clusterPath: string,
): string[] {
  if (opts.node !== undefined) {
    if (opts.url !== undefined) throw new UsageError('use either --url or --node, not both');
    return [findNode(loadClusterConfig(clusterPath), parseNodeId(opts.node)).url];
  }
  if (opts.url !== undefined) return [opts.url];
  if (process.env.VALIO_URL) return [process.env.VALIO_URL];

  try {
    return loadClusterConfig(clusterPath).nodes.map((n) => n.url);
  } catch (err) {
    // An explicitly-given config path must still error; only ./cluster.json falls back.
    const explicit = opts.cluster !== undefined || process.env.VALIO_CLUSTER !== undefined;
    if (explicit || !(err instanceof ClusterConfigError)) throw err;
    return ['http://localhost:3001'];
  }
}

type NodeReport = {
  id: number;
  url: string;
  state: 'up' | 'unreachable' | 'error';
  status?: StatusResponse;
  error?: string;
};

/** Asks every node in the cluster config for its status, in parallel. */
async function queryCluster(clusterPath: string): Promise<NodeReport[]> {
  const { nodes } = loadClusterConfig(clusterPath);
  return Promise.all(
    nodes.map(async ({ id, url }): Promise<NodeReport> => {
      try {
        const status = await new ValioClient(url, 1000).status();
        if (status.id !== id) {
          return { id, url, state: 'error', status, error: `reports node id ${status.id}` };
        }
        return { id, url, state: 'up', status };
      } catch (err) {
        const state = err instanceof ValioUnavailableError ? 'unreachable' : 'error';
        return { id, url, state, error: (err as Error).message };
      }
    }),
  );
}

/**
 * Prints `{"<node id>": <status block>}` for the whole cluster. Unreachable
 * nodes are included as `{ unavailable: true }` so the command still succeeds
 * and callers always get a full description.
 */
async function describeCluster(clusterPath: string): Promise<number> {
  const description: ClusterDescription = {};

  for (const report of await queryCluster(clusterPath)) {
    if (report.state === 'up' && report.status) {
      description[String(report.id)] = report.status;
    } else {
      const unavailable: UnavailableNodeStatus = {
        id: report.id,
        url: report.url,
        unavailable: true,
        error: report.error ?? report.state,
      };
      description[String(report.id)] = unavailable;
    }
  }

  console.log(JSON.stringify(description, null, 2));
  return EXIT_OK;
}

function formatUptime(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function requireArgs(args: string[], count: number, usage: string): string[] {
  if (args.length !== count) throw new UsageError(`usage: valio ${usage}`);
  return args;
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (err) {
  if (err instanceof ValioUnavailableError) {
    console.error(err.message);
    process.exitCode = EXIT_UNAVAILABLE;
  } else if (err instanceof ValioHttpError) {
    console.error(err.message);
    process.exitCode = err.status >= 500 ? EXIT_UNAVAILABLE : EXIT_USER;
  } else if (
    err instanceof UsageError ||
    err instanceof ClusterConfigError ||
    (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
  ) {
    console.error((err as Error).message);
    process.exitCode = EXIT_USER;
  } else {
    throw err;
  }
}
