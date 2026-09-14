import type { KVStore } from '../store.ts';
import type { Wal } from './wal.ts';
import { describeEvent, type AbortResponse, type CommitResponse, type Event, type Tx, type Vote } from './types.ts';

const short = (txId: string) => txId.slice(0, 8);

/**
 * 2PC participant. Holds at most one prepared (staged) transaction and applies
 * committed transactions to the local store in index order. When a WAL is
 * provided, committed txs are fsynced before apply so a restart can replay them.
 */
export class Participant {
  readonly store: KVStore;
  readonly #wal: Wal | undefined;
  commitIndex = 0;
  staged: Tx | null = null;

  constructor(store: KVStore, wal?: Wal) {
    this.store = store;
    this.#wal = wal;
  }

  /** Replays the WAL into the empty store. No-op when there is no WAL. */
  async restore(): Promise<void> {
    if (!this.#wal) return;
    const records = await this.#wal.load();
    for (const tx of records) {
      await applyEvent(this.store, tx.event);
      this.commitIndex = tx.index;
    }
  }

  prepare(tx: Tx): Vote {
    const vote = this.#vote(tx);
    if (vote.vote === 'yes') this.staged = tx;
    console.log(
      `2pc prepare ${short(tx.id)} #${tx.index} ${describeEvent(tx.event)} → ${vote.vote === 'yes' ? 'yes' : `no (${vote.reason})`}`,
    );
    return vote;
  }

  async commit(txId: string): Promise<CommitResponse> {
    const tx = this.staged;
    // Not ok when we hold no matching staged tx: we restarted after voting yes
    // (in-memory state lost), or this COMMIT is a duplicate / arrived late.
    if (!tx || tx.id !== txId) {
      console.log(`2pc commit ${short(txId)} → unknown tx`);
      return { ok: false, reason: 'unknown tx' };
    }
    this.staged = null;
    if (this.#wal) await this.#wal.append(tx);
    const result = await applyEvent(this.store, tx.event);
    this.commitIndex = tx.index;
    console.log(`2pc commit ${short(txId)} #${tx.index} ${describeEvent(tx.event)}`);
    return { ok: true, result };
  }

  /**
   * Applies an already-committed tx from a peer's WAL. Used to catch up a joining
   * node; not a 2PC vote.
   */
  async install(tx: Tx): Promise<void> {
    if (tx.index <= this.commitIndex) return;
    if (tx.index !== this.commitIndex + 1) {
      throw new Error(`cannot install #${tx.index} at commitIndex ${this.commitIndex}`);
    }
    if (this.#wal) await this.#wal.append(tx);
    await applyEvent(this.store, tx.event);
    this.commitIndex = tx.index;
  }

  /** Always ok: aborting a tx we don't hold is a no-op. */
  abort(txId: string): AbortResponse {
    if (this.staged?.id === txId) {
      this.staged = null;
      console.log(`2pc abort ${short(txId)}`);
    }
    return { ok: true };
  }

  #vote(tx: Tx): Vote {
    // Duplicate PREPARE for the tx we already staged: repeat our yes.
    if (this.staged?.id === tx.id) return { vote: 'yes' };
    // No: still holding an earlier tx whose COMMIT/ABORT never arrived
    // (coordinator crashed or the decision was lost). Must be resolved first.
    if (this.staged) return { vote: 'no', reason: `busy with ${short(this.staged.id)}` };
    // No: applying this tx would skip or repeat an index. We missed a commit
    // (were down, or a COMMIT failed) or restarted and lost state.
    if (tx.index !== this.commitIndex + 1) {
      return { vote: 'no', reason: `out of sync (at #${this.commitIndex}, got #${tx.index})` };
    }
    return { vote: 'yes' };
  }
}

async function applyEvent(store: KVStore, event: Event): Promise<boolean> {
  switch (event.type) {
    case 'SET':
      await store.set(event.key, event.value);
      return true;
    case 'DEL':
      return store.del(event.key);
    case 'CLEAR':
      await store.clear();
      return true;
  }
}
