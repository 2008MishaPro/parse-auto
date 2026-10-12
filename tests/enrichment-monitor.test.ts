import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { CollectDetailsResult, CollectPageResult, Listing, Search, SourceAdapter } from '../src/core/contracts.ts';
import { Crawler, type CrawlerCallbacks } from '../src/core/crawler.ts';
import { MonitorService } from '../src/core/monitor.ts';
import { AdapterRegistry } from '../src/core/registry.ts';
import { SourceScheduler, waitUntil } from '../src/core/scheduler.ts';
import { FileStore, type SourceState } from '../src/core/store.ts';

let observation = 0;
function listing(id: string, overrides: Partial<Listing> = {}): Listing {
  return { source: 'sim', externalId: id, title: `Car ${id}`, url: `https://example.test/${id}`, priceMinor: 100,
    currency: 'RUB', observedAt: new Date(Date.now() + ++observation).toISOString(), publishedAt: null,
    vehicle: { make: null, model: null, year: 2000, mileageKm: 100_000 }, provenance: {}, ...overrides };
}
function page(records: Listing[], nextCursor: string | null = null, diagnostics: Record<string, unknown> = {}): CollectPageResult {
  return { outcome: records.length ? 'success' : 'empty', records, nextCursor, endReached: nextCursor === null,
    diagnostics, retryAfterSeconds: null };
}
function details(record: Listing | null, outcome: CollectDetailsResult['outcome'] = 'success', retryAfterSeconds: number | null = null): CollectDetailsResult {
  return { outcome, record, diagnostics: {}, retryAfterSeconds };
}
function car(record: Listing, overrides: Partial<Listing> = {}) {
  return { ...record, observedAt: new Date(Date.parse(record.observedAt) + 1_000).toISOString(),
    vehicle: { ...record.vehicle, make: 'Make', model: 'Model' },
    provenance: { 'vehicle.make': 'card.make', 'vehicle.model': 'card.model' }, ...overrides };
}
function search(id = 'a', overrides: Partial<Search> = {}): Search {
  return { id, source: 'sim', url: `https://example.test/search/${id}`, enabled: true, intervalSeconds: 120,
    overlapPages: 2, sweepIntervalSeconds: 3_600, maxPagesPerSweep: 10, requestTimeoutSeconds: 1,
    maxCycleSeconds: 10, maxDetailsPerCycle: 2, ...overrides };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
class Adapter implements SourceAdapter {
  id = 'sim';
  calls: string[] = [];
  active = 0;
  maximumActive = 0;
  pageHandler: (url: string, cursor: string | null, signal: AbortSignal) => CollectPageResult | Promise<CollectPageResult>;
  detailsHandler: (id: string, signal: AbortSignal) => CollectDetailsResult | Promise<CollectDetailsResult>;
  constructor(pageHandler: Adapter['pageHandler'], detailsHandler: Adapter['detailsHandler']) {
    this.pageHandler = pageHandler;
    this.detailsHandler = detailsHandler;
  }
  capabilities() { return { pagination: 'cursor', sort: ['newest'], publishedAt: false, details: true }; }
  private async call<T>(name: string, handler: () => T | Promise<T>) {
    this.calls.push(name);
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try { return await handler(); } finally { this.active -= 1; }
  }
  collectPage(query: { url: string }, cursor: string | null, signal: AbortSignal) {
    return this.call(`page:${query.url.split('/').at(-1)}:${cursor ?? 'head'}`, () => this.pageHandler(query.url, cursor, signal));
  }
  getDetails(id: string, _url: string, signal: AbortSignal) {
    return this.call(`card:${id}`, () => this.detailsHandler(id, signal));
  }
}
async function temporary(t: TestContext) {
  const root = resolve('.tmp');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'enrichment-monitor-'));
  const holder = { store: await FileStore.open(directory) };
  t.after(async () => {
    await holder.store.close();
    assert.equal(dirname(resolve(directory)), root);
    assert.ok(basename(directory).startsWith('enrichment-monitor-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, holder };
}
function crawler(adapter: SourceAdapter, store: FileStore, scheduler = new SourceScheduler(0, store), callbacks: CrawlerCallbacks = {}) {
  return new Crawler(new AdapterRegistry().register(adapter), store, scheduler, callbacks);
}
function wrappedStore(store: FileStore, overrides: Partial<FileStore>): FileStore {
  return { getQuery: store.getQuery.bind(store), updateQuery: store.updateQuery.bind(store), commitPage: store.commitPage.bind(store),
    detailsCandidates: store.detailsCandidates.bind(store), beginDetailsAttempt: store.beginDetailsAttempt.bind(store),
    finishDetailsAttempt: store.finishDetailsAttempt.bind(store), bindSearches: store.bindSearches.bind(store),
    ensureSources: store.ensureSources.bind(store), getSource: store.getSource.bind(store), updateSource: store.updateSource.bind(store),
    ...overrides } as FileStore;
}

test('карточки берутся из всего сохранённого поиска с лимитом; default0 не делает запросов', async t => {
  const { directory, holder } = await temporary(t);
  const records = ['1', '2', '3', 'deep'].map(id => listing(id));
  const byId = new Map(records.map(record => [record.externalId, record]));
  const adapter = new Adapter((_url, cursor) => cursor === null ? page(records.slice(0, 3), '2') : page(records.slice(3)),
    id => details(car(byId.get(id)!)));
  await crawler(adapter, holder.store).crawl(search(), new AbortController().signal);
  assert.deepEqual(adapter.calls, ['page:a:head', 'page:a:2', 'card:1', 'card:2']);
  assert.equal(holder.store.getQuery('a').baselineComplete, true);
  const state = await FileStore.inspect(directory);
  assert.equal(state.records.find(record => record.externalId === '1')!.vehicle.make, 'Make');
  assert.equal(state.records.find(record => record.externalId === 'deep')!.vehicle.make, null);
  assert.deepEqual(state.events, [], 'baseline enrichment does not create discovered/details_changed');
  await crawler(adapter, holder.store).crawl(search('disabled', { maxDetailsPerCycle: undefined }), new AbortController().signal);
  assert.equal(adapter.calls.filter(call => call.startsWith('card:')).length, 2);
  await crawler(adapter, holder.store).crawl(search(), new AbortController().signal);
  assert.deepEqual(adapter.calls.filter(call => call.startsWith('card:')), ['card:1', 'card:2', 'card:3', 'card:deep']);
  const enriched = await FileStore.inspect(directory);
  assert.equal(enriched.records.find(record => record.externalId === 'deep')!.vehicle.make, 'Make');
  assert.deepEqual(enriched.events, []);
  const coverage = holder.store.getQuery('a').coverage.enrichment as Record<string, unknown>;
  assert.equal(coverage.selection, 'saved_search');
  assert.equal(Object.hasOwn(coverage, 'scopeRecords'), false);
});

test('52 сохранённые карточки обходятся по две: head poll не теряет хвост, restart не повторяет success', async t => {
  const { directory, holder } = await temporary(t);
  const records = Array.from({ length: 52 }, (_, index) => listing(String(index + 1)));
  const byId = new Map(records.map(record => [record.externalId, record]));
  const diagnostics: Array<{ type: string; [field: string]: unknown }> = [];
  const adapter = new Adapter((_url, cursor) => cursor === null ? page(records.slice(0, 50), 'tail') : page(records.slice(50)),
    async id => {
      const durable = await FileStore.inspect(directory);
      assert.equal(durable.queries.a!.baselineComplete, true);
      assert.equal(durable.queries.a!.coverage.outcome, 'success');
      assert.equal(durable.records.length, 52, 'полный каталог сохранён до первого карточного HTTP');
      assert.equal(holder.store.getDetailsState('sim', id)!.outcome, 'pending');
      return details(car(byId.get(id)!));
    });
  const query = search('a', { overlapPages: 1 });
  const run = async () => {
    const before = adapter.calls.filter(call => call.startsWith('card:')).length;
    await crawler(adapter, holder.store, new SourceScheduler(0, holder.store), {
      onDiagnostic(diagnostic) { diagnostics.push(diagnostic); },
    }).crawl(query, new AbortController().signal);
    assert.ok(adapter.calls.filter(call => call.startsWith('card:')).length - before <= 2);
    assert.equal(holder.store.getQuery('a').coverage.outcome, 'success');
    assert.equal(holder.store.getQuery('a').resumeCursor, null);
  };
  await run();
  assert.deepEqual(adapter.calls, ['page:a:head', 'page:a:tail', 'card:1', 'card:2']);
  const exhaustedScan = holder.store.getQuery('a').lastExhaustedScan;
  for (let cycle = 1; cycle < 25; cycle++) await run();
  assert.equal(adapter.calls.filter(call => call === 'page:a:tail').length, 1, 'обычные polls читают только head');
  assert.deepEqual(adapter.calls.filter(call => call.startsWith('card:')), records.slice(0, 50).map(record => `card:${record.externalId}`));
  assert.equal(holder.store.getQuery('a').lastExhaustedScan, exhaustedScan, 'head polls сохраняют полный checkpoint');
  await holder.store.compact();
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  const beforeRestart = adapter.calls.length;
  await new MonitorService(new AdapterRegistry().register(adapter), holder.store, [query], {
    requestIntervalMs: 0,
    onDiagnostic(diagnostic) { diagnostics.push(diagnostic); },
  }).run(new AbortController().signal, { once: true });
  assert.deepEqual(adapter.calls.slice(beforeRestart), ['page:a:head', 'page:a:tail', 'card:51', 'card:52'],
    'настоящий restart делает sweep и продолжает карточки без повторов');
  assert.equal(holder.store.getQuery('a').coverage.mode, 'sweep');
  const restartedScan = holder.store.getQuery('a').lastExhaustedScan;
  await run();
  assert.equal(holder.store.getQuery('a').lastExhaustedScan, restartedScan, 'следующий head poll сохраняет новый checkpoint');
  const requests = adapter.calls.filter(call => call.startsWith('card:'));
  assert.equal(requests.length, 52);
  assert.equal(new Set(requests).size, 52);
  const state = await FileStore.inspect(directory);
  assert.equal(state.detailsStates.length, 52);
  assert.equal(state.records.filter(record => record.vehicle.make === 'Make').length, 52);
  assert.deepEqual(state.events, [], 'обогащение baseline не создаёт ложных событий');
  assert.equal(holder.store.getSource('sim')!.failureCount, 0);
  const selections = diagnostics.filter(diagnostic => diagnostic.type === 'details_finished');
  assert.equal(selections.length, 27);
  assert.ok(selections.every(diagnostic => diagnostic.selection === 'saved_search' && !Object.hasOwn(diagnostic, 'scopeRecords')));
});

test('головная страница больше 50 не создаёт скрытого cap кандидатов', async t => {
  const { directory, holder } = await temporary(t);
  const records = Array.from({ length: 52 }, (_, index) => listing(String(index + 1), index < 50 ? {
    vehicle: { make: 'Known make', model: 'Known model', year: 2000, mileageKm: 100_000 },
  } : {}));
  const byId = new Map(records.map(record => [record.externalId, record]));
  const adapter = new Adapter(() => page(records), id => details(car(byId.get(id)!)));
  await crawler(adapter, holder.store).crawl(search(), new AbortController().signal);
  assert.deepEqual(adapter.calls, ['page:a:head', 'card:51', 'card:52']);
  const state = await FileStore.inspect(directory);
  assert.equal(state.records.length, 52);
  assert.deepEqual(state.events, []);
  assert.equal(state.records.find(record => record.externalId === '52')!.vehicle.make, 'Make');
});

test('alias продолжает свой backlog, не выбирает старые карточки другого сохранённого поиска', async t => {
  const { directory, holder } = await temporary(t);
  const original = search('a', { enabled: false });
  const alias = search('renamed', { url: original.url });
  const other = search('other', { enabled: false });
  await holder.store.bindSearches([{ ...original, enabled: true }, other]);
  await holder.store.bindSearches([original, alias, other]);
  const foreign = listing('foreign');
  await holder.store.commitPage('other', 'seed-other', null, [foreign], null);
  const records = ['1', '2', '3'].map(id => listing(id));
  const byId = new Map(records.map(record => [record.externalId, record]));
  await holder.store.commitPage('a', 'seed-target', null, records, null);
  const adapter = new Adapter(() => page(records.slice(0, 1)), id => {
    assert.ok(byId.has(id), 'другая query не попадает в карточный обход выбранной группы');
    return details(car(byId.get(id)!));
  });
  const run = () => new MonitorService(new AdapterRegistry().register(adapter), holder.store, [original, alias, other],
    { requestIntervalMs: 0 }).run(new AbortController().signal, { once: true });
  await run();
  assert.deepEqual(adapter.calls, ['page:a:head', 'card:1', 'card:2']);
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  await run();
  assert.deepEqual(adapter.calls.filter(call => call.startsWith('card:')), ['card:1', 'card:2', 'card:3']);
  assert.equal(holder.store.getDetailsState('sim', 'foreign'), null);
  const target = await FileStore.inspect(directory, 'renamed');
  assert.equal(target.records.length, 3);
  assert.ok(target.records.every(record => record.vehicle.make === 'Make'));
  assert.equal(target.searchBindings.renamed!.storageId, 'a');
  assert.deepEqual(target.events, []);
  const foreignState = await FileStore.inspect(directory, 'other');
  assert.deepEqual(foreignState.records, [foreign]);
  assert.deepEqual(foreignState.detailsStates, []);
});

test('обход хвоста не мешает price_changed/discovered и не продвигает полный checkpoint head poll', async t => {
  const { directory, holder } = await temporary(t);
  const original = ['head', 'tail-1', 'tail-2'].map(id => listing(id));
  const changed = listing('head', { priceMinor: 200 });
  const fresh = listing('fresh');
  const byId = new Map([...original, changed, fresh].map(record => [record.externalId, record]));
  let polling = false;
  const adapter = new Adapter((_url, cursor) => polling ? page([changed, fresh], 'tail')
    : cursor === null ? page(original.slice(0, 1), 'tail') : page(original.slice(1)), async id => {
    if (polling) {
      const durable = await FileStore.inspect(directory);
      assert.equal(durable.queries.a!.coverage.outcome, 'success');
      assert.deepEqual(durable.events.map(event => [event.type, event.externalId]), [['price_changed', 'head'], ['discovered', 'fresh']]);
    }
    return details(car(byId.get(id)!));
  });
  const query = search('a', { overlapPages: 1, maxDetailsPerCycle: 1 });
  await crawler(adapter, holder.store).crawl(query, new AbortController().signal);
  const exhaustedScan = holder.store.getQuery('a').lastExhaustedScan;
  polling = true;
  await crawler(adapter, holder.store).crawl(query, new AbortController().signal);
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  await crawler(adapter, holder.store).crawl(query, new AbortController().signal);
  assert.deepEqual(adapter.calls.filter(call => call.startsWith('card:')), ['card:head', 'card:tail-1', 'card:tail-2']);
  const state = await FileStore.inspect(directory);
  assert.equal(state.records.find(record => record.externalId === 'head')!.priceMinor, 200, 'цена приходит из каталога');
  assert.deepEqual(state.events.map(event => [event.type, event.externalId]), [['price_changed', 'head'], ['discovered', 'fresh']]);
  assert.equal(new Set(state.events.map(event => event.eventId)).size, 2);
  assert.equal(state.queries.a!.lastExhaustedScan, exhaustedScan);
  assert.equal(state.queries.a!.coverage.mode, 'poll');
  assert.equal(state.queries.a!.resumeCursor, null);
  assert.equal(state.queries.a!.baselineComplete, true);
});

test('catalog checkpoint и pending claim устойчивы до первого карточного HTTP; следующий poll/restart не повторяет success', async t => {
  const { directory, holder } = await temporary(t);
  const record = listing('1');
  const adapter = new Adapter(() => page([record]), async () => {
    const durable = await FileStore.inspect(directory);
    assert.equal(durable.queries.a!.baselineComplete, true);
    assert.equal(durable.queries.a!.coverage.outcome, 'success');
    assert.notEqual(durable.queries.a!.lastExhaustedScan, null);
    assert.equal(holder.store.getDetailsState('sim', '1')!.outcome, 'pending');
    return details(car(record));
  });
  await crawler(adapter, holder.store).crawl(search(), new AbortController().signal);
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  await crawler(adapter, holder.store).crawl(search(), new AbortController().signal);
  assert.equal(adapter.calls.filter(call => call === 'card:1').length, 1);
  assert.equal(holder.store.getQuery('a').coverage.outcome, 'success');
});

test('карточный mismatch title/price сохраняется отдельно и не подменяет успешный каталог', async t => {
  const { directory, holder } = await temporary(t);
  const record = listing('1');
  const adapter = new Adapter(() => page([record]), () => details(car(record, { title: 'Changed car title', priceMinor: 200 })));
  await crawler(adapter, holder.store).crawl(search(), new AbortController().signal);
  const state = await FileStore.inspect(directory);
  assert.equal(state.records[0]!.title, record.title);
  assert.equal(state.records[0]!.priceMinor, 100);
  assert.equal(state.records[0]!.vehicle.make, null);
  assert.equal(holder.store.getDetailsState('sim', '1')!.record!.title, 'Changed car title');
  assert.equal(holder.store.getQuery('a').coverage.outcome, 'success');
  assert.equal(holder.store.getSource('sim')!.lastOutcome, 'success');
});

test('partial/source cap catalogue не расходует HTTP на optional карточки', async t => {
  for (const mode of ['partial', 'source_cap', 'pagination_shift']) {
    await t.test(mode, async child => {
      const { holder } = await temporary(child);
      const record = listing('1');
      const adapter = new Adapter((_url, cursor) => mode === 'source_cap' ? page([record], null, { coverageLimited: true })
        : cursor === null ? page([record], '2') : page([record, listing('2')]), () => details(car(record)));
      await crawler(adapter, holder.store).crawl(search('a', { maxPagesPerSweep: mode === 'partial' ? 1 : 10 }), new AbortController().signal);
      assert.equal(adapter.calls.some(call => call.startsWith('card:')), false);
      assert.equal((holder.store.getQuery('a').coverage.enrichment as { stopReason: string }).stopReason, 'catalogue_not_healthy');
    });
  }
});

test('два поисковых цикла разделяют FIFO и durable identity claim, без двойной карточки', async t => {
  const { holder } = await temporary(t);
  const record = listing('shared');
  const adapter = new Adapter(async (_url, _cursor, signal) => { await waitUntil(Date.now() + 5, signal); return page([record]); },
    async (_id, signal) => { await waitUntil(Date.now() + 5, signal); return details(car(record)); });
  await new MonitorService(new AdapterRegistry().register(adapter), holder.store, [search('a'), search('b')],
    { requestIntervalMs: 0 }).run(new AbortController().signal, { once: true });
  assert.equal(adapter.maximumActive, 1);
  assert.equal(adapter.calls.filter(call => call === 'card:shared').length, 1);
  assert.equal(holder.store.getQuery('a').baselineComplete, true);
  assert.equal(holder.store.getQuery('b').baselineComplete, true);
});

test('scheduler.pages/cards используют один FIFO порядок и durable source backoff', async t => {
  const { holder } = await temporary(t);
  const entered = deferred();
  const release = deferred();
  const record = listing('1');
  const adapter = new Adapter(async (url, _cursor, signal) => {
    if (url.endsWith('/first')) { entered.resolve(); await release.promise; }
    signal.throwIfAborted();
    return page([record]);
  }, () => details(null, 'rate_limited', 120));
  const scheduler = new SourceScheduler(0, holder.store);
  const controller = new AbortController();
  const first = scheduler.collect(adapter, { url: 'https://example.test/first', requestTimeoutSeconds: 1 }, null, controller.signal);
  await entered.promise;
  const second = scheduler.details(adapter, { externalId: '1', url: record.url, requestTimeoutSeconds: 1 }, controller.signal);
  const third = scheduler.collect(adapter, { url: 'https://example.test/third', requestTimeoutSeconds: 1 }, null, controller.signal);
  release.resolve();
  await first;
  const refused = await second;
  assert.equal(refused.outcome, 'rate_limited');
  assert.equal(holder.store.getSource('sim')!.failureCount, 1);
  assert.ok(scheduler.availableAt('sim') > Date.now() + 119_000);
  controller.abort();
  await assert.rejects(third, { name: 'AbortError' });
  assert.deepEqual(adapter.calls, ['page:first:head', 'card:1']);
  assert.equal(adapter.maximumActive, 1);
});

test('отказ карточки сохраняет паузу и nextRunAt, но не меняет полный catalog checkpoint', async t => {
  const { holder } = await temporary(t);
  const record = listing('1');
  const adapter = new Adapter(() => page([record, listing('2')]), () => details(null, 'rate_limited', 120));
  await crawler(adapter, holder.store).crawl(search(), new AbortController().signal);
  const query = holder.store.getQuery('a');
  const source = holder.store.getSource('sim')!;
  assert.equal(query.baselineComplete, true);
  assert.equal(query.coverage.outcome, 'success');
  assert.equal(query.failureCount, 0);
  assert.notEqual(query.lastExhaustedScan, null);
  assert.ok(Date.parse(query.nextRunAt!) >= Date.parse(source.blockedUntil!));
  assert.equal((query.coverage.enrichment as { stopReason: string }).stopReason, 'source_failure');
  assert.deepEqual(adapter.calls, ['page:a:head', 'card:1']);
  const receipt = holder.store.getDetailsState('sim', '1')!;
  assert.equal(receipt.outcome, 'rate_limited');
  assert.ok(Date.parse(receipt.retryAt!) >= Date.parse(source.blockedUntil!));
});

test('invalid successful card получает schema_changed до durable source health', async t => {
  for (const invalid of ['null', 'source', 'id', 'vehicle']) {
    await t.test(invalid, async child => {
      const { holder } = await temporary(child);
      const record = listing('1');
      const changed = invalid === 'null' ? null : car(record, invalid === 'source' ? { source: 'wrong' }
        : invalid === 'id' ? { externalId: 'wrong' } : { vehicle: { ...record.vehicle, year: -1 } });
      const adapter = new Adapter(() => page([record]), () => details(changed));
      await crawler(adapter, holder.store).crawl(search(), new AbortController().signal);
      assert.equal(holder.store.getSource('sim')!.lastOutcome, 'schema_changed');
      assert.equal(holder.store.getSource('sim')!.failureCount, 1);
      assert.equal(holder.store.getDetailsState('sim', '1')!.outcome, 'schema_changed');
      assert.equal(holder.store.getQuery('a').coverage.outcome, 'success');
    });
  }
});

const malformedEnrichments: Array<{ name: string; value: unknown }> = [
  { name: 'null', value: null },
  { name: 'invalid timestamp', value: { observedAt: 'not-a-date', fields: ['make'] } },
  { name: 'empty fields', value: { observedAt: '2026-10-11T00:00:00.000Z', fields: [] } },
  { name: 'non-array fields', value: { observedAt: '2026-10-11T00:00:00.000Z', fields: 'make' } },
  { name: 'unknown vehicle field', value: { observedAt: '2026-10-11T00:00:00.000Z', fields: ['priceMinor'] } },
  { name: 'duplicate vehicle field', value: { observedAt: '2026-10-11T00:00:00.000Z', fields: ['make', 'make'] } },
];

test('malformed card enrichment становится schema_changed, не fatal store error или ложный source success', async t => {
  for (const malformed of malformedEnrichments) {
    await t.test(malformed.name, async child => {
      const { directory, holder } = await temporary(child);
      const record = listing('1');
      const adapter = new Adapter(() => page([record]), () => details(car(record, {
        enrichment: malformed.value as Listing['enrichment'],
      })));
      await crawler(adapter, holder.store).crawl(search(), new AbortController().signal);
      const source = holder.store.getSource('sim')!;
      assert.equal(source.lastOutcome, 'schema_changed');
      assert.equal(source.failureCount, 1);
      assert.equal(holder.store.getDetailsState('sim', '1')!.outcome, 'schema_changed');
      assert.equal(holder.store.getDetailsState('sim', '1')!.record, null);
      assert.equal(holder.store.getQuery('a').coverage.outcome, 'success');
      assert.deepEqual((await FileStore.inspect(directory)).records, [record]);
    });
  }
});

test('malformed catalog enrichment отбрасывается до commitPage; пригодные записи сохраняются без optional HTTP', async t => {
  for (const malformed of malformedEnrichments) {
    await t.test(malformed.name, async child => {
      const { directory, holder } = await temporary(child);
      const good = listing('good');
      const invalid = listing('invalid', { enrichment: malformed.value as Listing['enrichment'] });
      const adapter = new Adapter(() => page([good, invalid]), () => details(car(good)));
      await crawler(adapter, holder.store).crawl(search(), new AbortController().signal);
      const query = holder.store.getQuery('a');
      assert.equal(query.coverage.outcome, 'invalid_records');
      assert.equal(query.coverage.invalidRecords, 1);
      assert.equal(query.baselineComplete, false);
      assert.deepEqual(adapter.calls, ['page:a:head']);
      assert.deepEqual((await FileStore.inspect(directory)).records, [good]);
      assert.deepEqual((await FileStore.inspect(directory)).detailsStates, []);
    });
  }
});

test('deadline карточки не отменяет catalog success; pending claim защищает restart от немедленного дубля', async t => {
  const { directory, holder } = await temporary(t);
  const record = listing('1');
  const adapter = new Adapter(() => page([record]), async (_id, signal) => {
    await waitUntil(Date.now() + 10_000, signal);
    return details(car(record));
  });
  await crawler(adapter, holder.store).crawl(search('a', { maxCycleSeconds: 0.08 }), new AbortController().signal);
  assert.equal(holder.store.getQuery('a').coverage.outcome, 'success');
  assert.equal((holder.store.getQuery('a').coverage.enrichment as { stopReason: string }).stopReason, 'time_budget');
  assert.equal(holder.store.getDetailsState('sim', '1')!.outcome, 'pending');
  assert.equal(holder.store.getSource('sim')!.failureCount, 0);
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  await crawler(adapter, holder.store).crawl(search(), new AbortController().signal);
  assert.equal(adapter.calls.filter(call => call === 'card:1').length, 1);
});

test('stop активной карточки сохраняет pending claim, catalog success и ноль source отказов', async t => {
  const { holder } = await temporary(t);
  const controller = new AbortController();
  const record = listing('1');
  const adapter = new Adapter(() => page([record]), async (_id, signal) => {
    controller.abort();
    await waitUntil(Date.now() + 10_000, signal);
    return details(car(record));
  });
  await crawler(adapter, holder.store).crawl(search(), controller.signal);
  assert.equal(holder.store.getQuery('a').coverage.outcome, 'success');
  assert.equal((holder.store.getQuery('a').coverage.enrichment as { stopReason: string }).stopReason, 'interrupted');
  assert.equal(holder.store.getDetailsState('sim', '1')!.outcome, 'pending');
  assert.equal(holder.store.getSource('sim')!.failureCount, 0);
  assert.equal(adapter.active, 0);
});

test('deadline включает durable claim: законченная запись pending не начинает поздний карточный HTTP', async t => {
  const { holder } = await temporary(t);
  const record = listing('1');
  const adapter = new Adapter(() => page([record]), () => details(car(record)));
  const delayed = wrappedStore(holder.store, { async beginDetailsAttempt(...args: Parameters<FileStore['beginDetailsAttempt']>) {
    await new Promise(done => setTimeout(done, 120));
    return holder.store.beginDetailsAttempt(...args);
  } });
  await crawler(adapter, delayed, new SourceScheduler(0, holder.store)).crawl(search('a', { maxCycleSeconds: 0.08 }), new AbortController().signal);
  assert.deepEqual(adapter.calls, ['page:a:head']);
  assert.equal(holder.store.getDetailsState('sim', '1')!.outcome, 'pending');
  assert.equal(holder.store.getQuery('a').coverage.outcome, 'success');
  assert.equal((holder.store.getQuery('a').coverage.enrichment as { stopReason: string }).stopReason, 'time_budget');
});

test('полученная карточка сохраняется, если deadline истекает во время durable receipt fsync', async t => {
  const { directory, holder } = await temporary(t);
  const record = listing('1');
  const adapter = new Adapter(() => page([record]), () => details(car(record)));
  const delayed = wrappedStore(holder.store, {
    async finishDetailsAttempt(...args: Parameters<FileStore['finishDetailsAttempt']>) {
      await new Promise(done => setTimeout(done, 120));
      await holder.store.finishDetailsAttempt(...args);
    },
  });
  await crawler(adapter, delayed, new SourceScheduler(0, holder.store)).crawl(search('a', { maxCycleSeconds: 0.08 }), new AbortController().signal);
  assert.equal(holder.store.getDetailsState('sim', '1')!.outcome, 'success');
  assert.equal((await FileStore.inspect(directory)).records[0]!.vehicle.make, 'Make');
  assert.equal(holder.store.getQuery('a').coverage.outcome, 'success');
  assert.equal((holder.store.getQuery('a').coverage.enrichment as { stopReason: string }).stopReason, 'time_budget');
});

test('полученная карточка переживает stop в source-health fsync и очередь не освобождается до записи', async () => {
  const entered = deferred();
  const release = deferred();
  const record = listing('1');
  let health: SourceState | null = null;
  const persistence = { getSource: () => health, async updateSource(_source: string, next: SourceState) {
    entered.resolve(); await release.promise; health = next;
  } };
  const adapter = new Adapter(() => page([record]), () => details(car(record)));
  const scheduler = new SourceScheduler(0, persistence);
  const controller = new AbortController();
  const received = scheduler.details(adapter, { externalId: '1', url: record.url, requestTimeoutSeconds: 1 }, controller.signal);
  await entered.promise;
  const queued = scheduler.collect(adapter, { url: 'https://example.test/queued', requestTimeoutSeconds: 1 }, null, controller.signal);
  assert.deepEqual(adapter.calls, ['card:1']);
  controller.abort();
  release.resolve();
  assert.equal((await received).outcome, 'success');
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(health!.lastOutcome, 'success');
  assert.deepEqual(adapter.calls, ['card:1']);
});

test('ENOSPC receipt остаётся fatal при stop, а catalog checkpoint уже устойчив', async t => {
  const { holder } = await temporary(t);
  const failure = Object.assign(new Error('disk full receipt'), { code: 'ENOSPC' });
  const controller = new AbortController();
  const record = listing('1');
  const failing = wrappedStore(holder.store, { async finishDetailsAttempt() { controller.abort(); throw failure; } });
  const adapter = new Adapter(() => page([record]), () => details(car(record)));
  await assert.rejects(crawler(adapter, failing, new SourceScheduler(0, holder.store)).crawl(search(), controller.signal), error => error === failure);
  assert.equal(holder.store.getQuery('a').coverage.outcome, 'success');
  assert.equal(holder.store.getQuery('a').baselineComplete, true);
  assert.equal(holder.store.getDetailsState('sim', '1')!.outcome, 'pending');
});

test('fatal receipt останавливает и дожидается активной карточки другого источника', async t => {
  const { holder } = await temporary(t);
  const siblingStarted = deferred();
  const failure = Object.assign(new Error('disk full receipt with sibling'), { code: 'ENOSPC' });
  const diskRecord = listing('disk');
  const otherRecord = listing('other', { source: 'other' });
  const disk = new Adapter(() => page([diskRecord]), () => details(car(diskRecord)));
  let siblingAborted = false;
  const other = new Adapter(() => page([otherRecord]), async (_id, signal) => {
    siblingStarted.resolve();
    try { await waitUntil(Date.now() + 30_000, signal); }
    catch (error) { siblingAborted = true; throw error; }
    return details(car(otherRecord));
  });
  other.id = 'other';
  const failing = wrappedStore(holder.store, { async finishDetailsAttempt() { await siblingStarted.promise; throw failure; } });
  const service = new MonitorService(new AdapterRegistry().register(disk).register(other), failing,
    [search('disk'), search('other', { source: 'other' })], { requestIntervalMs: 0 });
  await assert.rejects(service.run(new AbortController().signal, { once: true }), error => error === failure);
  assert.equal(siblingAborted, true);
  assert.equal(other.active, 0);
  assert.equal(holder.store.getQuery('disk').coverage.outcome, 'success');
  assert.equal(holder.store.getQuery('other').coverage.outcome, 'success');
});

test('ошибка source-health записи карточки блокирует queued страницы и новые карточки', async () => {
  const failure = Object.assign(new Error('disk full health'), { code: 'ENOSPC' });
  const entered = deferred();
  const release = deferred();
  const persistence = { getSource: () => null, async updateSource() { entered.resolve(); await release.promise; throw failure; } };
  const record = listing('1');
  const adapter = new Adapter(() => page([record]), () => details(car(record)));
  const scheduler = new SourceScheduler(0, persistence);
  const signal = new AbortController().signal;
  const active = scheduler.details(adapter, { externalId: '1', url: record.url, requestTimeoutSeconds: 1 }, signal);
  await entered.promise;
  const queued = scheduler.collect(adapter, { url: 'https://example.test/queued', requestTimeoutSeconds: 1 }, null, signal);
  release.resolve();
  for (const entry of await Promise.allSettled([active, queued])) {
    assert.equal(entry.status, 'rejected');
    if (entry.status === 'rejected') assert.equal(entry.reason, failure);
  }
  await assert.rejects(scheduler.details(adapter, { externalId: '1', url: record.url, requestTimeoutSeconds: 1 }, signal), error => error === failure);
  assert.deepEqual(adapter.calls, ['card:1']);
});
