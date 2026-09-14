import type { NodeInfo } from '../config.ts';

/** Who currently leads. leaderId is null until an election has a winner. */
export type LeaderView = {
  leaderId: number | null;
  leaderUrl: string | null;
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
  readonly #listeners: ((view: LeaderView) => void)[] = [];

  constructor(self: NodeInfo, nodes: NodeInfo[]) {
    this.self = self;
    this.nodes = nodes;
  }

  get leaderId(): number | null {
    return this.#leaderId;
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
    return { leaderId: this.#leaderId, leaderUrl: this.leaderUrl() };
  }

  /**
   * Records the elected leader. A later adopt of the same id is a no-op. Adopting
   * a different id after one is already set is ignored: this is single-decree
   * Paxos, so the first value that stuck is the only legal one.
   * @returns true if the view changed
   */
  adopt(leaderId: number): boolean {
    if (!this.nodes.some((node) => node.id === leaderId)) {
      throw new Error(`node ${leaderId} is not in the cluster`);
    }
    if (this.#leaderId === leaderId) return false;
    if (this.#leaderId !== null) return false;
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
