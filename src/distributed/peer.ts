export type PeerResult<T> = { ok: true; body: T } | { ok: false; error: string };

export const PEER_TIMEOUT_MS = 1000;

/** POST JSON to a peer. Never throws: transport and HTTP failures become { ok: false }. */
export async function post<T>(baseUrl: string, path: string, body: unknown): Promise<PeerResult<T>> {
  try {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, body: (await res.json()) as T };
  } catch (err) {
    return { ok: false, error: (err as Error).name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}
