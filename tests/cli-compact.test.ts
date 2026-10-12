import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Listing } from '../src/core/contracts.ts';
import { FileStore } from '../src/core/store.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const directoryPrefix = resolve(join(tmpdir(), 'carradar-cli-compact-'));

async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(directoryPrefix);
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(directoryPrefix), 'cleanup remains in its task temp directory');
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function run(directory: string, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`CLI timeout: ${stderr}`)); }, 10_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolveRun({ code, stdout, stderr }); });
  });
}

function listing(priceMinor: number, second: number): Listing {
  return {
    source: 'fixture', externalId: 'one', url: 'https://fixture.invalid/one', title: 'Honda S2000',
    priceMinor, currency: 'RUB', observedAt: new Date(Date.UTC(2026, 9, 11, 0, 0, second)).toISOString(),
    publishedAt: null, vehicle: { make: 'Honda', model: 'S2000', year: 2000, mileageKm: null }, provenance: {},
  };
}

async function legacyJournal(directory: string): Promise<void> {
  const payloads = [
    { type: 'page', searchId: 'cars', runId: 'base', cursor: null, nextCursor: '2', records: [listing(100, 0)], events: [] },
    { type: 'query', searchId: 'cars', patch: { baselineComplete: true, coverage: { status: 'complete' }, queryKey: '["fixture","https://fixture.invalid/cars"]' } },
    {
      type: 'page', searchId: 'cars', runId: 'next', cursor: null, nextCursor: null, records: [listing(200, 1)],
      events: [{ eventId: 'legacy-price-event', sequence: 3, type: 'price_changed', searchId: 'cars', source: 'fixture', externalId: 'one', observedAt: listing(200, 1).observedAt, previousPriceMinor: 100, priceMinor: 200 }],
    },
  ];
  const lines = payloads.map((payload, index) => {
    const data = { version: 1, sequence: index + 1, payload };
    return JSON.stringify({ ...data, checksum: createHash('sha256').update(JSON.stringify(data)).digest('hex') });
  });
  await writeFile(join(directory, 'journal.ndjson'), `${lines.join('\n')}\n`);
}

test('compact accepts legacy journal without config and preserves status, listings and event export', async t => {
  const directory = await temporary(t);
  await legacyJournal(directory);
  const originalJournalBytes = (await readFile(join(directory, 'journal.ndjson'))).length;
  const before = await FileStore.inspect(directory);
  const beforeStatus = await run(directory, 'status', '--data-dir', '.');
  const beforeListings = await run(directory, 'export', '--data-dir', '.', '--format', 'json');
  const beforeEvents = await run(directory, 'export', '--data-dir', '.', '--events');
  for (const result of [beforeStatus, beforeListings, beforeEvents]) assert.equal(result.code, 0, result.stderr);

  const result = await run(directory, 'compact', '--data-dir', '.');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { compacted: true, sequence: 3, records: 1, events: 1 });
  assert.ok((await readFile(join(directory, 'snapshot.json'))).length > 0);
  assert.ok((await readFile(join(directory, 'journal.ndjson'))).length < originalJournalBytes);
  assert.deepEqual(await FileStore.inspect(directory), before);

  const afterStatus = await run(directory, 'status', '--data-dir', '.');
  const afterListings = await run(directory, 'export', '--data-dir', '.', '--format', 'json');
  const afterEvents = await run(directory, 'export', '--data-dir', '.', '--events');
  for (const result of [afterStatus, afterListings, afterEvents]) assert.equal(result.code, 0, result.stderr);
  assert.equal(afterStatus.stdout, beforeStatus.stdout);
  assert.equal(afterListings.stdout, beforeListings.stdout);
  assert.equal(afterEvents.stdout, beforeEvents.stdout);

  // CLI released its writer lock and the saved page key survives compaction.
  const reopened = await FileStore.open(directory);
  try {
    assert.deepEqual(await reopened.commitPage('cars', 'next', null, [listing(200, 1)], null), []);
    assert.deepEqual(await FileStore.inspect(directory), before);
  } finally { await reopened.close(); }
});

test('compact rejects an active writer with exit 1 while status remains readable', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  try {
    await store.updateQuery('cars', { failureCount: 1 });
    const result = await run(directory, 'compact', '--data-dir', '.');
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(JSON.parse(result.stderr).message, /уже занят процессом/);
    const status = await run(directory, 'status', '--data-dir', '.');
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).queries.cars.failureCount, 1);
    assert.equal((await FileStore.inspect(directory)).sequence, 1);
  } finally { await store.close(); }
});

test('compact creates an empty snapshot in a new data directory without loading configuration', async t => {
  const directory = await temporary(t);
  const result = await run(directory, 'compact', '--data-dir', './new-data');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { compacted: true, sequence: 0, records: 0, events: 0 });
  assert.ok((await readFile(join(directory, 'new-data', 'snapshot.json'))).length > 0);
  assert.equal((await FileStore.inspect(join(directory, 'new-data'))).sequence, 0);
});

test('help includes compact and extra commands are rejected before opening data', async t => {
  const directory = await temporary(t);
  const help = await run(directory, '--help');
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /monitor compact --data-dir/);
  const invalid = await run(directory, 'compact', 'start');
  assert.equal(invalid.code, 1);
  assert.match(JSON.parse(invalid.stderr).message, /одна команда.*compact/);
  const missing = await run(directory, 'compact', '--data-dir');
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, '');
});
