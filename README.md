# Valio

A small distributed key-value store. Nodes talk over HTTP. One elected coordinator replicates writes with a two-phase majority vote; every node serves local reads. Leadership is chosen with Paxos. Committed writes are stored in a WAL so a joining or restarted node can catch up.

Requires Node.js 24+.

```bash
npm install
npm run cluster          # start every node in cluster.json
```

## CLI

### DataStore Commands
By default `valio` uses `cluster.json` (or `$VALIO_CLUSTER`) and fails over across nodes. `--url` or `--node` pins a command to one server.

```bash
node src/cli.ts set greeting hello
node src/cli.ts get greeting
node src/cli.ts del greeting
node src/cli.ts list
node src/cli.ts clear
node src/cli.ts status
node src/cli.ts status --json
```

`set` stores a string. Pass `--json` to parse the value as JSON.

```bash
node src/cli.ts set obj '{"a":1}' --json
```

### Cluster Administration

```bash
node src/cli.ts cluster describe
node src/cli.ts cluster add http://127.0.0.1:3007
```

`cluster describe` prints each node’s `/status` as JSON, keyed by id. Unreachable nodes are `{ unavailable: true, ... }`.

`cluster add [URL]` appends the node to the cluster config, starts it with `VALIO_JOIN=1`, and has it copy committed WAL entries from a live peer. Until that finishes, the node reports `state: "initializing"` and rejects `/kv` requests. Then it becomes `available`.

## Topology

`cluster.json` is the membership list: node ids `0..N-1` and an `http://` origin per node.

```json
{ "nodes": [{ "id": 0, "url": "http://127.0.0.1:3001" }, ...] }
```

Every node runs the same process: HTTP API, write participant, Paxos accepter/proposer/learner. Who coordinates is runtime state, not a config flag. Followers redirect client writes to the current leader (`307`). Reads are served from the local map and do not go through the coordinator.

## Consensus and shared state

**Writes.** The leader asks every node to PREPARE, then COMMIT or ABORT. That is two phases, not classic 2PC: a write commits when a **majority** vote yes (`floor(N/2)+1`), not when every node does. Silence counts as no, not as a veto, so a minority of down nodes does not block writes. Nodes that voted no never apply the transaction. Each committed write has a monotonic `index`.

**Reads.** `GET` is local. After a failover or catch-up, nodes can briefly differ until they share the same committed prefix.

**WAL.** On commit, a node appends `{ index, id, event }` to `data/node-<id>.wal` and fsyncs before applying the event to memory. On boot it replays that file. A joining node pulls `GET /internal/wal?after=<commitIndex>` from an available peer and installs entries in order. That copy does not lock the source.

## Leader election

Startup (and a joining node after catch-up) runs single-decree Paxos. The value is a node id. A majority of promises and accepts is enough; Paxos may carry forward a value another proposer already had accepted, so the winner is not always the proposer.

That choice is permanent **for one epoch**. A later election uses epoch `N+1`, which resets accepter state so a new id can win. Followers poll the leader’s `/health`. After consecutive failures they propose the next epoch. Learners adopt the winner; `/status` reports `leaderId`, `epoch`, and `isCoordinator`.

## Failures

| Failure | What happens |
| --- | --- |
| Leader process dies | Followers notice `/health` fail, elect at the next epoch. Immediate writes that still redirect to the corpse fail; after election, writes go to the new coordinator. |
| Minority of nodes down | Writes still commit (majority vote). The down node’s WAL is missing those indexes; when it returns it votes `out of sync` until catch-up exists for *restarts* (joining nodes catch up via `cluster add`). |
| Majority of nodes down | Writes abort. The CLI reports no node available. |
| New node | Starts `initializing`, copies the WAL, then `available`. It does not vote in election until catch-up finishes. |

Split-brain (a slow leader vs a new epoch) is not fenced yet: prepare/commit do not reject stale epochs. Catch-up for a node that was down (as opposed to newly added) is also still a follow-up.

## Testing

```bash
npm test              # integration (no running cluster)
npm run e2e           # against `npm run cluster`
npm run failure       # disaster cases against a live cluster
npm run typecheck
```

**`npm test`** (`test/integ/`) starts in-process servers.

- `store.test.ts` — `MemoryStore` get/set/del/list isolation
- `api.test.ts` — standalone HTTP API and `ValioClient`
- `replication.test.ts` — config, write redirects, 503 with no leader, majority commit / abort
- `election.test.ts` — Paxos over HTTP, quorum with a node down, runtime leader election, re-election on a new epoch
- `wal.test.ts` — WAL replay, file durability, truncated last line
- `join.test.ts` — initializing nodes reject `/kv`; catch-up copies a peer’s committed log

**`npm run e2e`** (`test/e2e/`) needs a cluster already running.

- Concurrent writes, then every available node reports the same key count
- Kill the coordinator: `cluster describe` marks it unavailable, reads still work, writes fail immediately then succeed after election
- Ten writes, `cluster add`, wait until `state` is `available`, then key counts match again

**`npm run failure`** (`test/failure/`) is separate from e2e (shared helpers live in `test/helpers/`, not in a test file).

- Kill a majority of nodes and assert client writes fail with no node available
