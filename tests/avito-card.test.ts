import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAvitoCard } from '../src/integrations/avito/card.ts';

const url = 'https://www.avito.ru/moskva/avtomobili/honda_s2000_2.0_mt_1999_141_750_km_8270449145';
const id = '8270449145';
const observedAt = '2026-10-11T08:00:00.000Z';
const live = readFileSync(new URL('../fixtures/avito/live-card.html', import.meta.url), 'utf8');
const seed = {
  id: 8270449145, categoryId: 9, category: { id: 9, isCars: true },
  url: new URL(url).pathname, title: 'Honda S2000 2.0 MT, 1999, 141\u00a0750\u00a0км', price: 2400000,
  formattedPrice: { value: 2400000, isHasValue: true, currencySign: '₽', formatedString: '2\u00a0400\u00a0000&nbsp;₽', string: '2\u00a0400\u00a0000', postfix: '', normalizedPricePostFix: '', rubPricePostfix: '₽' },
};
function html(item: unknown = seed, buyerOverrides: Record<string, unknown> = {}): string {
  const state = { loaderData: { 'catalog-or-main-or-item': { buyerItem: { item, priceString: '2\u00a0400\u00a0000&nbsp;₽', ...buyerOverrides } } } };
  return `<script>window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(JSON.stringify(state))});</script>`;
}

test('живая карточка: независимые ID, URL и полная RUB цена подтверждены', () => {
  const result = parseAvitoCard(live, url, id, observedAt);
  assert.equal(result.reason, null);
  assert.equal(result.record!.externalId, id);
  assert.equal(result.record!.url, url);
  assert.equal(result.record!.priceMinor, 240000000);
  assert.equal(result.record!.currency, 'RUB');
  assert.equal(result.record!.observedAt, observedAt);
  assert.equal(result.record!.publishedAt, null);
  assert.deepEqual(result.record!.vehicle, { make: null, model: null, year: 1999, mileageKm: 141750 });
  assert.equal(result.record!.provenance['vehicle.year'],
    "window.__staticRouterHydrationData.loaderData['catalog-or-main-or-item'].buyerItem.item.title (strict vehicle title suffix)");
  assert.equal(result.record!.provenance['vehicle.mileageKm'],
    "window.__staticRouterHydrationData.loaderData['catalog-or-main-or-item'].buyerItem.item.title (strict vehicle title suffix)");
  assert.match(result.record!.provenance.priceMinor!, /buyerItem\.item\.price \+ formattedPrice.value/u);
});

test('ID, категория и URL карточки обязаны соответствовать запросу', () => {
  for (const replacement of [
    { id: 123 }, { id: null }, { categoryId: 4 }, { category: { id: 4, isCars: false } },
    { url: '/moskva/avtomobili/car_123' }, { url: 'https://evil.example/moskva/avtomobili/car_8270449145' },
    { url: 'http://www.avito.ru/moskva/avtomobili/car_8270449145' }, { title: '' },
  ]) assert.equal(parseAvitoCard(html({ ...seed, ...replacement }), url, id).record, null, JSON.stringify(replacement));
  assert.equal(parseAvitoCard(html(), 'https://www.avito.ru/moskva/avtomobili', id).record, null);
  assert.equal(parseAvitoCard(html(), url, '123').record, null);
  assert.equal(parseAvitoCard(html(), url, '').reason, 'invalid_expected_id');
});

test('неподтверждённая, кредитная, несогласованная цена и другая валюта остаются null', () => {
  for (const replacement of [
    { value: 0 }, { isHasValue: false }, { currencySign: 'USD' },
    { formatedString: 'от 2\u00a0400\u00a0000 ₽' }, { formatedString: '2\u00a0400\u00a0000 ₽ / мес.' },
    { formatedString: '3\u00a0400\u00a0000 ₽' }, { postfix: 'Первоначальный взнос' },
    { normalizedPricePostFix: 'неподтверждённый формат' }, { rubPricePostfix: 'USD' },
  ]) {
    const result = parseAvitoCard(html({ ...seed, formattedPrice: { ...seed.formattedPrice, ...replacement } }), url, id);
    assert.equal(result.record!.priceMinor, null, JSON.stringify(replacement));
    assert.equal(result.record!.currency, null);
    assert.equal(result.record!.provenance.priceMinor, undefined);
  }
  assert.equal(parseAvitoCard(html({ ...seed, price: null }), url, id).record!.priceMinor, null);
  assert.equal(parseAvitoCard(html(seed, { priceString: '2\u00a0900\u00a0000&nbsp;₽' }), url, id).record!.priceMinor, null);
});

test('вложенные price0, даты и данные машины не подменяют подтверждённые поля', () => {
  const result = parseAvitoCard(html({ ...seed, price: null, sortTimeStamp: 1780000000000,
    autoInfo: { year: 1999, mileage: 141750 }, carMarketPrice: { price0: 2400000 } }), url, id);
  assert.equal(result.record!.priceMinor, null);
  assert.equal(result.record!.publishedAt, null);
  assert.deepEqual(result.record!.vehicle, { make: null, model: null, year: 1999, mileageKm: 141750 });
});

test('только наблюдавшийся JSON путь карточки; произвольный JS не исполняется', () => {
  assert.equal(parseAvitoCard('<script>window.__staticRouterHydrationData = JSON.parse("invalid");</script>', url, id).record, null);
  assert.equal(parseAvitoCard('<script>window.__staticRouterHydrationData = {item: 123};</script>', url, id).record, null);
  assert.equal(parseAvitoCard('<script>window.__preloadedState__ = "{}";</script>', url, id).record, null);
  assert.equal(parseAvitoCard('<html>Доступ ограничен</html>', url, id).reason, 'card_state_not_found');
  const differentPath = { loaderData: { other: { buyerItem: { item: seed } } } };
  const data = JSON.stringify(JSON.stringify(differentPath));
  assert.equal(parseAvitoCard(`<script>window.__staticRouterHydrationData = JSON.parse(${data});</script>`, url, id).record, null);
  const globalKey = '__carradar_card_test_executed';
  assert.equal(parseAvitoCard(`<script>window.__staticRouterHydrationData = JSON.parse(globalThis.${globalKey} = "{}");</script>`, url, id).record, null);
  assert.equal(Reflect.get(globalThis, globalKey), undefined);
});
