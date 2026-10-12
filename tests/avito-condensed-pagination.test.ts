import assert from 'node:assert/strict';
import test from 'node:test';
import { AvitoAdapter, parseAvitoHtml } from '../src/integrations/avito/adapter.ts';

const path = '/volgogradskaya_oblast/avtomobili/do-150000-rubley-ASgCAgECAUXGmgwWeyJmcm9tIjowLCJ0byI6MTUwMDAwfQ';
const href = (page: number): string => `${path}?${page === 1 ? '' : `p=${page}&`}s=104`;
const pageUrl = (page: number): string => `https://www.avito.ru${href(page)}`;

interface PageData {
  count: number; mainCount: number; totalCount: number; totalElements: number;
  itemsOnPage: number; itemsOnPageMainSection: number;
  catalog: { items: unknown[]; pager: { current: number; prev?: unknown; start?: unknown; pages: Record<string, unknown> } };
}

function item(index: number) {
  const id = 20_001 + index;
  return { type: 'item', id, categoryId: 9, title: `Автомобиль ${index}`,
    urlPath: `/volgograd/avtomobili/avtomobil_${id}`,
    priceDetailed: { enabled: true, hasValue: true, value: 100_000, fullString: '100 000 ₽', title: { full: 'Цена' } } };
}

// Счётчики/current/pages/prev соответствуют live p23 2026-10-11 16:00:55 МСК:
// 1133 основных объявления, ёмкость 1150, остаток 33, prev=p22. Записи и
// метаданные start синтетические; live-диагностика декодирует start как null.
function lastPage(total = 1133): PageData {
  const last = Math.ceil(total / 50);
  const remainder = total - (last - 1) * 50;
  return { count: total, mainCount: total, totalCount: total, totalElements: last * 50,
    itemsOnPage: remainder, itemsOnPageMainSection: remainder,
    catalog: { items: [...Array.from({ length: remainder }, (_, index) => item(index)), { type: 'banner' }],
      pager: { current: last, prev: href(last - 1), start: null, pages: {
        '1': href(1), [String(last - 1)]: href(last - 1), [String(last)]: href(last), '…': href(last - 2),
      } } } };
}

function html(data: PageData, extra = ''): string {
  return `<script type="mime/invalid" data-mfe-state="true">${JSON.stringify({ loaderData: { data } })}</script>${extra}`;
}

test('compact p23 shape proves the exact 33-record remainder without treating unknown start metadata as a link', () => {
  const result = parseAvitoHtml(html(lastPage()), pageUrl(23));
  assert.equal(result.outcome, 'success');
  assert.equal(result.records.length, 33);
  assert.equal(result.endReached, true);
  assert.equal(result.nextCursor, null);
  assert.equal(result.diagnostics.completeCoverage, true);
  assert.equal(result.diagnostics.coverageLimited, false);
  assert.equal(result.diagnostics.endEvidence, 'rounded_capacity_and_exact_main_remainder');
  assert.equal(result.diagnostics.pageCapacity, 50);
  assert.equal(result.diagnostics.skippedBanners, 1);
  assert.deepEqual(result.diagnostics.pagerKeys, ['1', '22', '23', '…']);
  assert.equal(result.diagnostics.pagerPreviousPage, 22);
  assert.equal(result.diagnostics.pagerStartPage, null);
  assert.ok(!JSON.stringify(result.diagnostics).includes('https://'));
});

const badEvidence: Array<[string, (data: PageData) => void]> = [
  ['missing prev link', data => { delete data.catalog.pager.prev; }],
  ['prev points two pages back', data => { data.catalog.pager.prev = href(21); }],
  ['foreign origin in prev', data => { data.catalog.pager.prev = `https://example.invalid${href(22)}`; }],
  ['missing Unicode ellipsis', data => { delete data.catalog.pager.pages['…']; }],
  ['ASCII dots are not the observed Unicode ellipsis', data => {
    data.catalog.pager.pages['...'] = data.catalog.pager.pages['…']; delete data.catalog.pager.pages['…'];
  }],
  ['ellipsis points to the wrong jump page', data => { data.catalog.pager.pages['…'] = href(20); }],
  ['ellipsis link is not a string', data => { data.catalog.pager.pages['…'] = 21; }],
  ['foreign origin in ellipsis', data => { data.catalog.pager.pages['…'] = `https://example.invalid${href(21)}`; }],
  ['different path in preceding numeric page', data => { data.catalog.pager.pages['22'] = '/volgograd/avtomobili?p=22&s=104'; }],
  ['extra numeric page outside the observed compact shape', data => { data.catalog.pager.pages['2'] = href(2); }],
  ['missing first-page reference', data => { delete data.catalog.pager.pages['1']; }],
  ['missing preceding numeric-page reference', data => { delete data.catalog.pager.pages['22']; }],
  ['last numeric reference repeats the preceding page', data => { data.catalog.pager.pages['23'] = href(22); }],
  ['current link contains conflicting repeated page parameters', data => { data.catalog.pager.pages['23'] = `${href(23)}&p=24`; }],
  ['ellipsis contains repeated page parameters even with equal values', data => { data.catalog.pager.pages['…'] = `${href(21)}&p=21`; }],
  ['current page number is not a canonical numeric string', data => { data.catalog.pager.pages['23'] = href(23).replace('p=23', 'p=023'); }],
  ['inconsistent total count', data => { data.count = 1135; }],
  ['invalid item alongside the exact remainder', data => { data.catalog.items.push({ type: 'unknown' }); }],
  ['duplicate ID within the exact remainder', data => { data.catalog.items[1] = data.catalog.items[0]; }],
  ['source cap truncates the available catalog', data => { data.count = data.mainCount = data.totalCount = 2000; }],
];

for (const [reason, mutate] of badEvidence) test(`compact pager cannot prove the end: ${reason}`, () => {
  const data = lastPage();
  mutate(data);
  const result = parseAvitoHtml(html(data), pageUrl(23));
  assert.equal(result.outcome, 'partial');
  assert.equal(result.endReached, false);
  assert.equal(result.diagnostics.completeCoverage, false);
  assert.equal(result.diagnostics.pageCapacity, undefined);
});

test('optional start metadata never controls end evidence or causes the adapter to follow its value', async () => {
  const values: unknown[] = [undefined, null, false, 0, href(2), '/volgograd/avtomobili?s=104',
    'https://example.invalid/private?context=fixture-secret', `${href(1)}&p=2`];
  for (const value of values) {
    const data = lastPage();
    if (value === undefined) delete data.catalog.pager.start;
    else data.catalog.pager.start = value;
    const requested: string[] = [];
    const adapter = new AvitoAdapter(async url => {
      requested.push(url);
      return { status: 200, url, body: html(data), retryAfterSeconds: null };
    });
    const result = await adapter.collectPage({ url: pageUrl(23), requestTimeoutSeconds: 1 }, null, new AbortController().signal);
    assert.deepEqual(requested, [pageUrl(23)]);
    assert.equal(result.outcome, 'success', String(value));
    assert.equal(result.endReached, true, String(value));
    assert.equal(result.diagnostics.completeCoverage, true, String(value));
    assert.equal(result.diagnostics.pagerPreviousPage, 22);
    const serialized = JSON.stringify({ pagerKeys: result.diagnostics.pagerKeys,
      pagerStartPage: result.diagnostics.pagerStartPage, pagerPreviousPage: result.diagnostics.pagerPreviousPage,
      pagerStartType: result.diagnostics.pagerStartType });
    assert.ok(!serialized.includes('fixture-secret'));
    assert.ok(!serialized.includes('context'));
    assert.ok(!serialized.includes('https://'));
    assert.ok(!JSON.stringify(result.diagnostics).includes('fixture-secret'));
    assert.ok(!JSON.stringify(result.diagnostics).includes('example.invalid'));
  }
});

test('the observed compact shape is not accepted with an impossible four-page ellipsis', () => {
  const result = parseAvitoHtml(html(lastPage(165)), pageUrl(4));
  assert.equal(result.outcome, 'partial');
  assert.equal(result.endReached, false);
  assert.equal(result.diagnostics.completeCoverage, false);
});

test('matching request and pager current still cannot finish before the last page implied by the total', () => {
  const data = lastPage();
  data.catalog.pager.current = 22;
  const result = parseAvitoHtml(html(data), pageUrl(22));
  assert.equal(result.outcome, 'partial');
  assert.equal(result.endReached, false);
  assert.equal(result.diagnostics.paginationError, 'unconfirmed_end');
});

test('a future DOM page overrides otherwise consistent compact last-page evidence', () => {
  const next = href(24).replaceAll('&', '&amp;');
  const result = parseAvitoHtml(html(lastPage(), `<a href="${next}">Далее</a>`), pageUrl(23));
  assert.equal(result.outcome, 'partial');
  assert.equal(result.endReached, false);
  assert.equal(result.diagnostics.completeCoverage, false);
});
