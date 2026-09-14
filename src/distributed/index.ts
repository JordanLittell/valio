import type { Router } from 'express';
import type { NodeConfig } from '../config.ts';
import type { Leadership } from '../leadership/state.ts';
import type { KVStore } from '../store.ts';
import { Coordinator } from './coordinator.ts';
import { Participant } from './participant.ts';
import { ReplicatedStore } from './replicated-store.ts';
import { internalRouter } from './routes.ts';
import type { Wal } from './wal.ts';

export { catchUp } from './catch-up.ts';
export { NotCoordinatorError, TxAbortedError } from './errors.ts';
export { FileWal, MemoryWal, walPath, type Wal } from './wal.ts';

export type Replication = {
  store: ReplicatedStore;
  router: Router;
  participant: Participant;
};

/**
 * Every node can coordinate; whether it does is a runtime check against
 * leadership, not a role baked in at construction.
 */
export async function createReplication(
  node: NodeConfig,
  local: KVStore,
  leadership: Leadership,
  wal?: Wal,
): Promise<Replication> {
  const participant = new Participant(local, wal);
  await participant.restore();
  const coordinator = new Coordinator(node.self, node.peers, participant);

  return {
    store: new ReplicatedStore(local, coordinator, leadership),
    router: internalRouter(participant, wal),
    participant,
  };
}
