import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { CollectPageResult, Listing, Search, SourceAdapter } from '../src/core/contracts.ts';
import { MonitorService } from '../src/core/monitor.ts';
import { AdapterRegistry } from '../src/core/registry.ts';
import { FileStore } from '../src/core/store.ts';

const url = 'https://fixture.invalid/cars?make=honda';
const otherUrl = 'https://fixture.invalid/cars?make=toyota';
const queryKey = JSON.stringify(['fixture', url]);
let observation = 0;

function listing(priceMinor: number | null = 100, externalId = 'one'): Listing {
  return {
    source: 'fixture', externalId, title: externalId, url: `https://fixture.invalid/${externalId}`,
    priceMinor, currency: 'RUB', observedAt: new Date(Date.UTC(2026, 9, 11, 1, 0, ++observation)).toISOString(),
    publishedAt: null, vehicle: { make: null, model: null, year: null, mileageKm: null }, provenance: {},
  };
}

function search(id: string, overrides: Partial<Search> = {}): Search {
  return {
    id, source: 'fixture', url, enabled: true, intervalSeconds: 120, overlapPages: 2,
    sweepIntervalSeconds: 3_600, maxPagesPerSweep: 10, requestTimeoutSeconds: 1, maxCycleSeconds: 90,
    ...overrides,
  };
}

function page(records: Listing[], nextCursor: string | null = null): CollectPageResult {
  return { outcome: records.length ? 'success' : 'empty', records, nextCursor, endReached: nextCursor === null,
    diagnostics: {}, retryAfterSeconds: null };
}

class Adapter implements SourceAdapter {
  id = 'fixture';
  calls: Array<{ url: string; cursor: string | null; requestTimeoutSeconds: number }> = [];
  handler: (query: Pick<Search, 'url' | 'requestTimeoutSeconds'>, cursor: string | null) => CollectPageResult | Promise<CollectPageResult>;
  constructor(handler: Adapter['handler'] = () => page([listing()])) { this.handler = handler; }
  capabilities() { return { pagination: 'cursor', sort: ['newest'], publishedAt: false, details: false }; }
  async collectPage(query: Pick<Search, 'url' | 'requestTimeoutSeconds'>, cursor: string | null): Promise<CollectPageResult> {
    this.calls.push({ url: query.url, cursor, requestTimeoutSeconds: query.requestTimeoutSeconds });
    return this.handler(query, cursor);
  }
}

async function temporary(t: TestContext) {
  const root = resolve('.tmp');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'search-groups-'));
  const holder = { store: await FileStore.open(directory) };
  t.after(async () => {
    await holder.store.close();
    assert.equal(dirname(resolve(directory)), root);
    assert.ok(basename(directory).startsWith('search-groups-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, holder };
}

function once(store: FileStore, searches: Search[], adapter: Adapter) {
  const monitor = new MonitorService(new AdapterRegistry().register(adapter), store, searches, { requestIntervalMs: 0 });
  return monitor.run(new AbortController().signal, { once: true });
}

async function legacy(store: FileStore, id = 'm', aliases: string[] = []) {
  await store.commitPage(id, 'old-baseline', null, [listing()], '2');
  await store.updateQuery(id, { queryKey, baselineComplete: true, coverage: { aliases, status: 'partial', requiresFullScan: true } });
}

test('состав aliases не меняет canonical baseline, cursor, membership и исторические eventId', async t => {
  const { directory, holder } = await temporary(t);
  const store = holder.store;
  await store.bindSearches([search('m'), search('z')]);
  await store.commitPage('m', 'baseline', null, [listing()], '2');
  await store.updateQuery('m', { baselineComplete: true, lastSuccess: listing().observedAt,
    coverage: { requiresFullScan: true, marker: 'preserved' } });
  const priceEvents = await store.commitPage('z', 'changed', '2', [listing(200)], '3');
  assert.equal(priceEvents.length, 1);
  assert.equal(priceEvents[0]!.searchId, 'm');
  const expectedQuery = store.getQuery('m');
  const expectedEvents = (await FileStore.inspect(directory)).events;
  for (const searches of [
    [search('m', { enabled: false }), search('z')],
    [search('z')],
    [search('a'), search('z')],
  ]) {
    await store.bindSearches(searches);
    assert.deepEqual(store.getQuery(searches.at(-1)!.id), expectedQuery);
    assert.deepEqual(store.getQuery('m'), expectedQuery);
    const state = await FileStore.inspect(directory);
    assert.deepEqual(Object.keys(state.queries), ['m']);
    assert.deepEqual(state.events, expectedEvents);
    for (const alias of searches) assert.deepEqual(state.searchBindings[alias.id], { queryKey, storageId: 'm' });
  }
  const events = await store.commitPage('a', 'next', '3', [listing(300)], '4');
  assert.equal(events.length, 1, 'existing membership emits price change, never a second discovery');
  assert.equal(events[0]!.type, 'price_changed');
  assert.equal(events[0]!.previousPriceMinor, 200);
  assert.equal(events[0]!.searchId, 'm');
});

test('compact/restart и новый alias сохраняют A→null→A, A→B→A и page replay', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.bindSearches([search('m'), search('z')]);
  await holder.store.commitPage('m', 'baseline', null, [listing(100)], null);
  await holder.store.updateQuery('m', { baselineComplete: true });
  assert.deepEqual(await holder.store.commitPage('z', 'unknown', null, [listing(null)], '2'), []);
  await holder.store.bindSearches([search('a'), search('z')]);
  await holder.store.compact();
  const before = await FileStore.inspect(directory);
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  assert.deepEqual(await FileStore.inspect(directory), before);
  assert.equal(holder.store.getQuery('a').baselineComplete, true);
  assert.equal(holder.store.getQuery('a').resumeCursor, '2');
  assert.deepEqual(await holder.store.commitPage('a', 'same-A', '2', [listing(100)], '3'), []);
  const b = await holder.store.commitPage('a', 'to-B', '3', [listing(200)], '4');
  const a = await holder.store.commitPage('z', 'back-A', '4', [listing(100)], null);
  assert.deepEqual([...b, ...a].map(event => [event.type, event.previousPriceMinor, event.priceMinor, event.searchId]),
    [['price_changed', 100, 200, 'm'], ['price_changed', 200, 100, 'm']]);
  assert.deepEqual(await holder.store.commitPage('m', 'to-B', '3', [listing(999)], '4'), []);
  await holder.store.compact();
  assert.deepEqual((await FileStore.inspect(directory)).events, [...b, ...a]);
});

test('monitor продолжает cursor после отключения или удаления первого alias', async t => {
  for (const disabled of [false, true]) await t.test(`disabled root in config: ${disabled}`, async sub => {
    const { directory, holder } = await temporary(sub);
    await holder.store.bindSearches([search('m'), search('z')]);
    await holder.store.commitPage('m', 'baseline', null, [listing()], '2');
    const adapter = new Adapter((_query, cursor) => {
      assert.equal(cursor, '2');
      return page([listing(100, 'two')]);
    });
    await once(holder.store, disabled ? [search('m', { enabled: false }), search('z')] : [search('z')], adapter);
    assert.deepEqual(adapter.calls.map(call => call.cursor), ['2']);
    assert.equal(holder.store.getQuery('z').baselineComplete, false, 'a resumed tail cannot silently close baseline');
    const state = await FileStore.inspect(directory);
    assert.deepEqual(Object.keys(state.queries), ['m']);
    assert.equal(state.records.length, 2);
    assert.deepEqual(state.events, []);
  });
});

test('постоянный root не меняет объединение budgets: один обход, max budgets и min interval', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.bindSearches([search('m')]);
  const adapter = new Adapter((_query, cursor) => cursor === null ? page([listing()], '2') : page([listing(100, 'two')]));
  await once(holder.store, [
    search('a', { maxPagesPerSweep: 1, maxCycleSeconds: 0.001, requestTimeoutSeconds: 0.1 }),
    search('z', { maxPagesPerSweep: 2, maxCycleSeconds: 1, requestTimeoutSeconds: 2, intervalSeconds: 10 }),
    search('disabled', { enabled: false, intervalSeconds: 1, requestTimeoutSeconds: 100, maxPagesPerSweep: 100 }),
  ], adapter);
  assert.equal(adapter.calls.length, 2);
  assert.deepEqual(adapter.calls.map(call => call.requestTimeoutSeconds), [2, 2]);
  const state = holder.store.getQuery('a');
  assert.equal(state.baselineComplete, true);
  assert.equal(state.coverage.maxCycleSeconds, 1);
  assert.deepEqual(state.coverage.aliases, ['a', 'z']);
  assert.equal(Date.parse(state.nextRunAt!) - Date.parse(state.lastAttempt!), 10_000);
  assert.deepEqual(Object.keys((await FileStore.inspect(directory)).queries), ['m']);
});

test('регистрация всех bindings durable до первого HTTP и повторная регистрация не дописывает journal', async t => {
  const { directory, holder } = await temporary(t);
  const adapter = new Adapter(async () => {
    const state = await FileStore.inspect(directory);
    assert.deepEqual(state.searchBindings.a, { queryKey, storageId: 'a' });
    assert.deepEqual(state.searchBindings.z, { queryKey, storageId: 'a' });
    return page([listing()]);
  });
  await once(holder.store, [search('z'), search('a')], adapter);
  assert.equal(adapter.calls.length, 1);
  const before = await FileStore.inspect(directory);
  await holder.store.bindSearches([search('a'), search('z')]);
  assert.deepEqual(await FileStore.inspect(directory), before);
});

test('смена source/URL любого связанного alias, в том числе выключенного, отклоняется до HTTP', async t => {
  for (const change of [{ url: otherUrl }, { source: 'changed-source' }, { url: otherUrl, enabled: false }]) {
    await t.test(JSON.stringify(change), async sub => {
      const { directory, holder } = await temporary(sub);
      await holder.store.bindSearches([search('m'), search('z')]);
      const before = await FileStore.inspect(directory);
      const adapter = new Adapter();
      // bindSearches also checks disabled aliases and sources absent from the active registry.
      await assert.rejects(holder.store.bindSearches([search('m'), search('z', change)]));
      assert.deepEqual(await FileStore.inspect(directory), before);
      if (change.source === undefined) await assert.rejects(once(holder.store, [search('m'), search('z', change)], adapter));
      else {
        const changedAdapter = new Adapter();
        changedAdapter.id = change.source;
        const monitor = new MonitorService(new AdapterRegistry().register(adapter).register(changedAdapter), holder.store,
          [search('m'), search('z', change)], { requestIntervalMs: 0 });
        await assert.rejects(monitor.run(new AbortController().signal, { once: true }));
        assert.equal(changedAdapter.calls.length, 0);
      }
      assert.equal(adapter.calls.length, 0);
    });
  }
});

test('legacy coverage.aliases удерживает фильтр бывшего nonleader до первого HTTP', async t => {
  const { directory, holder } = await temporary(t);
  await legacy(holder.store, 'm', ['m', 'z']);
  const before = await FileStore.inspect(directory);
  const adapter = new Adapter();
  await assert.rejects(once(holder.store, [search('z', { url: otherUrl })], adapter));
  assert.equal(adapter.calls.length, 0);
  assert.deepEqual(await FileStore.inspect(directory), before, 'failed migration has no partial registration');
});

test('старый уникальный exactURL root принят, даже если весь прежний состав удалён', async t => {
  const { directory, holder } = await temporary(t);
  await legacy(holder.store);
  const before = holder.store.getQuery('m');
  await holder.store.bindSearches([search('a')]);
  assert.deepEqual(holder.store.getQuery('a'), before);
  const state = await FileStore.inspect(directory);
  assert.deepEqual(state.searchBindings.a, { queryKey, storageId: 'm' });
  assert.deepEqual(Object.keys(state.queries), ['m']);
  const adapter = new Adapter((_query, cursor) => {
    assert.equal(cursor, '2');
    return page([listing()]);
  });
  await once(holder.store, [search('a')], adapter);
  assert.equal(adapter.calls.length, 1);
  assert.equal(holder.store.getQuery('a').baselineComplete, true);
  assert.deepEqual((await FileStore.inspect(directory)).events, []);
});

test('несколько legacy roots одного exactURL отклоняются явно и без записи/HTTP', async t => {
  const { directory, holder } = await temporary(t);
  await legacy(holder.store, 'm');
  await legacy(holder.store, 'z');
  const before = await FileStore.inspect(directory);
  const adapter = new Adapter();
  await assert.rejects(once(holder.store, [search('a')], adapter), /ambiguous|неоднознач|несколько|конфликт/i);
  assert.equal(adapter.calls.length, 0);
  assert.deepEqual(await FileStore.inspect(directory), before);
});

test('preflight всех групп атомарен: новая группа не записана перед ошибкой другой', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.bindSearches([search('z')]);
  const before = await FileStore.inspect(directory);
  const adapter = new Adapter();
  await assert.rejects(once(holder.store, [search('a', { url: 'https://fixture.invalid/new' }), search('z', { url: otherUrl })], adapter));
  assert.equal(adapter.calls.length, 0);
  assert.deepEqual(await FileStore.inspect(directory), before);
  assert.equal((await FileStore.inspect(directory)).searchBindings.a, undefined);
});

test('выключенная группа переживает compact/restart и снова использует прежний baseline', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.bindSearches([search('m'), search('z')]);
  await holder.store.commitPage('m', 'baseline', null, [listing()], null);
  await holder.store.updateQuery('m', { baselineComplete: true });
  const paused = new Adapter();
  await once(holder.store, [search('m', { enabled: false }), search('z', { enabled: false })], paused);
  assert.equal(paused.calls.length, 0);
  await holder.store.compact();
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  const resumed = new Adapter(() => page([listing(200)]));
  await once(holder.store, [search('z')], resumed);
  assert.equal(resumed.calls.length, 1);
  const state = await FileStore.inspect(directory);
  assert.deepEqual(Object.keys(state.queries), ['m']);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0]!.type, 'price_changed');
  assert.equal(state.events[0]!.searchId, 'm');
});

function checksum(envelope: { version: number; sequence: number; payload: unknown }) {
  return createHash('sha256').update(JSON.stringify({ version: envelope.version, sequence: envelope.sequence, payload: envelope.payload })).digest('hex');
}

test('старый snapshot без searchBindings восстанавливается и принимает новый alias без переписывания событий', async t => {
  const { directory, holder } = await temporary(t);
  await legacy(holder.store);
  const events = await holder.store.commitPage('m', 'before-migration', '2', [listing(200)], '3');
  assert.equal(events.length, 1);
  await holder.store.compact();
  await holder.store.close();
  const snapshot = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'));
  delete snapshot.payload.searchBindings;
  snapshot.checksum = checksum(snapshot);
  await writeFile(join(directory, 'snapshot.json'), `${JSON.stringify(snapshot)}\n`);
  const anchor = JSON.parse(await readFile(join(directory, 'journal.ndjson'), 'utf8'));
  anchor.payload.snapshotChecksum = snapshot.checksum;
  anchor.checksum = checksum(anchor);
  await writeFile(join(directory, 'journal.ndjson'), `${JSON.stringify(anchor)}\n`);
  holder.store = await FileStore.open(directory);
  assert.equal(holder.store.getQuery('m').baselineComplete, true);
  await holder.store.bindSearches([search('a')]);
  assert.equal(holder.store.getQuery('a').resumeCursor, '3');
  assert.deepEqual((await FileStore.inspect(directory)).events, events);
  const next = await holder.store.commitPage('a', 'after-migration', '3', [listing(100)], null);
  assert.equal(next.length, 1);
  assert.equal(next[0]!.previousPriceMinor, 200);
  assert.equal(next[0]!.searchId, 'm');
});

test('ошибка устойчивой регистрации bindings останавливает monitor до HTTP', async t => {
  const { directory, holder } = await temporary(t);
  const probe = await open(join(directory, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const mocked = t.mock.method(prototype, 'writeFile', async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  const adapter = new Adapter();
  try {
    await assert.rejects(once(holder.store, [search('a'), search('z')], adapter), /устойчив|диска|disk full/i);
  } finally { mocked.mock.restore(); }
  assert.equal(adapter.calls.length, 0);
  const state = await FileStore.inspect(directory);
  assert.equal(state.sequence, 0);
  assert.deepEqual(Object.keys(state.searchBindings), []);
});

test('общий alias двух несовместимых legacy groups отклоняется до HTTP', async t => {
  const { directory, holder } = await temporary(t);
  await legacy(holder.store, 'm', ['m', 'shared']);
  await holder.store.commitPage('z', 'other-baseline', null, [listing(100, 'two')], null);
  await holder.store.updateQuery('z', { queryKey: JSON.stringify(['fixture', otherUrl]), coverage: { aliases: ['z', 'shared'] } });
  const before = await FileStore.inspect(directory);
  const adapter = new Adapter();
  await assert.rejects(once(holder.store, [search('m'), search('z', { url: otherUrl })], adapter));
  assert.equal(adapter.calls.length, 0);
  assert.deepEqual(await FileStore.inspect(directory), before);
});

test('ID старого canonical нельзя переиспользовать для другой группы после его удаления из config', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.bindSearches([search('m'), search('z')]);
  await holder.store.commitPage('m', 'baseline', null, [listing()], null);
  await holder.store.updateQuery('m', { baselineComplete: true });
  await holder.store.bindSearches([search('z')]);
  const before = await FileStore.inspect(directory);
  const adapter = new Adapter();
  await assert.rejects(once(holder.store, [search('a', { url: otherUrl }), search('m', { url: otherUrl }), search('z')], adapter));
  assert.equal(adapter.calls.length, 0);
  assert.deepEqual(await FileStore.inspect(directory), before);
});

test('public mutators разрешают alias в canonical и запрещают отвязать queryKey', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.bindSearches([search('m'), search('z')]);
  await holder.store.commitPage('z', 'baseline', null, [listing()], '2');
  await holder.store.updateQuery('z', { baselineComplete: true, failureCount: 3 });
  assert.equal(holder.store.getQuery('m').failureCount, 3);
  assert.equal(holder.store.getQuery('m').resumeCursor, '2');
  const event = await holder.store.commitPage('z', 'price-change', '2', [listing(200)], '3');
  assert.equal(event.length, 1);
  assert.equal(event[0]!.searchId, 'm');
  const before = await FileStore.inspect(directory);
  for (const changedKey of [null, JSON.stringify(['fixture', otherUrl])]) {
    await assert.rejects(holder.store.updateQuery('z', { queryKey: changedKey }));
    await assert.rejects(holder.store.updateQuery('m', { queryKey: changedKey }));
  }
  assert.deepEqual(await FileStore.inspect(directory), before);
  assert.deepEqual(Object.keys(before.queries), ['m']);
  assert.deepEqual(await holder.store.commitPage('m', 'price-change', '2', [listing(999)], '3'), []);
});

test('all-disabled новая группа сохраняет dormant root без HTTP и использует его при включении', async t => {
  const { directory, holder } = await temporary(t);
  const adapter = new Adapter();
  await once(holder.store, [search('z', { enabled: false }), search('m', { enabled: false })], adapter);
  assert.equal(adapter.calls.length, 0);
  const dormant = await FileStore.inspect(directory);
  assert.deepEqual(Object.keys(dormant.queries), ['m']);
  assert.deepEqual(dormant.searchBindings.z, { queryKey, storageId: 'm' });
  assert.deepEqual(dormant.searchBindings.m, { queryKey, storageId: 'm' });
  assert.equal(dormant.queries.m!.baselineComplete, false);
  await holder.store.compact();
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  await once(holder.store, [search('a')], adapter);
  assert.equal(adapter.calls.length, 1);
  assert.equal(holder.store.getQuery('a').baselineComplete, true);
  const resumed = await FileStore.inspect(directory);
  assert.deepEqual(Object.keys(resumed.queries), ['m']);
  assert.deepEqual(resumed.events, []);
});

test('untouched неоднозначная legacy группа не блокирует независимый активный exactURL', async t => {
  const { directory, holder } = await temporary(t);
  await legacy(holder.store, 'm');
  await legacy(holder.store, 'z');
  const m = holder.store.getQuery('m');
  const z = holder.store.getQuery('z');
  const adapter = new Adapter(() => page([listing(100, 'independent')]));
  await once(holder.store, [search('a', { url: otherUrl })], adapter);
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0]!.url, otherUrl);
  assert.deepEqual(holder.store.getQuery('m'), m);
  assert.deepEqual(holder.store.getQuery('z'), z);
  const state = await FileStore.inspect(directory);
  assert.deepEqual(Object.keys(state.queries).sort(), ['a', 'm', 'z']);
  assert.deepEqual(Object.keys(state.searchBindings), ['a']);
  assert.equal(state.queries.a!.baselineComplete, true);
});

test('special IDs __proto__/constructor безопасны при bind, alias mutation и compact/restart', async t => {
  const { directory, holder } = await temporary(t);
  const registrations = [search('constructor'), search('__proto__')];
  const resolved = await holder.store.bindSearches(registrations);
  const storageId = resolved.__proto__!;
  assert.equal(resolved.constructor, storageId);
  assert.ok(Object.hasOwn(resolved, '__proto__'));
  assert.ok(Object.hasOwn(resolved, 'constructor'));
  await holder.store.commitPage('constructor', 'baseline', null, [listing()], '2');
  await holder.store.updateQuery('__proto__', { baselineComplete: true });
  const events = await holder.store.commitPage('constructor', 'price-change', '2', [listing(200)], '3');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.searchId, storageId);
  await holder.store.compact();
  const before = await FileStore.inspect(directory);
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  assert.deepEqual(await FileStore.inspect(directory), before);
  assert.equal(holder.store.getQuery('__proto__').resumeCursor, '3');
  assert.deepEqual(holder.store.getQuery('constructor'), holder.store.getQuery('__proto__'));
  assert.deepEqual(await holder.store.commitPage('__proto__', 'price-change', '2', [listing(900)], '4'), []);
  assert.deepEqual((await FileStore.inspect(directory)).events, events);
});

test('checksummed corruption привязок отклоняется reader и writer без изменения committed файлов', async t => {
  for (const corruption of ['multiple_roots', 'missing_query', 'missing_root_binding', 'alias_reserved_query'] as const) {
    await t.test(corruption, async sub => {
      const { directory, holder } = await temporary(sub);
      await holder.store.bindSearches([search('m'), search('z')]);
      await holder.store.commitPage('m', 'baseline', null, [listing()], null);
      await holder.store.compact();
      await holder.store.close();
      const snapshot = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'));
      if (corruption === 'multiple_roots') {
        snapshot.payload.queries.z = structuredClone(snapshot.payload.queries.m);
        snapshot.payload.searchBindings.find((entry: [string, unknown]) => entry[0] === 'z')[1].storageId = 'z';
      } else if (corruption === 'missing_query') delete snapshot.payload.queries.m;
      else if (corruption === 'missing_root_binding') {
        snapshot.payload.searchBindings = snapshot.payload.searchBindings.filter((entry: [string, unknown]) => entry[0] !== 'm');
      } else snapshot.payload.queries.z = structuredClone(snapshot.payload.queries.m);
      snapshot.checksum = checksum(snapshot);
      await writeFile(join(directory, 'snapshot.json'), `${JSON.stringify(snapshot)}\n`);
      const anchor = JSON.parse(await readFile(join(directory, 'journal.ndjson'), 'utf8'));
      anchor.payload.snapshotChecksum = snapshot.checksum;
      anchor.checksum = checksum(anchor);
      await writeFile(join(directory, 'journal.ndjson'), `${JSON.stringify(anchor)}\n`);
      const snapshotBefore = await readFile(join(directory, 'snapshot.json'));
      const journalBefore = await readFile(join(directory, 'journal.ndjson'));
      await assert.rejects(FileStore.inspect(directory));
      await assert.rejects(async () => { const unexpected = await FileStore.open(directory); await unexpected.close(); });
      assert.deepEqual(await readFile(join(directory, 'snapshot.json')), snapshotBefore);
      assert.deepEqual(await readFile(join(directory, 'journal.ndjson')), journalBefore);
    });
  }
});

async function assertCommittedFilesRejected(directory: string) {
  const snapshotBefore = await readFile(join(directory, 'snapshot.json'));
  const journalBefore = await readFile(join(directory, 'journal.ndjson'));
  await assert.rejects(FileStore.inspect(directory));
  await assert.rejects(async () => { const unexpected = await FileStore.open(directory); await unexpected.close(); });
  assert.deepEqual(await readFile(join(directory, 'snapshot.json')), snapshotBefore);
  assert.deepEqual(await readFile(join(directory, 'journal.ndjson')), journalBefore);
}

test('final guards: checksummed suffix не создаёт alias query/page или root без self-binding', async t => {
  const malformedBatches = [
    { label: 'alias query', payload: { type: 'query', searchId: 'z', patch: { failureCount: 1 } } },
    { label: 'alias page', payload: { type: 'page', searchId: 'z', runId: 'bad-alias-run', cursor: null,
      nextCursor: '2', records: [listing()], events: [] } },
    { label: 'new bound-key query', payload: { type: 'query', searchId: 'unbound', patch: { queryKey } } },
    { label: 'new query without self-binding', payload: { type: 'search_bindings',
      queries: [['unbound', JSON.stringify(['fixture', otherUrl])]], bindings: [] } },
  ];
  for (const malformed of malformedBatches) await t.test(malformed.label, async sub => {
    const { directory, holder } = await temporary(sub);
    await holder.store.bindSearches([search('m'), search('z')]);
    await holder.store.commitPage('m', 'baseline', null, [listing()], null);
    await holder.store.compact();
    const state = await FileStore.inspect(directory);
    await holder.store.close();
    const envelope = { version: 1, sequence: state.sequence + 1, payload: malformed.payload };
    await appendFile(join(directory, 'journal.ndjson'), `${JSON.stringify({ ...envelope, checksum: checksum(envelope) })}\n`);
    await assertCommittedFilesRejected(directory);
  });
});

test('final guards: snapshot не принимает конфликт legacy alias или второй root bound-key', async t => {
  for (const corruption of ['legacy_alias_conflict', 'second_saved_bound_key'] as const) await t.test(corruption, async sub => {
    const { directory, holder } = await temporary(sub);
    await holder.store.bindSearches([search('m'), search('z')]);
    await holder.store.commitPage('m', 'baseline', null, [listing()], null);
    await holder.store.compact();
    await holder.store.close();
    const snapshot = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'));
    snapshot.payload.queries.unbound = structuredClone(snapshot.payload.queries.m);
    if (corruption === 'legacy_alias_conflict') {
      snapshot.payload.queries.unbound.queryKey = JSON.stringify(['fixture', otherUrl]);
      snapshot.payload.queries.unbound.coverage = { aliases: ['z'] };
    }
    snapshot.checksum = checksum(snapshot);
    await writeFile(join(directory, 'snapshot.json'), `${JSON.stringify(snapshot)}\n`);
    const anchor = JSON.parse(await readFile(join(directory, 'journal.ndjson'), 'utf8'));
    anchor.payload.snapshotChecksum = snapshot.checksum;
    anchor.checksum = checksum(anchor);
    await writeFile(join(directory, 'journal.ndjson'), `${JSON.stringify(anchor)}\n`);
    await assertCommittedFilesRejected(directory);
  });
});

test('final guards: public updateQuery незарегистрированного ID не присваивает bound queryKey', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.bindSearches([search('m'), search('z')]);
  const before = await FileStore.inspect(directory);
  await assert.rejects(holder.store.updateQuery('unbound', { queryKey, baselineComplete: true }));
  assert.deepEqual(await FileStore.inspect(directory), before);
  assert.equal(holder.store.getQuery('unbound').queryKey, null);
  assert.equal(holder.store.getQuery('unbound').baselineComplete, false);
});
