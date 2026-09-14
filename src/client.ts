import type { ErrorResponse, GetResponse, JsonValue, ListResponse, StatusResponse } from './types.ts';

export type NodeFailure = { url: string; cause: unknown };

/** No node could be reached (connection refused, timeout, DNS, 5xx, ...). */
export class ValioUnavailableError extends Error {
  readonly failures: readonly NodeFailure[];

  constructor(failures: NodeFailure[]) {
    const detail = (f: NodeFailure) => (f.cause as Error)?.message ?? String(f.cause);
    super(
      failures.length === 1
        ? `server unreachable: ${failures[0]!.url}`
        : `no node available (tried ${failures.length}):\n` +
            failures.map((f) => `  ${f.url}: ${detail(f)}`).join('\n'),
      { cause: failures.length === 1 ? failures[0]!.cause : new AggregateError(failures.map((f) => f.cause)) },
    );
    this.name = 'ValioUnavailableError';
    this.failures = failures;
  }
}

/** The server answered with an unexpected status. */
export class ValioHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`HTTP ${status}: ${message}`);
    this.name = 'ValioHttpError';
    this.status = status;
  }
}

export class ValioClient {
  /** Every candidate node, rotated by a random offset at construction. */
  readonly urls: readonly string[];
  readonly timeoutMs: number;
  #base: string;

  constructor(base: string | string[], timeoutMs = 5000) {
    const urls = (Array.isArray(base) ? base : [base]).map((u) => u.replace(/\/+$/, ''));
    if (urls.length === 0) throw new TypeError('ValioClient needs at least one url');
    const start = Math.floor(Math.random() * urls.length);
    this.urls = [...urls.slice(start), ...urls.slice(0, start)];
    this.#base = this.urls[0]!;
    this.timeoutMs = timeoutMs;
  }

  /** URL of the node that served (or last attempted) a request. */
  get base(): string {
    return this.#base;
  }

  async get(key: string): Promise<JsonValue | undefined> {
    const res = await this.#request('GET', keyPath(key));
    if (res.status === 404) return undefined;
    await expectOk(res);
    return ((await res.json()) as GetResponse).value;
  }

  async set(key: string, value: JsonValue): Promise<void> {
    const res = await this.#request('PUT', keyPath(key), { value });
    await expectOk(res);
  }

  async del(key: string): Promise<boolean> {
    const res = await this.#request('DELETE', keyPath(key));
    if (res.status === 404) return false;
    await expectOk(res);
    return true;
  }

  async list(): Promise<Record<string, JsonValue>> {
    const res = await this.#request('GET', '/kv');
    await expectOk(res);
    return ((await res.json()) as ListResponse).data;
  }

  async clear(): Promise<void> {
    const res = await this.#request('DELETE', '/kv');
    await expectOk(res);
  }

  async status(): Promise<StatusResponse> {
    const res = await this.#request('GET', '/status');
    await expectOk(res);
    return (await res.json()) as StatusResponse;
  }

  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    const failures: NodeFailure[] = [];
    // Fresh init per attempt: AbortSignal.timeout cannot be reused across fetches.
    const attempt = (origin: string) =>
      fetch(origin + path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        // A follower redirects writes to the coordinator; following that here would
        // re-enter this loop blind, so take the hint explicitly below.
        redirect: 'manual',
      });

    for (const url of this.urls) {
      this.#base = url;
      let res: Response;
      try {
        res = await attempt(url);
      } catch (err) {
        failures.push({ url, cause: err });
        continue;
      }

      const coordinator = coordinatorHint(res, url);
      if (coordinator) {
        this.#base = coordinator;
        try {
          res = await attempt(coordinator);
        } catch (err) {
          failures.push({ url: coordinator, cause: new Error(`coordinator unavailable: ${coordinator}`, { cause: err }) });
          continue;
        }
      }

      // 5xx: this node is broken. Still 3xx: it did not send us anywhere useful.
      if (res.status >= 500 || isRedirect(res)) {
        failures.push({ url: this.#base, cause: await httpError(res) });
        continue;
      }
      return res;
    }
    throw new ValioUnavailableError(failures);
  }
}

function keyPath(key: string): string {
  return `/kv/${encodeURIComponent(key)}`;
}

function isRedirect(res: Response): boolean {
  return res.status >= 300 && res.status < 400;
}

/** Origin a 3xx points at, when it is a different node. Null guards self-redirect loops. */
function coordinatorHint(res: Response, from: string): string | null {
  if (!isRedirect(res)) return null;
  const location = res.headers.get('location');
  if (!location) return null;
  try {
    const { origin } = new URL(location, from);
    return origin === from ? null : origin;
  } catch {
    return null;
  }
}

async function httpError(res: Response): Promise<ValioHttpError> {
  let message = res.statusText;
  try {
    message = ((await res.json()) as ErrorResponse).error ?? message;
  } catch {
    // non-JSON error body; keep statusText
  }
  return new ValioHttpError(res.status, message);
}

async function expectOk(res: Response): Promise<void> {
  if (res.ok) return;
  throw await httpError(res);
}
