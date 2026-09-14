import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { createApp } from '../../src/app.ts';
import { nodeConfig, parseClusterConfig } from '../../src/config.ts';
import { createReplication } from '../../src/distributed/index.ts';
import { Leadership } from '../../src/leadership/state.ts';
import { MemoryStore } from '../../src/store.ts';
import type { StatusResponse } from '../../src/types.ts';

/** Ports nothing listens on: the leader only has to be named, not reachable. */
const NODE_URLS = ['http://127.0.0.1:3991', 'http://127.0.0.1:3992'];

function rawConfig(): unknown {
  return { nodes: NODE_URLS.map((url, id) => ({ id, url })) };
}

/** Starts the cluster member with the given id, optionally already knowing a leader. */
async function startNode(
  id: number,
  leaderId?: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const node = nodeConfig(parseClusterConfig(rawConfig()), id);
  const leadership = new Leadership(node.self, node.nodes);
  if (leaderId !== undefined) leadership.adopt(leaderId);
  const local = new MemoryStore();
      const replication = await createReplication(node, local, leadership);
  const app = createApp(replication.store, { node, internalRouters: [replication.router], leadership });
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

describe('cluster config', () => {
  it('accepts a config with only id and url (no coordinator field)', () => {
    const { nodes } = parseClusterConfig(rawConfig());
    assert.deepEqual(
      nodes.map((n) => n.id),
      [0, 1],
    );
  });

  it('ignores a leftover coordinator field', () => {
    const { nodes } = parseClusterConfig({
      nodes: NODE_URLS.map((url, id) => ({ id, url, coordinator: id === 0 })),
    });
    assert.equal(nodes.length, 2);
    assert.equal('coordinator' in nodes[0]!, false);
  });
});

describe('replication roles', () => {
  it('redirects a follower write to the current leader with an absolute Location', async () => {
    const follower = await startNode(1, 0);
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

  it('returns 503 when no leader has been elected yet', async () => {
    const node = await startNode(0);
    try {
      const res = await fetch(`${node.url}/kv/k`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'v' }),
        redirect: 'manual',
      });
      assert.equal(res.status, 503);
      assert.match(((await res.json()) as { error: string }).error, /no leader elected yet/);
    } finally {
      await node.close();
    }
  });

  it('reports isCoordinator from live leadership, not config', async () => {
    const [leader, follower] = await Promise.all([startNode(0, 0), startNode(1, 0)]);
    try {
      const statusOf = async (url: string) => (await (await fetch(`${url}/status`)).json()) as StatusResponse;
      const leaderStatus = await statusOf(leader.url);
      const followerStatus = await statusOf(follower.url);
      assert.equal(leaderStatus.isCoordinator, true);
      assert.equal(leaderStatus.leaderId, 0);
      assert.equal(followerStatus.isCoordinator, false);
      assert.equal(followerStatus.leaderId, 0);
    } finally {
      await Promise.all([leader.close(), follower.close()]);
    }
  });
});

async function freePorts(count: number): Promise<number[]> {
  const probes = await Promise.all(
    Array.from({ length: count }, () =>
      new Promise<Server>((resolve) => {
        const probe = createServer().listen(0, '127.0.0.1', () => resolve(probe));
      }),
    ),
  );
  const ports = probes.map((probe) => (probe.address() as AddressInfo).port);
  await Promise.all(probes.map((probe) => new Promise<void>((resolve) => probe.close(() => resolve()))));
  return ports;
}

type LiveNode = { id: number; url: string; close: () => Promise<void> };

/** Real listeners so 2PC has reachable peers (unlike startNode's placeholder URLs). */
async function startLiveCluster(size: number): Promise<{ nodes: LiveNode[]; close: () => Promise<void> }> {
  const ports = await freePorts(size);
  const config = parseClusterConfig({
    nodes: ports.map((port, id) => ({ id, url: `http://127.0.0.1:${port}` })),
  });
  const nodes = await Promise.all(
    ports.map(async (port, id): Promise<LiveNode> => {
      const node = nodeConfig(config, id);
      const leadership = new Leadership(node.self, node.nodes);
      leadership.adopt(0);
      const replication = await createReplication(node, new MemoryStore(), leadership);
      const app = createApp(replication.store, {
        node,
        internalRouters: [replication.router],
        leadership,
      });
      const server: Server = await new Promise((resolve) => {
        const s = app.listen(port, '127.0.0.1', () => resolve(s));
      });
      return {
        id,
        url: node.self.url,
        close: () =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      };
    }),
  );
  return { nodes, close: async () => void (await Promise.all(nodes.map((n) => n.close()))) };
}

async function put(url: string, key: string, value: string): Promise<Response> {
  return fetch(`${url}/kv/${key}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  });
}

describe('majority commit', () => {
  it('commits a write when a minority of nodes are down', async () => {
    const cluster = await startLiveCluster(3);
    try {
      await cluster.nodes[2]!.close();
      const leader = cluster.nodes[0]!;
      const res = await put(leader.url, 'k', 'v');
      assert.equal(res.status, 200);
      assert.equal(((await (await fetch(`${leader.url}/kv/k`)).json()) as { value: string }).value, 'v');
      assert.equal(((await (await fetch(`${cluster.nodes[1]!.url}/kv/k`)).json()) as { value: string }).value, 'v');
    } finally {
      await cluster.close();
    }
  });

  it('aborts when a majority of nodes are unreachable', async () => {
    const cluster = await startLiveCluster(3);
    try {
      await Promise.all([cluster.nodes[1]!.close(), cluster.nodes[2]!.close()]);
      const res = await put(cluster.nodes[0]!.url, 'k', 'v');
      assert.equal(res.status, 503);
      assert.match(((await res.json()) as { error: string }).error, /aborted/);
    } finally {
      await cluster.close();
    }
  });
});
