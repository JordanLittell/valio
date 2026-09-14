import type { Router } from 'express';
import type { NodeConfig } from '../config.ts';
import type { Leadership } from '../leadership/state.ts';
import type { KVStore } from '../store.ts';
import { Coordinator } from './coordinator.ts';
import { Participant } from './participant.ts';
import { ReplicatedStore } from './replicated-store.ts';
import { internalRouter } from './routes.ts';

export { NotCoordinatorError, TxAbortedError } from './errors.ts';

export type Replication = {
  store: ReplicatedStore;
  router: Router;
};

/**
 * Every node can coordinate; whether it does is a runtime check against
 * leadership, not a role baked in at construction.
 */
export function createReplication(node: NodeConfig, local: KVStore, leadership: Leadership): Replication {
  const participant = new Participant(local);
  const coordinator = new Coordinator(node.self, node.peers, participant);

  return {
    store: new ReplicatedStore(local, coordinator, leadership),
    router: internalRouter(participant),
  };
}
