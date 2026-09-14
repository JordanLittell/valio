import type { JsonValue } from '../types.ts';

/** A proposal an accepter has already accepted, reported back in its promise. */
export type Accepted = { id: number; value: JsonValue };

export type PrepareMessage = {
  type: 'PREPARE';
  id: number; // the ballot this proposer is asking accepters to promise
  /** Paxos instance. Missing means 0, the first election. */
  epoch?: number;
};

export type PromiseMessage = {
  type: 'PROMISE';
  id: number; // the ballot the accepter has promised, i.e. the one it was asked about
  /**
   * The highest proposal this accepter had already accepted, or null if it has
   * accepted none. A proposer that sees any accepted proposal in its quorum must
   * re-propose the one with the largest id instead of its own value; that is what
   * keeps two proposers from choosing different values.
   */
  accepted: Accepted | null;
};

export type NAKMessage = {
  type: 'NAK';
  id: number; // the larger ballot the accepter has already promised
  reason: string;
};

export type AcceptMessage = {
  type: 'ACCEPT';
  id: number; // the ballot the proposer holds promises for
  epoch?: number;
  value: JsonValue; // the value the proposer wants accepted
};

export type AcceptedMessage = {
  type: 'ACCEPTED';
  id: number; // the ballot that was accepted
  epoch?: number;
  nodeId: number; // the id of the node that accepted the message
  value: JsonValue; // the value that the node accepted
};

export type RejectMessage = {
  type: 'REJECT';
  id: number; // the larger ballot the accepter has already promised
  reason: string;
};
