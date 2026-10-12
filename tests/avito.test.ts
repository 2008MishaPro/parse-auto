import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AvitoAdapter, parseAvitoHtml } from '../src/integrations/avito/adapter.ts';
import { extractAvitoCatalog } from '../src/integrations/avito/extract.ts';
import { normalizeAvitoItem } from '../src/integrations/avito/normalize.ts';

const url = 'https://www.avito.ru/moskva/avtomobili';
const observedAt = '2026-10-11T00:00:00.000Z';
const live = readFileSync(new URL('../fixtures/avito/live-page-1.html', import.meta.url), 'utf8');
const narrow = readFileSync(new URL('../fixtures/avito/live-narrow.html', import.meta.url), 'utf8');
const card = readFileSync(new URL('../fixtures/avito/live-card.html', import.meta.url), 'utf8');
const cardId = '8270449145';
const cardUrl = 'https://www.avito.ru/moskva/avtomobili/honda_s2000_2.0_mt_1999_141_750_km_8270449145';
const narrowUrl = 'https://www.avito.ru/moskva/avtomobili/honda/s2000-ASgBAgICAkTgtg2ymCjitg2Oryg?s=104';
const seed = {
  type: 'item', id: 123, categoryId: 9, title: 'Автомобиль &amp; пример',
  urlPath: '/moskva/avtomobili/avtomobil_123',
  priceDetailed: { enabled: true, hasValue: true, value: 1_000_000, fullString: '1 000 000 ₽', string: '1 000 000', title: { full: 'Цена' } },
  sortTimeStamp: 1790000000000, allowTimeStamp: 1780000000000,
};
function html(data: Record<string, unknown>): string {
  return `<script type="mime/invalid" data-mfe-state="true">${JSON.stringify({ loaderData: { data } })}</script>`;
}
function catalog(items: unknown[] = [seed], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    count: 1, mainCount: 1, totalCount: 1, totalElements: 50,
    itemsOnPage: 1, itemsOnPageMainSection: 1,
    catalog: { items, pager: { current: 1, next: null, last: '/moskva/avtomobili', pages: { 1: '/moskva/avtomobili' } } },
    ...overrides,
  };
}

test('живая выдача: ID, полная цена, banner, cap и готовая следующая ссылка', () => {
  const result = parseAvitoHtml(live, url, observedAt);
  assert.equal(result.outcome, 'success');
  assert.equal(result.records.length, 6);
  assert.equal(result.diagnostics.skippedBanners, 1);
  assert.deepEqual(result.records.slice(0, 3).map((item) => item.priceMinor), [null, null, null]);
  assert.equal(result.records[3]!.priceMinor, 4_477_000_000);
  assert.equal(result.records[3]!.currency, 'RUB');
  assert.equal(result.records[0]!.externalId, '8159063849');
  assert.equal(result.records[0]!.publishedAt, null);
  assert.equal(result.records[0]!.observedAt, observedAt);
  assert.deepEqual(result.records[0]!.vehicle, { make: null, model: null, year: null, mileageKm: null });
  assert.equal(result.diagnostics.sourceCount, 83846);
  assert.equal(result.diagnostics.availableCount, 1500);
  assert.equal(result.diagnostics.coverageLimited, true);
  assert.equal(result.endReached, false);
  const next = new URL(result.nextCursor!);
  assert.equal(next.searchParams.get('p'), '2');
  assert.equal(next.searchParams.get('radius'), '0');
  assert.ok(next.searchParams.get('context'));
});

test('узкая живая выдача завершена по mainCount, рекомендации не смешиваются с поиском', () => {
  const result = parseAvitoHtml(narrow, narrowUrl, observedAt);
  assert.equal(result.outcome, 'success');
  assert.deepEqual(result.records.map((item) => item.externalId), ['8270449145', '8229450104', '8101557468']);
  assert.deepEqual(result.records.map((item) => item.priceMinor), [240000000, 290000000, 600000000]);
  assert.deepEqual(result.records.map((item) => item.vehicle), [
    { make: null, model: null, year: 1999, mileageKm: 141750 },
    { make: null, model: null, year: 2002, mileageKm: 129800 },
    { make: null, model: null, year: 2000, mileageKm: 250000 },
  ]);
  for (const record of result.records) {
    assert.equal(record.provenance['vehicle.year'],
      'loaderData.data.catalog.items[].title (strict vehicle title suffix)');
    assert.equal(record.provenance['vehicle.mileageKm'],
      'loaderData.data.catalog.items[].title (strict vehicle title suffix)');
    assert.equal(record.provenance['vehicle.make'], undefined);
  }
  assert.equal(result.diagnostics.catalogTotalCount, 7);
  assert.equal(result.diagnostics.sourceCount, 3);
  assert.equal(result.diagnostics.availableCount, 3);
  assert.equal(result.endReached, true);
  assert.equal(result.diagnostics.completeCoverage, true);
});

test('SSR JSON сначала читается буквально; HTML entities только fallback', () => {
  const plain = html(catalog());
  assert.equal(parseAvitoHtml(plain, url).records[0]!.title, 'Автомобиль &amp; пример');
  const encoded = plain.replace(/<script([^>]*)>([\s\S]*?)<\/script>/, (_match, attrs: string, data: string) =>
    `<script${attrs}>${data.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}</script>`);
  assert.equal(extractAvitoCatalog(encoded)!.encoding, 'html_entities');
  assert.equal(parseAvitoHtml(encoded, url).records[0]!.title, 'Автомобиль &amp; пример');
  const unrelated = '<script type="mime/invalid" data-mfe-state="true">{"loaderData":{"data":{"sandbox":true}}}</script>';
  assert.equal(parseAvitoHtml(unrelated + plain, url).records.length, 1);
});

test('кредит, первый взнос, цена от, неверная валюта и несогласованная сумма остаются null', () => {
  for (const replacement of [
    { fullString: 'от 1 000 000 ₽' }, { fullString: '1 000 000 ₽ / мес.' },
    { title: { full: 'Первоначальный взнос' } }, { title: { full: 'Кредит' } },
    { fullString: '1 000 000 USD' }, { fullString: '2 000 000 ₽' },
    { value: null }, { hasValue: false }, { enabled: false },
  ]) {
    const result = normalizeAvitoItem({ ...seed, priceDetailed: { ...seed.priceDetailed, ...replacement } }, url, observedAt);
    assert.equal(result.record!.priceMinor, null, JSON.stringify(replacement));
    assert.equal(result.record!.currency, null);
  }
});

test('невалидные записи учитываются, полезные записи сохраняются', () => {
  const result = parseAvitoHtml(html(catalog([seed, null, { ...seed, id: {} }, { ...seed, categoryId: 4 },
    { ...seed, title: '' }, { ...seed, urlPath: 'https://evil.example/moskva/avtomobili/avtomobil_123' },
    { ...seed, type: 'new_unknown_type' }, { type: 'banner' } ])), url);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.records.length, 1);
  assert.equal(result.diagnostics.invalidItems, 6);
  assert.equal(result.diagnostics.skippedBanners, 1);
  assert.equal(result.diagnostics.completeCoverage, false);
});

test('конец доступного capped каталога не становится полным охватом', () => {
  const data = catalog([seed], { count: 83846, mainCount: 83846, totalCount: 1500, totalElements: 1500,
    catalog: { items: [seed], pager: { current: 30, next: null, last: '/moskva/avtomobili?p=30', pages: { 30: '/moskva/avtomobili?p=30' } } } });
  const result = parseAvitoHtml(html(data), `${url}?p=30`);
  assert.equal(result.endReached, true);
  assert.equal(result.diagnostics.coverageLimited, true);
  assert.equal(result.diagnostics.completeCoverage, false);
  const liveLast = parseAvitoHtml(readFileSync(new URL('../fixtures/avito/live-last-page.html', import.meta.url), 'utf8'), `${url}?p=30`);
  assert.equal(liveLast.outcome, 'success');
  assert.equal(liveLast.endReached, true);
  assert.equal(liveLast.diagnostics.completeCoverage, false);
  assert.equal(liveLast.diagnostics.endEvidence, 'current_page_equals_available_page_count');
});

test('неподтверждённый пустой результат и незнакомый pager не означают конец', () => {
  for (const data of [
    { catalog: { items: [] } },
    catalog([seed], { count: 2, mainCount: 2, catalog: { items: [seed] } }),
    catalog([seed], { count: 2, mainCount: 2, totalCount: 2, catalog: { items: [seed], pager: { current: 1, next: null, pages: { 1: '/moskva/avtomobili' } } } }),
  ]) {
    const result = parseAvitoHtml(html(data), url);
    assert.equal(result.outcome, 'partial');
    assert.equal(result.endReached, false);
  }
  const empty = parseAvitoHtml(html(catalog([], { count: 0, mainCount: 0, totalCount: 0,
    itemsOnPage: 0, itemsOnPageMainSection: 0, catalog: { items: [] } })), url);
  assert.equal(empty.outcome, 'empty');
  assert.equal(empty.endReached, true);
});

test('DOM next запрещает завершать первую страницу без pager', () => {
  const result = parseAvitoHtml(html(catalog([seed], { catalog: { items: [seed] } })) +
    '<a href="/moskva/avtomobili?x=1&amp;p=2">Далее</a>', url);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.endReached, false);
});

test('подтверждённая нулевая выдача с banner остаётся empty, неизвестная запись остаётся partial', () => {
  const counts = { count: 0, mainCount: 0, totalCount: 0, totalElements: 50,
    itemsOnPage: 0, itemsOnPageMainSection: 0 };
  const empty = parseAvitoHtml(html({ ...counts, catalog: { items: [{ type: 'banner' }] } }), url);
  assert.equal(empty.outcome, 'empty');
  assert.equal(empty.endReached, true);
  assert.equal(empty.diagnostics.completeCoverage, true);
  assert.equal(empty.diagnostics.skippedBanners, 1);
  assert.equal(empty.diagnostics.invalidItems, 0);
  const unknown = parseAvitoHtml(html({ ...counts, catalog: { items: [{ type: 'unknown' }] } }), url);
  assert.equal(unknown.outcome, 'partial');
  assert.equal(unknown.endReached, false);
  assert.equal(unknown.diagnostics.completeCoverage, false);
  assert.equal(unknown.diagnostics.invalidItems, 1);
});

test('пагинация проверяет номер, HTTPS, origin и путь', () => {
  for (const next of ['https://evil.example/moskva/avtomobili?p=2', 'http://www.avito.ru/moskva/avtomobili?p=2',
    '/kazan/avtomobili?p=2', '/moskva/avtomobili?p=1', '/moskva/avtomobili?p=3']) {
    const result = parseAvitoHtml(html(catalog([seed], { catalog: { items: [seed],
      pager: { current: 1, next, last: '/moskva/avtomobili?p=30', pages: { 1: '/moskva/avtomobili' } } } })), url);
    assert.equal(result.outcome, 'partial', next);
    assert.equal(result.nextCursor, null);
    assert.equal(result.endReached, false);
  }
  const repeated = parseAvitoHtml(html(catalog()), `${url}?p=2`);
  assert.equal(repeated.diagnostics.paginationError, 'pager_current_mismatch');
  assert.equal(repeated.endReached, false);
});

test('HTTP отказ, captcha, timeout и неизвестная разметка различаются', async () => {
  for (const [status, outcome] of [[403, 'blocked'], [439, 'blocked'], [429, 'rate_limited'], [401, 'auth_required'], [500, 'transport_error']] as const) {
    const adapter = new AvitoAdapter(async () => ({ status, url, body: '', retryAfterSeconds: 60 }));
    const result = await adapter.collectPage({ url, requestTimeoutSeconds: 1 }, null, new AbortController().signal);
    assert.equal(result.outcome, outcome);
    assert.equal(result.retryAfterSeconds, 60);
    assert.equal(result.endReached, false);
  }
  const timeout = new AvitoAdapter(async () => { throw new DOMException('deadline', 'TimeoutError'); });
  assert.equal((await timeout.collectPage({ url, requestTimeoutSeconds: 1 }, null, new AbortController().signal)).outcome, 'timeout');
  assert.equal(parseAvitoHtml('<html><title>Доступ ограничен: проверка безопасности</title></html>', url).outcome, 'blocked');
  assert.equal(parseAvitoHtml('<html><div>Новая разметка</div></html>', url).outcome, 'schema_changed');
});

test('отмена пробрасывается в ядро', async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = new AvitoAdapter(async () => { throw controller.signal.reason; });
  await assert.rejects(adapter.collectPage({ url, requestTimeoutSeconds: 1 }, null, controller.signal), { name: 'AbortError' });
});

test('мягкий SSR redirect выполняется последовательно с сохранением параметров', async () => {
  const target = '/moskva/avtomobili/honda/s2000-ASgBAgICAkTgtg2ymCjitg2Oryg?s=104&radius=0';
  const redirect = html({ status: { code: 301 }, redirected: true, url: target });
  const requests: string[] = [];
  const adapter = new AvitoAdapter(async (requested) => {
    requests.push(requested);
    return { status: 200, url: requested, body: requests.length === 1 ? redirect : narrow, retryAfterSeconds: null };
  }, 0);
  const result = await adapter.collectPage({ url: `${url}?q=Honda%20S2000&s=104`, requestTimeoutSeconds: 1 }, null, new AbortController().signal);
  assert.equal(result.outcome, 'success');
  assert.equal(result.records.length, 3);
  assert.equal(result.diagnostics.redirectHops, 1);
  assert.equal(result.diagnostics.httpRequests, 2);
  assert.equal(requests[1], `https://www.avito.ru${target}`);
});

test('мягкий redirect ограничен, цикл и чужой сайт являются ошибкой', async () => {
  const query = { url, requestTimeoutSeconds: 1 };
  const signal = new AbortController().signal;
  const loop = new AvitoAdapter(async (requested) => ({ status: 200, url: requested,
    body: html({ redirected: true, url }), retryAfterSeconds: null }), 0);
  assert.equal((await loop.collectPage(query, null, signal)).diagnostics.reason, 'ssr_redirect_loop');
  const foreign = new AvitoAdapter(async (requested) => ({ status: 200, url: requested,
    body: html({ redirected: true, url: 'https://evil.example/moskva/avtomobili' }), retryAfterSeconds: null }), 0);
  assert.equal((await foreign.collectPage(query, null, signal)).diagnostics.reason, 'invalid_ssr_redirect');
  let calls = 0;
  const tooMany = new AvitoAdapter(async (requested) => ({ status: 200, url: requested,
    body: html({ redirected: true, url: `${url}?hop=${++calls}` }), retryAfterSeconds: null }), 0);
  assert.equal((await tooMany.collectPage(query, null, signal)).diagnostics.reason, 'ssr_redirect_limit');
  assert.equal(calls, 4);
});

test('после мягкого redirect cursor с каноническим путём продолжает исходный поиск', async () => {
  const original = `${url}?q=Honda%20S2000&s=104`;
  const canonical = `${narrowUrl}&p=2`;
  let requestedUrl: string | null = null;
  const adapter = new AvitoAdapter(async (requested) => {
    requestedUrl = requested;
    return { status: 200, url: requested, body: html(catalog([seed], {
      catalog: { items: [seed], pager: { current: 2, next: null, last: canonical, pages: { 2: canonical } } },
    })), retryAfterSeconds: null };
  });
  const result = await adapter.collectPage({ url: original, requestTimeoutSeconds: 1 }, canonical, new AbortController().signal);
  assert.equal(requestedUrl, canonical);
  assert.equal(result.outcome, 'success');
  assert.equal(result.endReached, true);
});

test('timeout всей страницы включает ожидание мягкого redirect', async () => {
  const adapter = new AvitoAdapter(async (requested) => ({ status: 200, url: requested,
    body: html({ redirected: true, url: `${url}?redirected=1` }), retryAfterSeconds: null }), 100);
  const result = await adapter.collectPage({ url, requestTimeoutSeconds: 0.01 }, null, new AbortController().signal);
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.diagnostics.redirectHops, 1);
  assert.equal(typeof result.diagnostics.elapsedMs, 'number');
});

test('getDetails проверяет независимый ID/цену и сохраняет безопасную диагностику сессии', async () => {
  const requests: string[] = [];
  const adapter = new AvitoAdapter(async (requested) => {
    requests.push(requested);
    return { status: 200, url: requested, body: card, retryAfterSeconds: null,
      transportDiagnostics: { accessCheck: 'passed', httpRequests: 4 } };
  });
  const result = await adapter.getDetails(cardId, cardUrl, new AbortController().signal);
  assert.equal(result.outcome, 'success');
  assert.equal(result.record!.externalId, cardId);
  assert.equal(result.record!.priceMinor, 240000000);
  assert.equal(result.diagnostics.accessCheck, 'passed');
  assert.equal(result.diagnostics.httpRequests, 4);
  assert.equal(result.diagnostics.priceVerified, true);
  assert.equal(adapter.capabilities().details, true);
  assert.deepEqual(requests, [cardUrl]);
  assert.equal((await adapter.getDetails('123', cardUrl, new AbortController().signal)).outcome, 'schema_changed');
  assert.equal(requests.length, 1);
});

test('getDetails различает отказы, unknown state, чужой redirect и отмену', async () => {
  const signal = new AbortController().signal;
  for (const [status, outcome] of [[439, 'blocked'], [429, 'rate_limited'], [401, 'auth_required'], [500, 'transport_error']] as const) {
    const adapter = new AvitoAdapter(async () => ({ status, url: cardUrl, body: '', retryAfterSeconds: 17 }));
    const result = await adapter.getDetails(cardId, cardUrl, signal);
    assert.equal(result.outcome, outcome);
    assert.equal(result.retryAfterSeconds, 17);
    assert.equal(result.record, null);
  }
  for (const [body, outcome] of [['<html>Доступ ограничен: проверка безопасности</html>', 'blocked'],
    ['<html>Новая разметка</html>', 'schema_changed']] as const) {
    const adapter = new AvitoAdapter(async () => ({ status: 200, url: cardUrl, body, retryAfterSeconds: null }));
    assert.equal((await adapter.getDetails(cardId, cardUrl, signal)).outcome, outcome);
  }
  const foreign = new AvitoAdapter(async () => ({ status: 200, url: 'https://evil.example/car_8270449145', body: card, retryAfterSeconds: null }));
  assert.equal((await foreign.getDetails(cardId, cardUrl, signal)).diagnostics.reason, 'unexpected_redirect');
  const timeout = new AvitoAdapter(async () => { throw new DOMException('deadline', 'TimeoutError'); });
  assert.equal((await timeout.getDetails(cardId, cardUrl, signal)).outcome, 'timeout');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(timeout.getDetails(cardId, cardUrl, controller.signal), { name: 'AbortError' });
  const softRefusal = new AvitoAdapter(async (requested) => ({ status: 200, url: requested, body: card,
    retryAfterSeconds: null, transportDiagnostics: { accessCheck: 'failed', accessCheckReason: 'page_still_refused' } }));
  const details = await softRefusal.getDetails(cardId, cardUrl, signal);
  assert.equal(details.outcome, 'blocked');
  assert.equal(details.diagnostics.httpStatus, 200);
  assert.equal(details.record, null);
  const page = await softRefusal.collectPage({ url, requestTimeoutSeconds: 1 }, null, signal);
  assert.equal(page.outcome, 'blocked');
  assert.equal(page.diagnostics.httpStatus, 200);
});
