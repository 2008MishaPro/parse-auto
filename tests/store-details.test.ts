import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Listing } from '../src/core/contracts.ts';
import { FileStore } from '../src/core/store.ts';

const directoryPrefix = resolve(join(tmpdir(), 'carradar-store-details-'));
async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(directoryPrefix);
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(directoryPrefix), 'cleanup remains in its task temp directory');
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function listing(second = 0): Listing {
  return {
    source: 'fixture', externalId: 'one', url: 'https://fixture.invalid/one', title: 'Honda S2000',
    priceMinor: 100, currency: 'RUB', observedAt: new Date(Date.UTC(2026, 9, 11, 0, 0, second)).toISOString(),
    publishedAt: null, vehicle: { make: null, model: null, year: null, mileageKm: null }, provenance: {},
  };
}

function enriched(second = 1): Listing {
  return { ...listing(second), publishedAt: '2026-10-10T00:00:00.000Z',
    vehicle: { make: 'Honda', model: 'S2000', year: 2000, mileageKm: 100_000 },
    provenance: { vehicle: 'structured source fields' } };
}

test('old null baseline can be enriched quietly; subsequent confirmed detail change emits one event', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('cars', 'old-baseline', null, [listing()], null);
  await store.updateQuery('cars', { baselineComplete: true });
  const richer = enriched();
  assert.deepEqual(await store.commitPage('cars', 'enrichment', null, [richer], null), []);
  assert.deepEqual((await FileStore.inspect(directory)).records, [richer]);
  const changed = { ...enriched(2), vehicle: { ...richer.vehicle, mileageKm: 110_000 } };
  const events = await store.commitPage('cars', 'confirmed-change', null, [changed], null);
  assert.deepEqual(events.map(event => event.type), ['details_changed']);
  assert.deepEqual((await FileStore.inspect(directory)).records, [changed]);
});

test('known details can be lost and restored without false events, including a changed value across unknown', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('cars', 'baseline', null, [enriched(0)], null);
  await store.updateQuery('cars', { baselineComplete: true });
  assert.deepEqual(await store.commitPage('cars', 'missing-fields', null, [listing(1)], null), []);
  assert.deepEqual((await FileStore.inspect(directory)).records, [listing(1)]);
  assert.deepEqual(await store.commitPage('cars', 'restored-fields', null, [enriched(2)], null), []);
  assert.deepEqual(await store.commitPage('cars', 'missing-again', null, [listing(3)], null), []);
  const restoredDifferent = { ...enriched(4), vehicle: { ...enriched().vehicle, year: 2001 } };
  assert.deepEqual(await store.commitPage('cars', 'different-after-unknown', null, [restoredDifferent], null), []);
  assert.deepEqual((await FileStore.inspect(directory)).records, [restoredDifferent]);
});

const confirmedChanges: Array<[string, (record: Listing) => Listing]> = [
  ['publishedAt', record => ({ ...record, publishedAt: '2026-10-10T01:00:00.000Z' })],
  ['make', record => ({ ...record, vehicle: { ...record.vehicle, make: 'Toyota' } })],
  ['model', record => ({ ...record, vehicle: { ...record.vehicle, model: 'Civic' } })],
  ['year', record => ({ ...record, vehicle: { ...record.vehicle, year: 2001 } })],
  ['mileageKm', record => ({ ...record, vehicle: { ...record.vehicle, mileageKm: 101_000 } })],
];
for (const [field, change] of confirmedChanges) test(`two known ${field} values create a details event`, async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('cars', 'baseline', null, [enriched(0)], null);
  await store.updateQuery('cars', { baselineComplete: true });
  const changed = change(enriched(1));
  const events = await store.commitPage('cars', 'changed', null, [changed], null);
  assert.deepEqual(events.map(event => event.type), ['details_changed']);
  assert.equal(events[0]!.observedAt, changed.observedAt);
});

test('title changes are reported while nullable fields are being populated or lost', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('cars', 'baseline', null, [listing()], null);
  await store.updateQuery('cars', { baselineComplete: true });
  const title = 'Honda S2000, новое описание';
  assert.deepEqual((await store.commitPage('cars', 'rich-new-title', null, [{ ...enriched(1), title }], null))
    .map(event => event.type), ['details_changed']);
  assert.deepEqual((await store.commitPage('cars', 'unknown-new-title', null, [listing(2)], null))
    .map(event => event.type), ['details_changed']);
});

test('price change with enrichment emits only price_changed; confirmed details and price still emit both', async t => {
  const directory = await temporary(t);
  const store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('cars', 'baseline', null, [listing()], null);
  await store.updateQuery('cars', { baselineComplete: true });
  const richer = { ...enriched(1), priceMinor: 200 };
  const priceEvents = await store.commitPage('cars', 'rich-new-price', null, [richer], null);
  assert.deepEqual(priceEvents.map(event => event.type), ['price_changed']);
  assert.equal(priceEvents[0]!.previousPriceMinor, 100);
  const changed = { ...enriched(2), priceMinor: 100, vehicle: { ...richer.vehicle, year: 2001 } };
  const both = await store.commitPage('cars', 'price-back-and-details', null, [changed], null);
  assert.deepEqual(both.map(event => event.type), ['price_changed', 'details_changed']);
  assert.equal(both[0]!.previousPriceMinor, 200);
});

test('enrichment and actual changes survive journal replay, compact and restart without duplicate events', async t => {
  const directory = await temporary(t);
  let store = await FileStore.open(directory);
  t.after(() => store.close());
  await store.commitPage('cars', 'old-baseline', null, [listing()], null);
  await store.updateQuery('cars', { baselineComplete: true });
  await store.close();
  store = await FileStore.open(directory);
  assert.deepEqual(await store.commitPage('cars', 'enrichment', null, [enriched(1)], null), []);
  await store.compact();
  await store.close();
  store = await FileStore.open(directory);
  assert.deepEqual(await store.commitPage('cars', 'enrichment', null, [enriched(1)], null), []);
  const changed = { ...enriched(2), vehicle: { ...enriched().vehicle, model: 'S2000 Type S' } };
  assert.deepEqual((await store.commitPage('cars', 'actual-change', null, [changed], null))
    .map(event => event.type), ['details_changed']);
  const persisted = await FileStore.inspect(directory);
  await store.compact();
  await store.close();
  store = await FileStore.open(directory);
  assert.deepEqual(await store.commitPage('cars', 'actual-change', null, [changed], null), []);
  assert.deepEqual(await FileStore.inspect(directory), persisted);
  assert.deepEqual(await store.commitPage('cars', 'lost-after-restart', null, [listing(3)], null), []);
  await store.compact();
  await store.close();
  store = await FileStore.open(directory);
  assert.deepEqual(await store.commitPage('cars', 'restore-after-compact', null,
    [{ ...changed, observedAt: listing(4).observedAt }], null), []);
  const final = await FileStore.inspect(directory);
  assert.equal(final.events.length, 1);
  assert.equal(new Set(final.events.map(event => event.eventId)).size, 1);
});
