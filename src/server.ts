import { createApp } from './app.ts';
import {
  ClusterConfigError,
  DEFAULT_CLUSTER_PATH,
  loadClusterConfig,
  nodeConfig,
  parseNodeId,
  type NodeConfig,
} from './config.ts';
import { createReplication } from './distributed/index.ts';
import { createElection } from './election/index.ts';
import { MemoryStore } from './store.ts';

/**
 * Cluster mode: VALIO_NODE_ID selects this node from the cluster config
 * (VALIO_CLUSTER, default ./cluster.json) and the port comes from its URL.
 * Standalone mode: no VALIO_NODE_ID, port from PORT (default 3001).
 */
function resolveNode(): NodeConfig | undefined {
  const rawId = process.env.VALIO_NODE_ID;
  if (rawId === undefined || rawId === '') return undefined;
  try {
    const cluster = loadClusterConfig(process.env.VALIO_CLUSTER ?? DEFAULT_CLUSTER_PATH);
    return nodeConfig(cluster, parseNodeId(rawId));
  } catch (err) {
    if (err instanceof ClusterConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

const node = resolveNode();
const host = process.env.HOST ?? '0.0.0.0';
const port = node ? node.port : Number(process.env.PORT ?? 3001);
const name = node ? `node ${node.self.id}` : 'valio';

const local = new MemoryStore();
// TODO: replace inferring standalone mode from VALIO_NODE_ID with an explicit standalone flag.
const replication = node ? createReplication(node, local) : undefined;
// Every cluster member answers election RPCs: it is accepter, proposer, and learner.
// Nothing proposes yet; the coordinator still comes from the cluster config.
const election = node ? createElection(node) : undefined;
const internalRouters = [replication?.router, election?.router].filter((router) => router !== undefined);
const app = createApp(replication?.store ?? local, { node, internalRouters });

const server = app.listen(port, host, (err?: Error) => {
  if (err) {
    console.error(`${name} failed to start: ${err.message}`);
    process.exit(1);
  }
  const cluster =
    node && replication
      ? ` (${node.nodes.length}-node cluster, ${replication.role}, peers: ${node.peers.map((p) => p.id).join(', ') || 'none'})`
      : '';
  console.log(`${name} listening on http://${host}:${port}${cluster}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
  server.closeAllConnections();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, shutdown);
}
// When started by scripts/cluster.ts there is an IPC channel to the launcher;
// it disconnects if the launcher dies, so nodes never outlive it.
process.on('disconnect', shutdown);
