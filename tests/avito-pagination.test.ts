import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAvitoHtml } from '../src/integrations/avito/adapter.ts';

const path = '/moskva/avtomobili/honda/civic-ASgBAgICAkTgtg2ymCjitg3SoSg';
const pageUrl = `https://www.avito.ru${path}?p=4&s=104&radius=0`;
const href = (page: number) => `${path}?p=${page}&s=104&radius=0`;

interface PageData {
  count: number | null;
  mainCount: number | null;
  totalCount: number | null;
  totalElements: number | null;
  itemsOnPage: number | null;
  itemsOnPageMainSection: number | null;
  catalog: { items: unknown[]; pager: Record<string, unknown> | null };
}

function item(index: number) {
  const id = 10001 + index;
  return { type: 'item', categoryId: 9, id, title: `Honda Civic ${index}`,
    urlPath: `${path}/honda_civic_${id}`,
    priceDetailed: { enabled: true, hasValue: true, value: 1_000_000,
      fullString: '1 000 000 ₽', title: { full: 'Цена' } } };
}

// Точная форма счётчиков/pager live p4 от 2026-10-11: 50/50/50/15,
// totalElements=200, next/last отсутствуют, pages содержит 1..4. Записи
// синтетические; проверка всей живой выдачи выполняется отдельно.
function lastPage(): PageData {
  return {
    count: 165, mainCount: 165, totalCount: 165, totalElements: 200,
    itemsOnPage: 15, itemsOnPageMainSection: 15,
    catalog: { items: [...Array.from({ length: 15 }, (_, index) => item(index)), { type: 'banner' }],
      pager: { prev: href(3), start: 0, current: 4,
        pages: Object.fromEntries([1, 2, 3, 4].map(page => [String(page), href(page)])) } },
  };
}

function html(data: PageData, extra = ''): string {
  return `<script type="mime/invalid" data-mfe-state="true">${JSON.stringify({ loaderData: { data } })}</script>${extra}`;
}

test('неполная последняя страница подтверждается ёмкостью 50, округлённым totalElements и точным остатком основных ID', () => {
  const result = parseAvitoHtml(html(lastPage()), pageUrl);
  assert.equal(result.outcome, 'success');
  assert.equal(result.records.length, 15);
  assert.equal(result.endReached, true);
  assert.equal(result.nextCursor, null);
  assert.equal(result.diagnostics.completeCoverage, true);
  assert.equal(result.diagnostics.coverageLimited, false);
  assert.equal(result.diagnostics.endEvidence, 'rounded_capacity_and_exact_main_remainder');
  assert.equal(result.diagnostics.pageCapacity, 50);
  assert.equal(result.diagnostics.itemsOnPage, 15);
  assert.equal(result.diagnostics.skippedBanners, 1);
});

const badEvidence: Array<[string, (data: PageData) => void]> = [
  ['неизвестный mainCount', data => { data.mainCount = null; }],
  ['неизвестный count', data => { data.count = null; }],
  ['несогласованный count', data => { data.count = 164; }],
  ['неизвестный totalCount', data => { data.totalCount = null; }],
  ['totalCount включает другую выдачу', data => { data.totalCount = 166; }],
  ['неизвестная округлённая ёмкость', data => { data.totalElements = null; }],
  ['totalElements не согласован с ёмкостью', data => { data.totalElements = 165; }],
  ['обрезанная источником выдача', data => { data.count = data.mainCount = data.totalCount = 2001; }],
  ['неверный фактический остаток', data => { data.catalog.items.splice(0, 1); }],
  ['несогласованный itemsOnPage', data => { data.itemsOnPage = 14; }],
  ['несогласованный main section', data => { data.itemsOnPageMainSection = 14; }],
  ['повтор основного ID', data => { data.catalog.items[1] = data.catalog.items[0]; }],
  ['неизвестный элемент среди полезных', data => { data.catalog.items.push({ type: 'unknown' }); }],
  ['отсутствующий pager', data => { data.catalog.pager = null; }],
  ['неизвестный pager', data => { data.catalog.pager = {}; }],
  ['неполный набор подтверждённых страниц', data => {
    const pages = data.catalog.pager!.pages as Record<string, unknown>; delete pages['2'];
  }],
  ['ссылка ещё одной страницы в SSR', data => {
    const pages = data.catalog.pager!.pages as Record<string, unknown>; pages['5'] = href(5);
  }],
  ['несогласованный номер текущей ссылки', data => {
    const pages = data.catalog.pager!.pages as Record<string, unknown>; pages['4'] = href(3);
  }],
  ['несогласованный номер промежуточной ссылки', data => {
    const pages = data.catalog.pager!.pages as Record<string, unknown>; pages['2'] = href(3);
  }],
  ['чужой origin промежуточной ссылки', data => {
    const pages = data.catalog.pager!.pages as Record<string, unknown>; pages['2'] = `https://example.invalid${href(2)}`;
  }],
  ['другой фильтр в пути промежуточной ссылки', data => {
    const pages = data.catalog.pager!.pages as Record<string, unknown>; pages['2'] = '/moskva/avtomobili/toyota?p=2';
  }],
];

for (const [reason, mutate] of badEvidence) test(`неполная страница не завершает выдачу: ${reason}`, () => {
  const data = lastPage();
  mutate(data);
  const result = parseAvitoHtml(html(data), pageUrl);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.endReached, false);
  assert.equal(result.diagnostics.completeCoverage, false);
  assert.equal(result.diagnostics.pageCapacity, undefined);
});

test('DOM-ссылка далее противоречит предполагаемому концу неполной страницы', () => {
  const result = parseAvitoHtml(html(lastPage(), `<a href="${href(5).replaceAll('&', '&amp;')}">Далее</a>`), pageUrl);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.endReached, false);
  assert.equal(result.diagnostics.completeCoverage, false);
});

test('явный SSR next сохраняет продолжение даже при точном остатке последней страницы', () => {
  const data = lastPage();
  data.catalog.pager!.next = href(5);
  const result = parseAvitoHtml(html(data), pageUrl);
  assert.equal(result.outcome, 'success');
  assert.equal(result.endReached, false);
  assert.equal(new URL(result.nextCursor!).searchParams.get('p'), '5');
  assert.equal(result.diagnostics.completeCoverage, false);
});

test('request и SSR текущая страница должны совпадать, даже когда остаток подходит под конец', () => {
  const result = parseAvitoHtml(html(lastPage()), pageUrl.replace('p=4', 'p=3'));
  assert.equal(result.outcome, 'partial');
  assert.equal(result.endReached, false);
  assert.equal(result.diagnostics.paginationError, 'pager_current_mismatch');
});
