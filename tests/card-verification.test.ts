import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { CollectDetailsResult, Listing } from '../src/core/contracts.ts';
import { FileStore } from '../src/core/store.ts';
import { activeSourceBackoff, verifyAvitoCard } from '../scripts/card-verification.ts';

const catalog: Listing = {
  source: 'avito', externalId: '123', url: 'https://www.avito.ru/moskva/avtomobili/car_123',
  title: 'Honda Civic 1.6 MT, 2000, 250 000 км', priceMinor: 15000000, currency: 'RUB',
  observedAt: '2026-10-11T15:00:00.000Z', publishedAt: null,
  vehicle: { make: null, model: null, year: 2000, mileageKm: 250000 },
  provenance: { title: 'catalog.title', priceMinor: 'catalog.price',
    'vehicle.year': 'catalog.title (strict vehicle title suffix)',
    'vehicle.mileageKm': 'catalog.title (strict vehicle title suffix)' },
};

function details(record: Listing = structuredClone(catalog), outcome: CollectDetailsResult['outcome'] = 'success'): CollectDetailsResult {
  return { outcome, record, diagnostics: { httpStatus: 200 }, retryAfterSeconds: null };
}

test('сверка карточки: пустые make/model не мешают подтверждённым ID/title/цене', () => {
  const result = verifyAvitoCard(catalog, details());
  assert.equal(result.fetchSucceeded, true);
  assert.equal(result.comparisonStatus, 'match');
  assert.equal(result.titleMatches, true);
  assert.equal(result.fullPriceMatches, true);
  assert.equal(result.yearMatches, true);
  assert.equal(result.mileageMatches, true);
  assert.deepEqual(result.mismatchedFields, []);
});

test('сверка карточки: одно изменение названия запрещает match при прежних ID/цене', () => {
  const result = verifyAvitoCard(catalog, details({ ...catalog, title: `${catalog.title}, срочно` }));
  assert.equal(result.fetchSucceeded, true);
  assert.equal(result.idAndFullPriceMatch, true);
  assert.equal(result.titleMatches, false);
  assert.equal(result.comparisonStatus, 'mismatch');
  assert.deepEqual(result.mismatchedFields, ['title']);
  assert.equal(result.outcome, 'success');
});

test('сверка карточки: изменение цены — mismatch наблюдений при успешном получении', () => {
  const result = verifyAvitoCard(catalog, details({ ...catalog, priceMinor: 14000000 }));
  assert.equal(result.fetchSucceeded, true);
  assert.equal(result.comparisonStatus, 'mismatch');
  assert.deepEqual(result.mismatchedFields, ['priceMinor']);
  assert.equal(result.outcome, 'success');
});

test('сверка карточки: известные несогласованные год и пробег не скрываются совпадением ID/цены', () => {
  for (const field of ['year', 'mileageKm'] as const) {
    const record = { ...catalog, vehicle: { ...catalog.vehicle, [field]: catalog.vehicle[field]! + 1 } };
    const result = verifyAvitoCard(catalog, details(record));
    assert.equal(result.fetchSucceeded, true);
    assert.equal(result.idAndFullPriceMatch, true);
    assert.equal(result.comparisonStatus, 'mismatch');
    assert.deepEqual(result.mismatchedFields, [`vehicle.${field}`]);
  }
});

test('сверка карточки: unknown год/пробег не приравниваются к несовпадению или подтверждению', () => {
  const record = { ...catalog, vehicle: { make: null, model: null, year: null, mileageKm: null } };
  for (const [listing, card] of [[catalog, record], [record, catalog]] as const) {
    const result = verifyAvitoCard(listing, details(card));
    assert.equal(result.comparisonStatus, 'match');
    assert.equal(result.yearMatches, null);
    assert.equal(result.mileageMatches, null);
    assert.deepEqual(result.mismatchedFields, []);
  }
});

test('сверка карточки: unknown цена остаётся unverified при успешном parser', () => {
  for (const [listing, record] of [[catalog, { ...catalog, priceMinor: null, currency: null }],
    [{ ...catalog, priceMinor: null, currency: null }, catalog]] as const) {
    const result = verifyAvitoCard(listing, details(record));
    assert.equal(result.fetchSucceeded, true);
    assert.equal(result.outcome, 'success');
    assert.equal(result.comparisonStatus, 'unverified');
    assert.equal(result.fullPriceMatches, null);
    assert.deepEqual(result.mismatchedFields, []);
  }
});

test('сверка карточки: source/ID/валюта подтверждаются отдельно', () => {
  for (const [replacement, field] of [[{ source: 'other' }, 'source'], [{ externalId: '124' }, 'externalId'],
    [{ currency: 'USD' }, 'currency']] as const) {
    const result = verifyAvitoCard(catalog, details({ ...catalog, ...replacement }));
    assert.equal(result.comparisonStatus, 'mismatch');
    assert.deepEqual(result.mismatchedFields, [field]);
  }
  const nonRub = { ...catalog, currency: 'USD' };
  assert.equal(verifyAvitoCard(nonRub, details(nonRub)).comparisonStatus, 'unverified');
});

test('сверка карточки: характеристики и provenance сохраняют фактические данные каждого наблюдения', () => {
  const card = { ...catalog, vehicle: { ...catalog.vehicle, make: 'Honda', model: 'Civic' },
    provenance: { externalId: 'card.item.id', 'vehicle.make': 'card.ga[4].brand',
      'vehicle.model': 'card.ga[4].model', 'vehicle.year': 'card.ga[4].year',
      'vehicle.mileageKm': 'card.ga[4].mileage' } };
  const result = verifyAvitoCard(catalog, details(card));
  assert.equal(result.comparisonStatus, 'match');
  assert.deepEqual(result.catalogVehicle, catalog.vehicle);
  assert.deepEqual(result.cardVehicle, card.vehicle);
  assert.deepEqual(result.cardVehicleProvenance, {
    'vehicle.make': 'card.ga[4].brand', 'vehicle.model': 'card.ga[4].model',
    'vehicle.year': 'card.ga[4].year', 'vehicle.mileageKm': 'card.ga[4].mileage',
  });
  assert.equal(result.catalogVehicleProvenance.title, undefined);
});

test('сверка карточки: отказ или отсутствующий DTO не создают ложное сравнение', () => {
  for (const [outcome, record] of [['blocked', null], ['rate_limited', null], ['schema_changed', null],
    ['success', null], ['timeout', catalog]] as const) {
    const result = verifyAvitoCard(catalog, { outcome, record, diagnostics: {}, retryAfterSeconds: null });
    assert.equal(result.fetchSucceeded, false);
    assert.equal(result.comparisonStatus, 'not_compared');
    assert.equal(result.titleMatches, null);
    assert.equal(result.fullPriceMatches, null);
    assert.equal(result.cardVehicle, null);
    assert.deepEqual(result.mismatchedFields, []);
    assert.equal(result.outcome, outcome);
  }
});

test('пауза источника: будущий blockedUntil запрещает запрос и округляет ожидание вверх', () => {
  const now = Date.parse('2026-10-11T15:00:00.000Z');
  assert.deepEqual(activeSourceBackoff('2026-10-11T15:00:01.001Z', now), {
    blockedUntil: '2026-10-11T15:00:01.001Z', remainingSeconds: 2,
  });
});

test('пауза источника: отсутствующий или уже истёкший blockedUntil не задерживает запрос', () => {
  const now = Date.parse('2026-10-11T15:00:00.000Z');
  for (const until of [undefined, null, '2026-10-11T14:59:59.999Z', '2026-10-11T15:00:00.000Z']) {
    assert.equal(activeSourceBackoff(until, now), null);
  }
});

test('CLI карточек соблюдает сохранённый source backoff без fetch и изменения состояния', async t => {
  const prefix = resolve(join(tmpdir(), 'carradar-card-backoff-'));
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(prefix), 'cleanup remains in its task temp directory');
    await rm(directory, { recursive: true, force: true });
  });
  const dataDir = join(directory, 'state');
  const blockedUntil = new Date(Date.now() + 120_000).toISOString();
  const store = await FileStore.open(dataDir);
  try {
    await store.updateSource('avito', { failureCount: 1, blockedUntil, lastAttempt: new Date().toISOString(),
      lastSuccess: null, lastOutcome: 'rate_limited' });
    await store.compact();
  } finally { await store.close(); }
  const stateBytes = async () => {
    const files = (await readdir(dataDir)).sort();
    return await Promise.all(files.map(async name => ({ name, bytes: await readFile(join(dataDir, name)) })));
  };
  const before = await stateBytes();
  assert.ok(before.some(file => file.name === 'snapshot.json'));
  assert.ok(before.some(file => file.name === 'journal.ndjson'));
  const config = join(directory, 'searches.json');
  const reportPath = join(directory, 'report.json');
  const tracePath = join(directory, 'fetch-count.txt');
  const runner = join(directory, 'runner.mjs');
  await writeFile(config, JSON.stringify({ dataDir, searches: [{ id: 'test', source: 'avito',
    url: 'https://www.avito.ru/moskva/avtomobili', enabled: true }] }));
  await writeFile(tracePath, '0');
  // Every adapter instance captures this stub. Even a broken preflight cannot
  // issue a real request; the trace makes an attempted fetch fail the test.
  await writeFile(runner, `import { writeFile } from 'node:fs/promises';
globalThis.fetch = async () => {
  await writeFile(${JSON.stringify(tracePath)}, '1');
  throw new Error('NETWORK_FORBIDDEN_IN_TEST');
};
await import(${JSON.stringify(new URL('../scripts/check-avito-cards.ts', import.meta.url).href)});
`);
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, [runner, '--config', config, '--report', reportPath], {
      cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`CLI timeout: ${stderr}`)); }, 10_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolveRun({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 2, result.stderr);
  assert.equal(await readFile(tracePath, 'utf8'), '0', 'fetch was never called');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.failure, 'source_backoff');
  assert.equal(report.sourceBackoff.blockedUntil, blockedUntil);
  assert.ok(Number.isInteger(report.sourceBackoff.remainingSeconds) && report.sourceBackoff.remainingSeconds > 0);
  assert.equal(report.fetchSucceeded, false);
  assert.equal(report.success, false);
  assert.equal(report.catalogue, null);
  assert.deepEqual(report.checks, []);
  assert.equal(JSON.parse(result.stdout).failure, 'source_backoff');
  assert.deepEqual(await stateBytes(), before, 'all persistent files and bytes remain unchanged');
});
