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
  // the id of the current message we have promised to accept
  // if messages come in larger than this, we should respond with a NAK message
  #promisedId: number | undefined;
  /** The proposal we last accepted. Reported in promises so a later proposer can carry it forward. */
  #accepted: Accepted | null;
  readonly #broadcastToLearners: LearnerBroadcast;

  constructor(nodeId: number, broadcastToLearners: LearnerBroadcast) {
    this.nodeId = nodeId;
    this.#promisedId = undefined;
    this.#accepted = null;
    this.#broadcastToLearners = broadcastToLearners;
  }

  /**
   *
   * @param message - The prepare message to respond to
   * If the acceptor had already seen a larger message, it should respond with a NAK message.
   * Otherwise, it should respond with a promise message.
   * This places a lock on the accepter for the duration of the election.
   * That is, no other proposer can make progress until this election is resolved.
   * @returns The promise message
   */
  async promise(message: PrepareMessage): Promise<PromiseMessage | NAKMessage> {
    if (this.#promisedId !== undefined && message.id < this.#promisedId) {
      return {
        type: 'NAK',
        // Our promised ballot, not theirs: it tells the proposer how high it has to go to win.
        id: this.#promisedId,
        reason: 'Larger message already seen',
      };
    }

    this.#promisedId = message.id;

    return {
      type: 'PROMISE',
      id: message.id,
      accepted: this.#accepted,
    };
  }

  async accept(message: AcceptMessage): Promise<AcceptedMessage | RejectMessage> {
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
      nodeId: this.nodeId,
      value: message.value,
    };

    this.#broadcastToLearners(result);

    return result;
  }
}
