import { Router } from 'express';
import type { Accepter } from './accepter.ts';
import type { Learner } from './learner.ts';
import type { AcceptedMessage, AcceptMessage, PrepareMessage } from './types.ts';

export const PREPARE_PATH = '/internal/election/prepare';
export const ACCEPT_PATH = '/internal/election/accept';
export const LEARN_PATH = '/internal/election/learn';

function isMessage(value: unknown, type: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return message.type === type && Number.isInteger(message.id);
}

function isPrepare(value: unknown): value is PrepareMessage {
  return isMessage(value, 'PREPARE');
}

function isAccept(value: unknown): value is AcceptMessage {
  return isMessage(value, 'ACCEPT') && 'value' in (value as object);
}

function isAccepted(value: unknown): value is AcceptedMessage {
  return isMessage(value, 'ACCEPTED') && 'value' in (value as object) && Number.isInteger((value as AcceptedMessage).nodeId);
}

/** Peer-to-peer Paxos endpoints. Every node serves all of them: each is accepter and learner. */
export function electionRouter(accepter: Accepter, learner: Learner): Router {
  const router = Router();

  router.post(PREPARE_PATH, async (req, res) => {
    if (!isPrepare(req.body)) {
      res.status(400).json({ error: 'expected {"type": "PREPARE", "id": number}' });
      return;
    }
    res.json(await accepter.promise(req.body));
  });

  router.post(ACCEPT_PATH, async (req, res) => {
    if (!isAccept(req.body)) {
      res.status(400).json({ error: 'expected {"type": "ACCEPT", "id": number, "value": JsonValue}' });
      return;
    }
    res.json(await accepter.accept(req.body));
  });

  router.post(LEARN_PATH, async (req, res) => {
    if (!isAccepted(req.body)) {
      res.status(400).json({ error: 'expected {"type": "ACCEPTED", "id": number, "nodeId": number, "value": JsonValue}' });
      return;
    }
    await learner.learn(req.body);
    res.json({ ok: true });
  });

  return router;
}
