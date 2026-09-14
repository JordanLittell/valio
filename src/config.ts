import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_CLUSTER_PATH = 'cluster.json';

export type NodeInfo = { id: number; url: string };

export type ClusterConfig = { nodes: NodeInfo[] };

/** One node's view of the cluster. */
export type NodeConfig = {
  self: NodeInfo;
  nodes: NodeInfo[];
  peers: NodeInfo[];
  port: number;
};

export class ClusterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterConfigError';
  }
}

export function loadClusterConfig(path: string = DEFAULT_CLUSTER_PATH): ClusterConfig {
  const file = resolve(path);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new ClusterConfigError(`cannot read cluster config ${file}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ClusterConfigError(`invalid JSON in cluster config ${file}: ${(err as Error).message}`);
  }
  return parseClusterConfig(raw, file);
}

/**
 * Validates a cluster config. Node ids must be exactly 0..N-1 (used for ballot
 * numbering) and every node must have a unique http:// origin URL. Who leads is
 * decided at runtime, not in this file.
 */
export function parseClusterConfig(raw: unknown, source = 'cluster config'): ClusterConfig {
  const invalid = (message: string) => new ClusterConfigError(`${source}: ${message}`);

  if (typeof raw !== 'object' || raw === null || !('nodes' in raw) || !Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw invalid('expected {"nodes": [{"id": 0, "url": "http://host:port"}, ...]} with at least one node');
  }

  const nodes: NodeInfo[] = [];
  const seenUrls = new Set<string>();
  for (const [i, entry] of (raw.nodes as unknown[]).entries()) {
    if (typeof entry !== 'object' || entry === null) throw invalid(`nodes[${i}] must be an object`);
    const { id, url } = entry as Record<string, unknown>;

    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) {
      throw invalid(`nodes[${i}].id must be a non-negative integer`);
    }
    if (typeof url !== 'string') throw invalid(`nodes[${i}].url must be a string`);

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw invalid(`nodes[${i}].url is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:') throw invalid(`nodes[${i}].url must use http://`);
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw invalid(`nodes[${i}].url must not include a path, query, or fragment`);
    }
    if (seenUrls.has(parsed.origin)) throw invalid(`duplicate url ${parsed.origin}`);
    seenUrls.add(parsed.origin);

    nodes.push({ id, url: parsed.origin });
  }

  nodes.sort((a, b) => a.id - b.id);
  if (nodes.some((node, i) => node.id !== i)) {
    throw invalid(`node ids must be unique and numbered 0..${nodes.length - 1} (got ${nodes.map((n) => n.id).join(', ')})`);
  }

  return { nodes };
}

export function parseNodeId(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new ClusterConfigError(`invalid node id: ${raw}`);
  return Number(raw);
}

export function findNode(config: ClusterConfig, id: number): NodeInfo {
  const node = config.nodes.find((n) => n.id === id);
  if (!node) {
    throw new ClusterConfigError(`node ${id} is not in the cluster config (ids: ${config.nodes.map((n) => n.id).join(', ')})`);
  }
  return node;
}

export function nodeConfig(config: ClusterConfig, id: number): NodeConfig {
  const self = findNode(config, id);
  const { port } = new URL(self.url);
  return {
    self,
    nodes: config.nodes,
    peers: config.nodes.filter((n) => n.id !== id),
    port: port ? Number(port) : 80,
  };
}
