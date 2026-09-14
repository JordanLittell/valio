import type { ErrorResponse, GetResponse, JsonValue, ListResponse, StatusResponse } from './types.ts';

/** The server could not be reached (connection refused, timeout, DNS, ...). */
export class ValioUnavailableError extends Error {
  constructor(url: string, cause: unknown) {
    super(`server unreachable: ${url}`, { cause });
    this.name = 'ValioUnavailableError';
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
  readonly base: string;
  readonly timeoutMs: number;

  constructor(base: string, timeoutMs = 5000) {
    this.base = base.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
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
    const url = this.base + path;
    try {
      return await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ValioUnavailableError(url, err);
    }
  }
}

function keyPath(key: string): string {
  return `/kv/${encodeURIComponent(key)}`;
}

async function expectOk(res: Response): Promise<void> {
  if (res.ok) return;
  let message = res.statusText;
  try {
    message = ((await res.json()) as ErrorResponse).error ?? message;
  } catch {
    // non-JSON error body; keep statusText
  }
  throw new ValioHttpError(res.status, message);
}
