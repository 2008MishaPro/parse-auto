import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { CollectPageResult, SourceAdapter } from '../src/core/contracts.ts';
import { SourceScheduler, waitUntil } from '../src/core/scheduler.ts';
import { FileStore, type SourceState } from '../src/core/store.ts';

const source = 'fixture';
const url = 'https://fixture.invalid/cars';
const iso = (time: number) => new Date(time).toISOString();
const baseline = Date.UTC(2026, 9, 11, 10);
const emptyHealth = (): SourceState => ({ failureCount: 0, blockedUntil: null, lastAttempt: null, lastSuccess: null, lastOutcome: null });
function result(outcome: CollectPageResult['outcome'] = 'empty', retryAfterSeconds: number | null = null): CollectPageResult {
  return { outcome, records: [], nextCursor: null, endReached: outcome === 'empty' || outcome === 'success', diagnostics: {}, retryAfterSeconds };
}
class Adapter implements SourceAdapter {
  id = source;
  calls: string[] = [];
  handler: (url: string, signal: AbortSignal) => CollectPageResult | Promise<CollectPageResult>;
  constructor(handler: Adapter['handler']) { this.handler = handler; }
  capabilities() { return { pagination: 'cursor', sort: ['newest'], publishedAt: false, details: false }; }
  async collectPage(query: { url: string }, _cursor: string | null, signal: AbortSignal) {
    this.calls.push(query.url);
    return this.handler(query.url, signal);
  }
}
async function temporary(t: TestContext) {
  const root = resolve('.tmp');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'source-health-'));
  const holder = { store: await FileStore.open(directory) };
  t.after(async () => {
    await holder.store.close();
    assert.equal(dirname(resolve(directory)), root);
    assert.ok(basename(directory).startsWith('source-health-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, holder };
}
function collect(scheduler: SourceScheduler, adapter: SourceAdapter, id: string, signal = new AbortController().signal) {
  return scheduler.collect(adapter, { url: `${url}/${id}`, requestTimeoutSeconds: 1 }, null, signal);
}
function clock(t: TestContext) {
  let current = baseline;
  const original = Date.now;
  Date.now = () => current;
  t.after(() => { Date.now = original; });
  return { now: () => current, advanceTo: (time: number) => { current = time; } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function checksum(envelope: Record<string, unknown>) {
  const body = { version: envelope.version, sequence: envelope.sequence, payload: envelope.payload };
  return { ...body, checksum: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

test('ошибки разных query образуют общий source failureCount, который продолжается после рестарта', async t => {
  const { directory, holder } = await temporary(t);
  const time = clock(t);
  const adapter = new Adapter(() => result('blocked'));
  let scheduler = new SourceScheduler(0, holder.store);
  await collect(scheduler, adapter, 'a');
  assert.equal(holder.store.getSource(source)!.failureCount, 1);
  time.advanceTo(scheduler.availableAt(source));
  await collect(scheduler, adapter, 'b');
  assert.equal(holder.store.getSource(source)!.failureCount, 2);
  assert.equal(scheduler.availableAt(source), time.now() + 20_000);
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  scheduler = new SourceScheduler(0, holder.store);
  assert.equal(scheduler.availableAt(source), time.now() + 20_000);
  time.advanceTo(scheduler.availableAt(source));
  await collect(scheduler, adapter, 'c');
  const health = holder.store.getSource(source)!;
  assert.equal(health.failureCount, 3, 'restart cannot reduce two source failures to one failure of an individual query');
  assert.equal(Date.parse(health.blockedUntil!), time.now() + 40_000);
  assert.equal(health.lastOutcome, 'blocked');
  assert.deepEqual(adapter.calls, [`${url}/a`, `${url}/b`, `${url}/c`]);
  assert.equal((await FileStore.inspect(directory)).sources[source]!.failureCount, 3);
});

test('сохранённый Retry-After задерживает другую query после рестарта, даже без её предыдущей ошибки', async t => {
  const { directory, holder } = await temporary(t);
  const time = clock(t);
  const adapter = new Adapter(() => result('rate_limited', 123));
  await collect(new SourceScheduler(0, holder.store), adapter, 'old');
  const health = holder.store.getSource(source)!;
  assert.equal(Date.parse(health.blockedUntil!), time.now() + 123_000);
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  const scheduler = new SourceScheduler(0, holder.store);
  const controller = new AbortController();
  const waiting = collect(scheduler, adapter, 'new', controller.signal);
  await new Promise(resolvePause => setTimeout(resolvePause, 15));
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(adapter.calls.length, 1, 'an unseen query cannot bypass source Retry-After');
  assert.deepEqual(holder.store.getSource(source), health, 'cancelling a backoff waiter does not count as another HTTP failure');
  time.advanceTo(Date.parse(health.blockedUntil!));
  await collect(scheduler, adapter, 'new');
  assert.equal(holder.store.getSource(source)!.failureCount, 2);
});

test('success и empty устойчиво сбрасывают source backoff, а возвращённое состояние защищено от мутации', async t => {
  const { directory, holder } = await temporary(t);
  const time = clock(t);
  const adapter = new Adapter(() => result('transport_error'));
  const scheduler = new SourceScheduler(0, holder.store);
  await collect(scheduler, adapter, 'error');
  time.advanceTo(scheduler.availableAt(source));
  adapter.handler = () => result('success');
  await collect(scheduler, adapter, 'success');
  const health = holder.store.getSource(source)!;
  assert.equal(health.failureCount, 0);
  assert.equal(health.blockedUntil, null);
  assert.equal(health.lastSuccess, iso(time.now()));
  assert.equal(health.lastOutcome, 'success');
  health.failureCount = 90;
  assert.equal(holder.store.getSource(source)!.failureCount, 0);
  adapter.handler = () => result('empty');
  await collect(scheduler, adapter, 'empty');
  await holder.store.compact();
  const before = await FileStore.inspect(directory);
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  assert.deepEqual(holder.store.getSource(source), before.sources[source]);
  assert.equal(holder.store.getSource(source)!.lastOutcome, 'empty');
  assert.equal(new SourceScheduler(0, holder.store).availableAt(source), 0);
});

test('отмена активного HTTP и общий deadline не изменяют сохранённую серию source ошибок', async t => {
  const { holder } = await temporary(t);
  const prior: SourceState = { failureCount: 2, blockedUntil: null, lastAttempt: iso(baseline - 1_000), lastSuccess: null, lastOutcome: 'blocked' };
  await holder.store.updateSource(source, prior);
  const adapter = new Adapter(async (_url, signal) => { await waitUntil(Date.now() + 1_000, signal); return result(); });
  const scheduler = new SourceScheduler(0, holder.store);
  for (const reason of [new DOMException('Остановлен', 'AbortError'), new DOMException('Бюджет цикла', 'TimeoutError')]) {
    const controller = new AbortController();
    const pending = collect(scheduler, adapter, 'cancelled', controller.signal);
    const timer = setTimeout(() => controller.abort(reason), 10);
    await assert.rejects(pending, { name: 'AbortError' });
    clearTimeout(timer);
    const health = holder.store.getSource(source)!;
    assert.equal(health.failureCount, 2);
    assert.equal(health.lastOutcome, 'blocked');
    assert.equal(health.blockedUntil, null);
    assert.equal(health.lastSuccess, null);
  }
  assert.equal(adapter.calls.length, 2);
});

test('scheduler не отдаёт результат и очередь HTTP до устойчивой записи source health', async t => {
  const time = clock(t);
  const started = deferred();
  const release = deferred();
  let health: SourceState | null = emptyHealth();
  let writes = 0;
  const persistence = {
    getSource: () => health && structuredClone(health),
    async updateSource(_id: string, next: SourceState) {
      if (++writes === 1) { started.resolve(); await release.promise; }
      health = structuredClone(next);
    },
  };
  const adapter = new Adapter(current => result(current.endsWith('/a') ? 'blocked' : 'empty'));
  const scheduler = new SourceScheduler(0, persistence);
  let firstReturned = false;
  const first = collect(scheduler, adapter, 'a').then(() => { firstReturned = true; });
  const second = collect(scheduler, adapter, 'b');
  await started.promise;
  assert.equal(adapter.calls.length, 1);
  assert.equal(firstReturned, false, 'caller cannot save useful records or print a result before fsync of source failure');
  time.advanceTo(time.now() + 10_000);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(adapter.calls, [`${url}/a`, `${url}/b`]);
  assert.equal(health!.failureCount, 0);
});

test('ошибка сохранения source health запрещает queued HTTP на всех источниках и возвращает исходную ошибку', async () => {
  const release = deferred();
  const started = deferred();
  const otherStarted = deferred();
  const fatal = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  const persistence = {
    getSource: () => emptyHealth(),
    async updateSource() { started.resolve(); await release.promise; throw fatal; },
  };
  const firstAdapter = new Adapter(() => result('blocked'));
  const otherAdapter = new Adapter(async (_url, signal) => {
    otherStarted.resolve();
    await waitUntil(Date.now() + 1_000, signal);
    return result();
  });
  otherAdapter.id = 'other';
  const scheduler = new SourceScheduler(0, persistence);
  const first = collect(scheduler, firstAdapter, 'a');
  const second = collect(scheduler, firstAdapter, 'b');
  await started.promise;
  const activeOther = collect(scheduler, otherAdapter, 'active');
  const queuedOther = collect(scheduler, otherAdapter, 'queued');
  await otherStarted.promise;
  release.resolve();
  const settled = await Promise.allSettled([first, second, activeOther, queuedOther]);
  for (const entry of settled) { assert.equal(entry.status, 'rejected'); if (entry.status === 'rejected') assert.equal(entry.reason, fatal); }
  await assert.rejects(collect(scheduler, otherAdapter, 'c'), error => error === fatal);
  assert.equal(firstAdapter.calls.length, 1);
  assert.equal(otherAdapter.calls.length, 1, 'an active other source is aborted and its queued request never starts');
});

test('невалидный source update отвергается до журнала, не меняет sequence и не блокирует следующую допустимую запись', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.updateSource(source, emptyHealth());
  const before = await FileStore.inspect(directory);
  const journal = await readFile(join(directory, 'journal.ndjson'));
  for (const invalid of [{ ...emptyHealth(), failureCount: -1 }, { ...emptyHealth(), lastOutcome: 'success', failureCount: 2 }]) {
    await assert.rejects(holder.store.updateSource(source, invalid as SourceState));
    assert.deepEqual(await FileStore.inspect(directory), before);
    assert.deepEqual(await readFile(join(directory, 'journal.ndjson')), journal);
  }
  await holder.store.updateSource(source, { ...emptyHealth(), lastAttempt: iso(baseline), lastOutcome: 'blocked', failureCount: 1 });
  assert.equal(holder.store.getSource(source)!.failureCount, 1);
});

test('checksummed committed source batch с повреждённым health отвергается reader и writer без починки', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.updateSource(source, emptyHealth());
  await holder.store.close();
  const path = join(directory, 'journal.ndjson');
  const envelope = JSON.parse((await readFile(path, 'utf8')).trim());
  envelope.payload.sources[0][1].failureCount = -1;
  await writeFile(path, JSON.stringify(checksum(envelope)) + '\n');
  const corrupted = await readFile(path);
  await assert.rejects(FileStore.inspect(directory));
  await assert.rejects(FileStore.open(directory));
  assert.deepEqual(await readFile(path), corrupted);
});

test('committed завершение миграции gaps требует сохранённый legacyGaps массив даже когда он пуст', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.ensureSources([{ id: 'cars', source, url, enabled: true }]);
  await holder.store.close();
  const path = join(directory, 'journal.ndjson');
  const envelope = JSON.parse((await readFile(path, 'utf8')).trim());
  assert.equal(envelope.payload.initializeGaps, true);
  assert.deepEqual(envelope.payload.legacyGaps, []);
  delete envelope.payload.legacyGaps;
  await writeFile(path, JSON.stringify(checksum(envelope)) + '\n');
  const corrupted = await readFile(path);
  await assert.rejects(FileStore.inspect(directory));
  await assert.rejects(FileStore.open(directory));
  assert.deepEqual(await readFile(path), corrupted);
});

test('legacy health оценивается по всем сохранённым query источника, затем exact source становится авторитетным', async t => {
  const { directory, holder } = await temporary(t);
  const registrations = [{ id: 'current', source, url, enabled: true }];
  await holder.store.updateQuery('removed', { queryKey: JSON.stringify([source, `${url}/old`]), failureCount: 4,
    nextRunAt: iso(baseline + 60_000), lastAttempt: iso(baseline - 1_000) });
  await holder.store.updateQuery('disabled', { queryKey: JSON.stringify([source, `${url}/paused`]), failureCount: 2,
    nextRunAt: iso(baseline + 90_000), lastAttempt: iso(baseline - 2_000) });
  await holder.store.updateQuery('healthy', { queryKey: JSON.stringify([source, `${url}/ok`]), failureCount: 0,
    nextRunAt: iso(baseline + 999_000), lastSuccess: iso(baseline - 5_000) });
  await holder.store.bindSearches(registrations);
  await holder.store.ensureSources(registrations);
  const inferred = holder.store.getSource(source)!;
  assert.equal(inferred.failureCount, 4);
  assert.equal(inferred.blockedUntil, iso(baseline + 90_000), 'healthy scheduling interval cannot become source backoff');
  assert.equal(inferred.lastAttempt, iso(baseline - 1_000));
  assert.equal(inferred.lastSuccess, iso(baseline - 5_000));
  assert.equal(inferred.legacyEstimate, true);
  await holder.store.updateSource(source, emptyHealth());
  await holder.store.ensureSources(registrations);
  assert.deepEqual(holder.store.getSource(source), emptyHealth(), 'stale query counters cannot resurrect an exact cleared source backoff');
  await holder.store.compact();
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  await holder.store.ensureSources(registrations);
  assert.deepEqual(holder.store.getSource(source), emptyHealth());
});

test('старый snapshot без sources совместим, а новые source состояния переживают compact включая безопасные ID', async t => {
  const { directory, holder } = await temporary(t);
  await holder.store.updateQuery('old', { baselineComplete: true });
  await holder.store.compact();
  await holder.store.close();
  const snapshotPath = join(directory, 'snapshot.json');
  const old = JSON.parse(await readFile(snapshotPath, 'utf8'));
  delete old.payload.sources;
  const oldEnvelope = checksum(old);
  await writeFile(snapshotPath, JSON.stringify(oldEnvelope));
  await writeFile(join(directory, 'journal.ndjson'), JSON.stringify(checksum({ version: 1, sequence: old.sequence,
    payload: { type: 'anchor', snapshotChecksum: oldEnvelope.checksum } })) + '\n');
  holder.store = await FileStore.open(directory);
  assert.equal(holder.store.getSource(source), null);
  for (const id of [source, '__proto__', 'constructor']) {
    await holder.store.updateSource(id, { ...emptyHealth(), lastAttempt: iso(baseline), lastOutcome: 'empty' });
  }
  await holder.store.compact();
  const before = await FileStore.inspect(directory);
  assert.deepEqual(Object.keys(before.sources).sort(), ['__proto__', 'constructor', source].sort());
  await holder.store.close();
  holder.store = await FileStore.open(directory);
  assert.deepEqual((await FileStore.inspect(directory)).sources, before.sources);
});

for (const corruption of [
  { failureCount: -1 }, { failureCount: 0.5 }, { blockedUntil: 'not a date' },
  { lastAttempt: 'not a date' }, { lastSuccess: 123 }, { lastOutcome: 'invented' }, { legacyEstimate: 'yes' },
]) {
  test(`checksummed snapshot отвергает повреждённое source health ${JSON.stringify(corruption)}`, async t => {
    const { directory, holder } = await temporary(t);
    await holder.store.updateSource(source, emptyHealth());
    await holder.store.compact();
    await holder.store.close();
    const snapshotPath = join(directory, 'snapshot.json');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    // New payload stores source rows; match either a record or entry-list representation.
    if (Array.isArray(snapshot.payload.sources)) snapshot.payload.sources[0][1] = { ...emptyHealth(), ...corruption };
    else snapshot.payload.sources[source] = { ...emptyHealth(), ...corruption };
    const changed = checksum(snapshot);
    await writeFile(snapshotPath, JSON.stringify(changed));
    await writeFile(join(directory, 'journal.ndjson'), JSON.stringify(checksum({ version: 1, sequence: changed.sequence,
      payload: { type: 'anchor', snapshotChecksum: changed.checksum } })) + '\n');
    const files = [await readFile(snapshotPath), await readFile(join(directory, 'journal.ndjson'))];
    await assert.rejects(FileStore.inspect(directory));
    await assert.rejects(FileStore.open(directory));
    assert.deepEqual(await readFile(snapshotPath), files[0]);
    assert.deepEqual(await readFile(join(directory, 'journal.ndjson')), files[1]);
  });
}
