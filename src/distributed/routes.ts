import { Router } from 'express';
import type { Participant } from './participant.ts';
import type { Tx } from './types.ts';
import type { Wal } from './wal.ts';

export const WAL_PATH = '/internal/wal';

const EVENT_TYPES = new Set(['SET', 'DEL', 'CLEAR']);

function isTx(value: unknown): value is Tx {
  if (typeof value !== 'object' || value === null) return false;
  const { id, index, event } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    Number.isInteger(index) &&
    typeof event === 'object' &&
    event !== null &&
    EVENT_TYPES.has((event as { type?: unknown }).type as string)
  );
}

function txIdOf(body: unknown): string | undefined {
  const txId = (body as { txId?: unknown } | undefined)?.txId;
  return typeof txId === 'string' ? txId : undefined;
}

/** Peer-to-peer 2PC endpoints. */
export function internalRouter(participant: Participant, wal?: Wal): Router {
  const router = Router();

  router.get(WAL_PATH, async (req, res) => {
    const raw = Number(req.query.after);
    const after = Number.isInteger(raw) ? raw : -1;
    const entries = wal ? (await wal.load()).filter((tx) => tx.index > after) : [];
    res.json({ entries });
  });

  router.post('/internal/2pc/prepare', (req, res) => {
    const tx = (req.body as { tx?: unknown } | undefined)?.tx;
    if (!isTx(tx)) {
      res.status(400).json({ error: 'expected {"tx": {"id", "index", "event"}}' });
      return;
    }
    res.json(participant.prepare(tx));
  });

  router.post('/internal/2pc/commit', async (req, res) => {
    const txId = txIdOf(req.body);
    if (!txId) {
      res.status(400).json({ error: 'expected {"txId": string}' });
      return;
    }
    res.json(await participant.commit(txId));
  });

  router.post('/internal/2pc/abort', (req, res) => {
    const txId = txIdOf(req.body);
    if (!txId) {
      res.status(400).json({ error: 'expected {"txId": string}' });
      return;
    }
    res.json(participant.abort(txId));
  });

  return router;
}
