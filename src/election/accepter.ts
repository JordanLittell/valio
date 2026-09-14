import type {
  Accepted,
  AcceptedMessage,
  AcceptMessage,
  NAKMessage,
  PrepareMessage,
  PromiseMessage,
  RejectMessage,
} from './types.ts';

/** Where a node's accepter publishes the proposals it accepts. */
export type LearnerBroadcast = (message: AcceptedMessage) => void;

export class Accepter {
  readonly nodeId: number;
  #epoch = 0;
  #promisedId: number | undefined;
  #accepted: Accepted | null = null;
  readonly #broadcastToLearners: LearnerBroadcast;

  constructor(nodeId: number, broadcastToLearners: LearnerBroadcast) {
    this.nodeId = nodeId;
    this.#broadcastToLearners = broadcastToLearners;
  }

  /**
   * If this epoch is stale, NAK. A higher epoch is a new Paxos instance: drop the
   * previous accepted value so a new leader id can be chosen.
   */
  async promise(message: PrepareMessage): Promise<PromiseMessage | NAKMessage> {
    if (!this.#join(message.epoch ?? 0)) {
      return { type: 'NAK', id: this.#promisedId ?? 0, reason: 'stale epoch' };
    }
    if (this.#promisedId !== undefined && message.id < this.#promisedId) {
      return {
        type: 'NAK',
        id: this.#promisedId,
        reason: 'Larger message already seen',
      };
    }

    this.#promisedId = message.id;
    return { type: 'PROMISE', id: message.id, accepted: this.#accepted };
  }

  async accept(message: AcceptMessage): Promise<AcceptedMessage | RejectMessage> {
    if (!this.#join(message.epoch ?? 0)) {
      return { type: 'REJECT', id: this.#promisedId ?? 0, reason: 'stale epoch' };
    }
    if (this.#promisedId !== undefined && message.id < this.#promisedId) {
      return {
        type: 'REJECT',
        id: this.#promisedId,
        reason: 'We already promised a larger message',
      };
    }

    if (this.#promisedId === undefined || message.id > this.#promisedId) {
      this.#promisedId = message.id;
    }
    this.#accepted = { id: message.id, value: message.value };

    const result: AcceptedMessage = {
      type: 'ACCEPTED',
      id: message.id,
      epoch: message.epoch ?? 0,
      nodeId: this.nodeId,
      value: message.value,
    };
    this.#broadcastToLearners(result);
    return result;
  }

  #join(epoch: number): boolean {
    if (epoch < this.#epoch) return false;
    if (epoch > this.#epoch) {
      this.#epoch = epoch;
      this.#promisedId = undefined;
      this.#accepted = null;
    }
    return true;
  }
}
