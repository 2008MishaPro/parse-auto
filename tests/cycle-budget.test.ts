import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { CollectPageResult, Listing, Search, SourceAdapter } from '../src/core/contracts.ts';
import { Crawler, type CrawlerCallbacks } from '../src/core/crawler.ts';
import { MonitorService } from '../src/core/monitor.ts';
import { AdapterRegistry } from '../src/core/registry.ts';
import { SourceScheduler, waitUntil } from '../src/core/scheduler.ts';
import { FileStore, type QueryState } from '../src/core/store.ts';

let observation = 0;
function listing(id: string, priceMinor = 100): Listing {
  return {
    source: 'sim', externalId: id, title: id, url: `https://example.test/${id}`,
    priceMinor, currency: 'RUB', observedAt: new Date(Date.now() + ++observation).toISOString(), publishedAt: null,
    vehicle: { make: null, model: null, year: null, mileageKm: null }, provenance: {},
  };
}
function page(records: Listing[], nextCursor: string | null = null): CollectPageResult {
  return { outcome: records.length ? 'success' : 'empty', records, nextCursor, endReached: nextCursor === null,
    diagnostics: {}, retryAfterSeconds: null };
}
function search(id = 'a', overrides: Partial<Search> = {}): Search {
  return { id, source: 'sim', url: `https://example.test/search/${id}`, enabled: true, intervalSeconds: 0.02,
    overlapPages: 2, sweepIntervalSeconds: 3_600, maxPagesPerSweep: 10, requestTimeoutSeconds: 1,
    maxCycleSeconds: 0.1, ...overrides };
}
class Simulator implements SourceAdapter {
  id = 'sim';
  calls: Array<{ url: string; cursor: string | null }> = [];
  active = 0;
  maximumActive = 0;
  handler: (url: string, cursor: string | null, signal: AbortSignal) => CollectPageResult | Promise<CollectPageResult>;
  constructor(handler: Simulator['handler']) { this.handler = handler; }
  capabilities() { return { pagination: 'cursor', sort: ['newest'], publishedAt: false, details: false }; }
  async collectPage(query: { url: string; requestTimeoutSeconds: number }, cursor: string | null, signal: AbortSignal): Promise<CollectPageResult> {
    this.calls.push({ url: query.url, cursor });
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try { return await this.handler(query.url, cursor, signal); }
    finally { this.active -= 1; }
  }
}
function pause(milliseconds: number): Promise<void> {
  return new Promise(resolvePause => setTimeout(resolvePause, milliseconds));
}
function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>(resolveDeferred => { resolvePromise = resolveDeferred; });
  return { promise, resolve: resolvePromise };
}
async function temporaryStore() {
  const root = resolve('.tmp');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'cycle-budget-'));
  return { directory, store: await FileStore.open(directory) };
}
async function removeTemporary(directory: string) {
  const target = resolve(directory);
  assert.equal(dirname(target), resolve('.tmp'));
  assert.ok(basename(target).startsWith('cycle-budget-'));
  await rm(target, { recursive: true, force: true });
}
function crawler(adapter: SourceAdapter, store: FileStore, scheduler = new SourceScheduler(0), callbacks: CrawlerCallbacks = {}) {
  return new Crawler(new AdapterRegistry().register(adapter), store, scheduler, callbacks);
}
function assertTimeBudget(state: QueryState, previousFailureCount = 0) {
  assert.equal(state.coverage.status, 'partial');
  assert.equal(state.coverage.stopReason, 'time_budget');
  assert.equal(state.coverage.gapPossible, true);
  assert.equal(state.coverage.gapReason, 'time_budget');
  assert.equal(state.coverage.requiresFullScan, true);
  assert.equal(state.failureCount, previousFailureCount);
  assert.equal((state.coverage.lastGap as { reason: string }).reason, 'time_budget');
  assert.ok(Date.parse(state.nextRunAt!) >= Date.parse(state.coverage.finishedAt as string) + 20,
    'после исчерпания бюджета следующий цикл должен ждать свой интервал');
}

test('общий бюджет отменяет первый HTTP, сохраняет прошлые checkpoints и не усиливает source backoff', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const previous = new Date(Date.now() - 1_000).toISOString();
    await store.updateQuery('a', { baselineComplete: true, lastSuccess: previous, lastExhaustedScan: previous, failureCount: 3 });
    const scheduler = new SourceScheduler(0);
    const adapter = new Simulator(async (_url, _cursor, signal) => {
      await waitUntil(Date.now() + 10_000, signal);
      return page([listing('too-late')]);
    });
    await crawler(adapter, store, scheduler).crawl(search('a', { maxCycleSeconds: 0.05 }), new AbortController().signal);
    const state = store.getQuery('a');
    assertTimeBudget(state, 3);
    assert.equal(state.baselineComplete, true);
    assert.equal(state.lastSuccess, previous);
    assert.equal(state.lastExhaustedScan, previous);
    assert.equal(state.resumeCursor, null);
    assert.equal(adapter.calls.length, 1);
    assert.equal(adapter.active, 0);
    assert.equal(scheduler.availableAt('sim'), 0);
    assert.deepEqual((await FileStore.inspect(directory)).records, []);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('watch после time_budget выдерживает новый интервал и не повторяет просроченный цикл сразу', async () => {
  const { directory, store } = await temporaryStore();
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 1_500);
  try {
    const adapter = new Simulator(async (_url, _cursor, signal) => {
      await waitUntil(Date.now() + 10_000, signal);
      return page([listing('late')]);
    });
    const starts: number[] = [];
    let finished = 0;
    const service = new MonitorService(new AdapterRegistry().register(adapter), store,
      [search('a', { maxCycleSeconds: 0.04, intervalSeconds: 0.06 })], {
        requestIntervalMs: 0,
        onDiagnostic(diagnostic) {
          if (diagnostic.type === 'cycle_started') starts.push(Date.now());
          if (diagnostic.type === 'cycle_finished' && ++finished === 2) controller.abort();
        },
      });
    await service.run(controller.signal);
    assert.equal(finished, 2);
    assert.equal(adapter.calls.length, 2);
    assert.equal(starts.length, 2);
    assert.ok(starts[1]! - starts[0]! >= 90, '40 мс обхода плюс 60 мс интервала не должны стать busy loop');
    assert.equal(store.getQuery('a').coverage.stopReason, 'time_budget');
    assert.equal(store.getQuery('a').failureCount, 0);
  } finally { clearTimeout(safety); await store.close(); await removeTemporary(directory); }
});

test('короткий time_budget сохраняет start-to-start срок при достаточном интервале поиска', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const adapter = new Simulator(async (_url, _cursor, signal) => {
      await waitUntil(Date.now() + 10_000, signal);
      return page([listing('late')]);
    });
    const result = await crawler(adapter, store).crawl(search('a', { maxCycleSeconds: 0.04, intervalSeconds: 20 }), new AbortController().signal);
    const state = store.getQuery('a');
    assert.equal(state.coverage.stopReason, 'time_budget');
    assert.equal(Date.parse(state.nextRunAt!), result.startedAt + 20_000,
      'короткий обход не должен сдвигать двадцатисекундный start-to-start интервал на время своей работы');
  } finally { await store.close(); await removeTemporary(directory); }
});

test('страница до deadline сохраняется; restart обходит непроверенный хвост, затем полный baseline без событий replay', async () => {
  const { directory, store } = await temporaryStore();
  let current = store;
  try {
    const first = new Simulator(async (_url, cursor, signal) => {
      if (cursor === null) return page([listing('1')], '2');
      await waitUntil(Date.now() + 10_000, signal);
      return page([listing('lost')]);
    });
    await crawler(first, current).crawl(search(), new AbortController().signal);
    assertTimeBudget(current.getQuery('a'));
    assert.equal(current.getQuery('a').resumeCursor, '2');
    assert.equal(current.getQuery('a').baselineComplete, false);
    assert.equal(current.getQuery('a').lastSuccess, null);
    assert.equal(current.getQuery('a').lastExhaustedScan, null);
    assert.deepEqual(first.calls.map(call => call.cursor), [null, '2']);
    assert.deepEqual((await FileStore.inspect(directory)).records.map(record => record.externalId), ['1']);
    await current.close();
    current = await FileStore.open(directory);
    const resumed = new Simulator((_url, cursor) => cursor === null ? page([listing('1')], '2') : page([listing('2')]));
    await crawler(resumed, current).crawl(search(), new AbortController().signal);
    assert.deepEqual(resumed.calls.map(call => call.cursor), ['2']);
    assert.equal(current.getQuery('a').baselineComplete, false);
    assert.equal(current.getQuery('a').lastExhaustedScan, null);
    assert.equal(current.getQuery('a').lastSuccess, null);
    assert.equal(current.getQuery('a').coverage.requiresFullScan, true);
    await crawler(resumed, current).crawl(search(), new AbortController().signal);
    assert.deepEqual(resumed.calls.map(call => call.cursor), ['2', null, '2']);
    assert.equal(current.getQuery('a').baselineComplete, true);
    assert.notEqual(current.getQuery('a').lastExhaustedScan, null);
    assert.deepEqual((await FileStore.inspect(directory)).events, []);
    await current.close();
    current = await FileStore.open(directory);
    const replayed = await FileStore.inspect(directory);
    assert.deepEqual(replayed.records.map(record => record.externalId).sort(), ['1', '2']);
    assert.deepEqual(replayed.events, []);
    assert.equal(current.getQuery('a').baselineComplete, true);
  } finally { await current.close(); await removeTemporary(directory); }
});

test('время durable callback входит в бюджет: событие сохранено, второй HTTP не начат и replay не дублирует изменение', async () => {
  const { directory, store } = await temporaryStore();
  let current = store;
  try {
    await crawler(new Simulator(() => page([listing('1', 100)])), current).crawl(search(), new AbortController().signal);
    const previous = current.getQuery('a');
    const changed = listing('1', 200);
    const adapter = new Simulator((_url, cursor) => cursor === null ? page([changed], '2') : page([listing('2')]));
    let outputs = 0;
    await crawler(adapter, current, new SourceScheduler(0), {
      async onEvent(event) {
        const durable = await FileStore.inspect(directory);
        assert.ok(durable.events.some(saved => saved.eventId === event.eventId));
        outputs += 1;
        await pause(150);
      },
    }).crawl(search('a', { maxCycleSeconds: 0.08 }), new AbortController().signal);
    assertTimeBudget(current.getQuery('a'));
    assert.equal(current.getQuery('a').resumeCursor, '2');
    assert.equal(current.getQuery('a').lastSuccess, previous.lastSuccess);
    assert.equal(current.getQuery('a').lastExhaustedScan, previous.lastExhaustedScan);
    assert.equal(outputs, 1);
    assert.deepEqual(adapter.calls.map(call => call.cursor), [null]);
    await current.close();
    current = await FileStore.open(directory);
    const recovered = new Simulator((_url, cursor) => cursor === null ? page([changed], '2') : page([listing('2')]));
    await crawler(recovered, current).crawl(search(), new AbortController().signal);
    await crawler(recovered, current).crawl(search(), new AbortController().signal);
    const persisted = await FileStore.inspect(directory);
    assert.equal(persisted.events.filter(event => event.type === 'price_changed').length, 1);
    assert.equal(persisted.events.length, 2); // После baseline ID 2 обнаружен при успешном восстановлении.
  } finally { await current.close(); await removeTemporary(directory); }
});

test('deadline включает очередь записи перед первым HTTP; незавершённый durable write не отменяется', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const delayed = {
      getQuery: store.getQuery.bind(store),
      async updateQuery(id: string, patch: Partial<QueryState>) {
        if (patch.lastAttempt !== undefined) await pause(120);
        await store.updateQuery(id, patch);
      },
      commitPage: store.commitPage.bind(store),
    } as unknown as FileStore;
    const adapter = new Simulator(() => page([listing('unexpected')]));
    await crawler(adapter, delayed).crawl(search('a', { maxCycleSeconds: 0.05 }), new AbortController().signal);
    assertTimeBudget(store.getQuery('a'));
    assert.equal(adapter.calls.length, 0);
    assert.notEqual((await FileStore.inspect(directory)).queries.a!.lastAttempt, null);
    assert.equal(store.getQuery('a').baselineComplete, false);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('ожидание занятого FIFO истекает независимо от здорового sibling; очередь сохраняет порядок и один HTTP', async () => {
  const { directory, store } = await temporaryStore();
  const entered = deferred();
  const release = deferred();
  const scheduler = new SourceScheduler(0);
  let siblingFinished = false;
  const adapter = new Simulator(async url => {
    if (url.endsWith('/sibling')) {
      entered.resolve();
      await release.promise;
      siblingFinished = true;
    }
    return page([listing(url.endsWith('/sibling') ? 'sibling' : 'healthy')]);
  });
  const sibling = scheduler.collect(adapter, { url: 'https://example.test/sibling', requestTimeoutSeconds: 1 }, null, new AbortController().signal);
  const safety = setTimeout(release.resolve, 400);
  try {
    await entered.promise;
    await crawler(adapter, store, scheduler).crawl(search('queued', { maxCycleSeconds: 0.05 }), new AbortController().signal);
    assertTimeBudget(store.getQuery('queued'));
    assert.equal(siblingFinished, false, 'deadline ожидающего поиска не должен ждать окончания sibling');
    assert.deepEqual(adapter.calls.map(call => call.url), ['https://example.test/sibling']);
    release.resolve();
    await sibling;
    assert.equal(siblingFinished, true);
    assert.equal(scheduler.availableAt('sim'), 0);
    await crawler(adapter, store, scheduler).crawl(search('healthy'), new AbortController().signal);
    assert.equal(store.getQuery('healthy').baselineComplete, true);
    assert.equal(adapter.maximumActive, 1);
    assert.deepEqual(adapter.calls.map(call => call.url), ['https://example.test/sibling', 'https://example.test/search/healthy']);
  } finally {
    clearTimeout(safety);
    release.resolve();
    await sibling;
    await store.close();
    await removeTemporary(directory);
  }
});

test('deadline включает throttle и сохранённый source backoff, не начиная HTTP и не увеличивая отказ', async t => {
  for (const mode of ['throttle', 'backoff']) {
    await t.test(mode, async () => {
      const { directory, store } = await temporaryStore();
      try {
        const scheduler = new SourceScheduler(mode === 'throttle' ? 250 : 0);
        const adapter = new Simulator(() => page([listing('primer')]));
        if (mode === 'throttle') {
          await scheduler.collect(adapter, { url: 'https://example.test/primer', requestTimeoutSeconds: 1 }, null, new AbortController().signal);
        } else {
          const nextRunAt = new Date(Date.now() + 10_000).toISOString();
          await store.updateQuery('a', { failureCount: 2, nextRunAt });
          scheduler.restoreBackoff('sim', 2, nextRunAt);
        }
        const before = scheduler.availableAt('sim');
        await crawler(adapter, store, scheduler).crawl(search('a', { maxCycleSeconds: 0.05 }), new AbortController().signal);
        assertTimeBudget(store.getQuery('a'), mode === 'backoff' ? 2 : 0);
        assert.equal(adapter.calls.length, mode === 'throttle' ? 1 : 0);
        assert.equal(scheduler.availableAt('sim'), before);
        assert.equal(store.getQuery('a').baselineComplete, false);
        assert.equal(store.getQuery('a').lastSuccess, null);
      } finally { await store.close(); await removeTemporary(directory); }
    });
  }
});

test('отдельный timeout страницы остаётся error/backoff при достаточном общем бюджете', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const scheduler = new SourceScheduler(0);
    const adapter = new Simulator(async (_url, _cursor, signal) => {
      await waitUntil(Date.now() + 10_000, signal);
      return page([listing('late')]);
    });
    await crawler(adapter, store, scheduler).crawl(search('a', { requestTimeoutSeconds: 1, maxCycleSeconds: 2 }), new AbortController().signal);
    const state = store.getQuery('a');
    assert.equal(state.coverage.status, 'error');
    assert.equal(state.coverage.stopReason, 'timeout');
    assert.equal(state.failureCount, 1);
    assert.equal(state.lastSuccess, null);
    assert.equal(state.resumeCursor, null);
    assert.ok(scheduler.availableAt('sim') > Date.now() + 9_000);
    assert.deepEqual((await FileStore.inspect(directory)).records, []);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('пользовательский stop раньше deadline остаётся interrupted и не превращается в time_budget', async () => {
  const { directory, store } = await temporaryStore();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await store.updateQuery('a', { failureCount: 2 });
    const scheduler = new SourceScheduler(0);
    const adapter = new Simulator(async (_url, _cursor, signal) => {
      timer = setTimeout(() => controller.abort(), 20);
      await waitUntil(Date.now() + 10_000, signal);
      return page([listing('late')]);
    });
    await crawler(adapter, store, scheduler).crawl(search(), controller.signal);
    const state = store.getQuery('a');
    assert.equal(state.coverage.stopReason, 'interrupted');
    assert.equal(state.coverage.status, 'error');
    assert.equal(state.coverage.gapReason, 'interrupted');
    assert.equal(state.failureCount, 2);
    assert.equal(state.baselineComplete, false);
    assert.equal(state.lastSuccess, null);
    assert.equal(scheduler.availableAt('sim'), 0);
  } finally { if (timer) clearTimeout(timer); await store.close(); await removeTemporary(directory); }
});

test('подтверждённый до deadline конец сохраняет успех, даже если fsync страницы заканчивается после бюджета', async () => {
  const { directory, store } = await temporaryStore();
  try {
    const delayed = {
      getQuery: store.getQuery.bind(store),
      updateQuery: store.updateQuery.bind(store),
      async commitPage(...args: Parameters<FileStore['commitPage']>) {
        await pause(120); // Моделирует очередь/диск: commit уже принят, прерывать его нельзя.
        return store.commitPage(...args);
      },
    } as unknown as FileStore;
    const adapter = new Simulator(() => page([listing('terminal')]));
    await crawler(adapter, delayed).crawl(search('a', { maxCycleSeconds: 0.05 }), new AbortController().signal);
    const state = store.getQuery('a');
    assert.equal(state.coverage.stopReason, 'available_end');
    assert.equal(state.coverage.status, 'available_exhausted');
    assert.equal(state.baselineComplete, true);
    assert.notEqual(state.lastSuccess, null);
    assert.notEqual(state.lastExhaustedScan, null);
    assert.equal(state.resumeCursor, null);
    assert.equal(state.failureCount, 0);
    assert.deepEqual((await FileStore.inspect(directory)).records.map(record => record.externalId), ['terminal']);
  } finally { await store.close(); await removeTemporary(directory); }
});

test('ENOSPC после deadline остаётся fatal: ошибку durable commit нельзя принять за time_budget', async () => {
  const { directory, store } = await temporaryStore();
  const controller = new AbortController();
  try {
    const failure = Object.assign(new Error('ENOSPC during durable commit'), { code: 'ENOSPC' });
    const delayed = {
      getQuery: store.getQuery.bind(store),
      updateQuery: store.updateQuery.bind(store),
      async commitPage() {
        await pause(120);
        throw failure;
      },
    } as unknown as FileStore;
    const diagnostics: string[] = [];
    const adapter = new Simulator(() => page([listing('not-committed')], '2'));
    await assert.rejects(crawler(adapter, delayed, new SourceScheduler(0), {
      onDiagnostic(diagnostic) { diagnostics.push(diagnostic.type); },
    }).crawl(search('a', { maxCycleSeconds: 0.05 }), controller.signal), error => error === failure);
    assert.equal(controller.signal.aborted, false);
    assert.deepEqual(diagnostics, ['cycle_started']);
    const durable = await FileStore.inspect(directory);
    assert.deepEqual(durable.records, []);
    assert.deepEqual(durable.events, []);
    assert.equal(durable.queries.a!.resumeCursor, null);
    assert.equal(durable.queries.a!.baselineComplete, false);
    assert.deepEqual(durable.queries.a!.coverage, {});
  } finally { await store.close(); await removeTemporary(directory); }
});

test('пользовательский stop не скрывает конкурентную ошибку durable commit', async t => {
  await t.test('stop и ENOSPC происходят в одном commit', async () => {
    const { directory, store } = await temporaryStore();
    const controller = new AbortController();
    try {
      const failure = Object.assign(new Error('ENOSPC while stopping'), { code: 'ENOSPC' });
      const failing = {
        getQuery: store.getQuery.bind(store),
        updateQuery: store.updateQuery.bind(store),
        async commitPage() {
          controller.abort();
          throw failure;
        },
      } as unknown as FileStore;
      const diagnostics: string[] = [];
      const adapter = new Simulator(() => page([listing('not-committed')]));
      await assert.rejects(crawler(adapter, failing, new SourceScheduler(0), {
        onDiagnostic(diagnostic) { diagnostics.push(diagnostic.type); },
      }).crawl(search(), controller.signal), error => error === failure);
      assert.equal(controller.signal.aborted, true);
      assert.deepEqual(diagnostics, ['cycle_started']);
      const durable = await FileStore.inspect(directory);
      assert.deepEqual(durable.records, []);
      assert.deepEqual(durable.events, []);
      assert.deepEqual(durable.queries.a!.coverage, {});
      assert.equal(durable.queries.a!.baselineComplete, false);
    } finally { await store.close(); await removeTemporary(directory); }
  });

  await t.test('ранний AbortError ожидающего поиска не маскирует поздний ENOSPC другого источника', async () => {
    const { directory, store } = await temporaryStore();
    const controller = new AbortController();
    try {
      const failure = Object.assign(new Error('ENOSPC after sibling cancellation'), { code: 'ENOSPC' });
      // Watch ждёт сохранённый срок до входа в Crawler. Его AbortError успевает
      // отклонить Promise.all, пока другой поиск ещё владеет durable write.
      await store.updateQuery('waiting', { failureCount: 1, nextRunAt: new Date(Date.now() + 10_000).toISOString() });
      let commitFinished = false;
      const order: string[] = [];
      const failing = {
        bindSearches: store.bindSearches.bind(store),
        ensureSources: store.ensureSources.bind(store),
        getSource: store.getSource.bind(store),
        updateSource: store.updateSource.bind(store),
        getQuery: store.getQuery.bind(store),
        updateQuery: store.updateQuery.bind(store),
        async commitPage() {
          order.push('stop');
          controller.abort();
          await pause(60);
          commitFinished = true;
          order.push('disk_failure');
          throw failure;
        },
      } as unknown as FileStore;
      const disk = new Simulator(() => page([{ ...listing('disk-record'), source: 'disk' }]));
      disk.id = 'disk';
      const waiting = new Simulator(() => page([{ ...listing('should-not-fetch'), source: 'waiting' }]));
      waiting.id = 'waiting';
      const service = new MonitorService(new AdapterRegistry().register(disk).register(waiting), failing,
        [search('disk', { source: 'disk' }), search('waiting', { source: 'waiting' })], { requestIntervalMs: 0 });
      await assert.rejects(service.run(controller.signal), error => error === failure);
      assert.equal(commitFinished, true, 'monitor должен дождаться владельца записи перед завершением');
      assert.deepEqual(order, ['stop', 'disk_failure']);
      assert.equal(disk.calls.length, 1);
      assert.equal(disk.active, 0);
      assert.equal(waiting.calls.length, 0);
      const durable = await FileStore.inspect(directory);
      assert.deepEqual(durable.records, []);
      assert.deepEqual(durable.events, []);
      assert.equal(durable.queries.waiting!.lastAttempt, null);
      assert.equal(durable.queries.waiting!.failureCount, 1);
      assert.equal(durable.queries.disk!.baselineComplete, false);
      assert.deepEqual(durable.queries.disk!.coverage, {});
    } finally { await store.close(); await removeTemporary(directory); }
  });
});
