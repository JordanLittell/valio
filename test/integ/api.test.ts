import assert from 'node:assert/strict';
import { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../../src/app.ts';
import { ValioClient, ValioUnavailableError } from '../../src/client.ts';
import { MemoryStore } from '../../src/store.ts';

type TestServer = { url: string; close: () => Promise<void> };

/** Start a standalone app in-process on a random free port. */
async function startServer(): Promise<TestServer> {
  const app = createApp(new MemoryStore());
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('HTTP API', () => {
  let server: TestServer;
  let client: ValioClient;

  before(async () => {
    server = await startServer();
    client = new ValioClient(server.url);
  });
  after(() => server.close());

  it('reports health', async () => {
    const res = await fetch(`${server.url}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it('round-trips values through the client', async () => {
    await client.set('greeting', 'hello');
    await client.set('obj', { a: [1, 2], b: null });
    assert.equal(await client.get('greeting'), 'hello');
    assert.deepEqual(await client.get('obj'), { a: [1, 2], b: null });
  });

  it('returns undefined / false for missing keys', async () => {
    assert.equal(await client.get('missing'), undefined);
    assert.equal(await client.del('missing'), false);
  });

  it('deletes keys', async () => {
    await client.set('tmp', 1);
    assert.equal(await client.del('tmp'), true);
    assert.equal(await client.get('tmp'), undefined);
  });

  it('lists keys', async () => {
    await client.set('l1', 1);
    const data = await client.list();
    assert.equal(data.l1, 1);
  });

  it('handles keys that need URL encoding', async () => {
    const key = 'weird key/with?chars#&';
    await client.set(key, 'ok');
    assert.equal(await client.get(key), 'ok');
    assert.equal((await client.list())[key], 'ok');
  });

  it('GET /kv/:key 404s with an error body', async () => {
    const res = await fetch(`${server.url}/kv/nope`);
    assert.equal(res.status, 404);
    assert.match(((await res.json()) as { error: string }).error, /not found/);
  });

  it('DELETE /kv/:key returns 204 then 404', async () => {
    await client.set('d', 1);
    assert.equal((await fetch(`${server.url}/kv/d`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${server.url}/kv/d`, { method: 'DELETE' })).status, 404);
  });

  it('PUT rejects bodies without a value', async () => {
    for (const body of ['{}', '[]', '"str"', 'null']) {
      const res = await fetch(`${server.url}/kv/bad`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 400, `body ${body}`);
    }
  });

  it('PUT rejects malformed JSON', async () => {
    const res = await fetch(`${server.url}/kv/bad`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
  });

  it('PUT accepts null as a value', async () => {
    await client.set('nullable', null);
    assert.equal(await client.get('nullable'), null);
  });

  it('unknown routes 404', async () => {
    assert.equal((await fetch(`${server.url}/nope`)).status, 404);
  });

  it('client throws ValioUnavailableError when the server is down', async () => {
    const dead = new ValioClient('http://127.0.0.1:1', 1000);
    await assert.rejects(dead.list(), ValioUnavailableError);
  });
});
