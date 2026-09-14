/** A write reached a node that is not the coordinator. */
export class NotCoordinatorError extends Error {
  readonly coordinatorUrl: string;

  constructor(coordinatorUrl: string) {
    super(`not the coordinator; send writes to ${coordinatorUrl}`);
    this.name = 'NotCoordinatorError';
    this.coordinatorUrl = coordinatorUrl;
  }
}

export type Blocker = { id: number; reason: string };

/** At least one participant voted no (or never answered), so the transaction was aborted. */
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
