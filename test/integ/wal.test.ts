import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Participant } from '../../src/distributed/participant.ts';
import { FileWal, MemoryWal } from '../../src/distributed/wal.ts';
import { MemoryStore } from '../../src/store.ts';
import type { Tx } from '../../src/distributed/types.ts';

const setTx = (index: number, key: string, value: string): Tx => ({
  id: `tx-${index}`,
  index,
  event: { type: 'SET', key, value },
});

describe('WAL', () => {
  it('replays committed txs into an empty store', async () => {
    const wal = new MemoryWal();
    const live = new Participant(new MemoryStore(), wal);
    live.prepare(setTx(1, 'k', 'v'));
    await live.commit('tx-1');
    assert.equal(await live.store.get('k'), 'v');
    assert.equal(live.commitIndex, 1);

    const restored = new Participant(new MemoryStore(), wal);
    await restored.restore();
    assert.equal(await restored.store.get('k'), 'v');
    assert.equal(restored.commitIndex, 1);
  });

  it('fsyncs records so a new FileWal on the same path can restore', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'valio-wal-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'node-0.wal');

    const wal = new FileWal(path);
    const live = new Participant(new MemoryStore(), wal);
    live.prepare(setTx(1, 'a', '1'));
    await live.commit('tx-1');
    live.prepare({ id: 'tx-2', index: 2, event: { type: 'DEL', key: 'a' } });
    await live.commit('tx-2');

    const restored = new Participant(new MemoryStore(), new FileWal(path));
    await restored.restore();
    assert.equal(await restored.store.get('a'), undefined);
    assert.equal(restored.commitIndex, 2);
  });

  it('skips a truncated last line and still loads the prefix', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'valio-wal-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'node-0.wal');
    const wal = new FileWal(path);
    await wal.append(setTx(1, 'k', 'v'));
    await writeFile(path, `${JSON.stringify(setTx(1, 'k', 'v'))}\n{"index":2,`, 'utf8');

    const records = await new FileWal(path).load();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.index, 1);
  });
});
