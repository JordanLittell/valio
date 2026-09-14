import type { NodeInfo } from '../config.ts';

/** Who currently leads. leaderId is null until an election has a winner. */
export type LeaderView = {
  leaderId: number | null;
  leaderUrl: string | null;
  /** Paxos instance that chose this leader. 0 until the first election. */
  epoch: number;
};

/**
 * The cluster's current view of who leads. Pure state with no I/O: the elector
 * writes to it, and ReplicatedStore and /status read from it, so a node's role can
 * change at runtime instead of coming from the config file.
 */
export class Leadership {
  readonly self: NodeInfo;
  readonly nodes: NodeInfo[];
  #leaderId: number | null = null;
  #epoch = 0;
  readonly #listeners: ((view: LeaderView) => void)[] = [];

  constructor(self: NodeInfo, nodes: NodeInfo[]) {
    this.self = self;
    this.nodes = nodes;
  }

  get leaderId(): number | null {
    return this.#leaderId;
  }

  get epoch(): number {
    return this.#epoch;
  }

  isLeader(): boolean {
    return this.#leaderId === this.self.id;
  }

  /** Where writes should go, or null when no leader is known. */
  leaderUrl(): string | null {
    if (this.#leaderId === null) return null;
    return this.nodes.find((node) => node.id === this.#leaderId)?.url ?? null;
  }

  view(): LeaderView {
    return { leaderId: this.#leaderId, leaderUrl: this.leaderUrl(), epoch: this.#epoch };
  }

  /**
   * Records the elected leader for `epoch`. A later adopt of the same id at the
   * same epoch is a no-op. Adopting a different id at the same epoch is ignored:
   * that instance of Paxos already chose. A higher epoch replaces the leader
   * (re-election after failure).
   * @returns true if the view changed
   */
  adopt(leaderId: number, epoch = 1): boolean {
    if (!this.nodes.some((node) => node.id === leaderId)) {
      throw new Error(`node ${leaderId} is not in the cluster`);
    }
    if (epoch < this.#epoch) return false;
    if (epoch === this.#epoch) {
      if (this.#leaderId === leaderId) return false;
      if (this.#leaderId !== null) return false;
    }
    this.#epoch = epoch;
    this.#leaderId = leaderId;
    const view = this.view();
    for (const listener of this.#listeners) listener(view);
    return true;
  }

  onChange(listener: (view: LeaderView) => void): void {
    this.#listeners.push(listener);
  }

  /** Resolves with the current leader, or the next one adopted. */
  waitForLeader(): Promise<number> {
    if (this.#leaderId !== null) return Promise.resolve(this.#leaderId);
    return new Promise((resolve) => {
      this.onChange((view) => {
        if (view.leaderId !== null) resolve(view.leaderId);
      });
    });
  }
}
