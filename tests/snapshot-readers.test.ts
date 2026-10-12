import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { FileStore } from '../src/core/store.ts';

const directoryPrefix = resolve(join(tmpdir(), 'carradar-snapshot-readers-'));
async function temporary(t: TestContext) {
  const directory = await mkdtemp(directoryPrefix);
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(directoryPrefix));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('an empty published snapshot recovers with its old empty journal before the first anchor is published', async t => {
  const directory = await temporary(t);
  let store = await FileStore.open(directory);
  const expected = await FileStore.inspect(directory);
  await store.compact();
  await store.close();
  await writeFile(join(directory, 'journal.ndjson'), ''); // crash between the first empty snapshot and journal publication
  assert.deepEqual(await FileStore.inspect(directory), expected);
  store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.updateQuery('cars', { failureCount: 1 });
  await store.compact();
  assert.equal((await FileStore.inspect(directory)).sequence, 1);
});

test('empty or truncated journal cannot hide a missing nonempty snapshot sequence', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  await store.updateQuery('cars', { failureCount: 1 });
  await store.compact();
  await store.close();
  const journalPath = join(directory, 'journal.ndjson');
  const journal = await readFile(journalPath, 'utf8');
  for (const damaged of ['', journal.slice(0, -1)]) {
    await writeFile(journalPath, damaged);
    await assert.rejects(FileStore.inspect(directory), /не подтверждает последовательность снимка/);
    await assert.rejects(FileStore.open(directory), /не подтверждает последовательность снимка/);
    assert.equal(await readFile(journalPath, 'utf8'), damaged);
  }
});

test('readers racing repeated snapshots see a consistent committed prefix', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory, { compactAfterBatches: 2 });
  t.after(() => store.close());
  await store.updateQuery('counter', { failureCount: 1 });
  const writer = (async () => {
    for (let count = 2; count <= 35; count++) {
      await store.updateQuery('counter', { failureCount: count });
      if (count % 3 === 0) await store.compact();
    }
  })();
  const readers = Array.from({ length: 3 }, async () => {
    let previous = 0;
    for (let iteration = 0; iteration < 45; iteration++) {
      const state = await FileStore.inspect(directory);
      assert.equal(state.sequence, state.queries.counter!.failureCount);
      assert.ok(state.sequence >= previous && state.sequence <= 35);
      previous = state.sequence;
    }
  });
  await Promise.all([writer, ...readers]);
  assert.equal((await FileStore.inspect(directory)).sequence, 35);
});
