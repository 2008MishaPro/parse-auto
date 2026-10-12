import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { CollectPageResult, Listing, Search, SourceAdapter } from '../src/core/contracts.ts';
import { Crawler, type CrawlerCallbacks } from '../src/core/crawler.ts';
import { AdapterRegistry } from '../src/core/registry.ts';
import { SourceScheduler } from '../src/core/scheduler.ts';
import { FileStore } from '../src/core/store.ts';

type Item = { id: string; publishedAt: string | null };
const item = (id: string, publishedAt: string | null = null): Item => ({ id, publishedAt });
const items = (prefix: string, count: number): Item[] => Array.from({ length: count }, (_, index) => item(`${prefix}${index + 1}`));
const identity = (id: string) => JSON.stringify(['sim', id]);
let observation = 0;

function listing(value: Item): Listing {
  return {
    source: 'sim', externalId: value.id, url: `https://example.test/${value.id}`, title: value.id,
    priceMinor: 100, currency: 'RUB', observedAt: new Date(Date.now() + ++observation).toISOString(),
    publishedAt: value.publishedAt,
    vehicle: { make: null, model: null, year: null, mileageKm: null }, provenance: {},
  };
}

// Курсор хранит offset, а не снимок: изменения начала списка сдвигают следующие страницы.
class MutableOffsetSource implements SourceAdapter {
  id = 'sim';
  values: Item[];
  pageSize = 2;
  calls: Array<{ cursor: string | null; offset: number; ids: string[] }> = [];
  beforePage?: (offset: number) => void;
  failingOffset: number | null = null;

  constructor(values: Item[]) { this.values = [...values]; }
  capabilities() { return { pagination: 'offset', sort: ['newest'], publishedAt: false, details: false }; }

  async collectPage(_query: { url: string; requestTimeoutSeconds: number }, cursor: string | null, signal: AbortSignal): Promise<CollectPageResult> {
    signal.throwIfAborted();
    const offset = cursor === null ? 0 : Number(cursor);
    assert.ok(Number.isInteger(offset) && offset >= 0);
    this.beforePage?.(offset);
    if (offset === this.failingOffset) {
      this.calls.push({ cursor, offset, ids: [] });
      return { outcome: 'timeout', records: [], nextCursor: null, endReached: false, diagnostics: {}, retryAfterSeconds: null };
    }
    const current = this.values.slice(offset, offset + this.pageSize);
    this.calls.push({ cursor, offset, ids: current.map(value => value.id) });
    const nextOffset = offset + this.pageSize;
    const nextCursor = nextOffset < this.values.length ? String(nextOffset) : null;
    return {
      outcome: current.length ? 'success' : 'empty', records: current.map(listing), nextCursor,
      endReached: nextCursor === null,
      diagnostics: { availableCount: this.values.length, itemsOnPage: this.pageSize }, retryAfterSeconds: null,
    };
  }

  resetCalls() { this.calls = []; }
}

function search(overrides: Partial<Search> = {}): Search {
  return {
    id: 'coverage', source: 'sim', url: 'https://example.test/search', enabled: true,
    intervalSeconds: 120, overlapPages: 2, sweepIntervalSeconds: 1_000_000_000,
    maxPagesPerSweep: 12, requestTimeoutSeconds: 1, maxCycleSeconds: 90, ...overrides,
  };
}

function crawler(source: SourceAdapter, store: FileStore, callbacks: CrawlerCallbacks = {}) {
  return new Crawler(new AdapterRegistry().register(source), store, new SourceScheduler(0), callbacks);
}

async function crawl(source: SourceAdapter, store: FileStore, query = search(), callbacks: CrawlerCallbacks = {}, forceSweep = false) {
  return crawler(source, store, callbacks).crawl(query, new AbortController().signal, forceSweep);
}

async function temporaryStore() {
  const root = resolve('.tmp');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'coverage-'));
  return { directory, store: await FileStore.open(directory) };
}

async function removeTemporary(directory: string) {
  const target = resolve(directory);
  assert.equal(dirname(target), resolve('.tmp'));
  assert.ok(basename(target).startsWith('coverage-'));
  await rm(target, { recursive: true, force: true });
}

async function discovered(directory: string): Promise<string[]> {
  return (await FileStore.inspect(directory)).events.filter(event => event.type === 'discovered').map(event => event.externalId).sort();
}

test('подтверждённая ёмкость страницы сохраняет оценку обхода на неполной последней странице любого адаптера', async () => {
  const { directory, store } = await temporaryStore();
  try {
    class CapacitySource extends MutableOffsetSource {
      override async collectPage(query: { url: string; requestTimeoutSeconds: number }, cursor: string | null, signal: AbortSignal) {
        const result = await super.collectPage(query, cursor, signal);
        result.diagnostics = { ...result.diagnostics, pageCapacity: this.pageSize, itemsOnPage: result.records.length };
        return result;
      }
    }
    const source = new CapacitySource(items('baseline-', 3));
    await crawl(source, store, search({ maxPagesPerSweep: 2 }));
    const state = store.getQuery('coverage');
    assert.equal(state.baselineComplete, true);
    assert.equal(state.coverage.availablePagesEstimate, 2);
    assert.equal(state.coverage.pages, 2);
    assert.equal(state.coverage.baselineNeedsBudgetIncrease, false);
    assert.equal(state.coverage.status, 'available_exhausted');
    assert.deepEqual(await discovered(directory), []);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('всплеск за пределами двух страниц расширяет poll до конца и сохраняет новые ID ровно один раз', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const source = new MutableOffsetSource(items('old-', 8));
    await crawl(source, store);
    assert.deepEqual(store.getQuery('coverage').coverage.windowIds, items('old-', 4).map(value => identity(value.id)));
    const previousExhausted = store.getQuery('coverage').lastExhaustedScan;
    source.values.unshift(...items('new-', 6));
    source.resetCalls();
    const emitted: string[] = [];
    await crawl(source, store, search(), {
      async onEvent(event) {
        const durable = await FileStore.inspect(directory);
        assert.ok(durable.events.some(saved => saved.eventId === event.eventId));
        emitted.push(event.externalId);
      },
    });
    const state = store.getQuery('coverage');
    assert.deepEqual(source.calls.map(call => call.offset), [0, 2, 4, 6, 8, 10, 12]);
    assert.equal(state.coverage.mode, 'catch_up');
    assert.equal(state.coverage.windowOverflow, true);
    assert.equal(state.coverage.availableExhausted, true);
    assert.equal(state.coverage.requiresFullScan, false);
    assert.equal(state.lastExhaustedScan, state.coverage.finishedAt);
    assert.notEqual(state.lastExhaustedScan, previousExhausted);
    assert.deepEqual(state.coverage.windowIds, items('new-', 4).map(value => identity(value.id)));
    assert.deepEqual(emitted.sort(), items('new-', 6).map(value => value.id).sort());
    await crawl(source, store);
    assert.deepEqual(await discovered(directory), items('new-', 6).map(value => value.id).sort());
  } finally { await store.close(); await removeTemporary(directory); }
});

test('переполнение больше бюджета остаётся partial с gap, cursor и прежним полным checkpoint', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const source = new MutableOffsetSource(items('old-', 6));
    const query = search({ maxPagesPerSweep: 4 });
    await crawl(source, store, query);
    const previous = store.getQuery('coverage');
    source.values.unshift(...items('new-', 10));
    source.resetCalls();
    await crawl(source, store, query);
    const state = store.getQuery('coverage');
    assert.deepEqual(source.calls.map(call => call.offset), [0, 2, 4, 6]);
    assert.equal(state.coverage.status, 'partial');
    assert.equal(state.coverage.windowOverflow, true);
    assert.equal(state.coverage.gapPossible, true);
    assert.equal(state.coverage.gapReason, 'window_overflow');
    assert.equal(state.coverage.requiresFullScan, true);
    assert.equal(state.resumeCursor, '8');
    assert.equal(state.lastExhaustedScan, previous.lastExhaustedScan);
    assert.deepEqual(state.coverage.windowIds, previous.coverage.windowIds);
    assert.deepEqual(await discovered(directory), items('new-', 8).map(value => value.id).sort());
  } finally { await store.close(); await removeTemporary(directory); }
});

test('вставка головы между страницами даёт gap сдвига, следующий проход с головы собирает пропущенный ID', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const source = new MutableOffsetSource(items('old-', 8));
    await crawl(source, store);
    const previous = store.getQuery('coverage');
    source.resetCalls();
    let inserted = false;
    source.beforePage = offset => {
      if (offset === 2 && !inserted) { source.values.unshift(item('inserted-head')); inserted = true; }
    };
    await crawl(source, store, search(), {}, true);
    assert.deepEqual(source.calls[0]!.ids, ['old-1', 'old-2']);
    assert.deepEqual(source.calls[1]!.ids, ['old-2', 'old-3']);
    assert.equal(store.getQuery('coverage').coverage.availableExhausted, true);
    assert.equal(store.getQuery('coverage').coverage.status, 'partial');
    assert.equal(store.getQuery('coverage').coverage.paginationShiftObserved, true);
    assert.ok((store.getQuery('coverage').coverage.overlapRecords as number) > 0);
    assert.equal(store.getQuery('coverage').coverage.gapReason, 'pagination_shift');
    assert.equal(store.getQuery('coverage').coverage.requiresFullScan, true);
    assert.equal(store.getQuery('coverage').lastExhaustedScan, previous.lastExhaustedScan);
    assert.deepEqual(store.getQuery('coverage').coverage.windowIds, previous.coverage.windowIds);
    assert.notEqual(store.getQuery('coverage').coverage.stopReason, 'repeated_page');
    assert.deepEqual(await discovered(directory), []);
    source.resetCalls();
    await crawl(source, store);
    assert.deepEqual(source.calls.map(call => call.offset), [0, 2, 4, 6, 8]);
    assert.equal(store.getQuery('coverage').coverage.requiresFullScan, false);
    assert.deepEqual(await discovered(directory), ['inserted-head']);
    await crawl(source, store);
    assert.deepEqual(await discovered(directory), ['inserted-head']);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('знакомый и поднятый ID на первой странице не останавливает обязательное перекрытие', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const source = new MutableOffsetSource(items('old-', 8));
    await crawl(source, store);
    source.values = [item('old-1'), item('old-8'), item('new-on-second-page'), ...items('old-', 7).slice(1)];
    source.resetCalls();
    await crawl(source, store);
    assert.deepEqual(source.calls.map(call => call.offset), [0, 2]);
    assert.deepEqual(source.calls[0]!.ids, ['old-1', 'old-8']);
    assert.equal(store.getQuery('coverage').coverage.mode, 'poll');
    assert.equal(store.getQuery('coverage').coverage.windowOverflow, false);
    assert.deepEqual(await discovered(directory), ['new-on-second-page']);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('поздно появившийся старый publishedAt и null-дата не отсекаются watermark', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const source = new MutableOffsetSource(items('old-', 6));
    await crawl(source, store);
    source.values.splice(1, 0, item('late-old-date', '2001-01-01T00:00:00.000Z'), item('unknown-date'));
    source.resetCalls();
    await crawl(source, store);
    assert.deepEqual(source.calls.map(call => call.offset), [0, 2]);
    assert.deepEqual(await discovered(directory), ['late-old-date', 'unknown-date']);
    const records = (await FileStore.inspect(directory)).records;
    assert.equal(records.find(record => record.externalId === 'late-old-date')!.publishedAt, '2001-01-01T00:00:00.000Z');
    assert.equal(records.find(record => record.externalId === 'unknown-date')!.publishedAt, null);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('restart хвоста сохраняет опорное окно и full checkpoint до полного нового прохода с головы', async () => {
  const { directory, store } = await temporaryStore();
  let current = store;
  try {
    const source = new MutableOffsetSource(items('old-', 8));
    await crawl(source, current);
    const previous = current.getQuery('coverage');
    source.values.unshift(...items('new-', 6));
    await crawl(source, current, search({ maxPagesPerSweep: 3 }));
    assert.equal(current.getQuery('coverage').resumeCursor, '6');
    await current.close();
    current = await FileStore.open(directory);
    source.resetCalls();
    await crawl(source, current);
    const recovered = current.getQuery('coverage');
    assert.deepEqual(source.calls.map(call => call.offset), [6, 8, 10, 12]);
    assert.equal(recovered.resumeCursor, null);
    assert.equal(recovered.coverage.requiresFullScan, true);
    assert.deepEqual(recovered.coverage.windowIds, previous.coverage.windowIds);
    assert.equal(recovered.lastExhaustedScan, previous.lastExhaustedScan);
    source.resetCalls();
    await crawl(source, current);
    const complete = current.getQuery('coverage');
    assert.deepEqual(source.calls.map(call => call.offset), [0, 2, 4, 6, 8, 10, 12]);
    assert.equal(complete.coverage.requiresFullScan, false);
    assert.equal(complete.lastExhaustedScan, complete.coverage.finishedAt);
    assert.deepEqual(complete.coverage.windowIds, items('new-', 4).map(value => identity(value.id)));
    assert.deepEqual(await discovered(directory), items('new-', 6).map(value => value.id).sort());
  } finally { await current.close(); await removeTemporary(directory); }
});

test('сбой после полезной первой страницы сохраняет прежнее окно и не продвигает полный checkpoint', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const source = new MutableOffsetSource(items('old-', 8));
    await crawl(source, store);
    const previous = store.getQuery('coverage');
    source.values.unshift(...items('new-', 6));
    source.failingOffset = 2;
    source.resetCalls();
    await crawl(source, store);
    const state = store.getQuery('coverage');
    assert.deepEqual(source.calls.map(call => call.offset), [0, 2]);
    assert.equal(state.coverage.status, 'error');
    assert.equal(state.coverage.gapPossible, true);
    assert.equal(state.coverage.requiresFullScan, true);
    assert.equal(state.resumeCursor, '2');
    assert.equal(state.lastExhaustedScan, previous.lastExhaustedScan);
    assert.deepEqual(state.coverage.windowIds, previous.coverage.windowIds);
    assert.deepEqual(await discovered(directory), ['new-1', 'new-2']);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('legacy baseline без опорного окна начинает полный проход с головы', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const source = new MutableOffsetSource(items('old-', 6));
    await crawl(source, store);
    const coverage = store.getQuery('coverage').coverage;
    delete coverage.windowIds;
    await store.updateQuery('coverage', { coverage });
    source.values.push(item('legacy-tail'));
    source.resetCalls();
    await crawl(source, store);
    const state = store.getQuery('coverage');
    assert.deepEqual(source.calls.map(call => call.offset), [0, 2, 4, 6]);
    assert.equal(state.coverage.availableExhausted, true);
    assert.equal(state.coverage.requiresFullScan, false);
    assert.equal(state.lastExhaustedScan, state.coverage.finishedAt);
    assert.deepEqual(state.coverage.windowIds, items('old-', 4).map(value => identity(value.id)));
    assert.deepEqual(await discovered(directory), ['legacy-tail']);
  } finally { await store.close(); await removeTemporary(directory); }
});
