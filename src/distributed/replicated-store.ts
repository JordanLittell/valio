import type { KVStore } from '../store.ts';
import type { JsonValue } from '../types.ts';
import type { Leadership } from '../leadership/state.ts';
import type { Coordinator } from './coordinator.ts';
import { NotCoordinatorError } from './errors.ts';
import type { Event } from './types.ts';

/**
 * KVStore whose writes go through 2PC. Reads are served from the local
 * store. On non-leader nodes, writes throw NotCoordinatorError.
 */
export class ReplicatedStore implements KVStore {
  readonly #local: KVStore;
  readonly #coordinator: Coordinator;
  readonly #leadership: Leadership;

  constructor(local: KVStore, coordinator: Coordinator, leadership: Leadership) {
    this.#local = local;
    this.#coordinator = coordinator;
    this.#leadership = leadership;
  }

  get(key: string): Promise<JsonValue | undefined> {
    return this.#local.get(key);
  }

  list(): Promise<Record<string, JsonValue>> {
    return this.#local.list();
  }

  async set(key: string, value: JsonValue): Promise<void> {
    await this.#write({ type: 'SET', key, value });
  }

  del(key: string): Promise<boolean> {
    return this.#write({ type: 'DEL', key });
  }

  async clear(): Promise<void> {
    await this.#write({ type: 'CLEAR' });
  }

  async #write(event: Event): Promise<boolean> {
    if (this.#leadership.isLeader()) return this.#coordinator.run(event);
    throw new NotCoordinatorError(this.#leadership.leaderUrl());
  }
}
