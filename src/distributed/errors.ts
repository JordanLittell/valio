/** A write reached a node that is not the current leader. */
export class NotCoordinatorError extends Error {
  readonly coordinatorUrl: string | null;

  constructor(coordinatorUrl: string | null) {
    super(coordinatorUrl ? `not the coordinator; send writes to ${coordinatorUrl}` : 'not the coordinator; no leader elected yet');
    this.name = 'NotCoordinatorError';
    this.coordinatorUrl = coordinatorUrl;
  }
}

export type Blocker = { id: number; reason: string };

/** A majority of participants did not vote yes, so the transaction was aborted. */
export class TxAbortedError extends Error {
  readonly txId: string;
  readonly blockedBy: Blocker[];

  constructor(txId: string, blockedBy: Blocker[]) {
    super(`transaction aborted: ${blockedBy.map((b) => `node ${b.id} (${b.reason})`).join(', ')}`);
    this.name = 'TxAbortedError';
    this.txId = txId;
    this.blockedBy = blockedBy;
  }
}
