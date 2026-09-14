import { randomUUID } from 'node:crypto';
import type { NodeInfo } from '../config.ts';
import { TxAbortedError, type Blocker } from './errors.ts';
import type { Participant } from './participant.ts';
import { post } from './peer.ts';
import type { CommitResponse, DecisionRequest, Event, PrepareRequest, Tx, Vote } from './types.ts';

/**
 * 2PC coordinator. Runs one transaction at a time across every node in the
 * cluster (itself included, via its local participant). Strict: every node
 * must vote yes or the transaction aborts.
 */
export class Coordinator {
  readonly self: NodeInfo;
  readonly peers: NodeInfo[];
  readonly local: Participant;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(self: NodeInfo, peers: NodeInfo[], local: Participant) {
    this.self = self;
    this.peers = peers;
    this.local = local;
  }

  /** Replicates event to every node. Resolves with the event's result; rejects with TxAbortedError. */
  run(event: Event): Promise<boolean> {
    const result = this.#chain.then(() => this.#execute(event));
    this.#chain = result.catch(() => {});
    return result;
  }

  async #execute(event: Event): Promise<boolean> {
    const tx: Tx = { id: randomUUID(), index: this.local.commitIndex + 1, event };

    // Phase 1: prepare everywhere
    const localVote = this.local.prepare(tx);
    const peerVotes = await Promise.all(
      this.peers.map(async (peer): Promise<[number, Vote]> => {
        const res = await post<Vote>(peer.url, '/internal/2pc/prepare', { tx } satisfies PrepareRequest);
        // No answer (down, paused, partitioned, timed out, HTTP error) counts as a "no" vote.
        return [peer.id, res.ok ? res.body : { vote: 'no', reason: res.error }];
      }),
    );

    const blockedBy: Blocker[] = [];
    for (const [id, vote] of [[this.self.id, localVote] as [number, Vote], ...peerVotes]) {
      if (vote.vote === 'no') blockedBy.push({ id, reason: vote.reason });
    }

    // Phase 2: abort if anyone said no
    if (blockedBy.length > 0) {
      this.local.abort(tx.id);
      await this.#broadcast('abort', tx.id);
      throw new TxAbortedError(tx.id, blockedBy);
    }

    // Phase 2: commit. Every node voted yes, so the decision is final from here on.
    const committed = await this.local.commit(tx.id);
    // Cannot happen while writes are serialized: we staged this tx ourselves above.
    if (!committed.ok) throw new Error(`local commit failed: ${committed.reason}`);
    await this.#broadcast('commit', tx.id);
    return committed.result;
  }

  /**
   * Best effort. A COMMIT that is not ok (unreachable, timeout, or "unknown tx"
   * because the participant restarted) cannot be rolled back: the tx is committed
   * elsewhere. That participant stays staged or out of sync and votes no until reset.
   */
  async #broadcast(decision: 'commit' | 'abort', txId: string): Promise<void> {
    await Promise.all(
      this.peers.map(async (peer) => {
        const res = await post<CommitResponse>(peer.url, `/internal/2pc/${decision}`, { txId } satisfies DecisionRequest);
        const failure = !res.ok ? res.error : !res.body.ok ? res.body.reason : null;
        if (failure) console.warn(`2pc ${decision} ${txId.slice(0, 8)} not applied on node ${peer.id}: ${failure}`);
      }),
    );
  }
}
