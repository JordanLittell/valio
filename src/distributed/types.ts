import type { JsonValue } from '../types.ts';

/** A replicated write. */
export type Event =
  | { type: 'SET'; key: string; value: JsonValue }
  | { type: 'DEL'; key: string }
  | { type: 'CLEAR' };

/** One distributed transaction. */
export type Tx = {
  id: string;
  /** Position in the commit order: the participant's commitIndex + 1. */
  index: number;
  event: Event;
};

/**
 * A participant's answer to PREPARE. A "no" vote aborts the transaction on every node.
 *
 * Why a vote may be "no":
 * - busy: the participant already holds a different staged tx. It voted yes on an
 *   earlier tx but never received that tx's COMMIT/ABORT (coordinator crashed or the
 *   decision message was lost), so it cannot accept new work until that tx is resolved.
 * - out of sync: tx.index is not the participant's commitIndex + 1. The participant
 *   missed a commit (it was down or its COMMIT failed) or restarted and lost its
 *   in-memory state, so applying this tx would apply events out of order.
 * - unreachable / timeout / HTTP error: the participant never answered (down, paused,
 *   partitioned, or slow). The coordinator counts silence as "no".
 */
export type Vote = { vote: 'yes' } | { vote: 'no'; reason: string };

// Messages: coordinator → participant
export type PrepareRequest = { tx: Tx };
export type DecisionRequest = { txId: string };

/**
 * A participant's answer to COMMIT. result: whether the event changed an existing
 * key (DEL of a missing key → false).
 *
 * Why a commit may be not ok:
 * - unknown tx: the participant has no staged tx with this id. It restarted after
 *   voting yes (staged state is in memory), or it already applied/dropped this tx and
 *   the COMMIT is a duplicate or arrived late. The node is now out of sync.
 * - unreachable / timeout / HTTP error (seen by the coordinator): the COMMIT may or
 *   may not have been applied. Either way the tx is already committed elsewhere, so
 *   it cannot be undone; the participant stays staged ("busy") until reset.
 */
export type CommitResponse = { ok: true; result: boolean } | { ok: false; reason: string };
export type AbortResponse = { ok: true };

export function describeEvent(event: Event): string {
  return event.type === 'CLEAR' ? 'CLEAR' : `${event.type} ${event.key}`;
}
