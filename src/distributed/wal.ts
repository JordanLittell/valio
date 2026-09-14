import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Event, Tx } from './types.ts';

export const DEFAULT_WAL_DIR = 'data';

export function walPath(nodeId: number, dir: string = DEFAULT_WAL_DIR): string {
  return join(dir, `node-${nodeId}.wal`);
}

/** Durable log of committed 2PC transactions. append() must not resolve until the record is on disk. */
export interface Wal {
  append(tx: Tx): Promise<void>;
  load(): Promise<Tx[]>;
}

/** For tests: same interface, process lifetime only. */
export class MemoryWal implements Wal {
  #records: Tx[] = [];

  async append(tx: Tx): Promise<void> {
    this.#records.push(cloneTx(tx));
  }

  async load(): Promise<Tx[]> {
    return this.#records.map(cloneTx);
  }
}

/**
 * One JSON object per line: {"index","id","event"}. Appends are fsynced before
 * they resolve. A truncated last line from a crash mid-write is skipped.
 */
export class FileWal implements Wal {
  readonly path: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async append(tx: Tx): Promise<void> {
    const write = this.#chain.then(() => this.#write(tx));
    this.#chain = write.catch(() => {});
    await write;
  }

  async load(): Promise<Tx[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();

    const records: Tx[] = [];
    for (const [i, line] of lines.entries()) {
      try {
        records.push(parseTx(JSON.parse(line)));
      } catch (err) {
        if (i === lines.length - 1) break;
        throw new Error(`corrupt wal at ${this.path}:${i + 1}: ${(err as Error).message}`);
      }
    }
    return records;
  }

  async #write(tx: Tx): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const line = `${JSON.stringify({ index: tx.index, id: tx.id, event: tx.event })}\n`;
    const handle = await open(this.path, 'a');
    try {
      await handle.write(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function cloneTx(tx: Tx): Tx {
  return structuredClone(tx);
}

function parseTx(raw: unknown): Tx {
  if (typeof raw !== 'object' || raw === null) throw new Error('record is not an object');
  const { id, index, event } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !Number.isInteger(index)) {
    throw new Error('id must be a string and index an integer');
  }
  if (typeof event !== 'object' || event === null) throw new Error('event is missing');
  const type = (event as Event).type;
  if (type !== 'SET' && type !== 'DEL' && type !== 'CLEAR') {
    throw new Error(`unknown event type ${String(type)}`);
  }
  return { id, index: index as number, event: event as Event };
}
