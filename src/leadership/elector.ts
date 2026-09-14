import type { NodeInfo } from '../config.ts';
import type { Proposer } from '../election/proposer.ts';
import type { Leadership } from './state.ts';

const HEALTH_MS = 250;
const HEALTH_TIMEOUT_MS = 200;
const HEALTH_MISSES = 2;

/**
 * Proposes this node as leader for the next epoch. Paxos may carry forward a
 * value another proposer already had accepted in that epoch, so the winner is
 * not always us. Follow-up elections (leader gone) are a new epoch so the
 * previous leader id is not carried forward.
 */
export class Elector {
  readonly #self: NodeInfo;
  readonly #proposer: Proposer;
  readonly #leadership: Leadership;
  #busy = false;
  #misses = 0;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(self: NodeInfo, proposer: Proposer, leadership: Leadership) {
    this.#self = self;
    this.#proposer = proposer;
    this.#leadership = leadership;
  }

  async elect(): Promise<void> {
    if (this.#leadership.leaderId !== null) return;
    await this.#propose();
  }

  /** Poll the leader's /health; if it stays down, start the next epoch. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#tick(), HEALTH_MS);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #tick(): Promise<void> {
    if (this.#busy || this.#leadership.isLeader()) return;
    const url = this.#leadership.leaderUrl();
    if (url) {
      try {
        if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })).ok) {
          this.#misses = 0;
          return;
        }
      } catch {
        // unreachable
      }
      if (++this.#misses < HEALTH_MISSES) return;
      this.#misses = 0;
    }
    await this.#propose();
  }

  async #propose(): Promise<void> {
    this.#busy = true;
    try {
      const epoch = this.#leadership.epoch + 1;
      const result = await this.#proposer.propose(this.#self.id, epoch);
      if (result.chosen && typeof result.value === 'number') {
        this.#leadership.adopt(result.value, epoch);
      }
    } finally {
      this.#busy = false;
    }
  }
}
