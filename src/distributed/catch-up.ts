import type { NodeInfo } from '../config.ts';
import type { Leadership } from '../leadership/state.ts';
import type { StatusResponse } from '../types.ts';
import type { Participant } from './participant.ts';
import { get } from './peer.ts';
import { WAL_PATH } from './routes.ts';
import type { Tx } from './types.ts';

const CATCH_UP_MS = 10_000;
const RETRY_MS = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Copies committed WAL entries from an available peer until this node is caught
 * up. Does not lock the source: each fetch is a prefix of an append-only log.
 */
export async function catchUp(
  peers: NodeInfo[],
  participant: Participant,
  leadership?: Leadership,
): Promise<void> {
  const source = await waitForSource(peers);
  if (leadership && typeof source.status.leaderId === 'number') {
    leadership.adopt(source.status.leaderId, source.status.epoch ?? 1);
  }

  for (;;) {
    const res = await get<{ entries: Tx[] }>(source.url, `${WAL_PATH}?after=${participant.commitIndex}`);
    if (!res.ok) throw new Error(`wal fetch from ${source.url} failed: ${res.error}`);
    const entries = res.body.entries ?? [];
    if (entries.length === 0) return;
    for (const tx of entries) await participant.install(tx);
  }
}

async function waitForSource(peers: NodeInfo[]): Promise<{ url: string; status: StatusResponse }> {
  const deadline = Date.now() + CATCH_UP_MS;
  while (Date.now() < deadline) {
    const source = await findSource(peers);
    if (source) return source;
    await sleep(RETRY_MS);
  }
  throw new Error('no available peer to catch up from');
}

async function findSource(peers: NodeInfo[]): Promise<{ url: string; status: StatusResponse } | null> {
  let best: { url: string; status: StatusResponse } | null = null;
  for (const peer of peers) {
    const res = await get<StatusResponse>(peer.url, '/status');
    if (!res.ok) continue;
    if (res.body.state === 'initializing') continue;
    if (!best || res.body.keys > best.status.keys) best = { url: peer.url, status: res.body };
  }
  return best;
}
