import express from 'express';
import type { NextFunction, Request, Response, Router } from 'express';
import type { NodeConfig } from './config.ts';
import { NotCoordinatorError, TxAbortedError } from './distributed/errors.ts';
import type { KVStore } from './store.ts';
import type { JsonValue, StatusResponse } from './types.ts';

type KeyParams = { key: string };

export type AppOptions = {
  /** Present when the server runs as a member of a cluster. */
  node?: NodeConfig | undefined;
  /** Peer-to-peer routes (e.g. 2PC), mounted before the client routes. */
  internalRouter?: Router | undefined;
};

export function createApp(store: KVStore, { node, internalRouter }: AppOptions = {}): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  if (internalRouter) app.use(internalRouter);

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/status', async (_req, res) => {
    const status: StatusResponse = {
      id: node?.self.id ?? null,
      isLeader: node?.self.leader === true,
      url: node?.self.url ?? null,
      peers: node?.peers.map((p) => p.id) ?? [],
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      keys: Object.keys(await store.list()).length,
    };
    res.json(status);
  });

  app.get('/kv', async (_req, res) => {
    res.json({ data: await store.list() });
  });

  app.get('/kv/:key', async (req: Request<KeyParams>, res) => {
    const { key } = req.params;
    const value = await store.get(key);
    if (value === undefined) {
      res.status(404).json({ error: `key not found: ${key}` });
      return;
    }
    res.json({ key, value });
  });

  app.put('/kv/:key', async (req: Request<KeyParams>, res) => {
    const { key } = req.params;
    const body: unknown = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body) || !('value' in body)) {
      res.status(400).json({ error: 'body must be a JSON object with a "value" property' });
      return;
    }
    const value = body.value as JsonValue;
    await store.set(key, value);
    res.json({ key, value });
  });

  app.delete('/kv', async (_req, res) => {
    await store.clear();
    res.status(204).end();
  });

  app.delete('/kv/:key', async (req: Request<KeyParams>, res) => {
    const { key } = req.params;
    if (!(await store.del(key))) {
      res.status(404).json({ error: `key not found: ${key}` });
      return;
    }
    res.status(204).end();
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'route not found' });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof NotCoordinatorError) {
      const location = err.coordinatorUrl + req.originalUrl;
      res.status(307).location(location).json({ error: err.message, location });
      return;
    }
    if (err instanceof TxAbortedError) {
      res.status(503).set('Retry-After', '1').json({ error: err.message, txId: err.txId, blockedBy: err.blockedBy });
      return;
    }
    const status = (err as { status?: number }).status;
    if (status === 400 || status === 413) {
      res.status(status).json({ error: (err as Error).message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
