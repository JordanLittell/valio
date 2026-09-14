import type { Router } from 'express';
import { findNode, type NodeConfig } from '../config.ts';
import type { KVStore } from '../store.ts';
import { Coordinator } from './coordinator.ts';
import { Participant } from './participant.ts';
import { ReplicatedStore } from './replicated-store.ts';
import { internalRouter } from './routes.ts';

export { NotCoordinatorError, TxAbortedError } from './errors.ts';

/** Naive fixed coordinator until leader election exists. */
export const COORDINATOR_ID = 0;

export type Replication = {
  role: 'coordinator' | 'participant';
  store: ReplicatedStore;
  router: Router;
};

export function createReplication(node: NodeConfig, local: KVStore): Replication {
  const participant = new Participant(local);
  const isCoordinator = node.self.id === COORDINATOR_ID;
  const coordinator = isCoordinator ? new Coordinator(node.self, node.peers, participant) : null;
  const coordinatorUrl = findNode({ nodes: node.nodes }, COORDINATOR_ID).url;
  return {
    role: isCoordinator ? 'coordinator' : 'participant',
    store: new ReplicatedStore(local, coordinator, coordinatorUrl),
    router: internalRouter(participant),
  };
}
