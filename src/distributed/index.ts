import type { Router } from 'express';
import { ClusterConfigError, type NodeConfig } from '../config.ts';
import type { KVStore } from '../store.ts';
import { Coordinator } from './coordinator.ts';
import { Participant } from './participant.ts';
import { ReplicatedStore } from './replicated-store.ts';
import { internalRouter } from './routes.ts';

export { NotCoordinatorError, TxAbortedError } from './errors.ts';

export type Replication = {
  role: 'coordinator' | 'participant';
  store: ReplicatedStore;
  router: Router;
};

export function createReplication(node: NodeConfig, local: KVStore): Replication {
  const participant = new Participant(local);
  // parseClusterConfig guarantees exactly one coordinator; a hand-built NodeConfig may not.
  const coordinatorNode = node.nodes.find((n) => n.coordinator);
  if (!coordinatorNode) throw new ClusterConfigError('cluster config names no coordinator');

  const isCoordinator = coordinatorNode.id === node.self.id;
  const coordinator = isCoordinator ? new Coordinator(node.self, node.peers, participant) : null;

  return {
    role: isCoordinator ? 'coordinator' : 'participant',
    store: new ReplicatedStore(local, coordinator, coordinatorNode.url),
    router: internalRouter(participant),
  };
}
