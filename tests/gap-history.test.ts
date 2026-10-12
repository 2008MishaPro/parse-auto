import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { CollectPageResult, Listing, Search, SourceAdapter } from '../src/core/contracts.ts';
import { Crawler } from '../src/core/crawler.ts';
import type { CrawlerCallbacks } from '../src/core/crawler.ts';
import { AdapterRegistry } from '../src/core/registry.ts';
import { SourceScheduler, waitUntil } from '../src/core/scheduler.ts';
import { FileStore, type CoverageGap, type GapInput } from '../src/core/store.ts';

const url = 'https://fixture.invalid/cars';
const initialTime = Date.UTC(2026, 9, 11, 10);
const iso = (offset = 0) => new Date(initialTime + offset).toISOString();
let observation = 0;
function listing(externalId: string): Listing {
  return { source: 'fixture', externalId, url: `https://fixture.invalid/${externalId}`, title: externalId,
    priceMinor: 100, currency: 'RUB', observedAt: new Date(Date.now() + ++observation).toISOString(),
    publishedAt: null, vehicle: { make: null, model: null, year: null, mileageKm: null }, provenance: {} };
}
function page(ids: string[], nextCursor: string | null = null, diagnostics: Record<string, unknown> = {}): CollectPageResult {
  return { outcome: ids.length ? 'success' : 'empty', records: ids.map(listing), nextCursor,
    endReached: nextCursor === null, retryAfterSeconds: null, diagnostics };
}
function search(overrides: Partial<Search> = {}): Search {
  return { id: 'cars', source: 'fixture', url, enabled: true, intervalSeconds: 120, overlapPages: 1,
    maxPagesPerSweep: 4, sweepIntervalSeconds: 1_000_000_000, requestTimeoutSeconds: 1, maxCycleSeconds: 1, ...overrides };
}
class Adapter implements SourceAdapter {
  id = 'fixture';
  calls: Array<string | null> = [];
  handler: (cursor: string | null, signal: AbortSignal) => CollectPageResult | Promise<CollectPageResult>;
  constructor(handler: Adapter['handler']) { this.handler = handler; }
  capabilities() { return { pagination: 'cursor', sort: ['newest'], publishedAt: false, details: false }; }
  async collectPage(_query: { url: string }, cursor: string | null, signal: AbortSignal) {
    this.calls.push(cursor);
    return this.handler(cursor, signal);
  }
}
async function temporary(t: TestContext) {
  const root = resolve('.tmp');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'gap-history-'));
  const holder = { store: await FileStore.open(directory) };
  t.after(async () => {
    await holder.store.close();
    assert.equal(dirname(resolve(directory)), root);
    assert.ok(basename(directory).startsWith('gap-history-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, holder };
}
function crawl(store: FileStore, adapter: Adapter, query = search(), callbacks: CrawlerCallbacks = {}, forceSweep = false,
  signal = new AbortController().signal, scheduler = new SourceScheduler(0, store)) {
  return new Crawler(new AdapterRegistry().register(adapter), store, scheduler, callbacks).crawl(query, signal, forceSweep);
}
function gap(reason: string, runId = 'run', until = iso(1_000), since: string | null = iso()): GapInput {
  return { runId, reason, since, until };
}
async function history(directory: string) { return (await FileStore.inspect(directory)).gaps; }
function checksum(envelope: Record<string, unknown>) {
  const body = { version: envelope.version, sequence: envelope.sequence, payload: envelope.payload };
  return { ...body, checksum: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

test('gap вместе с query устойчиво записывается; same run/reason расширяется без дубликата через alias/restart/compact', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.bindSearches([search(), search({ id: 'z' })]);
  await holder.store.updateQuery('cars', { coverage: { status: 'error' }, resumeCursor: '2' }, gap('timeout'));
  const first = (await history(directory))[0]!;
  await holder.store.updateQuery('z', { failureCount: 2 }, gap('timeout', 'run', iso(3_000), iso(-1_000)));
  assert.equal((await history(directory)).length, 1);
  const extended = (await history(directory))[0]!;
  assert.equal(extended.gapId, first.gapId);
  assert.equal(extended.searchId, 'cars');
  assert.equal(extended.until, iso(3_000));
  assert.equal(extended.since, iso(-1_000));
  await holder.store.updateQuery('z', {}, gap('timeout', 'run', iso(2_000), iso(-1_000)));
  assert.equal((await history(directory))[0]!.until, iso(3_000), 'older replay cannot shrink the recorded period');
  await holder.store.compact();
  const saved = await FileStore.inspect(directory);
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  assert.deepEqual(await FileStore.inspect(directory), saved);
  await holder.store.updateQuery('z', { resumeCursor: '3' }, gap('timeout', 'run', iso(4_000), iso(-1_000)));
  assert.equal((await history(directory)).length, 1);
  assert.equal((await history(directory))[0]!.gapId, first.gapId);
  assert.equal(holder.store.getQuery('cars').resumeCursor, '3');
});

test('разные run и reasons сохраняют отдельные gaps, а успех не удаляет историю и lastGap', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.updateQuery('cars', { coverage: { status: 'error', lastGap: gap('blocked') } },
    [gap('blocked'), gap('source_limit'), gap('blocked', 'next')]);
  const before = await history(directory);
  assert.equal(before.length, 3);
  assert.equal(new Set(before.map(entry => entry.gapId)).size, 3);
  const previousLastGap = holder.store.getQuery('cars').coverage.lastGap;
  await crawl(holder.store, new Adapter(() => page(['one'])));
  assert.deepEqual(await history(directory), before);
  assert.equal(holder.store.getQuery('cars').coverage.gapPossible, false);
  assert.deepEqual(holder.store.getQuery('cars').coverage.lastGap, previousLastGap);
  await holder.store.compact();
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  assert.deepEqual(await history(directory), before);
});

test('ошибка источника фиксирует gap до полезной страницы и diagnostics, final не дублирует interim gap', async t => {
  const { directory, holder } = await temporary(t);
  let confirmedBeforeOutput = false;
  const adapter = new Adapter(() => ({ ...page(['useful']), outcome: 'blocked', endReached: false,
    nextCursor: 'untrusted', retryAfterSeconds: 30 }));
  await crawl(holder.store, adapter, search(), {
    async onDiagnostic(diagnostic) {
      if (diagnostic.type !== 'page') return;
      const state = await FileStore.inspect(directory);
      assert.equal(state.gaps.filter(entry => entry.reason === 'blocked').length, 1);
      assert.equal(state.sources.fixture!.failureCount, 1);
      assert.equal(state.queries.cars!.resumeCursor, null);
      assert.equal(state.records.length, 1);
      confirmedBeforeOutput = true;
    },
  });
  const gaps = await history(directory);
  assert.equal(confirmedBeforeOutput, true);
  assert.equal(gaps.filter(entry => entry.reason === 'blocked').length, 1);
  assert.equal(gaps[0]!.searchId, 'cars');
  assert.equal(holder.store.getQuery('cars').coverage.gapReason, 'blocked');
  const batches = (await readFile(join(directory, 'journal.ndjson'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  const usefulIndex = batches.findIndex(row => row.payload.type === 'page');
  assert.ok(batches.slice(0, usefulIndex).some(row => row.payload.type === 'query' && row.payload.gaps?.some((value: CoverageGap) => value.reason === 'blocked')),
    'journal contains query and gap before useful page commit');
});

test('time_budget сохраняет наблюдённый source_limit, cursor и оба основания истории без source failure', async t => {
  const { directory, holder } = await temporary(t);
  const adapter = new Adapter(async (cursor, signal) => {
    if (cursor === null) return page(['first'], '2', { coverageLimited: true });
    await waitUntil(Date.now() + 1_000, signal);
    return page(['too-late']);
  });
  await crawl(holder.store, adapter, search({ maxCycleSeconds: 0.03 }));
  const state = await FileStore.inspect(directory);
  assert.deepEqual(state.gaps.map(entry => entry.reason).sort(), ['source_limit', 'time_budget']);
  assert.equal(state.queries.cars!.coverage.gapReason, 'time_budget');
  assert.equal(state.queries.cars!.resumeCursor, '2');
  assert.equal(state.queries.cars!.baselineComplete, false);
  assert.equal(state.sources.fixture!.failureCount, 0);
  assert.equal(state.records.length, 1);
  await holder.store.compact();
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  assert.deepEqual(await history(directory), state.gaps);
});

test('process_restart записан до HTTP даже при успешном первом запросе и продлевается тем же gapId', async t => {
  const { directory, holder } = await temporary(t);
  const previous = new Date(Date.now() - 5_000).toISOString();
  await holder.store.updateQuery('cars', { baselineComplete: true, lastAttempt: previous, lastSuccess: previous, lastExhaustedScan: previous });
  let observedAtHttp: CoverageGap | undefined;
  const adapter = new Adapter(async () => {
    observedAtHttp = (await history(directory)).find(entry => entry.reason === 'process_restart');
    assert.ok(observedAtHttp, 'a restart gap exists even if the process crashes in the first HTTP');
    assert.equal(observedAtHttp.since, previous);
    return page(['one']);
  });
  await crawl(holder.store, adapter, search(), {}, true);
  const gaps = await history(directory);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.gapId, observedAtHttp!.gapId);
  assert.ok(Date.parse(gaps[0]!.until) >= Date.parse(observedAtHttp!.until));
  assert.equal(holder.store.getQuery('cars').baselineComplete, true);
  assert.equal(holder.store.getQuery('cars').coverage.gapReason, 'process_restart');
});

test('сдвиг между страницами и переполнение опорного окна остаются разными историческими основаниями', async t => {
  const { directory, holder } = await temporary(t);
  const adapter = new Adapter(cursor => cursor === null ? page(['one', 'two'], '2') : page(['two', 'three']));
  await crawl(holder.store, adapter);
  assert.equal((await history(directory)).filter(entry => entry.reason === 'pagination_shift').length, 1);
  assert.equal(holder.store.getQuery('cars').baselineComplete, false);
  const checkpoint = new Date(Date.now() - 1_000).toISOString();
  await holder.store.updateQuery('cars', { baselineComplete: true, lastExhaustedScan: checkpoint, lastSuccess: checkpoint,
    resumeCursor: null, coverage: { requiresFullScan: false, windowIds: [JSON.stringify(['fixture', 'old'])] } });
  adapter.handler = cursor => cursor === null ? page(['new1'], '2') : page(['new2'], '3');
  await crawl(holder.store, adapter, search({ maxPagesPerSweep: 2 }));
  const gaps = await history(directory);
  assert.equal(gaps.filter(entry => entry.reason === 'pagination_shift').length, 1);
  assert.equal(gaps.filter(entry => entry.reason === 'window_overflow').length, 1);
  assert.equal(holder.store.getQuery('cars').coverage.gapReason, 'window_overflow');
  assert.equal(holder.store.getQuery('cars').lastSuccess, checkpoint);
});

test('остановка сохраняет interrupted, а продолжение cursor сохраняет resume gap без объявления полного прохода', async t => {
  const { directory, holder } = await temporary(t);
  const controller = new AbortController();
  const adapter = new Adapter(() => page(['one'], '2'));
  await crawl(holder.store, adapter, search(), {
    onDiagnostic(diagnostic) { if (diagnostic.type === 'page') controller.abort(); },
  }, false, controller.signal);
  const before = await history(directory);
  assert.equal(before.filter(entry => entry.reason === 'interrupted').length, 1);
  assert.equal(holder.store.getQuery('cars').resumeCursor, '2');
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  adapter.handler = () => page(['two']);
  await crawl(holder.store, adapter, search(), {}, true);
  const after = await history(directory);
  assert.deepEqual(after.filter(entry => entry.reason === 'interrupted'), before);
  assert.equal(after.filter(entry => entry.reason === 'resume_is_not_a_full_snapshot').length, 1);
  assert.equal(after.filter(entry => entry.reason === 'process_restart').length, 1);
  assert.equal(holder.store.getQuery('cars').baselineComplete, false);
});

test('ENOSPC scheduler после cycle deadline остаётся фатальным и не превращается в time_budget gap', async t => {
  const { directory, holder } = await temporary(t);
  const fatal = Object.assign(new Error('source state disk full'), { code: 'ENOSPC' });
  const scheduler = new SourceScheduler(0);
  scheduler.collect = async () => { await new Promise(resolvePause => setTimeout(resolvePause, 30)); throw fatal; };
  await assert.rejects(crawl(holder.store, new Adapter(() => page(['one'])), search({ maxCycleSeconds: 0.01 }), {}, false,
    new AbortController().signal, scheduler), error => error === fatal);
  assert.deepEqual(await history(directory), []);
  assert.equal(holder.store.getQuery('cars').coverage.gapReason, undefined);
});

test('успешная terminal страница сохраняется после медленного health fsync, даже если цикл тем временем истёк', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.updateSource('fixture', { failureCount: 0, blockedUntil: null, lastAttempt: null, lastSuccess: null, lastOutcome: null });
  const scheduler = new SourceScheduler(0, {
    getSource: holder.store.getSource.bind(holder.store),
    async updateSource(source, state) {
      await new Promise(resolvePause => setTimeout(resolvePause, 70));
      await holder.store.updateSource(source, state);
    },
  });
  await crawl(holder.store, new Adapter(() => page(['one'])), search({ maxCycleSeconds: 0.03 }), {}, false,
    new AbortController().signal, scheduler);
  const state = await FileStore.inspect(directory);
  assert.equal(state.records.length, 1);
  assert.equal(state.queries.cars!.baselineComplete, true);
  assert.equal(state.queries.cars!.coverage.timeBudgetExhausted, false);
  assert.equal(state.sources.fixture!.lastOutcome, 'success');
  assert.deepEqual(state.gaps, []);
});

test('уже наблюдённый cap и pagination shift устойчивы до сбоя внешнего page callback', async t => {
  const { directory, holder } = await temporary(t);
  const fatal = new Error('external diagnostic failed');
  const adapter = new Adapter(cursor => cursor === null ? page(['one', 'two'], '2')
    : page(['two', 'three'], null, { coverageLimited: true }));
  await assert.rejects(crawl(holder.store, adapter, search(), {
    onDiagnostic(diagnostic) { if (diagnostic.type === 'page' && diagnostic.cursor === '2') throw fatal; },
  }), error => error === fatal);
  const state = await FileStore.inspect(directory);
  assert.deepEqual(state.gaps.map(entry => entry.reason).sort(), ['pagination_shift', 'source_limit']);
  assert.equal(state.records.length, 3);
  assert.equal(state.queries.cars!.baselineComplete, false);
  await holder.store.compact();
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  assert.deepEqual(await history(directory), state.gaps);
});

test('legacy snapshot без истории импортирует последний известный gap один раз, не выдумывая утраченные периоды', async t => {
  const { directory, holder } = await temporary(t);
  const lastGap = { since: iso(), until: iso(2_000), reason: 'process_restart' };
  await holder.store.updateQuery('cars', { queryKey: JSON.stringify(['fixture', url]), coverage: { lastGap } });
  await holder.store.updateQuery('unknown', { coverage: { lastGap: { reason: 'timeout', until: 'bad' } } });
  await holder.store.compact();
  await holder.store.close();
  const snapshotPath = join(directory, 'snapshot.json');
  const old = JSON.parse(await readFile(snapshotPath, 'utf8'));
  delete old.payload.gaps;
  delete old.payload.gapsInitialized;
  delete old.payload.sources;
  const legacy = checksum(old);
  await writeFile(snapshotPath, JSON.stringify(legacy));
  await writeFile(join(directory, 'journal.ndjson'), JSON.stringify(checksum({ version: 1, sequence: legacy.sequence,
    payload: { type: 'anchor', snapshotChecksum: legacy.checksum } })) + '\n');
  holder.store = await FileStore.open(directory);
  assert.deepEqual(await history(directory), []);
  const registrations = [search({ id: 'new' })];
  await holder.store.bindSearches(registrations);
  await holder.store.ensureSources(registrations);
  const imported = await history(directory);
  assert.equal(imported.length, 1);
  assert.equal(imported[0]!.searchId, 'cars');
  assert.equal(imported[0]!.reason, lastGap.reason);
  assert.equal(imported[0]!.until, lastGap.until);
  assert.ok(imported[0]!.runId.startsWith('legacy:'));
  await holder.store.ensureSources(registrations);
  assert.deepEqual(await history(directory), imported);
  await holder.store.compact();
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  await holder.store.ensureSources(registrations);
  assert.deepEqual(await history(directory), imported);
});

test('checksummed committed gap batch не может содержать период другого поиска даже с корректным gapId', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.updateQuery('cars', {}, gap('timeout'));
  await holder.store.close();
  const path = join(directory, 'journal.ndjson');
  const envelope = JSON.parse((await readFile(path, 'utf8')).trim());
  const period = envelope.payload.gaps[0];
  period.searchId = 'other';
  period.gapId = createHash('sha256').update(JSON.stringify([period.searchId, period.runId, period.reason])).digest('hex');
  await writeFile(path, JSON.stringify(checksum(envelope)) + '\n');
  const corrupted = await readFile(path);
  await assert.rejects(FileStore.inspect(directory));
  await assert.rejects(FileStore.open(directory));
  assert.deepEqual(await readFile(path), corrupted);
});

test('повтор gap с unknown since сохраняет неизвестную нижнюю границу при следующих replay', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.updateQuery('cars', {}, gap('timeout'));
  const first = (await history(directory))[0]!;
  await holder.store.updateQuery('cars', {}, gap('timeout', 'run', iso(3_000), null));
  await holder.store.updateQuery('cars', {}, gap('timeout', 'run', iso(2_000), iso(-5_000)));
  const periods = await history(directory);
  assert.equal(periods.length, 1);
  assert.equal(periods[0]!.gapId, first.gapId);
  assert.equal(periods[0]!.since, null);
  assert.equal(periods[0]!.until, iso(3_000));
});

test('инвертированный gap отвергается до append и не портит последующие допустимые записи', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.updateQuery('cars', { resumeCursor: '2' }, gap('timeout'));
  const before = await FileStore.inspect(directory);
  const path = join(directory, 'journal.ndjson');
  const journal = await readFile(path);
  await assert.rejects(holder.store.updateQuery('cars', { resumeCursor: 'unsafe' },
    gap('blocked', 'inverted', iso(1_000), iso(5_000))));
  assert.deepEqual(await FileStore.inspect(directory), before);
  assert.deepEqual(await readFile(path), journal);
  await holder.store.updateQuery('cars', { resumeCursor: '3' }, gap('blocked', 'valid', iso(5_000), iso(1_000)));
  assert.equal(holder.store.getQuery('cars').resumeCursor, '3');
  assert.equal((await history(directory)).length, 2);
});

test('snapshot с завершённой миграцией gaps не может молча потерять поле истории', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.updateQuery('cars', {}, gap('timeout'));
  await holder.store.ensureSources([search()]);
  await holder.store.compact();
  await holder.store.close();
  const snapshotPath = join(directory, 'snapshot.json');
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  assert.equal(snapshot.payload.gapsInitialized, true);
  delete snapshot.payload.gaps;
  const changed = checksum(snapshot);
  await writeFile(snapshotPath, JSON.stringify(changed));
  const journalPath = join(directory, 'journal.ndjson');
  await writeFile(journalPath, JSON.stringify(checksum({ version: 1, sequence: changed.sequence,
    payload: { type: 'anchor', snapshotChecksum: changed.checksum } })) + '\n');
  const saved = [await readFile(snapshotPath), await readFile(journalPath)];
  await assert.rejects(FileStore.inspect(directory));
  await assert.rejects(FileStore.open(directory));
  assert.deepEqual(await readFile(snapshotPath), saved[0]);
  assert.deepEqual(await readFile(journalPath), saved[1]);
});

test('откат часов относительно lastSuccess сохраняет restart gap с неизвестным since', async t => {
  const { directory, holder } = await temporary(t);
  const future = new Date(Date.now() + 60_000).toISOString();
  await holder.store.updateQuery('cars', { baselineComplete: true, lastAttempt: future, lastSuccess: future, lastExhaustedScan: future });
  await crawl(holder.store, new Adapter(() => page(['one'])), search(), {}, true);
  const periods = await history(directory);
  assert.equal(periods.length, 1);
  assert.equal(periods[0]!.reason, 'process_restart');
  assert.equal(periods[0]!.since, null, 'unknown lower bound represents an observed clock rollback');
  assert.equal((holder.store.getQuery('cars').coverage.lastGap as { since: unknown }).since, null);
  assert.equal(holder.store.getQuery('cars').baselineComplete, true);
});

for (const corruption of [
  { gapId: 'wrong' }, { searchId: 'wrong' }, { sequence: 999_999 }, { since: 'bad timestamp' },
  { until: null }, { reason: '' }, { runId: '' }, { since: iso(5_000), until: iso(1_000) },
]) {
  test(`checksummed snapshot отвергает повреждённую историю gaps ${JSON.stringify(corruption)}`, async t => {
    const { directory, holder } = await temporary(t);
    await holder.store.updateQuery('cars', {}, gap('timeout'));
    await holder.store.compact();
    await holder.store.close();
    const snapshotPath = join(directory, 'snapshot.json');
    const original = JSON.parse(await readFile(snapshotPath, 'utf8'));
    const value = original.payload.gaps[0];
    if (Array.isArray(value)) value[1] = { ...value[1], ...corruption };
    else original.payload.gaps[0] = { ...value, ...corruption };
    const changed = checksum(original);
    await writeFile(snapshotPath, JSON.stringify(changed));
    await writeFile(join(directory, 'journal.ndjson'), JSON.stringify(checksum({ version: 1, sequence: changed.sequence,
      payload: { type: 'anchor', snapshotChecksum: changed.checksum } })) + '\n');
    const saved = [await readFile(snapshotPath), await readFile(join(directory, 'journal.ndjson'))];
    await assert.rejects(FileStore.inspect(directory));
    await assert.rejects(FileStore.open(directory));
    assert.deepEqual(await readFile(snapshotPath), saved[0]);
    assert.deepEqual(await readFile(join(directory, 'journal.ndjson')), saved[1]);
  });
}
