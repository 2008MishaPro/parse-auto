import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Listing } from '../src/core/contracts.ts';
import { FileStore } from '../src/core/store.ts';

const storeModule = new URL('../src/core/store.ts', import.meta.url).href;
const directoryPrefix = resolve(join(tmpdir(), 'carradar-store-'));

async function temporary(t: TestContext) {
  const directory = await mkdtemp(directoryPrefix);
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(directoryPrefix), 'cleanup remains in its task temp directory');
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function listing(priceMinor: number | null = 100, second = 0, externalId = 'one'): Listing {
  return {
    source: 'fixture', externalId, url: `https://fixture.invalid/${externalId}`, title: 'Honda S2000',
    priceMinor, currency: 'RUB', observedAt: new Date(Date.UTC(2026, 9, 11, 0, 0, second)).toISOString(),
    publishedAt: null, vehicle: { make: 'Honda', model: 'S2000', year: 2000, mileageKm: null }, provenance: {},
  };
}

function contender(directory: string): { process: ChildProcess; ready: Promise<string> } {
  const script = `
    const { FileStore } = await import(${JSON.stringify(storeModule)});
    try {
      await FileStore.open(${JSON.stringify(directory)});
      process.stdout.write('ACQUIRED\\n');
      setInterval(() => {}, 1000);
    } catch (error) {
      process.stdout.write('BLOCKED\\n');
      process.stderr.write(error.message);
      process.exitCode = 0;
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise<string>((resolveReady, reject) => {
    let output = '';
    let diagnostic = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Lock child timeout: ${diagnostic}`)); }, 10_000);
    child.stderr!.on('data', chunk => { diagnostic += chunk.toString(); });
    child.stdout!.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('\n')) { clearTimeout(timeout); resolveReady(output.trim()); }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { if (!output.includes('\n')) { clearTimeout(timeout); reject(new Error(`Lock child exited: ${diagnostic}`)); } });
  });
  return { process: child, ready };
}

async function crash(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

test('page, query, cursor and event are replayed across restart; committed page replay is idempotent', async t => {
  const directory = await temporary(t);
  let store = await FileStore.open(directory);
  t.after(() => store.close());
  assert.deepEqual(await store.commitPage('cars', 'baseline', null, [listing()], '2'), []);
  assert.equal(store.getQuery('cars').resumeCursor, '2');
  assert.equal(store.getQuery('cars').activeRunId, 'baseline');
  await store.updateQuery('cars', { baselineComplete: true, lastExhaustedScan: listing().observedAt });
  const events = await store.commitPage('cars', 'next', null, [listing(200, 1), listing(500, 1, 'two')], null);
  assert.deepEqual(events.map(event => event.type), ['price_changed', 'discovered']);
  const live = await FileStore.inspect(directory); // reader works while writer owns the directory
  assert.equal(live.records.length, 2);
  assert.equal(live.events.length, 2);
  await store.close();
  store = await FileStore.open(directory);
  assert.equal(store.getQuery('cars').baselineComplete, true);
  assert.equal(store.getQuery('cars').resumeCursor, null);
  assert.deepEqual(await store.commitPage('cars', 'next', null, [listing(200, 1), listing(500, 1, 'two')], null), []);
  assert.deepEqual(await FileStore.inspect(directory), live);
  const returned = store.getQuery('cars');
  returned.coverage.reason = 'caller mutation';
  assert.deepEqual(store.getQuery('cars').coverage, {});
});

test('A→B→A compares latest confirmed price; stale/equal observations and duplicate IDs cannot revert it', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('cars', 'base', null, [listing(100)], null);
  await store.updateQuery('cars', { baselineComplete: true });
  assert.equal((await store.commitPage('cars', 'b', null, [listing(200, 1)], null))[0]!.previousPriceMinor, 100);
  assert.equal((await store.commitPage('cars', 'a', null, [listing(100, 2)], null))[0]!.previousPriceMinor, 200);
  assert.deepEqual(await store.commitPage('cars', 'stale', null, [listing(200, 1)], null), []);
  assert.deepEqual(await store.commitPage('cars', 'equal', null, [listing(300, 2)], null), []);
  const duplicate = await store.commitPage('cars', 'duplicates', null, [listing(200, 3), listing(300, 4), listing(200, 3)], null);
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0]!.priceMinor, 300);
  const state = await FileStore.inspect(directory);
  assert.equal(state.records[0]!.priceMinor, 300);
  assert.equal(state.events.length, 3);
  assert.equal(new Set(state.events.map(event => event.eventId)).size, 3);
});

test('unknown price remains null and does not create A→null→A price events, including restart', async t => {
  const directory = await temporary(t);
  let store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('cars', 'base', null, [listing()], null);
  await store.updateQuery('cars', { baselineComplete: true });
  assert.deepEqual(await store.commitPage('cars', 'unknown', null, [listing(null, 1)], null), []);
  assert.equal((await FileStore.inspect(directory)).records[0]!.priceMinor, null);
  await store.close();
  store = await FileStore.open(directory);
  assert.deepEqual(await store.commitPage('cars', 'again-a', null, [listing(100, 2)], null), []);
  await store.commitPage('cars', 'unknown-again', null, [listing(null, 3)], null);
  const events = await store.commitPage('cars', 'b', null, [listing(200, 4)], null);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.previousPriceMinor, 100);
});

test('baseline belongs to each search; identity is source plus externalId', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('first', 'base-first', null, [listing()], null);
  await store.updateQuery('first', { baselineComplete: true });
  assert.deepEqual(await store.commitPage('__proto__', 'base-second', null, [listing(200, 1)], null), []);
  assert.equal(store.getQuery('__proto__').baselineComplete, false);
  await store.updateQuery('__proto__', { baselineComplete: true });
  const firstEvents = await store.commitPage('first', 'fresh-first', null, [listing(200, 2)], null);
  assert.equal(firstEvents[0]!.type, 'price_changed');
  const changedDetails = { ...listing(200, 3), title: 'Honda S2000 updated' };
  const secondEvents = await store.commitPage('__proto__', 'fresh-second', null, [changedDetails, { ...listing(100, 3), source: 'other' }], null);
  assert.deepEqual(secondEvents.map(event => event.type), ['details_changed', 'discovered']);
  const state = await FileStore.inspect(directory);
  assert.equal(state.records.length, 2);
  assert.equal(state.queries['__proto__']!.baselineComplete, true);
});

test('unfinished tail is ignored by reader and durably truncated by next writer', async t => {
  const directory = await temporary(t);
  const first = await FileStore.open(directory);
  await first.commitPage('cars', 'base', null, [listing()], '2');
  await first.close();
  const path = join(directory, 'journal.ndjson');
  const committed = await readFile(path);
  await appendFile(path, '{"version":1,"payload":"незавершённый хвост');
  assert.equal((await FileStore.inspect(directory)).sequence, 1);
  const recovered = await FileStore.open(directory);
  t.after(() => recovered.close());
  assert.deepEqual(await readFile(path), committed);
  assert.equal(recovered.getQuery('cars').resumeCursor, '2');
  await recovered.commitPage('cars', 'base', '2', [listing(200, 1, 'two')], null);
  assert.equal((await FileStore.inspect(directory)).records.length, 2);
});

test('corrupt committed line stops writer and reader without silently dropping data', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  await store.commitPage('cars', 'base', null, [listing()], null);
  await store.close();
  const path = join(directory, 'journal.ndjson');
  const original = await readFile(path, 'utf8');
  const damaged = original.replace('Honda S2000', 'broken title');
  await writeFile(path, damaged);
  await assert.rejects(FileStore.inspect(directory), /Повреждён committed журнал/);
  await assert.rejects(FileStore.open(directory), /Повреждён committed журнал/);
  assert.equal(await readFile(path, 'utf8'), damaged);
  await writeFile(path, original);
  const restored = await FileStore.open(directory);
  await restored.close();
});

test('second writer is rejected in the same process and another process; reader remains available', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  await assert.rejects(FileStore.open(directory), /уже занят процессом/);
  const child = contender(directory);
  t.after(() => crash(child.process));
  assert.equal(await child.ready, 'BLOCKED');
  await store.updateQuery('cars', { coverage: { mode: 'baseline' } });
  assert.equal((await FileStore.inspect(directory)).queries.cars!.coverage.mode, 'baseline');
});

test('crashed child writer lock is recovered; two concurrent recovery processes elect one writer', async t => {
  const directory = await temporary(t);
  const old = contender(directory);
  t.after(() => crash(old.process));
  assert.equal(await old.ready, 'ACQUIRED');
  await crash(old.process); // forced termination leaves owner on disk
  const a = contender(directory);
  const b = contender(directory);
  t.after(async () => { await crash(a.process); await crash(b.process); });
  const results = await Promise.all([a.ready, b.ready]);
  assert.deepEqual([...results].sort(), ['ACQUIRED', 'BLOCKED']);
  await assert.rejects(FileStore.open(directory), /уже занят процессом/);
  await crash(a.process);
  await crash(b.process);
  const recovered = await FileStore.open(directory);
  await recovered.updateQuery('cars', { failureCount: 1 });
  await recovered.close();
  assert.equal((await FileStore.inspect(directory)).queries.cars!.failureCount, 1);
});

test('disk append failure poisons writer and leaves in-memory query unchanged', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.updateQuery('cars', { failureCount: 1 });
  const probe = await open(join(directory, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const mocked = t.mock.method(prototype, 'writeFile', async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  await assert.rejects(store.updateQuery('cars', { failureCount: 2 }), /дальнейшая запись остановлена/);
  mocked.mock.restore();
  assert.equal(store.getQuery('cars').failureCount, 1);
  await assert.rejects(store.updateQuery('cars', { failureCount: 3 }), /необходим перезапуск/);
  assert.equal((await FileStore.inspect(directory)).queries.cars!.failureCount, 1);
});

test('fsync failure never acknowledges events or advances the current writer state', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('cars', 'base', null, [listing()], null);
  await store.updateQuery('cars', { baselineComplete: true });
  const probe = await open(join(directory, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const mocked = t.mock.method(prototype, 'sync', async () => { throw Object.assign(new Error('sync failure'), { code: 'EIO' }); });
  await assert.rejects(store.commitPage('cars', 'failed', null, [listing(200, 1)], '2'), /дальнейшая запись остановлена/);
  mocked.mock.restore();
  assert.equal(store.getQuery('cars').resumeCursor, null);
  assert.equal(store.getQuery('cars').activeRunId, 'base');
  await assert.rejects(store.updateQuery('cars', { lastSuccess: listing(200, 1).observedAt }), /необходим перезапуск/);
});

test('close drains already queued commits, rejects new writes and releases the exact owner', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  const first = store.commitPage('cars', 'one', null, [listing()], '2');
  const second = store.updateQuery('cars', { baselineComplete: true });
  const closing = store.close();
  await assert.rejects(store.updateQuery('cars', { failureCount: 99 }), /закрывается/);
  await Promise.all([first, second, closing, store.close()]);
  const next = await FileStore.open(directory);
  t.after(() => next.close());
  assert.equal(next.getQuery('cars').baselineComplete, true);
  assert.equal(next.getQuery('cars').resumeCursor, '2');
});

test('query source/url binding persists across read and restart; older batches default to null', async t => {
  const directory = await temporary(t);
  let store = await FileStore.open(directory);
  t.after(() => store.close());
  // A page from an older writer contains no queryKey in its batch.
  await store.commitPage('cars', 'old-format', null, [listing()], '2');
  await store.close();
  store = await FileStore.open(directory);
  assert.equal(store.getQuery('cars').queryKey, null);
  const queryKey = JSON.stringify(['fixture', 'https://fixture.invalid/cars?model=S2000']);
  await store.updateQuery('cars', { queryKey });
  assert.equal((await FileStore.inspect(directory)).queries.cars!.queryKey, queryKey);
  await store.close();
  store = await FileStore.open(directory);
  assert.equal(store.getQuery('cars').queryKey, queryKey);
  assert.equal(store.getQuery('cars').resumeCursor, '2');
});
