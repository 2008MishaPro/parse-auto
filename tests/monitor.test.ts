import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { CollectPageResult, Listing, Search, SourceAdapter } from '../src/core/contracts.ts';
import { AdapterRegistry } from '../src/core/registry.ts';
import { MonitorService, type MonitorOptions } from '../src/core/monitor.ts';
import { SourceScheduler, waitUntil } from '../src/core/scheduler.ts';
import { FileStore, type QueryState } from '../src/core/store.ts';

let observation = 0;
function listing(id: string, priceMinor = 100, source = 'sim'): Listing {
  return {
    source, externalId: id, title: id, url: `https://example.test/${id}`,
    priceMinor, currency: 'RUB', observedAt: new Date(Date.now() + ++observation).toISOString(), publishedAt: null,
    vehicle: { make: null, model: null, year: null, mileageKm: null }, provenance: {},
  };
}
function page(records: Listing[], nextCursor: string | null = null, diagnostics: Record<string, unknown> = {}): CollectPageResult {
  return { outcome: records.length ? 'success' : 'empty', records, nextCursor, endReached: nextCursor === null, diagnostics, retryAfterSeconds: null };
}
function search(id = 'a', overrides: Partial<Search> = {}): Search {
  return { id, source: 'sim', url: `https://example.test/search/${id}`, enabled: true, intervalSeconds: 120,
    overlapPages: 2, sweepIntervalSeconds: 3_600, maxPagesPerSweep: 10, requestTimeoutSeconds: 1, maxCycleSeconds: 90, ...overrides };
}
class Simulator implements SourceAdapter {
  id: string;
  calls: Array<{ url: string; cursor: string | null; timeout: number }> = [];
  active = 0;
  maximumActive = 0;
  handler: (url: string, cursor: string | null, signal: AbortSignal) => CollectPageResult | Promise<CollectPageResult>;
  constructor(handler: Simulator['handler'], id = 'sim') { this.handler = handler; this.id = id; }
  capabilities() { return { pagination: 'cursor', sort: ['newest'], publishedAt: false, details: false }; }
  async collectPage(query: { url: string; requestTimeoutSeconds: number }, cursor: string | null, signal: AbortSignal): Promise<CollectPageResult> {
    this.calls.push({ url: query.url, cursor, timeout: query.requestTimeoutSeconds });
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try { return await this.handler(query.url, cursor, signal); } finally { this.active -= 1; }
  }
}
async function temporaryStore() {
  const root = resolve('.tmp');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'monitor-'));
  const store = await FileStore.open(directory);
  return { directory, store };
}
async function removeTemporary(directory: string) {
  const target = resolve(directory);
  assert.equal(dirname(target), resolve('.tmp'));
  assert.ok(basename(target).startsWith('monitor-'));
  await rm(target, { recursive: true, force: true });
}
function monitor(adapter: SourceAdapter, store: FileStore, searches = [search()], options: MonitorOptions = {}) {
  return new MonitorService(new AdapterRegistry().register(adapter), store, searches, { requestIntervalMs: 0, ...options });
}
async function once(adapter: SourceAdapter, store: FileStore, searches = [search()], options: MonitorOptions = {}) {
  await monitor(adapter, store, searches, options).run(new AbortController().signal, { once: true });
}

test('точный URL собирается один раз, параметры дублей объединяются', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const adapter = new Simulator((_url, cursor) => cursor === null ? page([listing('1')], '2') : page([listing('2')]));
    await once(adapter, store, [search('z', { url: 'https://example.test/one', maxPagesPerSweep: 1, maxCycleSeconds: 0.001 }),
      search('a', { url: 'https://example.test/one', intervalSeconds: 10, maxPagesPerSweep: 2, requestTimeoutSeconds: 2, maxCycleSeconds: 1 }), search('disabled', { enabled: false })]);
    assert.equal(adapter.calls.length, 2);
    assert.equal(adapter.calls[0]!.timeout, 2);
    assert.equal(store.getQuery('a').baselineComplete, true);
    assert.deepEqual(store.getQuery('a').coverage.aliases, ['a', 'z']);
    const state = await FileStore.inspect(directory);
    assert.equal(state.queries.z, undefined);
    assert.equal(state.events.length, 0);
    const due = Date.parse(store.getQuery('a').nextRunAt!) - Date.parse(store.getQuery('a').lastAttempt!);
    assert.equal(due, 10_000);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('baseline обходит известные ID до подтверждённого конца', async () => {
  const { directory, store } = await temporaryStore();
  try {
    await store.commitPage('a', 'seed', null, [listing('1')], null);
    const adapter = new Simulator((_url, cursor) => cursor === null ? page([listing('1'), listing('2')], '2') : page([listing('3')]));
    await once(adapter, store);
    assert.deepEqual(adapter.calls.map(call => call.cursor), [null, '2']);
    assert.equal(store.getQuery('a').baselineComplete, true);
    assert.notEqual(store.getQuery('a').lastExhaustedScan, null);
    const state = await FileStore.inspect(directory);
    assert.deepEqual(state.records.map(record => record.externalId).sort(), ['1', '2', '3']);
    assert.deepEqual(state.events, []);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('сбой страницы сохраняет полезное, restart продолжает failed cursor, хвост не закрывает baseline', async () => {
  const { directory, store } = await temporaryStore();
  let current = store;
  try {
    const first = new Simulator((_url, cursor) => cursor === null ? page([listing('1')], '2') : {
      outcome: 'timeout', records: [listing('2')], nextCursor: '3', endReached: false, diagnostics: {}, retryAfterSeconds: null,
    });
    await once(first, current);
    assert.equal(current.getQuery('a').resumeCursor, '2');
    assert.equal(current.getQuery('a').lastExhaustedScan, null);
    assert.equal((await FileStore.inspect(directory)).records.length, 2);
    // В этом тесте проверяется cursor/replay; ожидание backoff отдельно ниже.
    await current.updateQuery('a', { nextRunAt: new Date(0).toISOString() });
    await current.updateSource('sim', { ...current.getSource('sim')!, blockedUntil: new Date(0).toISOString() });
    await current.close();
    current = await FileStore.open(directory);
    const recovered = new Simulator((_url, cursor) => cursor === null ? page([listing('1')], '2') : page([listing('2'), listing('3')]));
    await once(recovered, current);
    assert.deepEqual(recovered.calls.map(call => call.cursor), ['2']);
    assert.equal(current.getQuery('a').baselineComplete, false);
    assert.equal(current.getQuery('a').lastExhaustedScan, null);
    assert.equal(current.getQuery('a').coverage.requiresFullScan, true);
    assert.ok((current.getQuery('a').coverage.overdueMs as number) > 0);
    await once(recovered, current);
    assert.equal(current.getQuery('a').baselineComplete, true);
    assert.deepEqual(recovered.calls.map(call => call.cursor), ['2', null, '2']);
    assert.equal((await FileStore.inspect(directory)).events.length, 0);
  } finally { await current.close(); await removeTemporary(directory); }
});

test('повтор cursor и одинаковый набор ID обнаруживаются отдельно', async () => {
  for (const repeatedPage of [false, true]) {
    const { directory, store } = await temporaryStore();
    try {
      const adapter = new Simulator((_url, cursor) => cursor === null ? page([listing('1')], '2')
        : repeatedPage ? page([listing('1')]) : page([listing('2')], '2'));
      await once(adapter, store);
      assert.equal(store.getQuery('a').coverage.status, 'error');
      assert.equal(store.getQuery('a').coverage.stopReason, repeatedPage ? 'repeated_page' : 'repeated_cursor');
      assert.equal(store.getQuery('a').resumeCursor, '2');
      assert.equal(store.getQuery('a').baselineComplete, false);
      assert.equal(adapter.calls.length, 2);
    } finally { await store.close(); await removeTemporary(directory); }
  }
});

test('бюджет страниц не закрывает baseline; доступный source cap виден', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const adapter = new Simulator((_url, cursor) => cursor === null ? page([listing('1')], '2') : page([listing('2')]));
    await once(adapter, store, [search('a', { maxPagesPerSweep: 1 })]);
    assert.equal(store.getQuery('a').coverage.gapPossible, true);
    assert.equal(store.getQuery('a').coverage.baselineNeedsBudgetIncrease, true);
    await once(adapter, store, [search('a', { maxPagesPerSweep: 1 })]);
    assert.equal(store.getQuery('a').baselineComplete, false);
    assert.equal(store.getQuery('a').lastExhaustedScan, null);
    assert.equal(store.getQuery('a').coverage.status, 'partial');
    const limited = new Simulator(() => page([listing('limited')], null, { coverageLimited: true }));
    await once(limited, store, [search('limited')]);
    assert.equal(store.getQuery('limited').baselineComplete, true);
    assert.equal(store.getQuery('limited').coverage.status, 'partial');
    assert.equal(store.getQuery('limited').coverage.gapPossible, true);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('два поиска делают последовательные циклы; источник освобождается между страницами', async () => {
  const { directory, store } = await temporaryStore();
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 2_000);
  try {
    const adapter = new Simulator(async (url, cursor, signal) => {
      await waitUntil(Date.now() + 2, signal);
      const id = url.split('/').at(-1)!;
      return page([listing(`${id}-${cursor ?? '1'}`)], cursor === null ? '2' : null);
    });
    const cycles: Record<string, number> = { a: 0, b: 0 };
    const running: Record<string, number> = { a: 0, b: 0 };
    const starts: Record<string, number[]> = { a: [], b: [] };
    await monitor(adapter, store, [search('a', { intervalSeconds: 0.025 }), search('b', { intervalSeconds: 0.025 })], {
      onDiagnostic(diagnostic) {
        if (diagnostic.type === 'cycle_started') {
          running[diagnostic.searchId]! += 1;
          starts[diagnostic.searchId]!.push(Date.now());
          assert.equal(running[diagnostic.searchId], 1);
        }
        if (diagnostic.type === 'cycle_finished') {
          running[diagnostic.searchId]! -= 1;
          cycles[diagnostic.searchId]! += 1;
          if (cycles.a! >= 3 && cycles.b! >= 3) controller.abort();
        }
      },
    }).run(controller.signal);
    assert.ok(cycles.a! >= 3 && cycles.b! >= 3);
    assert.equal(adapter.maximumActive, 1);
    assert.deepEqual(adapter.calls.slice(0, 4).map(call => `${call.url.split('/').at(-1)}:${call.cursor ?? '1'}`), ['a:1', 'b:1', 'a:2', 'b:2']);
    for (const id of ['a', 'b']) {
      for (let index = 1; index < starts[id]!.length; index++) assert.ok(starts[id]![index]! - starts[id]![index - 1]! >= 24);
      const state = store.getQuery(id);
      assert.equal(state.coverage.mode, 'poll');
      assert.notEqual(state.lastExhaustedScan, state.lastSuccess);
    }
  } finally { clearTimeout(safety); await store.close(); await removeTemporary(directory); }
});

test('событие выводится после durable commit; повтор наблюдения не создаёт дубликат', async () => {
  const { directory, store } = await temporaryStore();
  try {
    await once(new Simulator(() => page([listing('1', 100)])), store);
    const observed = [listing('1', 200), listing('2', 300)];
    const output: string[] = [];
    await once(new Simulator(() => page(observed)), store, [search()], {
      async onEvent(event) {
        const durable = await FileStore.inspect(directory);
        assert.ok(durable.events.some(saved => saved.eventId === event.eventId));
        output.push(event.type);
      },
    });
    assert.deepEqual(output.sort(), ['discovered', 'price_changed']);
    await once(new Simulator(() => page(observed)), store);
    assert.equal((await FileStore.inspect(directory)).events.length, 2);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('невалидные DTO учитываются, пригодные сохраняются без продвижения страницы', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const invalid = { ...listing('bad'), priceMinor: -1 };
    await once(new Simulator(() => page([listing('good'), invalid], '2')), store);
    assert.equal(store.getQuery('a').coverage.invalidRecords, 1);
    assert.equal(store.getQuery('a').coverage.stopReason, 'invalid_records');
    assert.equal(store.getQuery('a').resumeCursor, null);
    assert.equal(store.getQuery('a').baselineComplete, false);
    assert.deepEqual((await FileStore.inspect(directory)).records.map(record => record.externalId), ['good']);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('общий backoff источника блокирует другую query и отменяется без ожидания десяти секунд', async () => {
  const scheduler = new SourceScheduler(0);
  const controller = new AbortController();
  const adapter = new Simulator(() => ({ outcome: 'rate_limited', records: [], nextCursor: null, endReached: false,
    diagnostics: {}, retryAfterSeconds: 20 }));
  await scheduler.collect(adapter, { url: 'https://example.test/a', requestTimeoutSeconds: 1 }, null, controller.signal);
  const waiting = scheduler.collect(adapter, { url: 'https://example.test/b', requestTimeoutSeconds: 1 }, null, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(adapter.calls.length, 1);
  assert.ok(scheduler.availableAt('sim') - Date.now() > 19_000);
});

test('ошибка adapter изолирована; другой источник продолжает once', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const registry = new AdapterRegistry()
      .register(new Simulator(() => { throw new Error('сеть недоступна'); }, 'bad'))
      .register(new Simulator(() => page([listing('good', 100, 'good')]), 'good'));
    await new MonitorService(registry, store, [search('bad', { source: 'bad' }), search('good', { source: 'good' })], { requestIntervalMs: 0 }).run(new AbortController().signal, { once: true });
    assert.equal(store.getQuery('bad').coverage.outcome, 'transport_error');
    assert.equal(store.getQuery('good').baselineComplete, true);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('ошибка записи останавливает и дожидается sibling запроса', async () => {
  const state: QueryState = { queryKey: null, baselineComplete: false, lastAttempt: null, lastSuccess: null, lastExhaustedScan: null,
    nextRunAt: null, failureCount: 0, coverage: {}, resumeCursor: null, activeRunId: null };
  let siblingStarted = false;
  let siblingAborted = false;
  const store = {
    async bindSearches(searches: Parameters<FileStore['bindSearches']>[0]) { return Object.fromEntries(searches.map(search => [search.id, search.id])); },
    async ensureSources() {},
    getSource() { return null; },
    async updateSource() {},
    getQuery() { return structuredClone(state); },
    async updateQuery() {},
    async commitPage() { await waitUntil(Date.now() + 5, new AbortController().signal); throw new Error('disk failure'); },
  } as unknown as FileStore;
  const adapter = new Simulator(async (url, _cursor, signal) => {
    if (url.endsWith('/a')) return page([listing('1')]);
    siblingStarted = true;
    try { await waitUntil(Date.now() + 30_000, signal); } catch (error) { siblingAborted = true; throw error; }
    return page([]);
  });
  await assert.rejects(monitor(adapter, store, [search('a'), search('b')]).run(new AbortController().signal, { once: true }), /disk failure/);
  assert.equal(siblingStarted, true);
  assert.equal(siblingAborted, true);
  assert.equal(adapter.active, 0);
});

test('ожидание следующего цикла прерывается сигналом stop', async () => {
  const { directory, store } = await temporaryStore();
  const controller = new AbortController();
  const started = Date.now();
  try {
    const adapter = new Simulator(() => page([listing('1')]));
    await monitor(adapter, store, [search('a', { intervalSeconds: 30 })], {
      onDiagnostic(diagnostic) { if (diagnostic.type === 'cycle_finished') setTimeout(() => controller.abort(), 10); },
    }).run(controller.signal);
    assert.equal(adapter.calls.length, 1);
    assert.ok(Date.now() - started < 1_000);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('смена фильтров сохранённого id отвергается до HTTP, cursor и baseline сохраняются', async () => {
  const { directory, store } = await temporaryStore();
  try {
    await once(new Simulator(() => page([listing('1')], '2')), store, [search('a', { maxPagesPerSweep: 1 })]);
    const previous = store.getQuery('a');
    const adapter = new Simulator(() => page([listing('different')]));
    await assert.rejects(once(adapter, store, [search('a', { url: 'https://example.test/changed' })]), /создайте новый id/);
    assert.equal(adapter.calls.length, 0);
    assert.deepEqual(store.getQuery('a'), previous);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('сохранённый backoff учитывается после restart до начала HTTP', async () => {
  const { directory, store } = await temporaryStore();
  let current = store;
  const controller = new AbortController();
  try {
    await current.updateQuery('a', { failureCount: 2, nextRunAt: new Date(Date.now() + 30_000).toISOString() });
    await current.close();
    current = await FileStore.open(directory);
    const adapter = new Simulator(() => page([listing('1')]));
    setTimeout(() => controller.abort(), 10);
    await monitor(adapter, current).run(controller.signal);
    assert.equal(adapter.calls.length, 0);
    assert.equal(current.getQuery('a').lastAttempt, null);
  } finally { controller.abort(); await current.close(); await removeTemporary(directory); }
});

test('полезный poll не стирает сохранённый возможный gap после restart', async () => {
  const { directory, store } = await temporaryStore();
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 2_000);
  try {
    await once(new Simulator(() => page([listing('1')])), store);
    const adapter = new Simulator(() => page([listing('1')]));
    let cycles = 0;
    await monitor(adapter, store, [search('a', { intervalSeconds: 0.02 })], {
      onDiagnostic(diagnostic) { if (diagnostic.type === 'cycle_finished' && ++cycles === 2) controller.abort(); },
    }).run(controller.signal);
    const coverage = store.getQuery('a').coverage;
    assert.equal(coverage.mode, 'poll');
    assert.equal(coverage.gapPossible, false);
    assert.equal((coverage.lastGap as { reason: string }).reason, 'process_restart');
  } finally { clearTimeout(safety); await store.close(); await removeTemporary(directory); }
});

test('Retry-After устойчиво сохранён до прерывания вывода cycle_finished и page', async () => {
  for (const interruptType of ['page', 'cycle_finished']) {
    const { directory, store } = await temporaryStore();
    try {
      const adapter = new Simulator(() => ({ outcome: 'rate_limited', records: [], nextCursor: null, endReached: false,
        diagnostics: {}, retryAfterSeconds: 60 }));
      const started = Date.now();
      await assert.rejects(once(adapter, store, [search('a', { intervalSeconds: 1 })], {
        onDiagnostic(diagnostic) { if (diagnostic.type === interruptType) throw new Error('output interrupted'); },
      }), /output interrupted/);
      const persisted = (await FileStore.inspect(directory)).queries.a!;
      assert.equal(persisted.failureCount, 1);
      assert.equal(persisted.coverage.outcome, 'rate_limited');
      assert.ok(Date.parse(persisted.nextRunAt!) >= started + 60_000);
    } finally { await store.close(); await removeTemporary(directory); }
  }
});

test('отказ полезной страницы сохраняет Retry-After до аварии сразу после page commit', async () => {
  const { directory, store } = await temporaryStore();
  const started = Date.now();
  const failure = new Error('crash after committed partial page');
  try {
    const interruptedStore = {
      bindSearches: store.bindSearches.bind(store),
      ensureSources: store.ensureSources.bind(store),
      getSource: store.getSource.bind(store),
      updateSource: store.updateSource.bind(store),
      getQuery: store.getQuery.bind(store),
      updateQuery: store.updateQuery.bind(store),
      async commitPage(...args: Parameters<FileStore['commitPage']>) {
        await store.commitPage(...args);
        throw failure;
      },
    } as unknown as FileStore;
    const adapter = new Simulator(() => ({ outcome: 'partial', records: [listing('useful')],
      nextCursor: '2', endReached: false, diagnostics: {}, retryAfterSeconds: 60 }));
    await assert.rejects(once(adapter, interruptedStore), error => error === failure);
    const persisted = await FileStore.inspect(directory);
    assert.deepEqual(persisted.records.map(record => record.externalId), ['useful']);
    assert.equal(persisted.queries.a!.resumeCursor, null);
    assert.equal(persisted.queries.a!.failureCount, 1);
    assert.equal(persisted.queries.a!.coverage.status, 'error');
    assert.equal(persisted.queries.a!.coverage.gapPossible, true);
    assert.ok(Date.parse(persisted.queries.a!.nextRunAt!) >= started + 60_000);
    assert.deepEqual(persisted.events, []);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('legacy resume без baseline flag показывает недостаточный бюджет и при незавершённом, и при полном хвосте', async () => {
  for (const exhaustedTail of [false, true]) {
    const { directory, store } = await temporaryStore();
    let current = store;
    try {
      await current.updateQuery('a', { resumeCursor: exhaustedTail ? '29' : '5', coverage: {} });
      await current.close();
      current = await FileStore.open(directory);
      assert.equal(current.getQuery('a').coverage.baselineNeedsBudgetIncrease, undefined);
      const adapter = new Simulator((_url, cursor) => {
        const currentPage = Number(cursor);
        const end = exhaustedTail && currentPage === 30;
        return page([listing(`page-${currentPage}`)], end ? null : String(currentPage + 1),
          exhaustedTail ? { availableCount: 1_200, itemsOnPage: 40 } : {});
      });
      await once(adapter, current, [search('a', { maxPagesPerSweep: 2 })]);
      const state = current.getQuery('a');
      assert.equal(state.coverage.resumed, true);
      assert.equal(state.coverage.availableExhausted, exhaustedTail);
      assert.equal(state.coverage.baselineNeedsBudgetIncrease, true);
      assert.equal(state.coverage.requiredAction, 'increase_maxPagesPerSweep_or_narrow_query');
      assert.equal(state.baselineComplete, false);
      assert.equal(state.lastExhaustedScan, null);
      assert.equal(adapter.calls.length, 2);
      if (exhaustedTail) assert.equal(state.coverage.availablePagesEstimate, 30);
    } finally { await current.close(); await removeTemporary(directory); }
  }
});
