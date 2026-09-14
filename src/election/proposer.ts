import type { NodeInfo } from '../config.ts';
import { post, type PeerResult } from '../distributed/peer.ts';
import type { JsonValue } from '../types.ts';
import type { Accepter } from './accepter.ts';
import { ACCEPT_PATH, PREPARE_PATH } from './routes.ts';
import type {
  Accepted,
  AcceptedMessage,
  AcceptMessage,
  NAKMessage,
  PrepareMessage,
  PromiseMessage,
  RejectMessage,
} from './types.ts';

/** Attempts per propose() call, each with a fresh, larger ballot. */
const MAX_ATTEMPTS = 3;
/** Backoff between attempts, jittered so duelling proposers don't stay in lockstep. */
const RETRY_BASE_MS = 25;

export type ProposalResult =
  /** A quorum accepted ballot id. value is what was chosen, which may not be the value passed in. */
  | { chosen: true; id: number; value: JsonValue }
  | { chosen: false; reason: string };

/** A phase that did not get a quorum, with the tally that explains why. */
type PhaseFailure = { ok: false; reason: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Paxos proposer. Drives both phases of one proposal against every node in the
 * cluster (itself included, via its local accepter) and needs only a majority to
 * answer, so a proposal survives a minority of nodes being down or partitioned.
 */
export class Proposer {
  readonly self: NodeInfo;
  readonly peers: NodeInfo[];
  readonly local: Accepter;
  readonly #quorum: number;
  /** Ballots this node issues are round * clusterSize + self.id, so no two nodes share one. */
  readonly #clusterSize: number;
  #round = -1;
  /** Largest ballot any accepter has told us about, via NAK or REJECT. */
  #highestSeen = -1;

  constructor(self: NodeInfo, peers: NodeInfo[], local: Accepter) {
    this.self = self;
    this.peers = peers;
    this.local = local;
    this.#clusterSize = peers.length + 1;
    this.#quorum = Math.floor(this.#clusterSize / 2) + 1;
  }

  /**
   * Runs Paxos until a quorum accepts a value or the attempts run out. Resolves
   * chosen: false rather than throwing: losing a ballot race is normal and the
   * caller decides whether to try again.
   */
  async propose(value: JsonValue): Promise<ProposalResult> {
    let reason = 'no attempts made';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(Math.random() * RETRY_BASE_MS * 2 ** attempt);

      const id = this.#nextBallot();
      const promised = await this.#prepare(id);
      if (!promised.ok) {
        reason = promised.reason;
        continue;
      }

      // Safety: if anyone in the quorum has already accepted a proposal, that value
      // may already be chosen, so we must carry it forward instead of our own.
      const chosenValue = promised.accepted ? promised.accepted.value : value;
      const accepted = await this.#accept({ type: 'ACCEPT', id, value: chosenValue });
      if (!accepted.ok) {
        reason = accepted.reason;
        continue;
      }
      return { chosen: true, id, value: chosenValue };
    }
    return { chosen: false, reason };
  }

  /** Phase 1. Resolves with the highest proposal already accepted in the quorum, if any. */
  async #prepare(id: number): Promise<{ ok: true; accepted: Accepted | null } | PhaseFailure> {
    const message: PrepareMessage = { type: 'PREPARE', id };
    const replies = await this.#broadcast<PromiseMessage | NAKMessage>(PREPARE_PATH, message, () =>
      this.local.promise(message),
    );

    let promises = 0;
    let highest: Accepted | null = null;
    for (const reply of replies) {
      // Silence (down, paused, partitioned, timed out, HTTP error) is not a promise.
      if (!reply.ok) continue;
      if (reply.body.type === 'NAK') {
        this.#observe(reply.body.id);
        continue;
      }
      promises++;
      const { accepted } = reply.body;
      if (accepted && accepted.id > (highest?.id ?? -1)) highest = accepted;
    }

    if (promises < this.#quorum) {
      return { ok: false, reason: `ballot ${id} got ${promises} of ${this.#quorum} promises` };
    }
    return { ok: true, accepted: highest };
  }

  /** Phase 2. A quorum of ACCEPTED means the value is chosen and can never change. */
  async #accept(message: AcceptMessage): Promise<{ ok: true } | PhaseFailure> {
    const replies = await this.#broadcast<AcceptedMessage | RejectMessage>(ACCEPT_PATH, message, () =>
      this.local.accept(message),
    );

    let accepted = 0;
    for (const reply of replies) {
      if (!reply.ok) continue;
      if (reply.body.type === 'REJECT') {
        this.#observe(reply.body.id);
        continue;
      }
      accepted++;
    }

    if (accepted < this.#quorum) {
      return { ok: false, reason: `ballot ${message.id} got ${accepted} of ${this.#quorum} accepts` };
    }
    return { ok: true };
  }

  /**
   * Sends message to every node at once: over HTTP to the peers, in process to our
   * own accepter. Every node fills all three roles, so there is no separate set of
   * accepters to track; the peer list is the accepter list.
   */
  #broadcast<T>(path: string, message: unknown, local: () => Promise<T>): Promise<PeerResult<T>[]> {
    return Promise.all([
      local().then((body): PeerResult<T> => ({ ok: true, body })),
      ...this.peers.map((peer) => post<T>(peer.url, path, message)),
    ]);
  }

  /** Smallest ballot this node can issue that beats both its last one and anything an accepter reported. */
  #nextBallot(): number {
    const beat = Math.max(this.#round, Math.floor((this.#highestSeen - this.self.id) / this.#clusterSize));
    this.#round = beat + 1;
    return this.#round * this.#clusterSize + this.self.id;
  }

  #observe(id: number): void {
    if (id > this.#highestSeen) this.#highestSeen = id;
  }
}
