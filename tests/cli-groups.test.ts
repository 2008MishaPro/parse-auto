import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Listing, Search, SourceAdapter } from '../src/core/contracts.ts';
import { MonitorService } from '../src/core/monitor.ts';
import { AdapterRegistry } from '../src/core/registry.ts';
import { FileStore } from '../src/core/store.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const directoryPrefix = resolve(join(tmpdir(), 'carradar-cli-groups-'));
const url = 'https://fixture.invalid/cars?model=S2000';

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

function search(id: string, enabled = true): Search {
  return { id, enabled, source: 'fixture', url, intervalSeconds: 120, overlapPages: 1,
    sweepIntervalSeconds: 1800, maxPagesPerSweep: 2, requestTimeoutSeconds: 10, maxCycleSeconds: 90 };
}

async function once(store: FileStore, searches: Search[], priceMinor: number, second: number): Promise<void> {
  const record: Listing = {
    source: 'fixture', externalId: 'one', url: 'https://fixture.invalid/one', title: 'Honda S2000',
    priceMinor, currency: 'RUB', observedAt: new Date(Date.UTC(2026, 9, 11, 0, 0, second)).toISOString(),
    publishedAt: null, vehicle: { make: 'Honda', model: 'S2000', year: 2000, mileageKm: null }, provenance: {},
  };
  const adapter: SourceAdapter = {
    id: 'fixture',
    capabilities: () => ({ pagination: 'cursor', sort: ['newest'], publishedAt: false, details: false }),
    collectPage: async () => ({ outcome: 'success', records: [record], nextCursor: null,
      endReached: true, diagnostics: {}, retryAfterSeconds: null }),
  };
  await new MonitorService(new AdapterRegistry().register(adapter), store, searches,
    { requestIntervalMs: 0 }).run(new AbortController().signal, { once: true });
}

test('CLI status resolves current aliases to the retained query and event exports survive compaction', async t => {
  const directory = await mkdtemp(directoryPrefix);
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(directoryPrefix), 'cleanup remains in its task temp directory');
    await rm(directory, { recursive: true, force: true });
  });
  const initial = await FileStore.open(directory);
  try { await once(initial, [search('z-original')], 100, 0); } finally { await initial.close(); }

  const restarted = await FileStore.open(directory);
  let beforeStatus: Awaited<ReturnType<typeof run>>;
  let beforeEvents: Awaited<ReturnType<typeof run>>;
  try {
    await once(restarted, [search('a-current'), search('z-original', false)], 200, 1);
    const state = await FileStore.inspect(directory);
    beforeStatus = await run(directory, 'status', '--data-dir', '.');
    assert.equal(beforeStatus.code, 0, beforeStatus.stderr);
    const status = JSON.parse(beforeStatus.stdout);
    const binding = { queryKey: JSON.stringify(['fixture', url]), storageId: 'z-original' };
    assert.deepEqual(status.searchBindings, { 'a-current': binding, 'z-original': binding });
    assert.deepEqual(status.queries, state.queries);
    assert.equal(status.queries['a-current'], undefined);
    assert.equal(status.queries['z-original'].baselineComplete, true);
    assert.deepEqual(status.queries['z-original'].coverage.aliases, ['a-current']);
    assert.deepEqual(restarted.getQuery('a-current'), restarted.getQuery('z-original'));

    beforeEvents = await run(directory, 'export', '--data-dir', '.', '--events', '--format', 'json');
    assert.equal(beforeEvents.code, 0, beforeEvents.stderr);
    const events = JSON.parse(beforeEvents.stdout);
    assert.deepEqual(events, state.events);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'price_changed');
    assert.equal(events[0].searchId, 'z-original');
    assert.equal(events[0].previousPriceMinor, 100);
    assert.equal(events[0].priceMinor, 200);
    const listings = await run(directory, 'export', '--data-dir', '.', '--format', 'json');
    assert.equal(listings.code, 0, listings.stderr);
    assert.deepEqual(JSON.parse(listings.stdout), state.records);
  } finally { await restarted.close(); }

  const compact = await run(directory, 'compact', '--data-dir', '.');
  assert.equal(compact.code, 0, compact.stderr);
  const afterStatus = await run(directory, 'status', '--data-dir', '.');
  const afterEvents = await run(directory, 'export', '--data-dir', '.', '--events', '--format', 'json');
  assert.equal(afterStatus.code, 0, afterStatus.stderr);
  assert.equal(afterEvents.code, 0, afterEvents.stderr);
  assert.equal(afterStatus.stdout, beforeStatus!.stdout);
  assert.equal(afterEvents.stdout, beforeEvents!.stdout);
});
