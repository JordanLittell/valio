import type { JsonValue } from '../types.ts';
import type { AcceptedMessage } from './types.ts';

/**
 * A learner is a node that learns the value of the accepted message.
 * It is responsible for acting on concensus being achieved
 * Concensus is achieved when a majority of the learners have accepted the same identifier number
 * Learners recieve messages from accepters and keep track of the values they have accepted through a log
 * The log is partitioned by the identifier number and consists of a list of accepted messages
 * along with the identifier of the node that accepted it
 */
export class Learner {
  #log: Map<number, { nodeId: number; value: JsonValue }[]>;
  #quorum: number;
  #epoch = 0;
  readonly #onConsensus: ((value: JsonValue, epoch: number) => void) | undefined;
  #announced = false;

  constructor(quorum: number, onConsensus?: (value: JsonValue, epoch: number) => void) {
    this.#log = new Map();
    this.#quorum = quorum;
    this.#onConsensus = onConsensus;
  }

  async learn(message: AcceptedMessage): Promise<JsonValue | undefined> {
    const epoch = message.epoch ?? 0;
    if (epoch < this.#epoch) return this.consensus();
    if (epoch > this.#epoch) {
      this.#epoch = epoch;
      this.#log = new Map();
      this.#announced = false;
    }

    const entries = this.#log.get(message.id) ?? [];
    if (entries.length === 0) this.#log.set(message.id, entries);
    // One vote per node: a redelivered ACCEPTED must not count twice toward the quorum.
    const existing = entries.find((entry) => entry.nodeId === message.nodeId);
    if (existing) {
      existing.value = message.value;
    } else {
      entries.push({ nodeId: message.nodeId, value: message.value });
    }

    const value = this.consensus();
    // Announce once: the same value keeps arriving as the remaining accepters report in.
    if (value !== undefined && !this.#announced) {
      this.#announced = true;
      this.#onConsensus?.(value, this.#epoch);
    }
    return value;
  }

  /**
   *
   * Concensus is achieved when a majority of the learners have accepted the same identifier number
   * @returns the value a quorum accepted, or undefined if no ballot has reached the quorum yet
   */
  consensus(): JsonValue | undefined {
    for (const [, log] of this.#log) {
      if (log.length >= this.#quorum) {
        return log[0]?.value;
      }
    }
    return undefined;
  }
}
