import type { JsonValue } from './types.ts';

/**
 * Local key-value storage. Async so that disk persistence and replication
 * can be layered in later without changing callers.
 */
export interface KVStore {
  /** Returns undefined when the key is missing (null is a valid stored value). */
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  /** Returns true if the key existed. */
  del(key: string): Promise<boolean>;
  list(): Promise<Record<string, JsonValue>>;
  /** Clears the store. */
  clear(): Promise<void>;
}

export class MemoryStore implements KVStore {
  #data = new Map<string, JsonValue>();

  async get(key: string): Promise<JsonValue | undefined> {
    const value = this.#data.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async set(key: string, value: JsonValue): Promise<void> {
    this.#data.set(key, structuredClone(value));
  }

  async del(key: string): Promise<boolean> {
    return this.#data.delete(key);
  }

  async list(): Promise<Record<string, JsonValue>> {
    return structuredClone(Object.fromEntries(this.#data));
  }

  async clear(): Promise<void> {
    this.#data.clear();
  }
}
