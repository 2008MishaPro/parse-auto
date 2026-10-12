import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Listing } from '../src/core/contracts.ts';
import { FileStore } from '../src/core/store.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const directoryPrefix = resolve(join(tmpdir(), 'carradar-search-export-'));
const timestamp = (second: number) => new Date(Date.UTC(2026, 9, 11, 0, 0, second)).toISOString();

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

function listing(externalId: string, priceMinor: number, second: number): Listing {
  return { source: 'fixture', externalId, url: `https://fixture.invalid/${externalId}`, title: externalId,
    priceMinor, currency: 'RUB', observedAt: timestamp(second), publishedAt: null,
    vehicle: { make: null, model: null, year: null, mileageKm: null }, provenance: {} };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(directoryPrefix);
  const dataDir = join(directory, 'data', 'state');
  const store = await FileStore.open(dataDir);
  t.after(async () => {
    await store.close();
    assert.ok(resolve(directory).startsWith(directoryPrefix), 'cleanup remains in its task temp directory');
    await rm(directory, { recursive: true, force: true });
  });
  const search = (id: string, query: string) => ({ id, source: 'fixture', url: `https://fixture.invalid/cars?query=${query}`, enabled: true });
  await store.bindSearches([search('original-alpha', 'alpha'), search('beta', 'beta'), search('empty', 'empty')]);
  await store.bindSearches([search('current-alpha', 'alpha'), search('beta', 'beta'), search('empty', 'empty')]);
  await store.commitPage('original-alpha', 'alpha-baseline', null,
    [listing('shared', 100, 0), listing('alpha-only', 100, 0)], null);
  await store.commitPage('beta', 'beta-baseline', null,
    [listing('shared', 200, 10), listing('beta-only', 300, 10)], null);
  await store.updateQuery('original-alpha', { baselineComplete: true });
  await store.updateQuery('beta', { baselineComplete: true });
  await store.commitPage('current-alpha', 'alpha-poll', null, [listing('alpha-only', 120, 20)], null);
  await store.commitPage('beta', 'beta-poll', null, [listing('beta-only', 400, 25)], null);
  await store.updateQuery('current-alpha', {}, [{ runId: 'alpha-gap', since: timestamp(20), until: timestamp(30), reason: 'pagination_shift' }]);
  await store.updateQuery('beta', {}, [{ runId: 'beta-gap', since: timestamp(25), until: timestamp(30), reason: 'timeout' }]);
  return { directory, dataDir, store };
}

test('search export uses persisted membership and its observation even when another search observed the same ID later', async t => {
  const { directory, dataDir } = await fixture(t);
  const before = await readFile(join(dataDir, 'journal.ndjson'));
  const selected = await FileStore.inspect(dataDir, 'current-alpha');
  assert.deepEqual(selected.records, [listing('shared', 100, 0), listing('alpha-only', 120, 20)]);
  assert.deepEqual(await FileStore.inspect(dataDir, 'original-alpha'), selected);
  const exported = await run(directory, 'export', '--search-id', 'current-alpha', '--format', 'json');
  assert.equal(exported.code, 0, exported.stderr);
  assert.deepEqual(JSON.parse(exported.stdout), selected.records);
  const full = await run(directory, 'export', '--format', 'json');
  assert.equal(full.code, 0, full.stderr);
  assert.deepEqual(JSON.parse(full.stdout), (await FileStore.inspect(dataDir)).records);
  assert.equal(JSON.parse(full.stdout).length, 3);
  assert.equal(JSON.parse(full.stdout).find((row: Listing) => row.externalId === 'shared').priceMinor, 200);
  assert.deepEqual(await readFile(join(dataDir, 'journal.ndjson')), before, 'readers do not change committed state while writer owns it');
});

test('search events and gaps resolve aliases and remain identical after compaction and restart', async t => {
  const { directory, dataDir, store } = await fixture(t);
  const expected = await FileStore.inspect(dataDir, 'current-alpha');
  assert.equal(expected.events.length, 1);
  assert.equal(expected.events[0]!.searchId, 'original-alpha');
  assert.equal(expected.gaps.length, 1);
  assert.equal(expected.gaps[0]!.searchId, 'original-alpha');
  for (const [flag, rows] of [['--events', expected.events], ['--gaps', expected.gaps]] as const) {
    const result = await run(directory, 'export', '--search-id', 'current-alpha', flag);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n').map(line => JSON.parse(line)), rows);
  }
  await store.compact();
  await store.close();
  assert.deepEqual(await FileStore.inspect(dataDir, 'current-alpha'), expected);
  const result = await run(directory, 'export', '--search-id', 'original-alpha', '--events', '--format', 'json');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected.events);
});

test('unknown or empty search IDs fail explicitly while a registered search with no observations exports an empty array', async t => {
  const { directory, dataDir } = await fixture(t);
  for (const id of ['', ' ', null, 0] as unknown[]) {
    await assert.rejects(FileStore.inspect(dataDir, id as string), /непустой ID поиска/);
  }
  for (const id of ['missing', '__proto__', 'constructor']) {
    await assert.rejects(FileStore.inspect(dataDir, id), /Неизвестный поиск/);
  }
  for (const id of ['', 'missing']) {
    const result = await run(directory, 'export', '--search-id', id, '--format', 'json');
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /непустой ID поиска|Неизвестный поиск/);
  }
  const empty = await run(directory, 'export', '--search-id', 'empty', '--format', 'json');
  assert.equal(empty.code, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), []);
});

test('search selection cannot silently alter a different CLI command', async t => {
  const { directory } = await fixture(t);
  const result = await run(directory, 'compact', '--search-id', 'current-alpha');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--search-id поддерживается только командой export/);
});
