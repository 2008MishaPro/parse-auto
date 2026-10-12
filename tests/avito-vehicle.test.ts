import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAvitoHtml } from '../src/integrations/avito/adapter.ts';
import { parseAvitoCard } from '../src/integrations/avito/card.ts';
import { avitoCardVehicle, parseAvitoVehicleTitle } from '../src/integrations/avito/vehicle.ts';

const observedAt = '2026-10-11T14:53:06.000Z';
const unknown = { year: null, mileageKm: null };
const unknownVehicle = { make: null, model: null, ...unknown };
const title = 'ВАЗ (LADA) 2101 1.2 MT, 1976, 250\u00a0000\u00a0км';
const buyerPath = "window.__staticRouterHydrationData.loaderData['catalog-or-main-or-item'].buyerItem";
const block = { brand: 'ВАЗ (LADA)', model: '2101', year: '1976', mileage: '250 000 км' };
const titleVehicle = { make: null, model: null, year: 1976, mileageKm: 250000 };

function cardVehicle(ga: unknown, currentTitle = title, at = observedAt) {
  return avitoCardVehicle(currentTitle, at, { ga }, buyerPath);
}

function assertTitleOnly(ga: unknown, currentTitle = title): void {
  const result = cardVehicle(ga, currentTitle);
  assert.deepEqual(result.vehicle, titleVehicle);
  assert.deepEqual(result.provenance, {
    'vehicle.year': `${buyerPath}.item.title (strict vehicle title suffix)`,
    'vehicle.mileageKm': `${buyerPath}.item.title (strict vehicle title suffix)`,
  });
}

test('характеристики заголовка: три независимо наблюдавшихся Honda', () => {
  for (const [currentTitle, year, mileageKm] of [
    ['Honda S2000 2.0 MT, 1999, 141\u00a0750\u00a0км', 1999, 141750],
    ['Honda S2000 2.0 MT, 2002, 129\u00a0800\u00a0км', 2002, 129800],
    ['Honda S2000 2.0 MT, 2000, 250\u00a0000\u00a0км', 2000, 250000],
  ] as const) assert.deepEqual(parseAvitoVehicleTitle(currentTitle, observedAt), { year, mileageKm });
});

test('характеристики заголовка: пробелы ASCII, NBSP и narrow NBSP в точном пробеге', () => {
  for (const space of [' ', '\u00a0', '\u202f']) {
    assert.deepEqual(parseAvitoVehicleTitle(`Honda S2000, 1999, 141${space}750${space}км`, observedAt),
      { year: 1999, mileageKm: 141750 });
  }
});

test('характеристики заголовка: нулевой и несгруппированный целый пробег допустимы', () => {
  for (const mileageKm of [0, 9, 999, 141750, 1234567]) {
    assert.deepEqual(parseAvitoVehicleTitle(`Машина, 1999, ${mileageKm} км`, observedAt),
      { year: 1999, mileageKm });
  }
});

test('характеристики заголовка: год от 1886 до года наблюдения плюс один', () => {
  for (const year of [1886, 2026, 2027]) {
    assert.deepEqual(parseAvitoVehicleTitle(`Машина, ${year}, 0 км`, observedAt), { year, mileageKm: 0 });
  }
});

test('характеристики заголовка: верхняя граница года зависит от observedAt', () => {
  const currentTitle = 'Машина, 2028, 0 км';
  assert.deepEqual(parseAvitoVehicleTitle(currentTitle, observedAt), unknown);
  assert.deepEqual(parseAvitoVehicleTitle(currentTitle, '2027-01-01T00:00:00.000Z'),
    { year: 2028, mileageKm: 0 });
});

test('характеристики заголовка: неизвестные типы не приводятся к строке', () => {
  for (const value of [undefined, null, 1999, {}, [], { toString: () => title }]) {
    assert.deepEqual(parseAvitoVehicleTitle(value, observedAt), unknown);
  }
});

test('характеристики заголовка: неполная пара года и пробега остаётся неизвестной', () => {
  for (const value of ['FAW Bestune T77 1.5 AMT, 2023', 'Машина, 141 750 км', 'Машина, 1999,',
    'Машина, 1999, км', 'Машина', '']) {
    assert.deepEqual(parseAvitoVehicleTitle(value, observedAt), unknown, value);
  }
});

test('характеристики заголовка: неверный год обнуляет всю пару', () => {
  for (const year of ['1885', '2028', '999', '01999', '1999.0', '+1999', '1e3', '0000']) {
    assert.deepEqual(parseAvitoVehicleTitle(`Машина, ${year}, 141 750 км`, observedAt), unknown, year);
  }
});

test('характеристики заголовка: другая единица и приблизительный пробег не принимаются', () => {
  for (const mileage of ['141750 mi', '141750 miles', '141750 м', '141750 km', '141750 тыс. км',
    'около 141750 км', '~141750 км', 'от 141750 км', '141–142 тыс. км']) {
    assert.deepEqual(parseAvitoVehicleTitle(`Машина, 1999, ${mileage}`, observedAt), unknown, mileage);
  }
});

test('характеристики заголовка: группирование пробега требует групп из трёх цифр', () => {
  for (const mileage of ['141 75', '1417 500', '1 41 750', '141  750', '141\t750', '141\n750', '141,750']) {
    assert.deepEqual(parseAvitoVehicleTitle(`Машина, 1999, ${mileage} км`, observedAt), unknown, mileage);
  }
  assert.deepEqual(parseAvitoVehicleTitle('Машина, 1999, 1 234 567 км', observedAt),
    { year: 1999, mileageKm: 1234567 });
});

test('характеристики заголовка: знаки, дроби и exponent не становятся пробегом', () => {
  for (const mileage of ['-1', '+1', '1.0', '1,0', '1e3', '1E3', 'Infinity', 'NaN']) {
    assert.deepEqual(parseAvitoVehicleTitle(`Машина, 1999, ${mileage} км`, observedAt), unknown, mileage);
  }
});

test('характеристики заголовка: целый пробег не теряет точность выше MAX_SAFE_INTEGER', () => {
  assert.deepEqual(parseAvitoVehicleTitle(`Машина, 1999, ${Number.MAX_SAFE_INTEGER} км`, observedAt),
    { year: 1999, mileageKm: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(parseAvitoVehicleTitle('Машина, 1999, 9007199254740992 км', observedAt), unknown);
  assert.deepEqual(parseAvitoVehicleTitle('Машина, 1999, 9 007 199 254 740 992 км', observedAt), unknown);
});

test('характеристики заголовка: неверное время наблюдения оставляет пару неизвестной', () => {
  for (const at of ['', 'not-a-date', '2026-99-11T00:00:00.000Z']) {
    assert.deepEqual(parseAvitoVehicleTitle(title, at), unknown, at);
  }
});

test('характеристики заголовка: только наблюдавшийся маркер битый между годом и пробегом', () => {
  assert.deepEqual(parseAvitoVehicleTitle('ВАЗ (LADA) 2101, 1976, битый, 250 000 км', observedAt),
    { year: 1976, mileageKm: 250000 });
  for (const value of ['ВАЗ (LADA) 2101, 1976, битая, 250 000 км',
    'ВАЗ (LADA) 2101, 1976, битые, 250 000 км', 'ВАЗ (LADA) 2101, 1976, повреждён, 250 000 км',
    'ВАЗ (LADA) 2101, 1976, 250 000 км, битый']) {
    assert.deepEqual(parseAvitoVehicleTitle(value, observedAt), unknown, value);
  }
});

test('характеристики заголовка: пояснение после пробега запрещает точный суффикс', () => {
  for (const suffix of [', срочно', ' по одометру', ' (примерно)', ', 2000']) {
    assert.deepEqual(parseAvitoVehicleTitle(`Машина, 1999, 141 750 км${suffix}`, observedAt), unknown, suffix);
  }
});

test('характеристики карточки: подтверждённый GA блок и точное происхождение всех полей', () => {
  const result = cardVehicle([null, block]);
  assert.deepEqual(result.vehicle, { make: 'ВАЗ (LADA)', model: '2101', year: 1976, mileageKm: 250000 });
  assert.deepEqual(result.provenance, {
    'vehicle.make': `${buyerPath}.ga[1].brand`,
    'vehicle.model': `${buyerPath}.ga[1].model`,
    'vehicle.year': `${buyerPath}.ga[1].year`,
    'vehicle.mileageKm': `${buyerPath}.ga[1].mileage`,
  });
});

test('характеристики карточки: индекс GA блока не закреплён за единицей', () => {
  for (const index of [0, 2, 5]) {
    const ga = Array.from({ length: index }, () => ({ event: 'page_view' }));
    const result = cardVehicle([...ga, block]);
    assert.equal(result.vehicle.make, 'ВАЗ (LADA)');
    assert.equal(result.provenance['vehicle.make'], `${buyerPath}.ga[${index}].brand`);
  }
});

test('характеристики карточки: одинаковые GA блоки разрешены, provenance первого', () => {
  const result = cardVehicle([null, block, { event: 'page_view' }, { ...block }]);
  assert.equal(result.vehicle.make, 'ВАЗ (LADA)');
  assert.equal(result.provenance['vehicle.make'], `${buyerPath}.ga[1].brand`);
  assert.equal(result.provenance['vehicle.year'], `${buyerPath}.ga[1].year`);
});

test('характеристики карточки: неизвестная или не массивная GA структура не обходится рекурсивно', () => {
  for (const ga of [undefined, null, {}, block, { nested: [block] }, 'ga', 1]) assertTitleOnly(ga);
});

test('характеристики карточки: аналитические события и вложенные данные не подменяют flat блок', () => {
  const result = cardVehicle([{ event: 'page_view', data: { ...block, year: '2000' } },
    { attributes: { ...block, mileage: '1 км' } }, block]);
  assert.equal(result.vehicle.make, 'ВАЗ (LADA)');
  assert.equal(result.provenance['vehicle.make'], `${buyerPath}.ga[2].brand`);
  assertTitleOnly([{ event: 'page_view', vehicle: block }]);
});

test('характеристики карточки: неполные и неправильно типизированные блоки не мешают подтверждённому', () => {
  for (const invalid of [{ brand: 'Другая марка' }, { ...block, year: 1976 }, { ...block, mileage: 250000 },
    { ...block, brand: null }, { ...block, model: '' }, { ...block, year: '1976.0' },
    { ...block, year: '1976\n' }, { ...block, mileage: '250 000 км\n' },
    { ...block, mileage: '250 000 км\t' },
    { ...block, mileage: 'примерно 250 000 км' }, { ...block, mileage: '250 00 км' }]) {
    const result = cardVehicle([invalid, block]);
    assert.equal(result.vehicle.make, 'ВАЗ (LADA)', JSON.stringify(invalid));
    assert.equal(result.provenance['vehicle.make'], `${buyerPath}.ga[1].brand`);
  }
});

test('характеристики карточки: полноценный блок с другим годом не фильтруется ради первого совпадения', () => {
  for (const ga of [[block, { ...block, year: '1977' }], [{ ...block, year: '1977' }, block]]) {
    assertTitleOnly(ga);
  }
});

test('характеристики карточки: полноценный блок с другим пробегом создаёт неоднозначность', () => {
  for (const ga of [[block, { ...block, mileage: '1 км' }], [{ ...block, mileage: '1 км' }, block]]) {
    assertTitleOnly(ga);
  }
});

test('характеристики карточки: другое сочетание марки и модели создаёт неоднозначность', () => {
  for (const replacement of [{ ...block, brand: 'Honda' }, { ...block, model: '2102' }]) {
    assertTitleOnly([block, replacement]);
    assertTitleOnly([replacement, block]);
  }
});

test('характеристики карточки: одиночный несовместимый GA блок оставляет год и пробег из заголовка', () => {
  for (const replacement of [{ ...block, year: '1977' }, { ...block, mileage: '1 км' },
    { ...block, brand: 'Honda', model: 'S2000' }]) assertTitleOnly([replacement]);
});

test('характеристики карточки: две различные валидные разбивки общего префикса не выбираются по порядку', () => {
  const currentTitle = 'Aston Martin DBX 4.0 AT, 2025, 100 км';
  const ga = [
    { brand: 'Aston Martin', model: 'DBX', year: '2025', mileage: '100 км' },
    { brand: 'Aston', model: 'Martin DBX', year: '2025', mileage: '100 км' },
  ];
  for (const blocks of [ga, [...ga].reverse()]) {
    const result = cardVehicle(blocks, currentTitle);
    assert.deepEqual(result.vehicle, { make: null, model: null, year: 2025, mileageKm: 100 });
    assert.equal(result.provenance['vehicle.make'], undefined);
    assert.match(result.provenance['vehicle.year']!, /title \(strict vehicle title suffix\)$/u);
  }
});

test('характеристики карточки: префикс марки и модели требует границы слова', () => {
  for (const currentTitle of ['ВАЗ (LADA) 21010, 1976, 250 000 км',
    'ВАЗ (LADA) 2101X 1.2 MT, 1976, 250 000 км', 'Автомобиль ВАЗ (LADA) 2101, 1976, 250 000 км',
    'ВАЗ (LADA)  2101, 1976, 250 000 км', 'ваз (LADA) 2101, 1976, 250 000 км']) {
    assertTitleOnly([block], currentTitle);
  }
  const result = cardVehicle([block], 'ВАЗ (LADA) 2101, 1976, 250 000 км');
  assert.equal(result.vehicle.model, '2101');
  assert.equal(cardVehicle([block], 'ВАЗ\u00a0(LADA)\u202f2101, 1976, 250 000 км').vehicle.model, '2101');
});

test('характеристики карточки: составные марки и модели принимаются из GA без словаря', () => {
  for (const [currentTitle, brand, model] of [
    ['Aston Martin DBX 4.0 AT, 2025, 100 км', 'Aston Martin', 'DBX'],
    ['FAW Bestune T77 1.5 AMT, 2025, 100 км', 'FAW', 'Bestune T77'],
  ] as const) {
    const result = cardVehicle([{ brand, model, year: '2025', mileage: '100 км' }], currentTitle);
    assert.deepEqual(result.vehicle, { make: brand, model, year: 2025, mileageKm: 100 });
  }
});

test('характеристики карточки: GA не подтверждается без строгой пары в заголовке', () => {
  for (const currentTitle of ['ВАЗ (LADA) 2101 1.2 MT, 1976', 'ВАЗ (LADA) 2101 1.2 MT',
    'ВАЗ (LADA) 2101, 1976, битая, 250 000 км']) {
    const result = cardVehicle([block], currentTitle);
    assert.deepEqual(result.vehicle, unknownVehicle, currentTitle);
    assert.deepEqual(result.provenance, {});
  }
  const confirmed = cardVehicle([block], 'ВАЗ (LADA) 2101, 1976, битый, 250 000 км');
  assert.equal(confirmed.vehicle.make, 'ВАЗ (LADA)');
  assert.equal(confirmed.provenance['vehicle.make'], `${buyerPath}.ga[0].brand`);
});

test('характеристики карточки: неверный observedAt не подтверждается GA данными', () => {
  const result = cardVehicle([block], title, 'not-a-date');
  assert.deepEqual(result.vehicle, unknownVehicle);
  assert.deepEqual(result.provenance, {});
});

test('живая минимальная карточка машины: публичный parser использует согласованный GA блок', () => {
  const fixture = readFileSync(new URL('../fixtures/avito/live-vehicle-card.html', import.meta.url), 'utf8');
  const currentUrl = 'https://www.avito.ru/volgograd/avtomobili/vaz_lada_2101_1.2_mt_1976_250_000_km_8366290005';
  const result = parseAvitoCard(fixture, currentUrl, '8366290005', observedAt);
  assert.equal(result.reason, null);
  assert.equal(result.record!.externalId, '8366290005');
  assert.equal(result.record!.priceMinor, null);
  assert.deepEqual(result.record!.vehicle, { make: 'ВАЗ (LADA)', model: '2101', year: 1976, mileageKm: 250000 });
  assert.equal(result.record!.provenance['vehicle.make'], `${buyerPath}.ga[1].brand`);
  assert.equal(result.record!.publishedAt, null);
});

const furtherCards = JSON.parse(readFileSync(new URL('../fixtures/avito/live-vehicle-cards.json', import.meta.url), 'utf8')) as Array<{
  case: string; capturedAt: string; externalId: string; url: string; buyerItem: unknown;
}>;
for (const [label, expected] of [
  ['other_vaz', { make: 'ВАЗ (LADA)', model: '2114 Samara', year: 2007, mileageKm: 200000 }],
  ['foreign', { make: 'Daewoo', model: 'Nexia', year: 2001, mileageKm: 300000 }],
  ['damaged', { make: 'ВАЗ (LADA)', model: 'Priora', year: 2009, mileageKm: 234000 }],
] as const) {
  test(`дополнительная живая карточка: ${label}, отдельные характеристики и точный provenance`, () => {
    const fixture = furtherCards.find(row => row.case === label)!;
    assert.ok(fixture, 'подтверждённая минимальная fixture присутствует');
    const hydration = { loaderData: { 'catalog-or-main-or-item': { buyerItem: fixture.buyerItem } } };
    const html = `<script>window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(JSON.stringify(hydration))});</script>`;
    const result = parseAvitoCard(html, fixture.url, fixture.externalId, fixture.capturedAt);
    assert.equal(result.reason, null);
    assert.equal(result.record!.externalId, fixture.externalId);
    assert.deepEqual(result.record!.vehicle, expected);
    assert.deepEqual(Object.fromEntries(Object.entries(result.record!.provenance).filter(([key]) => key.startsWith('vehicle.'))), {
      'vehicle.make': `${buyerPath}.ga[1].brand`,
      'vehicle.model': `${buyerPath}.ga[1].model`,
      'vehicle.year': `${buyerPath}.ga[1].year`,
      'vehicle.mileageKm': `${buyerPath}.ga[1].mileage`,
    });
    assert.equal(result.record!.publishedAt, null);
  });
}

test('каталог: вложенные автомобильные данные не подменяют пару из заголовка и не угадывают марку', () => {
  const item = {
    type: 'item', id: 123, categoryId: 9, title, urlPath: '/moskva/avtomobili/car_123',
    autoInfo: { make: 'Honda', model: 'S2000', year: 2000, mileage: 1 },
  };
  const html = `<script type="mime/invalid" data-mfe-state="true">${JSON.stringify({ loaderData: {
    data: { count: 1, mainCount: 1, totalCount: 1, itemsOnPage: 1, itemsOnPageMainSection: 1,
      catalog: { items: [item] } },
  } })}</script>`;
  const result = parseAvitoHtml(html, 'https://www.avito.ru/moskva/avtomobili', observedAt);
  assert.equal(result.outcome, 'success');
  assert.deepEqual(result.records[0]!.vehicle, titleVehicle);
  assert.equal(result.records[0]!.provenance['vehicle.year'],
    'loaderData.data.catalog.items[].title (strict vehicle title suffix)');
  assert.equal(result.records[0]!.provenance['vehicle.make'], undefined);
});
