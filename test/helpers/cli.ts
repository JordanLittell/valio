import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAvailableNode, type ClusterDescription, type StatusResponse } from '../../src/types.ts';

export const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
export const CLUSTER_CONFIG = fileURLToPath(new URL('../../cluster.json', import.meta.url));

export interface CliFailure {
  code: number;
  reason: string;
}

function buildCliArgs(operation: string, payload: Record<string, unknown>): string[] {
  const args: string[] = [];

  switch (operation) {
    case 'get':
    case 'del':
      args.push(operation, String(payload.key));
      break;
    case 'set': {
      const value = payload.value;
      if (typeof value === 'string') {
        args.push(operation, String(payload.key), value);
      } else {
        args.push(operation, String(payload.key), JSON.stringify(value), '--json');
      }
      break;
    }
    case 'cluster':
      if (payload.subcommand === undefined) {
        throw new Error('cluster requires a subcommand');
      }
      args.push(operation, String(payload.subcommand));
      if (payload.target !== undefined) {
        args.push(String(payload.target));
      }
      break;
    case 'list':
    case 'clear':
    case 'status':
      args.push(operation);
      break;
    default:
      args.push(operation);
      break;
  }

  if (payload.url !== undefined) {
    args.push('--url', String(payload.url));
  }

  if (payload.cluster !== undefined) {
    args.push('--cluster', String(payload.cluster));
  }

  return args;
}

export function call(operation: string, payload: Record<string, unknown> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...buildCliArgs(operation, payload)], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      reject({ code: 1, reason: err.message } satisfies CliFailure);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject({
          code: code ?? 1,
          reason: stderr.trim() || stdout.trim() || `exit ${code}`,
        } satisfies CliFailure);
      }
    });
  });
}

/** Runs `valio cluster describe` and parses the node id -> status map it prints. */
export async function describeCluster(): Promise<ClusterDescription> {
  const stdout = await call('cluster', { subcommand: 'describe', cluster: CLUSTER_CONFIG });
  try {
    return JSON.parse(stdout) as ClusterDescription;
  } catch (err) {
    throw new Error(`could not parse cluster describe output: ${(err as Error).message}\n${stdout}`);
  }
}

/** Every available node should hold the same number of keys once replication has caught up. */
export async function assertKeysAreEqualAcrossNodes(): Promise<void> {
  const description = await describeCluster();
  const counts = Object.entries(description)
    .filter((entry): entry is [string, StatusResponse] => isAvailableNode(entry[1]))
    .map(([id, status]) => ({ id, keys: status.keys }));

  if (counts.length === 0) {
    throw new Error('cluster describe returned no nodes');
  }

  const expected = counts[0]!.keys;
  if (counts.some(({ keys }) => keys !== expected)) {
    const detail = counts.map(({ id, keys }) => `node ${id}: ${keys}`).join(', ');
    throw new Error(`key counts differ across nodes (${detail})`);
  }

  console.log(`All ${counts.length} nodes report ${expected} keys`);
}

/** Polls a killed node until it stops answering, so later assertions see the cluster without it. */
export async function waitForShutdown(url: string | null, timeoutMs = 5000): Promise<void> {
  if (url === null) {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`node at ${url} is still answering ${timeoutMs}ms after being killed`);
}

/** Polls /status until the joining node reports state=available. */
export async function waitUntilAvailable(url: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = (await (
        await fetch(`${url}/status`, { signal: AbortSignal.timeout(500) })
      ).json()) as StatusResponse;
      if (status.state === 'available') return;
    } catch {
      // process is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`node at ${url} did not become available within ${timeoutMs}ms`);
}
