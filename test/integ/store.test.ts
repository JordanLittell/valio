import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryStore } from '../../src/store.ts';

describe('MemoryStore', () => {
  it('returns undefined for missing keys', async () => {
    const store = new MemoryStore();
    assert.equal(await store.get('nope'), undefined);
  });

  it('sets, gets, and overwrites values', async () => {
    const store = new MemoryStore();
    await store.set('a', 1);
    assert.equal(await store.get('a'), 1);
    await store.set('a', 'two');
    assert.equal(await store.get('a'), 'two');
  });

  it('stores null as a real value', async () => {
    const store = new MemoryStore();
    await store.set('n', null);
    assert.equal(await store.get('n'), null);
  });

  it('deletes keys and reports whether they existed', async () => {
    const store = new MemoryStore();
    await store.set('a', 1);
    assert.equal(await store.del('a'), true);
    assert.equal(await store.del('a'), false);
    assert.equal(await store.get('a'), undefined);
  });

  it('lists all entries', async () => {
    const store = new MemoryStore();
    await store.set('a', 1);
    await store.set('b', { nested: [true] });
    assert.deepEqual(await store.list(), { a: 1, b: { nested: [true] } });
  });

  it('isolates stored values from caller mutation', async () => {
    const store = new MemoryStore();
    const obj = { x: 1 };
    await store.set('o', obj);
    obj.x = 2;
    const read = (await store.get('o')) as { x: number };
    assert.equal(read.x, 1);
    read.x = 3;
    assert.deepEqual(await store.get('o'), { x: 1 });
  });
});
