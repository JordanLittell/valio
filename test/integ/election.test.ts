import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { createApp } from '../../src/app.ts';
import { nodeConfig, parseClusterConfig } from '../../src/config.ts';
import { createReplication } from '../../src/distributed/index.ts';
import { createElection, PREPARE_PATH, type Election } from '../../src/election/index.ts';
import type { Accepted, NAKMessage, PromiseMessage } from '../../src/election/types.ts';
import { Elector, Leadership } from '../../src/leadership/index.ts';
import { MemoryStore } from '../../src/store.ts';
import type { JsonValue, StatusResponse } from '../../src/types.ts';

type Node = {
  id: number;
  url: string;
  election: Election;
  leadership: Leadership;
  close: () => Promise<void>;
};
type Cluster = { nodes: Node[]; close: () => Promise<void> };

/** Ballots and peer URLs are fixed at construction, so the ports have to be known up front. */
async function freePorts(count: number): Promise<number[]> {
  const probes = await Promise.all(
    Array.from({ length: count }, () => new Promise<Server>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => resolve(probe));
    })),
  );
  const ports = probes.map((probe) => (probe.address() as AddressInfo).port);
  await Promise.all(probes.map((probe) => new Promise<void>((resolve) => probe.close(() => resolve()))));
  return ports;
}

/** Starts a real cluster: every node listens and serves the election routes. */
async function startCluster(size: number): Promise<Cluster> {
  const ports = await freePorts(size);
  const config = parseClusterConfig({
    nodes: ports.map((port, id) => ({ id, url: `http://127.0.0.1:${port}` })),
  });

  const nodes = await Promise.all(
    ports.map(async (port, id): Promise<Node> => {
      const node = nodeConfig(config, id);
      const leadership = new Leadership(node.self, node.nodes);
      const election = createElection(node, {
        onConsensus: (value, epoch) => {
          if (typeof value === 'number') leadership.adopt(value, epoch);
        },
      });
      const replication = await createReplication(node, new MemoryStore(), leadership);
      const app = createApp(replication.store, {
        node,
        internalRouters: [replication.router, election.router],
        leadership,
      });
      const server: Server = await new Promise((resolve) => {
        const s = app.listen(port, '127.0.0.1', () => resolve(s));
      });
      return {
        id,
        url: node.self.url,
        election,
        leadership,
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

/** Asks a node over HTTP what it has accepted, using a ballot high enough to never be NAKed. */
async function probeAccepted(url: string): Promise<Accepted | null> {
  const res = await fetch(url + PREPARE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'PREPARE', id: Number.MAX_SAFE_INTEGER }),
  });
  const body = (await res.json()) as PromiseMessage | NAKMessage;
  assert.equal(body.type, 'PROMISE');
  return (body as PromiseMessage).accepted;
}

/** The accepters answer the proposer before telling the learners, so learning lands shortly after. */
async function waitForConsensus(node: Node, expected: JsonValue, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (node.election.learner.consensus() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`node ${node.id} never learned ${JSON.stringify(expected)}`);
}

async function waitForLeader(node: Node, timeoutMs = 2000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (node.leadership.leaderId !== null) return node.leadership.leaderId;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`node ${node.id} never learned a leader`);
}

async function waitForLeaderNot(node: Node, notId: number, timeoutMs = 2000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = node.leadership.leaderId;
    if (id !== null && id !== notId) return id;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`node ${node.id} never replaced leader ${notId}`);
}

describe('paxos proposal over the network', () => {
  it('reaches consensus on a value and every accepter records it', async () => {
    const cluster = await startCluster(3);
    try {
      const [, second] = cluster.nodes;
      const result = await second!.election.proposer.propose('node-1');

      assert.equal(result.chosen, true);
      assert.equal(result.chosen && result.value, 'node-1');
      // Ballots are round * clusterSize + nodeId, so node 1's first is 1.
      assert.equal(result.chosen && result.id, 1);

      for (const node of cluster.nodes) {
        assert.deepEqual(await probeAccepted(node.url), { id: 1, value: 'node-1' });
      }
    } finally {
      await cluster.close();
    }
  });

  it('tells every learner what was accepted', async () => {
    const cluster = await startCluster(3);
    try {
      const result = await cluster.nodes[0]!.election.proposer.propose('leader-0');
      assert.equal(result.chosen, true);
      for (const node of cluster.nodes) await waitForConsensus(node, 'leader-0');
    } finally {
      await cluster.close();
    }
  });

  it('still reaches consensus with a minority of nodes down', async () => {
    const cluster = await startCluster(3);
    try {
      await cluster.nodes[2]!.close();
      const result = await cluster.nodes[0]!.election.proposer.propose('survivor');
      assert.equal(result.chosen, true);
      assert.equal(result.chosen && result.value, 'survivor');
    } finally {
      await cluster.close();
    }
  });

  it('fails without a quorum when a majority is unreachable', async () => {
    const cluster = await startCluster(3);
    try {
      await Promise.all([cluster.nodes[1]!.close(), cluster.nodes[2]!.close()]);
      const result = await cluster.nodes[0]!.election.proposer.propose('lonely');

      assert.equal(result.chosen, false);
      assert.match(result.chosen ? '' : result.reason, /1 of 2 promises/);
      assert.equal(await probeAccepted(cluster.nodes[0]!.url), null);
    } finally {
      await cluster.close();
    }
  });

  it('a preempted proposer retries above the winning ballot and carries its value forward', async () => {
    const cluster = await startCluster(3);
    try {
      const winner = await cluster.nodes[2]!.election.proposer.propose('from-2');
      assert.equal(winner.chosen, true);
      assert.equal(winner.chosen && winner.id, 2);

      const preempted = await cluster.nodes[0]!.election.proposer.propose('from-0');
      assert.equal(preempted.chosen, true);
      assert.ok(preempted.chosen && preempted.id > 2, `expected a ballot above 2, got ${preempted.chosen && preempted.id}`);
      assert.equal(preempted.chosen && preempted.value, 'from-2');
    } finally {
      await cluster.close();
    }
  });
});

describe('runtime leader election', () => {
  it('elects one leader and every node reports the same one', async () => {
    const cluster = await startCluster(3);
    try {
      await Promise.all(
        cluster.nodes.map((node) => new Elector(node.election.proposer.self, node.election.proposer, node.leadership).elect()),
      );

      const leaders = await Promise.all(cluster.nodes.map((node) => waitForLeader(node)));
      assert.equal(new Set(leaders).size, 1);

      const leaderId = leaders[0]!;
      for (const node of cluster.nodes) {
        const status = (await (await fetch(`${node.url}/status`)).json()) as StatusResponse;
        assert.equal(status.leaderId, leaderId);
        assert.equal(status.isCoordinator, node.id === leaderId);
      }
    } finally {
      await cluster.close();
    }
  });

  it('redirects writes to the elected leader', async () => {
    const cluster = await startCluster(3);
    try {
      await Promise.all(
        cluster.nodes.map((node) => new Elector(node.election.proposer.self, node.election.proposer, node.leadership).elect()),
      );
      const leaderId = await waitForLeader(cluster.nodes[0]!);
      const follower = cluster.nodes.find((node) => node.id !== leaderId)!;
      const leader = cluster.nodes.find((node) => node.id === leaderId)!;

      const res = await fetch(`${follower.url}/kv/k`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'v' }),
        redirect: 'manual',
      });
      assert.equal(res.status, 307);
      assert.equal(res.headers.get('location'), `${leader.url}/kv/k`);
    } finally {
      await cluster.close();
    }
  });

  it('a higher epoch can elect a different leader after the current one is killed', async () => {
    const cluster = await startCluster(3);
    try {
      await Promise.all(
        cluster.nodes.map((node) => new Elector(node.election.proposer.self, node.election.proposer, node.leadership).elect()),
      );
      const first = await waitForLeader(cluster.nodes[0]!);
      await cluster.nodes.find((node) => node.id === first)!.close();

      const survivor = cluster.nodes.find((node) => node.id !== first)!;
      const epoch = survivor.leadership.epoch + 1;
      const result = await survivor.election.proposer.propose(survivor.id, epoch);
      assert.equal(result.chosen, true);
      assert.notEqual(result.value, first);

      for (const node of cluster.nodes.filter((node) => node.id !== first)) {
        assert.equal(await waitForLeaderNot(node, first), result.value);
      }
    } finally {
      await cluster.close();
    }
  });
});
