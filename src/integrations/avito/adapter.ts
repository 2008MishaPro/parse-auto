import type { CollectDetailsResult, CollectPageResult, Outcome, SourceAdapter } from '../../core/contracts.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { getHtml } from '../../transport/http.ts';
import { asObject, decodeEntities, extractAvitoCatalog, extractAvitoRedirect, type AvitoCatalog } from './extract.ts';
import { avitoUrl, normalizeAvitoItem } from './normalize.ts';
import { AvitoHttpSession } from './http-session.ts';
import { parseAvitoCard } from './card.ts';

function failure(outcome: Outcome, diagnostics: Record<string, unknown>, retryAfterSeconds: number | null = null): CollectPageResult {
  return { outcome, records: [], nextCursor: null, endReached: false, diagnostics, retryAfterSeconds };
}

function httpFailure(status: number): Outcome | null {
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'auth_required';
  if ([403, 439].includes(status)) return 'blocked';
  return status < 200 || status >= 300 ? 'transport_error' : null;
}

function accessChallenge(html: string): boolean {
  const visibleText = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<[^>]*>/g, ' ');
  return /Доступ\s+ограничен|Подтвердите,?\s+что\s+вы\s+не\s+робот|Проверка\s+браузера|доступ\s+с\s+вашего\s+IP|id=["'](?:captcha|challenge)/iu.test(visibleText + html.slice(0, 12000));
}

function pagerPageNumber(href: unknown, page: URL): number | null {
  const target = typeof href === 'string' ? avitoUrl(href, page.href) : null;
  if (!target || target.origin !== page.origin || target.pathname !== page.pathname
    || target.searchParams.getAll('p').length > 1) return null;
  const value = target.searchParams.get('p') ?? '1';
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && value === String(number) ? number : null;
}

// Проверено на автомобильном SSR: полные страницы содержат 50 основных
// объявлений, totalElements округлён до этой ёмкости, а itemsOnPage на последней
// странице сообщает фактический остаток (например, 15 из 165), не page size.
// Применяем это свидетельство только к согласованной неограниченной выдаче
// с полным pager либо строгой формой сжатого pager последней страницы.
// Отсутствия next для конца недостаточно.
function confirmsCompressedLastPager(pager: Record<string, unknown>, pages: Record<string, unknown>, page: URL,
  lastPage: number): boolean {
  if (lastPage < 5) return false;
  const expectedKeys = new Set(['1', String(lastPage - 1), String(lastPage), '…']);
  const keys = Object.keys(pages);
  if (keys.length !== expectedKeys.size || keys.some(key => !expectedKeys.has(key))) return false;
  const matchesPage = (href: unknown, number: number): boolean => pagerPageNumber(href, page) === number;
  return matchesPage(pages['1'], 1) && matchesPage(pages[String(lastPage - 1)], lastPage - 1)
    && matchesPage(pages[String(lastPage)], lastPage) && matchesPage(pages['…'], lastPage - 2)
    && matchesPage(pager.prev, lastPage - 1);
}

function confirmsShortLastPage(catalog: AvitoCatalog, page: URL, records: CollectPageResult['records'],
  invalidItems: number, coverageLimited: boolean, domNextPage: boolean): boolean {
  const capacity = 50;
  const sourceCount = catalog.mainCount;
  const current = catalog.pager?.current;
  const pages = asObject(catalog.pager?.pages);
  if (sourceCount === null || sourceCount <= capacity || sourceCount > 1500 || catalog.count !== sourceCount
    || catalog.totalCount !== sourceCount || coverageLimited || domNextPage || invalidItems !== 0
    || typeof current !== 'number' || !Number.isSafeInteger(current) || !pages) return false;
  const lastPage = Math.ceil(sourceCount / capacity);
  const remainder = sourceCount - (lastPage - 1) * capacity;
  if (current !== lastPage || remainder >= capacity || catalog.totalElements !== lastPage * capacity
    || catalog.itemsOnPage !== remainder || catalog.itemsOnPageMainSection !== remainder
    || records.length !== remainder || new Set(records.map(record => record.externalId)).size !== remainder) return false;
  if (Object.keys(pages).length !== lastPage) {
    return confirmsCompressedLastPager(catalog.pager!, pages, page, lastPage);
  }
  for (let index = 1; index <= lastPage; index++) {
    const href = pages[String(index)];
    const target = typeof href === 'string' ? avitoUrl(href, page.href) : null;
    if (!target || target.origin !== page.origin || target.pathname !== page.pathname
      || Number(target.searchParams.get('p') ?? '1') !== index) return false;
  }
  return true;
}

export function parseAvitoHtml(html: string, pageUrl: string, observedAt = new Date().toISOString()): CollectPageResult {
  const base = avitoUrl(pageUrl);
  if (!base) return failure('schema_changed', { reason: 'invalid_search_url' });
  if (extractAvitoRedirect(html)) return failure('schema_changed', { reason: 'ssr_redirect_requires_follow' });
  const catalog = extractAvitoCatalog(html);
  if (!catalog) {
    if (accessChallenge(html)) {
      return failure('blocked', { reason: 'access_challenge' });
    }
    return failure('schema_changed', { reason: 'catalog_ssr_not_found' });
  }
  const records: CollectPageResult['records'] = [];
  const invalidReasons: Record<string, number> = {};
  let skippedBanners = 0;
  for (const item of catalog.items) {
    if (asObject(item)?.type === 'banner') { skippedBanners++; continue; }
    const normalized = normalizeAvitoItem(item, base.href, observedAt);
    if (normalized.record) records.push(normalized.record);
    else {
      const reason = normalized.reason ?? 'invalid_item';
      invalidReasons[reason] = (invalidReasons[reason] ?? 0) + 1;
    }
  }
  const invalidItems = Object.values(invalidReasons).reduce((sum, value) => sum + value, 0);
  const sourceCount = catalog.mainCount ?? catalog.count;
  const availableCount = sourceCount !== null && catalog.totalElements !== null
    ? Math.min(sourceCount, catalog.totalElements) : catalog.totalCount;
  const coverageLimited = sourceCount !== null && availableCount !== null && sourceCount > availableCount;
  const diagnostics: Record<string, unknown> = {
    extraction: 'ssr_catalog', scriptEncoding: catalog.encoding,
    rawItems: catalog.items.length, validItems: records.length, skippedBanners, invalidItems, invalidReasons,
    sourceCount, availableCount, catalogCount: catalog.count, catalogTotalCount: catalog.totalCount,
    totalElements: catalog.totalElements, itemsOnPage: catalog.itemsOnPage,
    itemsOnPageMainSection: catalog.itemsOnPageMainSection, coverageLimited,
    publishedAtAvailable: false,
  };
  const pager = catalog.pager;
  let nextCursor: string | null = null;
  let endReached = false;
  let paginationError: string | null = null;
  const requestedPage = Number(base.searchParams.get('p') ?? '1');
  const domNextPage = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].some((link) => {
    const url = avitoUrl(decodeEntities(link[1] ?? link[2] ?? ''), base.href);
    return url?.origin === base.origin && url.pathname === base.pathname && Number(url.searchParams.get('p')) > requestedPage;
  });
  const completeFirstPage = !pager && requestedPage === 1 && !domNextPage && invalidItems === 0
    && sourceCount !== null && catalog.count === sourceCount && catalog.mainCount === sourceCount
    && catalog.itemsOnPageMainSection === sourceCount && records.length === sourceCount
    && new Set(records.map((item) => item.externalId)).size === sourceCount;
  if (completeFirstPage) {
    endReached = true;
    diagnostics.endEvidence = 'main_count_equals_first_page_main_items';
  } else if (!pager || typeof pager.current !== 'number' || !Number.isSafeInteger(pager.current) || pager.current < 1
    || !asObject(pager.pages)) {
    paginationError = 'unconfirmed_pager';
  } else {
    diagnostics.currentPage = pager.current;
    const currentPages = asObject(pager.pages)!;
    const currentHref = currentPages[String(pager.current)];
    const currentUrl = typeof currentHref === 'string' ? avitoUrl(currentHref, base.href) : null;
    if (requestedPage !== pager.current || !currentUrl || currentUrl.origin !== base.origin || currentUrl.pathname !== base.pathname
      || Number(currentUrl.searchParams.get('p') ?? '1') !== pager.current) {
      paginationError = 'pager_current_mismatch';
    } else if (typeof pager.next === 'string' && pager.next) {
      const next = avitoUrl(pager.next, base.href);
      const nextPage = Number(next?.searchParams.get('p'));
      if (!next || next.origin !== base.origin || next.pathname !== base.pathname
        || !Number.isSafeInteger(nextPage) || nextPage !== pager.current + 1) {
        paginationError = 'invalid_next_page';
      } else nextCursor = next.href;
    } else if (pager.next === null || pager.next === undefined) {
      const keys = Object.keys(currentPages);
      const currentPage = pager.current;
      const fullNumericKeys = keys.length === currentPage && keys.every(key => {
        const number = Number(key);
        return Number.isSafeInteger(number) && number >= 1 && number <= currentPage && key === String(number);
      });
      if (!fullNumericKeys) {
        // Expose page numbers and shape only; never dump pager URLs or contexts.
        diagnostics.pagerKeys = keys.slice(0, 32).map(key => /^[1-9]\d{0,4}$/.test(key) || key === '…' ? key : 'unknown');
        if (keys.length > 32) diagnostics.pagerKeysTruncated = true;
        diagnostics.pagerStartPage = pagerPageNumber(pager.start, base);
        diagnostics.pagerStartType = pager.start === null ? 'null' : typeof pager.start;
        diagnostics.pagerPreviousPage = pagerPageNumber(pager.prev, base);
      }
      // A missing link alone is not evidence of the end. Confirm last/current,
      // or the explicit zero-count first page of an empty result.
      const last = typeof pager.last === 'string' ? avitoUrl(pager.last, base.href) : null;
      const lastPage = last ? Number(last.searchParams.get('p') ?? '1') : null;
      const perPage = catalog.itemsOnPage;
      const countConfirmsLast = availableCount !== null && availableCount > 0 && perPage !== null && perPage > 0
        && pager.current === Math.ceil(availableCount / perPage) && !domNextPage;
      const shortPageConfirmsLast = confirmsShortLastPage(catalog, base, records, invalidItems, coverageLimited, domNextPage);
      if ((last && last.origin === base.origin && last.pathname === base.pathname && lastPage === pager.current)
        || countConfirmsLast || shortPageConfirmsLast
        || (sourceCount === 0 && availableCount === 0 && catalog.items.length === 0 && pager.current === 1)) {
        endReached = true;
        diagnostics.endEvidence = shortPageConfirmsLast ? 'rounded_capacity_and_exact_main_remainder'
          : countConfirmsLast ? 'current_page_equals_available_page_count' : 'pager_last_equals_current';
        if (shortPageConfirmsLast) diagnostics.pageCapacity = 50;
      } else paginationError = 'unconfirmed_end';
    } else paginationError = 'invalid_next_page';
  }
  if (paginationError) diagnostics.paginationError = paginationError;
  diagnostics.availableEndReached = endReached;
  const confirmedEmpty = records.length === 0 && invalidItems === 0
    && skippedBanners === catalog.items.length && sourceCount === 0 && availableCount === 0 && endReached;
  const noVerifiedEmpty = records.length === 0 && !confirmedEmpty;
  if (noVerifiedEmpty) diagnostics.reason = 'empty_unconfirmed';
  diagnostics.completeCoverage = endReached && !coverageLimited && sourceCount !== null && availableCount !== null
    && invalidItems === 0 && !paginationError && !noVerifiedEmpty;
  return {
    outcome: invalidItems > 0 || paginationError || noVerifiedEmpty ? 'partial' : records.length ? 'success' : 'empty',
    records, nextCursor, endReached, diagnostics, retryAfterSeconds: null,
  };
}

export class AvitoAdapter implements SourceAdapter {
  readonly id = 'avito';
  private readonly fetchHtml: typeof getHtml;
  private readonly redirectDelayMs: number;
  constructor(fetchHtml?: typeof getHtml, redirectDelayMs = 2000) {
    this.fetchHtml = fetchHtml ?? new AvitoHttpSession().getHtml;
    this.redirectDelayMs = redirectDelayMs;
  }
  capabilities() {
    return { pagination: 'SSR catalog.pager; available catalog may be capped', sort: ['s=104 (По дате)'], publishedAt: false, details: true };
  }
  async getDetails(externalId: string, url: string, signal: AbortSignal, requestTimeoutSeconds = 30): Promise<CollectDetailsResult> {
    const page = avitoUrl(url);
    const failed = (outcome: Outcome, diagnostics: Record<string, unknown>, retryAfter: number | null = null): CollectDetailsResult =>
      ({ outcome, record: null, diagnostics, retryAfterSeconds: retryAfter });
    if (!/^[1-9]\d*$/.test(externalId) || !page?.pathname.endsWith(`_${externalId}`)) {
      return failed('schema_changed', { reason: 'invalid_card_identity' });
    }
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(requestTimeoutSeconds * 1000)));
    const pageSignal = AbortSignal.any([signal, timeout]);
    const startedAt = Date.now();
    try {
      pageSignal.throwIfAborted();
      const response = await this.fetchHtml(page.href, requestTimeoutSeconds, pageSignal);
      const diagnostics = { ...response.transportDiagnostics, httpStatus: response.status, requestUrl: page.href,
        elapsedMs: Date.now() - startedAt };
      const refused = httpFailure(response.status);
      if (refused) return failed(refused, diagnostics, response.retryAfterSeconds);
      if (response.transportDiagnostics?.accessCheck === 'failed') return failed('blocked', diagnostics, response.retryAfterSeconds);
      const final = avitoUrl(response.url);
      if (!final || final.origin !== page.origin) return failed('schema_changed', { ...diagnostics, reason: 'unexpected_redirect' });
      const result = parseAvitoCard(response.body, final.href, externalId);
      if (!result.record) return failed(accessChallenge(response.body) ? 'blocked' : 'schema_changed', {
        ...diagnostics, reason: result.reason,
      });
      return { outcome: 'success', record: result.record, retryAfterSeconds: null,
        diagnostics: { ...diagnostics, extraction: 'ssr_buyer_item', canonicalUrl: final.href,
          priceVerified: result.record.priceMinor !== null, publishedAtAvailable: false } };
    } catch (error) {
      if (signal.aborted) throw error;
      const name = error instanceof Error ? error.name : '';
      return failed(timeout.aborted || name === 'TimeoutError' ? 'timeout' : 'transport_error', {
        reason: name || 'request_failed', elapsedMs: Date.now() - startedAt,
      });
    }
  }
  async collectPage(query: { url: string; requestTimeoutSeconds: number }, cursor: string | null, signal: AbortSignal): Promise<CollectPageResult> {
    const search = avitoUrl(query.url);
    let page = avitoUrl(cursor ?? query.url, query.url);
    if (!search || !page || search.origin !== page.origin) {
      return failure('schema_changed', { reason: 'invalid_search_or_cursor_url' });
    }
    const timeout = AbortSignal.timeout(query.requestTimeoutSeconds * 1000);
    const pageSignal = AbortSignal.any([signal, timeout]);
    const startedAt = Date.now();
    let redirectHops = 0;
    let httpRequests = 0;
    try {
      const visited = new Set<string>();
      while (true) {
        pageSignal.throwIfAborted();
        if (visited.has(page.href)) return failure('schema_changed', { reason: 'ssr_redirect_loop', redirectHops });
        visited.add(page.href);
        const response = await this.fetchHtml(page.href, query.requestTimeoutSeconds, pageSignal);
        const requestCount = response.transportDiagnostics?.httpRequests;
        httpRequests += typeof requestCount === 'number' && Number.isSafeInteger(requestCount) && requestCount > 0 ? requestCount : 1;
        const diagnostics = { ...response.transportDiagnostics, httpStatus: response.status, requestUrl: page.href,
          redirectHops, httpRequests, elapsedMs: Date.now() - startedAt };
        const refused = httpFailure(response.status);
        if (refused) return failure(refused, diagnostics, response.retryAfterSeconds);
        if (response.transportDiagnostics?.accessCheck === 'failed') return failure('blocked', diagnostics, response.retryAfterSeconds);
        const final = avitoUrl(response.url);
        if (!final || final.origin !== search.origin) {
          return failure('schema_changed', { ...diagnostics, reason: 'unexpected_redirect' });
        }
        const redirect = extractAvitoRedirect(response.body);
        if (redirect) {
          const target = redirect.target ? avitoUrl(redirect.target, final.href) : null;
          if (!target || target.origin !== search.origin) return failure('schema_changed', { ...diagnostics, reason: 'invalid_ssr_redirect' });
          if (redirectHops >= 3) return failure('schema_changed', { ...diagnostics, reason: 'ssr_redirect_limit' });
          redirectHops++;
          page = target;
          await delay(this.redirectDelayMs, undefined, { signal: pageSignal });
          continue;
        }
        const result = parseAvitoHtml(response.body, final.href);
        result.diagnostics = { ...result.diagnostics, ...diagnostics, canonicalUrl: final.href };
        return result;
      }
    } catch (error) {
      if (signal.aborted) throw error;
      const name = error instanceof Error ? error.name : '';
      return failure(timeout.aborted || name === 'TimeoutError' ? 'timeout' : 'transport_error', {
        reason: name || 'request_failed', redirectHops, completedHttpRequests: httpRequests, elapsedMs: Date.now() - startedAt,
      });
    }
  }
}

export const avitoAdapter = new AvitoAdapter();
