import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { CollectDetailsResult, Listing } from '../src/core/contracts.ts';
import { FileStore } from '../src/core/store.ts';

const prefix = resolve(join(tmpdir(), 'carradar-store-enrichment-'));
const timestamp = (second: number) => new Date(Date.UTC(2026, 9, 11, 0, 0, second)).toISOString();
const moment = (second: number) => Date.parse(timestamp(second));

async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(prefix), 'cleanup remains in its task temp directory');
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function catalog(second = 0, externalId = 'one'): Listing {
  return { source: 'fixture', externalId, title: 'Honda S2000, 2000, 100 000 км',
    url: `https://fixture.invalid/${externalId}?context=catalog`, priceMinor: 100, currency: 'RUB',
    observedAt: timestamp(second), publishedAt: null,
    vehicle: { make: null, model: null, year: 2000, mileageKm: null },
    provenance: { priceMinor: 'catalog.price', 'vehicle.year': 'catalog.title' } };
}

function card(second = 1, externalId = 'one'): Listing {
  return { ...catalog(second, externalId), priceMinor: 900, title: catalog().title,
    url: `https://fixture.invalid/${externalId}?context=card`, publishedAt: timestamp(0),
    vehicle: { make: 'Honda', model: 'S2000', year: 2000, mileageKm: 100_000 },
    provenance: { priceMinor: 'card.price', title: 'card.title', 'vehicle.make': 'card.brand',
      'vehicle.model': 'card.model', 'vehicle.year': 'card.year', 'vehicle.mileageKm': 'card.mileage' } };
}

function result(record: Listing | null, outcome: CollectDetailsResult['outcome'] = 'success'): CollectDetailsResult {
  return { outcome, record, retryAfterSeconds: null, diagnostics: {} };
}

async function accept(store: FileStore, searchId = 'cars', record = catalog(), detailed = card()): Promise<string> {
  const attempt = await store.beginDetailsAttempt(searchId, record, timestamp(1), timestamp(30));
  assert.ok(attempt);
  await store.finishDetailsAttempt(record.source, record.externalId, attempt, result(detailed), null);
  return attempt;
}

test('card is separate durable evidence; view fills only null vehicle fields with card provenance/time', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  const raw = catalog();
  await store.commitPage('cars', 'baseline', null, [raw], '2');
  await store.updateQuery('cars', { baselineComplete: true, lastSuccess: timestamp(0), coverage: { reason: 'exhausted' } });
  const queryBefore = store.getQuery('cars');
  await accept(store);
  const view = (await FileStore.inspect(directory, 'cars')).records[0]!;
  assert.deepEqual({ ...view, vehicle: raw.vehicle, provenance: raw.provenance, enrichment: undefined }, { ...raw, enrichment: undefined });
  assert.deepEqual(view.vehicle, { make: 'Honda', model: 'S2000', year: 2000, mileageKm: 100_000 });
  assert.deepEqual(view.enrichment, { observedAt: timestamp(1), fields: ['make', 'model', 'mileageKm'] });
  assert.deepEqual(view.provenance, { ...raw.provenance, 'vehicle.make': 'card.brand',
    'vehicle.model': 'card.model', 'vehicle.mileageKm': 'card.mileage' });
  assert.deepEqual(store.getQuery('cars'), queryBefore);
  assert.deepEqual((await FileStore.inspect(directory)).events, []);
  assert.deepEqual(store.getDetailsState('fixture', 'one')!.record, card());
  await store.compact();
  const snapshot = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'));
  assert.deepEqual(snapshot.payload.records, [raw]);
  assert.deepEqual(snapshot.payload.searchRecords[0][1], [raw]);
  assert.equal(snapshot.payload.knownPrices[0][1][0][1], 100, 'card price never changes catalog history');
});

test('new catalog null fields retain card enrichment; confirmed catalog fields have priority without false events', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('cars', 'baseline', null, [catalog()], null);
  await store.updateQuery('cars', { baselineComplete: true });
  await accept(store);
  const later = catalog(2);
  assert.deepEqual(await store.commitPage('cars', 'later', null, [later], null), []);
  let view = (await FileStore.inspect(directory)).records[0]!;
  assert.equal(view.vehicle.make, 'Honda');
  assert.equal(view.observedAt, later.observedAt);
  assert.equal(view.enrichment!.observedAt, timestamp(1));
  const known = { ...catalog(3), vehicle: { make: 'Toyota', model: 'MR2', year: 2000, mileageKm: 200_000 },
    provenance: { 'vehicle.make': 'catalog.structured', 'vehicle.model': 'catalog.structured' } };
  assert.deepEqual(await store.commitPage('cars', 'known', null, [known], null), []);
  view = (await FileStore.inspect(directory)).records[0]!;
  assert.deepEqual(view, known);
  assert.equal(view.enrichment, undefined);
});

for (const conflict of ['year', 'mileageKm'] as const) test(`confirmed ${conflict} conflict forbids all vehicle overlay despite an identical title`, async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  const raw = { ...catalog(), vehicle: { ...catalog().vehicle, [conflict]: conflict === 'year' ? 2001 : 200_000 } };
  await store.commitPage('cars', 'baseline', null, [raw], null);
  await accept(store, 'cars', raw);
  assert.deepEqual((await FileStore.inspect(directory)).records, [raw]);
  assert.deepEqual(store.getDetailsState('fixture', 'one')!.record, card());
});

test('card price/title differences never produce card events or alter A→B→A catalog price comparison', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('cars', 'baseline', null, [catalog()], null);
  await store.updateQuery('cars', { baselineComplete: true });
  await accept(store, 'cars', catalog(), { ...card(), title: 'Card title changed' });
  assert.deepEqual((await FileStore.inspect(directory)).records, [catalog()]);
  assert.deepEqual((await FileStore.inspect(directory)).events, []);
  const newer = { ...catalog(2), priceMinor: 200 };
  const b = await store.commitPage('cars', 'b', null, [newer], null);
  const a = await store.commitPage('cars', 'a', null, [catalog(3)], null);
  assert.deepEqual(b.map(event => [event.type, event.previousPriceMinor, event.priceMinor]), [['price_changed', 100, 200]]);
  assert.deepEqual(a.map(event => [event.type, event.previousPriceMinor, event.priceMinor]), [['price_changed', 200, 100]]);
  assert.deepEqual(await store.commitPage('cars', 'stale', null, [{ ...catalog(1), priceMinor: 900 }], null), []);
  assert.equal((await FileStore.inspect(directory)).records[0]!.priceMinor, 100);
});

test('successful receipt suppresses repeated GET across queries, restart and compact; results replay without new batches', async t => {
  const directory = await temporary(t);
  let store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('first', 'base-first', null, [catalog()], null);
  await store.commitPage('second', 'base-second', null, [catalog(1)], null);
  const attempt = await accept(store, 'first');
  const successful = await FileStore.inspect(directory);
  await store.finishDetailsAttempt('fixture', 'one', attempt, result(card()), null);
  assert.deepEqual(await FileStore.inspect(directory), successful);
  assert.deepEqual(store.detailsCandidates('second', 2, moment(40)), []);
  assert.equal(await store.beginDetailsAttempt('second', catalog(1), timestamp(40), timestamp(50)), null);
  await store.close();
  store = await FileStore.open(directory);
  assert.deepEqual(store.detailsCandidates('first', 2, moment(50)), []);
  await store.compact();
  await store.close();
  store = await FileStore.open(directory);
  assert.equal(await store.beginDetailsAttempt('first', catalog(), timestamp(60), timestamp(70)), null);
  assert.deepEqual((await FileStore.inspect(directory, 'second')).records[0]!.enrichment,
    { observedAt: timestamp(1), fields: ['make', 'model', 'mileageKm'] });
  const caller = store.getDetailsState('fixture', 'one')!;
  caller.record!.vehicle.make = 'Caller mutated';
  assert.equal(store.getDetailsState('fixture', 'one')!.record!.vehicle.make, 'Honda');
});

test('changed catalog title invalidates overlay and success suppression; catalog catching up with card needs no GET', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('cars', 'baseline', null, [catalog()], null);
  const received = { ...card(), title: 'Title already changed on card' };
  await accept(store, 'cars', catalog(), received);
  assert.deepEqual(store.detailsCandidates('cars', 2, moment(10)), []);
  assert.equal((await FileStore.inspect(directory)).records[0]!.enrichment, undefined);
  const caughtUp = { ...catalog(2), title: received.title };
  await store.commitPage('cars', 'catch-up', null, [caughtUp], null);
  assert.deepEqual(store.detailsCandidates('cars', 2, moment(10)), []);
  assert.equal((await FileStore.inspect(directory)).records[0]!.vehicle.make, 'Honda');
  const changed = { ...catalog(3), title: 'Another confirmed catalog title' };
  await store.commitPage('cars', 'changed', null, [changed], null);
  assert.deepEqual((await FileStore.inspect(directory)).records, [changed]);
  assert.deepEqual(store.detailsCandidates('cars', 2, moment(10)), [changed]);
  assert.ok(await store.beginDetailsAttempt('cars', changed, timestamp(10), timestamp(30)));
});

test('pending attempt survives hard restart and blocks another query/title until cooldown; failures retain only earlier card evidence', async t => {
  const directory = await temporary(t);
  let store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('first', 'base-first', null, [catalog()], null);
  const anotherTitle = { ...catalog(2), title: 'Other query title' };
  await store.commitPage('second', 'base-second', null, [anotherTitle], null);
  const pending = await store.beginDetailsAttempt('first', catalog(), timestamp(3), timestamp(30));
  assert.ok(pending);
  await store.close();
  store = await FileStore.open(directory);
  assert.equal(store.getDetailsState('fixture', 'one')!.outcome, 'pending');
  assert.deepEqual(store.detailsCandidates('second', 2, moment(29)), []);
  assert.equal(await store.beginDetailsAttempt('second', anotherTitle, timestamp(29), timestamp(40)), null);
  await store.finishDetailsAttempt('fixture', 'one', pending, result(card(), 'rate_limited'), timestamp(40));
  assert.equal(store.getDetailsState('fixture', 'one')!.record, null, 'failure record is not applied');
  assert.deepEqual((await FileStore.inspect(directory, 'first')).records, [catalog()]);
  assert.deepEqual(store.detailsCandidates('second', 2, moment(39)), []);
  assert.deepEqual(store.detailsCandidates('second', 2, moment(40)), [anotherTitle]);
  const retry = await store.beginDetailsAttempt('second', anotherTitle, timestamp(40), timestamp(60));
  assert.ok(retry);
  await assert.rejects(store.finishDetailsAttempt('fixture', 'one', pending, result(card()), null), /попытке/);
  const detail = { ...card(41), title: anotherTitle.title };
  await store.finishDetailsAttempt('fixture', 'one', retry, result(detail), null);
  const nextTitle = { ...catalog(42), title: 'Third title' };
  await store.commitPage('second', 'third-title', null, [nextTitle], null);
  const third = await store.beginDetailsAttempt('second', nextTitle, timestamp(43), timestamp(60));
  assert.ok(third);
  await store.finishDetailsAttempt('fixture', 'one', third, result(null, 'timeout'), timestamp(70));
  assert.deepEqual(store.getDetailsState('fixture', 'one')!.record, detail, 'last successful evidence survives failures');
});

test('candidate count is bounded; successful unknown vehicle fields do not cause repeated requests', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  const records = [catalog(0, 'old'), catalog(0, 'first'), catalog(0, 'second')];
  await store.commitPage('cars', 'baseline', null, records, null);
  assert.deepEqual(store.detailsCandidates('cars', 1, moment(0)), [records[0]]);
  assert.deepEqual(store.detailsCandidates('cars', 0, moment(0)), []);
  const noAttrs = { ...catalog(1, 'first'), vehicle: { make: null, model: null, year: null, mileageKm: null } };
  await accept(store, 'cars', records[1]!, noAttrs);
  assert.deepEqual(store.detailsCandidates('cars', 2, moment(50)), [records[0], records[2]]);
  assert.deepEqual((await FileStore.inspect(directory)).records.find(record => record.externalId === 'first'), records[1]);
  assert.throws(() => store.detailsCandidates('cars', -1, moment(1)), /отбор/);
});

test('all saved pages participate beyond 50; aliases share the queue without pulling another query or source', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  const url = 'https://fixture.invalid/cars';
  await store.bindSearches([
    { id: 'cars', source: 'fixture', url, enabled: true }, { id: 'cars-alias', source: 'fixture', url, enabled: true },
    { id: 'another-query', source: 'fixture', url: `${url}?other=true`, enabled: true },
    { id: 'another-source', source: 'other-adapter', url, enabled: true },
  ]);
  const records = Array.from({ length: 57 }, (_, index) => catalog(0, `car-${index}`));
  await store.commitPage('cars', 'baseline', null, records.slice(0, 50), '2');
  await store.commitPage('cars-alias', 'baseline', '2', records.slice(50), null);
  const outsider = catalog(0, 'only-another-query');
  const otherSource = { ...catalog(0, 'car-50'), source: 'other-adapter' };
  await store.commitPage('another-query', 'baseline', null, [outsider, records[50]!], null);
  await store.commitPage('another-source', 'baseline', null, [otherSource], null);
  assert.deepEqual(store.detailsCandidates('cars-alias', 55, moment(1)), records.slice(0, 55));
  assert.deepEqual(store.detailsCandidates('cars', 100, moment(1)), records);
  // Fully known head records must not prevent the unfinished second page from being read.
  const knownHead = records.slice(0, 50).map(record => ({ ...record, observedAt: timestamp(1), vehicle: card().vehicle }));
  await store.commitPage('cars', 'known-head', null, knownHead, null);
  assert.deepEqual(store.detailsCandidates('cars-alias', 2, moment(2)), records.slice(50, 52));
  const firstTail = records[50]!;
  await accept(store, 'cars-alias', firstTail, card(2, firstTail.externalId));
  assert.deepEqual(store.detailsCandidates('cars', 2, moment(3)), records.slice(51, 53));
  assert.deepEqual(store.detailsCandidates('another-query', 10, moment(3)), [outsider],
    'shared successful identity is skipped, while this other membership remains isolated');
  assert.deepEqual(store.detailsCandidates('another-source', 10, moment(3)), [otherSource],
    'externalId alone does not share a receipt between adapters');
  const detached = store.detailsCandidates('cars', 2, moment(3));
  detached[0]!.vehicle.make = 'Caller mutated';
  assert.equal(store.detailsCandidates('cars', 2, moment(3))[0]!.vehicle.make, null);
});

test('bounded progress survives replay, compact and a new alias without resetting the membership queue', async t => {
  const directory = await temporary(t);
  let store = await FileStore.open(directory);
  t.after(() => store.close());
  const url = 'https://fixture.invalid/cars';
  await store.bindSearches([{ id: 'cars', source: 'fixture', url, enabled: true }, { id: 'alias', source: 'fixture', url, enabled: true }]);
  const records = Array.from({ length: 6 }, (_, index) => catalog(0, `car-${index}`));
  await store.commitPage('cars', 'baseline', null, records, null);
  await store.updateQuery('cars', { baselineComplete: true, lastSuccess: timestamp(0) });
  for (const record of store.detailsCandidates('alias', 2, moment(1))) {
    await accept(store, 'alias', record, card(1, record.externalId));
  }
  assert.deepEqual(store.detailsCandidates('cars', 2, moment(2)), records.slice(2, 4));
  const queryBefore = store.getQuery('cars');
  await store.close();
  store = await FileStore.open(directory);
  assert.deepEqual(store.detailsCandidates('alias', 2, moment(2)), records.slice(2, 4));
  await store.compact();
  await store.close();
  store = await FileStore.open(directory);
  await store.bindSearches([{ id: 'replacement', source: 'fixture', url, enabled: true }]);
  assert.deepEqual(store.detailsCandidates('replacement', 2, moment(3)), records.slice(2, 4));
  for (const record of store.detailsCandidates('replacement', 2, moment(3))) {
    await accept(store, 'replacement', record, card(3, record.externalId));
  }
  assert.deepEqual(store.getQuery('replacement'), queryBefore);
  // Seeing a familiar head again does not move it ahead or hide older saved tail records.
  await store.commitPage('replacement', 'head-again', null, records.slice(0, 2).map(record => ({ ...record, observedAt: timestamp(4) })), null);
  assert.deepEqual(store.detailsCandidates('replacement', 2, moment(4)), records.slice(4));
  assert.equal(store.getQuery('replacement').baselineComplete, true);
  assert.equal(store.getQuery('replacement').lastSuccess, queryBefore.lastSuccess);
  assert.deepEqual((await FileStore.inspect(directory)).events, []);
});

test('untouched identities precede ready failures; attempts retry oldest first with stable ties and pending cooldown', async t => {
  const directory = await temporary(t);
  let store = await FileStore.open(directory);
  t.after(() => store.close());
  const records = Array.from({ length: 7 }, (_, index) => catalog(0, `car-${index}`));
  await store.commitPage('cars', 'baseline', null, records, null);
  async function fail(index: number, second: number): Promise<void> {
    const record = records[index]!;
    const attempt = await store.beginDetailsAttempt('cars', record, timestamp(second), timestamp(20));
    assert.ok(attempt);
    await store.finishDetailsAttempt(record.source, record.externalId, attempt, result(null, 'transport_error'), timestamp(20));
  }
  await fail(0, 8);
  assert.ok(await store.beginDetailsAttempt('cars', records[1]!, timestamp(2), timestamp(20)));
  await fail(2, 2);
  await fail(3, 2);
  assert.ok(await store.beginDetailsAttempt('cars', records[6]!, timestamp(1), timestamp(100)));
  assert.deepEqual(store.detailsCandidates('cars', 10, moment(19)), records.slice(4, 6));
  assert.deepEqual(store.detailsCandidates('cars', 2, moment(20)), records.slice(4, 6),
    'ready failed/pending attempts cannot occupy the slots before untouched cards');
  const expected = [records[4], records[5], records[1], records[2], records[3], records[0]];
  assert.deepEqual(store.detailsCandidates('cars', 10, moment(20)), expected);
  await store.close();
  store = await FileStore.open(directory);
  assert.deepEqual(store.detailsCandidates('cars', 10, moment(20)), expected);
  await store.compact();
  await store.close();
  store = await FileStore.open(directory);
  assert.deepEqual(store.detailsCandidates('cars', 10, moment(20)), expected);
  for (const record of store.detailsCandidates('cars', 2, moment(20))) {
    const attempt = await store.beginDetailsAttempt('cars', record, timestamp(20), timestamp(30));
    assert.ok(attempt);
    await store.finishDetailsAttempt(record.source, record.externalId, attempt, result(card(21, record.externalId)), null);
  }
  assert.deepEqual(store.detailsCandidates('cars', 4, moment(21)), [records[1], records[2], records[3], records[0]]);
  const retried = records[1]!;
  const attempt = await store.beginDetailsAttempt('cars', retried, timestamp(21), timestamp(30));
  assert.ok(attempt);
  await store.finishDetailsAttempt(retried.source, retried.externalId, attempt, result(null, 'timeout'), timestamp(30));
  assert.deepEqual(store.detailsCandidates('cars', 4, moment(31)), [records[2], records[3], records[0], records[1]],
    'a new failure rejoins behind older eligible attempts rather than taking the first slot forever');
});

test('candidate selection rejects malformed arguments and leaves durable state unchanged', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('cars', 'baseline', null, [catalog()], null);
  const before = await FileStore.inspect(directory);
  const candidates = store.detailsCandidates.bind(store) as (...args: unknown[]) => Listing[];
  for (const searchId of ['', '   ', null, undefined, 1, {}]) {
    assert.throws(() => candidates(searchId, 2, moment(0)), /отбор/);
  }
  for (const limit of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null, undefined]) {
    assert.throws(() => candidates('cars', limit, moment(0)), /отбор/);
  }
  for (const now of [NaN, Infinity, -Infinity, timestamp(0), null, undefined, new Date()]) {
    assert.throws(() => candidates('cars', 2, now), /отбор/);
  }
  assert.deepEqual(store.detailsCandidates('absent', 2, moment(0)), []);
  assert.deepEqual(store.detailsCandidates('cars', 0, moment(0)), []);
  assert.deepEqual(await FileStore.inspect(directory), before);
});

test('receipt identity includes source, so identical external IDs on two adapters remain independent', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('first', 'baseline', null, [catalog()], null);
  const other = { ...catalog(), source: 'other-adapter' };
  await store.commitPage('second', 'baseline', null, [other], null);
  await accept(store, 'first');
  assert.equal(store.getDetailsState('other-adapter', 'one'), null);
  assert.deepEqual(store.detailsCandidates('second', 2, moment(2)), [other]);
  const attempt = await store.beginDetailsAttempt('second', other, timestamp(2), timestamp(30));
  assert.ok(attempt);
  await store.finishDetailsAttempt('other-adapter', 'one', attempt, result({ ...card(2), source: 'other-adapter' }), null);
  assert.equal((await FileStore.inspect(directory)).detailsStates.length, 2);
});

test('claim checks durable membership and FIFO prevents parallel duplicates; malformed/mismatched results cannot commit', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('cars', 'baseline', null, [catalog()], null);
  assert.equal(await store.beginDetailsAttempt('cars', catalog(0, 'absent'), timestamp(1), timestamp(30)), null);
  assert.equal(await store.beginDetailsAttempt('cars', { ...catalog(), title: 'Stale caller' }, timestamp(1), timestamp(30)), null);
  const [first, second] = await Promise.all([
    store.beginDetailsAttempt('cars', catalog(), timestamp(1), timestamp(30)),
    store.beginDetailsAttempt('cars', catalog(), timestamp(1), timestamp(30)),
  ]);
  assert.ok(first);
  assert.equal(second, null);
  const before = await FileStore.inspect(directory);
  await assert.rejects(store.finishDetailsAttempt('fixture', 'one', first, result(card(1, 'wrong-id')), null), /identity/);
  await assert.rejects(store.finishDetailsAttempt('fixture', 'one', first, result(null), null), /без записи/);
  await assert.rejects(store.finishDetailsAttempt('fixture', 'one', first,
    result({ ...card(), vehicle: { ...card().vehicle, mileageKm: -1 } }), null), /поля объявления/);
  assert.deepEqual(await FileStore.inspect(directory), before);
});

test('legacy snapshot/journal without details state remains readable and can acquire its first card receipt', async t => {
  const directory = await temporary(t);
  let store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('cars', 'baseline', null, [catalog()], null);
  await store.compact();
  await store.close();
  const checksum = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
  const snapshot = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8'));
  delete snapshot.payload.detailsStates;
  snapshot.checksum = checksum({ version: snapshot.version, sequence: snapshot.sequence, payload: snapshot.payload });
  await writeFile(join(directory, 'snapshot.json'), JSON.stringify(snapshot) + '\n');
  const anchor = JSON.parse(await readFile(join(directory, 'journal.ndjson'), 'utf8'));
  anchor.payload.snapshotChecksum = snapshot.checksum;
  anchor.checksum = checksum({ version: anchor.version, sequence: anchor.sequence, payload: anchor.payload });
  await writeFile(join(directory, 'journal.ndjson'), JSON.stringify(anchor) + '\n');
  assert.deepEqual((await FileStore.inspect(directory)).detailsStates, []);
  store = await FileStore.open(directory);
  await accept(store);
  await store.compact();
  await store.close();
  store = await FileStore.open(directory);
  assert.equal(store.getDetailsState('fixture', 'one')!.outcome, 'success');
  assert.equal((await FileStore.inspect(directory)).records[0]!.vehicle.make, 'Honda');
});
