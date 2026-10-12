import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { appendFile, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Listing } from '../src/core/contracts.ts';
import { FileStore } from '../src/core/store.ts';

const storeModule = new URL('../src/core/store.ts', import.meta.url).href;
const directoryPrefix = resolve(join(tmpdir(), 'carradar-snapshot-'));

async function temporary(t: TestContext) {
  const directory = await mkdtemp(directoryPrefix);
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(directoryPrefix), 'cleanup remains in its task temp directory');
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function listing(priceMinor: number | null = 100, second = 0, externalId = 'one', source = 'fixture'): Listing {
  return {
    source, externalId, url: `https://fixture.invalid/${externalId}`, title: 'Honda S2000',
    priceMinor, currency: 'RUB', observedAt: new Date(Date.UTC(2026, 9, 11, 0, 0, second)).toISOString(),
    publishedAt: null, vehicle: { make: 'Honda', model: 'S2000', year: 2000, mileageKm: null }, provenance: {},
  };
}

async function seed(directory: string) {
  const store = await FileStore.open(directory);
  await store.commitPage('cars', 'baseline', null, [listing()], '2');
  await store.updateQuery('cars', { baselineComplete: true, lastSuccess: listing().observedAt });
  await store.commitPage('cars', 'price-change', null, [listing(200, 1)], '3');
  return store;
}

function checksummed(envelope: Record<string, unknown>) {
  const body = { version: envelope.version, sequence: envelope.sequence, payload: envelope.payload };
  return { ...body, checksum: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

async function assertUnreadable(directory: string) {
  await assert.rejects(FileStore.inspect(directory));
  let caught: unknown;
  try { await (await FileStore.open(directory)).close(); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error, 'a corrupt durable file rejects a writer as well as the reader');
}

test('snapshot preserves query coverage, cursors, replay keys, memberships, known prices and every event', async t => {
  const directory = await temporary(t);
  let store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('cars', 'baseline', null, [listing()], '2');
  await store.updateQuery('cars', {
    baselineComplete: true, lastAttempt: listing().observedAt, lastSuccess: listing().observedAt,
    lastExhaustedScan: listing().observedAt, nextRunAt: listing(100, 30).observedAt, failureCount: 2,
    queryKey: JSON.stringify(['fixture', 'https://fixture.invalid/cars']),
    coverage: { status: 'partial', gapPossible: true, windowIds: ['["fixture","one"]'], requiresFullScan: true },
  });
  await store.commitPage('cars', 'unknown', '2', [listing(null, 1), listing(400, 1, 'two')], '3');
  assert.deepEqual(await store.commitPage('__proto__', 'other-baseline', null, [listing(900, 2)], null), []);
  await store.commitPage('__proto__', 'prototype-identity', '2', [listing(700, 2, 'constructor', '__proto__')], '4');
  await store.updateQuery('__proto__', { baselineComplete: true, coverage: JSON.parse('{"__proto__":{"safe":true}}') });
  const expected = await FileStore.inspect(directory);
  assert.equal(expected.events.length, 1);
  const originalJournalSize = (await readFile(join(directory, 'journal.ndjson'))).length;
  await store.compact();
  assert.deepEqual(await FileStore.inspect(directory), expected);
  const snapshot = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'));
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.sequence, expected.sequence);
  assert.equal(snapshot.checksum, checksummed(snapshot).checksum);
  const journal = await readFile(join(directory, 'journal.ndjson'), 'utf8');
  const anchor = JSON.parse(journal.trim());
  assert.equal(anchor.sequence, expected.sequence);
  assert.equal(anchor.payload.type, 'anchor');
  assert.ok(Buffer.byteLength(journal) < originalJournalSize);
  await store.close();
  store = await FileStore.open(directory);
  assert.deepEqual(await FileStore.inspect(directory), expected);
  assert.deepEqual(await store.commitPage('cars', 'unknown', '2', [listing(500, 20)], '99'), []);
  assert.deepEqual(await FileStore.inspect(directory), expected, 'replayed page cannot change sequence or cursor after compaction');
  assert.deepEqual(await store.commitPage('cars', 'confirmed-again', null, [listing(100, 3)], null), [], 'A→null→A retains the last known price');
  const b = await store.commitPage('cars', 'b', null, [listing(200, 4)], null);
  const a = await store.commitPage('cars', 'a', null, [listing(100, 5)], null);
  assert.equal(b[0]!.previousPriceMinor, 100);
  assert.equal(a[0]!.previousPriceMinor, 200);
  const independent = await store.commitPage('__proto__', 'own-price', null, [listing(800, 6)], null);
  assert.equal(independent[0]!.previousPriceMinor, 900, 'each query restores its own membership and confirmed price');
  const after = await FileStore.inspect(directory);
  assert.deepEqual(after.events.slice(0, expected.events.length), expected.events);
  assert.equal(new Set(after.events.map(event => event.eventId)).size, after.events.length);
  assert.equal(after.queries['__proto__']!.coverage['__proto__'] && (after.queries['__proto__']!.coverage['__proto__'] as { safe: boolean }).safe, true);
});

test('repeated compaction retains sequence and later appends replay from the anchor', async t => {
  const directory = await temporary(t);
  let store = await seed(directory);
  t.after(() => store.close());
  const initial = await FileStore.inspect(directory);
  await store.compact();
  await store.compact();
  assert.deepEqual(await FileStore.inspect(directory), initial);
  await store.updateQuery('cars', { failureCount: 3 });
  const firstSuffix = (await readFile(join(directory, 'journal.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(firstSuffix.map(line => line.sequence), [initial.sequence, initial.sequence + 1]);
  await store.compact();
  await store.commitPage('cars', 'a-again', null, [listing(100, 2)], null);
  const expected = await FileStore.inspect(directory);
  await store.close();
  store = await FileStore.open(directory);
  assert.deepEqual(await FileStore.inspect(directory), expected);
  assert.equal(expected.events.at(-1)!.previousPriceMinor, 200);
  assert.equal(expected.queries.cars!.failureCount, 3);
});

test('old journal without snapshot migrates without changing state or acknowledging another batch', async t => {
  const directory = await temporary(t);
  let store = await seed(directory);
  const expected = await FileStore.inspect(directory);
  await store.close();
  await assert.rejects(readFile(join(directory, 'snapshot.json')), { code: 'ENOENT' });
  store = await FileStore.open(directory);
  await store.compact();
  await store.close();
  assert.deepEqual(await FileStore.inspect(directory), expected);
});

test('published snapshot can coexist with its original complete journal and later suffix', async t => {
  const directory = await temporary(t);
  const store = await seed(directory);
  const oldJournal = await readFile(join(directory, 'journal.ndjson'));
  await store.compact();
  await store.updateQuery('cars', { failureCount: 4 });
  const expected = await FileStore.inspect(directory);
  await store.close();
  const compacted = await readFile(join(directory, 'journal.ndjson'), 'utf8');
  const suffix = compacted.slice(compacted.indexOf('\n') + 1);
  await writeFile(join(directory, 'journal.ndjson'), Buffer.concat([oldJournal, Buffer.from(suffix)]));
  assert.deepEqual(await FileStore.inspect(directory), expected);
  const restored = await FileStore.open(directory);
  await restored.close();
  assert.deepEqual(await FileStore.inspect(directory), expected);
});

test('a newer snapshot can coexist with the preceding anchor and its fully covered suffix', async t => {
  const directory = await temporary(t);
  const store = await seed(directory);
  await store.compact();
  await store.updateQuery('cars', { failureCount: 4 });
  const previousJournal = await readFile(join(directory, 'journal.ndjson'));
  const expected = await FileStore.inspect(directory);
  await store.compact();
  await store.close();
  await writeFile(join(directory, 'journal.ndjson'), previousJournal);
  assert.deepEqual(await FileStore.inspect(directory), expected);
  const restored = await FileStore.open(directory);
  await restored.commitPage('cars', 'return-a', null, [listing(100, 2)], null);
  await restored.close();
  const after = await FileStore.inspect(directory);
  assert.equal(after.sequence, expected.sequence + 1);
  assert.equal(after.events.at(-1)!.previousPriceMinor, 200);
});

test('a corrupt covered journal prefix is still rejected when a valid snapshot exists', async t => {
  const directory = await temporary(t);
  const store = await seed(directory);
  const fullJournal = await readFile(join(directory, 'journal.ndjson'), 'utf8');
  await store.compact();
  await store.close();
  const snapshot = await readFile(join(directory, 'snapshot.json'));
  const damaged = fullJournal.replace('Honda S2000', 'corrupt covered record');
  await writeFile(join(directory, 'journal.ndjson'), damaged);
  await assertUnreadable(directory);
  assert.equal(await readFile(join(directory, 'journal.ndjson'), 'utf8'), damaged);
  assert.deepEqual(await readFile(join(directory, 'snapshot.json')), snapshot);
});

test('unfinished tail after snapshot anchor is ignored and durably removed before new appends', async t => {
  const directory = await temporary(t);
  let store = await seed(directory);
  await store.compact();
  await store.updateQuery('cars', { failureCount: 2 });
  const expected = await FileStore.inspect(directory);
  await store.close();
  const journalPath = join(directory, 'journal.ndjson');
  const committed = await readFile(journalPath);
  await appendFile(journalPath, '{"version":1,"unfinished":"незавершённый хвост');
  assert.deepEqual(await FileStore.inspect(directory), expected);
  store = await FileStore.open(directory);
  t.after(() => store.close());
  assert.deepEqual(await readFile(journalPath), committed);
  await store.updateQuery('cars', { failureCount: 3 });
  assert.equal((await FileStore.inspect(directory)).sequence, expected.sequence + 1);
});

test('malformed or checksummed corrupt snapshots reject access and preserve both original durable files', async t => {
  for (const corruption of ['truncated', 'checksum', 'invalid-query', 'invalid-known-price', 'invalid-event', 'duplicate-record', 'missing-membership', 'missing-page-keys', 'orphan-global-record'] as const) {
    await t.test(corruption, async sub => {
      const directory = await temporary(sub);
      const store = await seed(directory);
      await store.compact();
      await store.close();
      const snapshotPath = join(directory, 'snapshot.json');
      const original = await readFile(snapshotPath, 'utf8');
      const envelope = JSON.parse(original);
      let damaged: string;
      if (corruption === 'truncated') damaged = original.slice(0, -10);
      else if (corruption === 'checksum') damaged = original.replace('Honda S2000', 'damaged');
      else {
        if (corruption === 'invalid-query') envelope.payload.queries.cars.failureCount = -1;
        else if (corruption === 'invalid-known-price') envelope.payload.knownPrices[0][1][0][1] = -1;
        else if (corruption === 'invalid-event') envelope.payload.events[0].sequence = envelope.sequence + 1;
        else if (corruption === 'duplicate-record') envelope.payload.records.push(envelope.payload.records[0]);
        else if (corruption === 'missing-membership') {
          envelope.payload.searchRecords = [];
          envelope.payload.knownPrices = [];
        } else if (corruption === 'missing-page-keys') envelope.payload.pages = [];
        else envelope.payload.records.push(listing(300, 3, 'orphan'));
        damaged = JSON.stringify(checksummed(envelope));
      }
      const journalPath = join(directory, 'journal.ndjson');
      const journal = await readFile(journalPath);
      await writeFile(snapshotPath, damaged);
      await assertUnreadable(directory);
      assert.equal(await readFile(snapshotPath, 'utf8'), damaged);
      assert.deepEqual(await readFile(journalPath), journal);
      await writeFile(snapshotPath, original);
      await (await FileStore.open(directory)).close();
    });
  }
});

test('missing snapshot, corrupt checksum or mismatched anchor sequence never becomes an empty success', async t => {
  for (const corruption of ['missing-snapshot', 'checksum', 'sequence'] as const) {
    await t.test(corruption, async sub => {
      const directory = await temporary(sub);
      const store = await seed(directory);
      await store.compact();
      await store.close();
      const snapshotPath = join(directory, 'snapshot.json');
      const journalPath = join(directory, 'journal.ndjson');
      const snapshot = await readFile(snapshotPath);
      const original = await readFile(journalPath, 'utf8');
      let damaged = original;
      if (corruption === 'missing-snapshot') await rm(snapshotPath);
      else {
        const anchor = JSON.parse(original.trim());
        if (corruption === 'checksum') anchor.checksum = '0'.repeat(64);
        else anchor.sequence += 1;
        damaged = JSON.stringify(corruption === 'sequence' ? checksummed(anchor) : anchor) + '\n';
        await writeFile(journalPath, damaged);
      }
      await assertUnreadable(directory);
      assert.equal(await readFile(journalPath, 'utf8'), damaged);
      if (corruption !== 'missing-snapshot') assert.deepEqual(await readFile(snapshotPath), snapshot);
    });
  }
});

test('queued compaction drains previous writes and close drains compaction while rejecting new operations', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  const first = store.commitPage('cars', 'base', null, [listing()], '2');
  const second = store.updateQuery('cars', { baselineComplete: true });
  const compaction = store.compact();
  const third = store.commitPage('cars', 'after-snapshot', '2', [listing(200, 1)], null);
  const closing = store.close();
  await assert.rejects(store.compact(), /закрывается|закрыто/);
  await assert.rejects(store.updateQuery('cars', { failureCount: 99 }), /закрывается|закрыто/);
  await Promise.all([first, second, compaction, third, closing]);
  const snapshot = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'));
  assert.equal(snapshot.sequence, 2, 'compaction snapshots exactly the committed queue prefix');
  const next = await FileStore.open(directory);
  t.after(() => next.close());
  const state = await FileStore.inspect(directory);
  assert.equal(state.sequence, 3);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0]!.previousPriceMinor, 100);
});

test('automatic batch and byte thresholds compact without losing the triggering commit', async t => {
  for (const options of [{ compactAfterBatches: 2 }, { compactAfterBytes: 1 }]) {
    await t.test(JSON.stringify(options), async sub => {
      const directory = await temporary(sub);
      const store = await FileStore.open(directory, options);
      await store.commitPage('cars', 'base', null, [listing()], null);
      await store.updateQuery('cars', { baselineComplete: true });
      const event = await store.commitPage('cars', 'price', null, [listing(200, 1)], null);
      const state = await FileStore.inspect(directory);
      assert.equal(state.sequence, 3);
      assert.equal(state.events.length, 1);
      assert.deepEqual(state.events, event);
      const snapshot = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'));
      assert.ok(snapshot.sequence >= 2 && snapshot.sequence <= state.sequence);
      await store.close();
      await (await FileStore.open(directory)).close();
      assert.deepEqual(await FileStore.inspect(directory), state);
    });
  }
});

test('snapshot temp write or fsync failure leaves the original journal and confirmed state recoverable', async t => {
  for (const method of ['writeFile', 'sync'] as const) {
    await t.test(method, async sub => {
      const directory = await temporary(sub);
      const store = await seed(directory);
      const expected = await FileStore.inspect(directory);
      const journalPath = join(directory, 'journal.ndjson');
      const original = await readFile(journalPath);
      const probe = await open(join(directory, 'probe'), 'w');
      const prototype = Object.getPrototypeOf(probe);
      await probe.close();
      const mocked = sub.mock.method(prototype, method, async () => { throw Object.assign(new Error(`snapshot ${method} failure`), { code: 'EIO' }); });
      await assert.rejects(store.compact());
      mocked.mock.restore();
      assert.deepEqual(await readFile(journalPath), original);
      await assert.rejects(readFile(join(directory, 'snapshot.json')), { code: 'ENOENT' });
      assert.deepEqual(await FileStore.inspect(directory), expected);
      await store.close();
      await (await FileStore.open(directory)).close();
      assert.deepEqual(await FileStore.inspect(directory), expected);
    });
  }
});

test('automatic compaction failure after a durable page restores that page and its event exactly once', async t => {
  const directory = await temporary(t);
  let store = await FileStore.open(directory, { compactAfterBatches: 3 });
  t.after(() => store.close());
  await store.commitPage('cars', 'base', null, [listing()], null);
  await store.updateQuery('cars', { baselineComplete: true });
  const originalOpen = fs.promises.open;
  const mocked = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    if (String(args[0]).includes('.snapshot-') && args[1] === 'wx') throw Object.assign(new Error('snapshot temp unavailable'), { code: 'EIO' });
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.commitPage('cars', 'price', null, [listing(200, 1)], '2'), /сжать|остановлена/);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  const durable = await FileStore.inspect(directory);
  assert.equal(durable.sequence, 3);
  assert.equal(durable.events.length, 1);
  assert.equal(durable.events[0]!.previousPriceMinor, 100);
  assert.equal(durable.queries.cars!.resumeCursor, '2');
  await assert.rejects(store.updateQuery('cars', { failureCount: 99 }), /необходим перезапуск/);
  await store.close();
  store = await FileStore.open(directory);
  assert.deepEqual(await store.commitPage('cars', 'price', null, [listing(200, 1)], '2'), []);
  assert.deepEqual(await FileStore.inspect(directory), durable);
  await store.compact();
  assert.deepEqual(await FileStore.inspect(directory), durable);
});

test('snapshot publication, journal publication and journal reopen failures all preserve confirmed data', async t => {
  for (const stage of ['snapshot-rename', 'journal-rename', 'journal-reopen'] as const) {
    await t.test(stage, async sub => {
      const directory = await temporary(sub);
      const store = await seed(directory);
      const expected = await FileStore.inspect(directory);
      const journalPath = join(directory, 'journal.ndjson');
      const snapshotPath = join(directory, 'snapshot.json');
      const oldJournal = await readFile(journalPath);
      const originalRename = fs.promises.rename;
      const originalOpen = fs.promises.open;
      let reached = false;
      const mockedRename = sub.mock.method(fs.promises, 'rename', async (...args: Parameters<typeof originalRename>) => {
        if (stage === 'snapshot-rename' && String(args[1]) === snapshotPath
          || stage === 'journal-rename' && String(args[1]) === journalPath) {
          reached = true;
          throw Object.assign(new Error(`forced ${stage}`), { code: 'EIO' });
        }
        return originalRename(...args);
      });
      const mockedOpen = sub.mock.method(fs.promises, 'open', async (...args: Parameters<typeof originalOpen>) => {
        if (stage === 'journal-reopen' && String(args[0]) === journalPath && args[1] === 'a+') {
          reached = true;
          throw Object.assign(new Error(`forced ${stage}`), { code: 'EIO' });
        }
        return originalOpen(...args);
      });
      syncBuiltinESMExports();
      try { await assert.rejects(store.compact(), /сжать|остановлена/); }
      finally { mockedRename.mock.restore(); mockedOpen.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(reached, true, 'the requested publication failure stage was reached');
      assert.deepEqual(await FileStore.inspect(directory), expected);
      if (stage !== 'journal-reopen') assert.deepEqual(await readFile(journalPath), oldJournal);
      await store.close();
      const next = await FileStore.open(directory);
      await next.updateQuery('cars', { failureCount: 7 });
      await next.compact();
      await next.close();
      const recovered = await FileStore.inspect(directory);
      assert.equal(recovered.sequence, expected.sequence + 1);
      assert.deepEqual(recovered.events, expected.events);
      assert.equal(recovered.queries.cars!.failureCount, 7);
    });
  }
});

test('reader retries a deterministic old-snapshot/new-anchor race and returns a coherent state', async t => {
  const directory = await temporary(t);
  const store = await seed(directory);
  t.after(() => store.close());
  await store.compact();
  await store.updateQuery('cars', { failureCount: 8 });
  const expected = await FileStore.inspect(directory);
  const snapshotPath = join(directory, 'snapshot.json');
  const originalRead = fs.promises.readFile;
  let snapshotReads = 0;
  const mocked = t.mock.method(fs.promises, 'readFile', async (...args: Parameters<typeof originalRead>) => {
    const content = await originalRead(...args);
    if (String(args[0]) === snapshotPath && ++snapshotReads === 1) await store.compact();
    return content;
  });
  syncBuiltinESMExports();
  try { assert.deepEqual(await FileStore.inspect(directory), expected); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(snapshotReads >= 2, 'reader reloads snapshot after encountering the newer anchor');
});

async function crashCompaction(directory: string, stage: 'snapshot' | 'anchor' | 'published') {
  const script = `
    import fs from 'node:fs';
    import { open } from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const probe = await open(join(${JSON.stringify(directory)}, 'probe'), 'w');
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const originalWrite = prototype.writeFile;
    const originalSync = prototype.sync;
    const targets = new WeakSet();
    prototype.writeFile = async function (data, ...args) {
      if (typeof data === 'string') {
        try {
          const value = JSON.parse(data.trim());
          if (${JSON.stringify(stage)} === 'anchor' ? value.payload?.type === 'anchor' : ${JSON.stringify(stage)} === 'snapshot' && value.payload?.queries !== undefined) targets.add(this);
        } catch {}
      }
      return originalWrite.call(this, data, ...args);
    };
    prototype.sync = async function (...args) {
      await originalSync.call(this, ...args);
      if (targets.has(this)) process.exit(73);
    };
    const originalRename = fs.promises.rename;
    fs.promises.rename = async function (...args) {
      await originalRename(...args);
      if (${JSON.stringify(stage)} === 'published' && String(args[1]) === join(${JSON.stringify(directory)}, 'journal.ndjson')) process.exit(73);
    };
    syncBuiltinESMExports();
    const { FileStore } = await import(${JSON.stringify(storeModule)});
    const store = await FileStore.open(${JSON.stringify(directory)});
    await store.compact();
    await store.close();
    process.exit(74);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise<void>((resolveCrash, reject) => {
    let diagnostic = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Compaction crash child timed out: ${diagnostic}`)); }, 10_000);
    child.stderr!.on('data', chunk => { diagnostic += chunk.toString(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code === 73) resolveCrash();
      else reject(new Error(`Crash stage was not reached: exit=${code}: ${diagnostic}`));
    });
  });
}

test('forced exit after snapshot or anchor temp fsync or journal publication recovers the previously confirmed state', async t => {
  for (const stage of ['snapshot', 'anchor', 'published'] as const) {
    for (const existingSnapshot of [false, true]) {
      await t.test(`${stage}; existing snapshot=${existingSnapshot}`, async sub => {
      const directory = await temporary(sub);
      const store = await seed(directory);
      if (existingSnapshot) {
        await store.compact();
        await store.updateQuery('cars', { failureCount: 2 });
      }
      const expected = await FileStore.inspect(directory);
      const originalJournal = await readFile(join(directory, 'journal.ndjson'));
      await store.close();
      await crashCompaction(directory, stage);
      assert.deepEqual(await FileStore.inspect(directory), expected);
      if (stage !== 'published') assert.deepEqual(await readFile(join(directory, 'journal.ndjson')), originalJournal, 'journal publication has not been reached');
      const next = await FileStore.open(directory);
      await next.updateQuery('cars', { failureCount: 5 });
      await next.compact();
      await next.close();
      const recovered = await FileStore.inspect(directory);
      assert.equal(recovered.sequence, expected.sequence + 1);
      assert.equal(recovered.queries.cars!.failureCount, 5);
      assert.deepEqual(recovered.events, expected.events);
      });
    }
  }
});
