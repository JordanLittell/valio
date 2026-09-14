#!/usr/bin/env node
/**
 * Local cluster launcher: spins up n node processes and joins them to a cluster.
 * cluster config, prefixes each node's log lines, and stops every node on
 * Ctrl-C. A node that exits on its own is reported but does not stop the rest.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ClusterConfigError, DEFAULT_CLUSTER_PATH, loadClusterConfig, type NodeInfo } from '../src/config.ts';

const USAGE = `Usage: npm run cluster -- [--config PATH]

Starts one valio server process per node in the cluster config and
multiplexes their logs. Ctrl-C stops every node (press twice to force).

Options:
  -c, --config PATH  Cluster config file (default: $VALIO_CLUSTER or ./cluster.json)
  -h, --help         Show this help`;

const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));
const FORCE_KILL_MS = 3000;
const COLORS = [36, 33, 35, 32, 34, 31];
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function tag(label: string, color: number): string {
  const text = `[${label}]`;
  return useColor ? `\x1b[${color}m${text}\x1b[0m` : text;
}

const launcherTag = tag('cluster', 90);

function log(message: string): void {
  console.log(`${launcherTag} ${message}`);
}

function parseCli() {
  try {
    return parseArgs({
      options: {
        config: { type: 'string', short: 'c' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values;
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    return process.exit(1);
  }
}

function loadNodes(path: string): NodeInfo[] {
  try {
    return loadClusterConfig(path).nodes;
  } catch (err) {
    if (err instanceof ClusterConfigError) {
      console.error(err.message);
      process.exit(1);
    } else {
      throw err;
    }
  }
}

const children = new Map<number, ChildProcess>();
let stopping = false;

function pipeLines(stream: Readable, prefix: string, out: NodeJS.WriteStream): void {
  createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => {
    out.write(`${prefix} ${line}\n`);
  });
}

function startNode(node: NodeInfo, configPath: string): void {
  const prefix = tag(`n${node.id}`, COLORS[node.id % COLORS.length]!);
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, VALIO_NODE_ID: String(node.id), VALIO_CLUSTER: configPath },
    // The IPC channel lets a node notice if this launcher dies (see server.ts).
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.set(node.id, child);
  pipeLines(child.stdout!, prefix, process.stdout);
  pipeLines(child.stderr!, prefix, process.stderr);
  log(`started node ${node.id} (pid ${child.pid}) at ${node.url}`);

  child.on('error', (err) => log(`node ${node.id} failed to spawn: ${err.message}`));
  // 'close' (not 'exit') so the node's final log lines are flushed first.
  child.on('close', (code, signal) => {
    children.delete(node.id);
    if (!stopping) {
      log(`node ${node.id} exited (${signal ?? `code ${code}`}); ${children.size} node(s) still running`);
    }
    if (children.size === 0) {
      if (!stopping) log('all nodes have exited');
      process.exit(stopping ? 0 : 1);
    }
  });
}

function stop(signal: NodeJS.Signals): void {
  if (stopping) {
    log('forcing shutdown');
    for (const child of children.values()) child.kill('SIGKILL');
    return;
  }
  stopping = true;
  if (children.size === 0) process.exit(0);
  log(`received ${signal}, stopping ${children.size} node(s)`);
  for (const child of children.values()) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of children.values()) child.kill('SIGKILL');
  }, FORCE_KILL_MS).unref();
}

const opts = parseCli();
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

const configPath = resolve(opts.config ?? process.env.VALIO_CLUSTER ?? DEFAULT_CLUSTER_PATH);
const nodes = loadNodes(configPath);

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

log(`starting ${nodes.length} node(s) from ${configPath}`);
for (const node of nodes) startNode(node, configPath);
