import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { createApp } from '../../src/app.ts';
import { ClusterConfigError, nodeConfig, parseClusterConfig } from '../../src/config.ts';
import { createReplication } from '../../src/distributed/index.ts';
import { MemoryStore } from '../../src/store.ts';
import type { StatusResponse } from '../../src/types.ts';

/** Ports nothing listens on: the coordinator only has to be named, not reachable. */
const NODE_URLS = ['http://127.0.0.1:3991', 'http://127.0.0.1:3992'];

function rawConfig(coordinators: number[]): unknown {
  return { nodes: NODE_URLS.map((url, id) => ({ id, url, coordinator: coordinators.includes(id) })) };
}

/** Starts the cluster member with the given id on a random free port. */
async function startNode(id: number): Promise<{ url: string; close: () => Promise<void> }> {
  const node = nodeConfig(parseClusterConfig(rawConfig([0])), id);
  const local = new MemoryStore();
  const replication = createReplication(node, local);
  const app = createApp(replication.store, { node, internalRouter: replication.router });
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

describe('cluster config coordinator invariant', () => {
  it('rejects a config with no coordinator', () => {
    assert.throws(
      () => parseClusterConfig(rawConfig([])),
      (err: unknown) => {
        assert.ok(err instanceof ClusterConfigError);
        assert.match(err.message, /exactly one node must have "coordinator": true/);
        return true;
      },
    );
  });

  it('rejects a config with two coordinators', () => {
    assert.throws(
      () => parseClusterConfig(rawConfig([0, 1])),
      (err: unknown) => {
        assert.ok(err instanceof ClusterConfigError);
        assert.match(err.message, /nodes 0, 1 do/);
        return true;
      },
    );
  });

  it('accepts a config with exactly one coordinator', () => {
    const { nodes } = parseClusterConfig(rawConfig([1]));
    assert.deepEqual(
      nodes.map((n) => n.coordinator),
      [false, true],
    );
  });
});

describe('replication roles', () => {
  it('redirects a follower write to the coordinator with an absolute Location', async () => {
    const follower = await startNode(1);
    try {
      const res = await fetch(`${follower.url}/kv/k`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'v' }),
        redirect: 'manual',
      });
      assert.equal(res.status, 307);
      assert.equal(res.headers.get('location'), `${NODE_URLS[0]!}/kv/k`);
      assert.match(((await res.json()) as { error: string }).error, /not the coordinator/);
    } finally {
      await follower.close();
    }
  });

  it('reports isCoordinator per node on /status', async () => {
    const [coordinator, follower] = await Promise.all([startNode(0), startNode(1)]);
    try {
      const statusOf = async (url: string) => (await (await fetch(`${url}/status`)).json()) as StatusResponse;
      assert.equal((await statusOf(coordinator.url)).isCoordinator, true);
      assert.equal((await statusOf(follower.url)).isCoordinator, false);
    } finally {
      await Promise.all([coordinator.close(), follower.close()]);
    }
  });
});
