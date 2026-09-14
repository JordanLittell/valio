import type { NodeInfo } from '../config.ts';
import type { Proposer } from '../election/proposer.ts';
import type { Leadership } from './state.ts';

/**
 * Runs one election: propose this node as leader. Paxos may carry forward a
 * value another proposer already had accepted, so the winner is not always us.
 * Startup is the only caller; there is no re-election.
 */
export class Elector {
  readonly #self: NodeInfo;
  readonly #proposer: Proposer;
  readonly #leadership: Leadership;

  constructor(self: NodeInfo, proposer: Proposer, leadership: Leadership) {
    this.#self = self;
    this.#proposer = proposer;
    this.#leadership = leadership;
  }

  async elect(): Promise<void> {
    if (this.#leadership.leaderId !== null) return;

    const result = await this.#proposer.propose(this.#self.id);
    if (result.chosen && typeof result.value === 'number') {
      this.#leadership.adopt(result.value);
    }
    // If we did not win a quorum, a peer that did will tell our learner, which
    // adopts the same value. We do not wait: an isolated node would hang forever.
  }
}
