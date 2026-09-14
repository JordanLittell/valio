import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { createApp } from '../../src/app.ts';
import { nodeConfig, parseClusterConfig } from '../../src/config.ts';
import { catchUp, createReplication } from '../../src/distributed/index.ts';
import { Participant } from '../../src/distributed/participant.ts';
import { MemoryWal } from '../../src/distributed/wal.ts';
import { Leadership } from '../../src/leadership/state.ts';
import { MemoryStore } from '../../src/store.ts';
import type { StatusResponse } from '../../src/types.ts';

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
      const wal = new MemoryWal();
      const replication = await createReplication(node, new MemoryStore(), leadership, wal);
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

describe('joining node', () => {
  it('rejects client writes while initializing', async () => {
    const app = createApp(new MemoryStore(), { membership: { state: 'initializing' } });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    try {
      const write = await fetch(`${url}/kv/k`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'v' }),
      });
      assert.equal(write.status, 503);
      const status = (await (await fetch(`${url}/status`)).json()) as StatusResponse;
      assert.equal(status.state, 'initializing');
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    }
  });

  it('copies committed WAL entries from an available peer', async () => {
    const cluster = await startLiveCluster(2);
    try {
      const leader = cluster.nodes[0]!;
      const res = await fetch(`${leader.url}/kv/k`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'v' }),
      });
      assert.equal(res.status, 200);

      const joining = new Participant(new MemoryStore(), new MemoryWal());
      await catchUp([{ id: 0, url: leader.url }], joining);
      assert.equal(await joining.store.get('k'), 'v');
      assert.equal(joining.commitIndex, 1);
    } finally {
      await cluster.close();
    }
  });
});
