import { randomUUID } from 'node:crypto';
import type { CollectDetailsResult, CollectPageResult, Search } from './contracts.ts';
import { AdapterRegistry } from './registry.ts';
import { isCancellation, SourceScheduler } from './scheduler.ts';
import { FileStore, type MonitorEvent } from './store.ts';
import { validListing } from './listing-validation.ts';

export interface MonitorDiagnostic {
  searchId: string;
  source: string;
  type: string;
  at: string;
  [field: string]: unknown;
}

export interface CycleResult {
  startedAt: number;
  failed: boolean;
}

export interface CrawlerCallbacks {
  onEvent?: (event: MonitorEvent) => void | Promise<void>;
  onDiagnostic?: (diagnostic: MonitorDiagnostic) => void | Promise<void>;
}

function availablePages(diagnostics: unknown): number | null {
  if (!diagnostics || typeof diagnostics !== 'object') return null;
  const { availableCount, pageCapacity, itemsOnPage } = diagnostics as Record<string, unknown>;
  const perPage = pageCapacity ?? itemsOnPage;
  return typeof availableCount === 'number' && Number.isSafeInteger(availableCount) && availableCount >= 0
    && typeof perPage === 'number' && Number.isSafeInteger(perPage) && perPage > 0
    ? Math.ceil(availableCount / perPage) : null;
}

export class Crawler {
  private registry: AdapterRegistry;
  private store: FileStore;
  private scheduler: SourceScheduler;
  private callbacks: CrawlerCallbacks;

  constructor(registry: AdapterRegistry, store: FileStore, scheduler: SourceScheduler, callbacks: CrawlerCallbacks = {}) {
    this.registry = registry;
    this.store = store;
    this.scheduler = scheduler;
    this.callbacks = callbacks;
  }

  async crawl(search: Search, signal: AbortSignal, forceSweep = false, aliases: string[] = []): Promise<CycleResult> {
    const startedAt = Date.now();
    const initial = this.store.getQuery(search.id);
    const processRestart = forceSweep && initial.lastAttempt !== null;
    const gapSince = initial.lastSuccess ?? initial.lastAttempt;
    const previousDue = Date.parse(initial.nextRunAt ?? '');
    const overdueMs = Number.isFinite(previousDue) ? Math.max(0, startedAt - previousDue) : 0;
    const resumed = initial.resumeCursor !== null;
    const sweepDue = !initial.lastExhaustedScan || startedAt - Date.parse(initial.lastExhaustedScan) >= search.sweepIntervalSeconds * 1_000;
    const previousWindow = Array.isArray(initial.coverage.windowIds)
      ? initial.coverage.windowIds.filter((id): id is string => typeof id === 'string') : [];
    const windowIds = new Set(previousWindow);
    let full = !initial.baselineComplete || forceSweep || sweepDue || resumed
      || initial.coverage.requiresFullScan === true || windowIds.size === 0;
    let mode = !initial.baselineComplete ? 'baseline' : resumed ? 'recovery' : full ? 'sweep' : 'poll';
    let budget = full ? search.maxPagesPerSweep : search.overlapPages;
    const deadline = startedAt + search.maxCycleSeconds * 1000;
    const adapter = this.registry.get(search.source);
    const budgetController = new AbortController();
    const cycleSignal = AbortSignal.any([signal, budgetController.signal]);
    const budgetTimer = setTimeout(() => budgetController.abort(new DOMException('Бюджет времени обхода исчерпан', 'TimeoutError')),
      Math.max(1, Math.ceil(deadline - Date.now())));
    const runId = randomUUID();
    let cursor = resumed ? initial.resumeCursor : null;
    let pages = 0;
    let records = 0;
    let invalidRecords = 0;
    let sourceLimited = resumed && initial.coverage.coverageLimited === true;
    let exhausted = false;
    let failed = false;
    let timedOut = false;
    let windowOverflow = false;
    let windowOverlap = false;
    let paginationShiftObserved = false;
    let overlapRecords = 0;
    let stopReason = 'page_budget';
    let lastDiagnostics: Record<string, unknown> = {};
    let availablePagesEstimate = availablePages(initial.coverage.sourceDiagnostics);
    const cursors = new Set<string>();
    const fingerprints = new Set<string>();
    const seenIds = new Set<string>();
    const candidateWindow = new Set<string>();
    const report = async (type: string, fields: Record<string, unknown>) => {
      await this.callbacks.onDiagnostic?.({ searchId: search.id, source: search.source, type, at: new Date().toISOString(), ...fields });
    };
    const nextRunAt = () => new Date(Math.max(startedAt + search.intervalSeconds * 1_000,
      timedOut ? Date.now() + Math.min(search.intervalSeconds * 1_000, 10_000) : 0,
      this.scheduler.availableAt(search.source))).toISOString();
    // После перевода часов назад прежний success может оказаться в будущем.
    // Не выдумываем отрицательный период: нижняя граница тогда неизвестна.
    const gapSinceAt = (until: string) => gapSince !== null && Date.parse(gapSince) > Date.parse(until) ? null : gapSince;
    const gap = (reason: string, until: string) => ({ runId, since: gapSinceAt(until), until, reason });
    const emittedGapReasons = new Set<string>();

    try {
      const attemptAt = new Date(startedAt).toISOString();
      // Простой уже известен до HTTP. Crash или отказ первого запроса не должны
      // удалить это основание из истории; финальная запись продлит тот же gap.
      if (processRestart) emittedGapReasons.add('process_restart');
      if (sourceLimited) emittedGapReasons.add('source_limit');
      await this.store.updateQuery(search.id, { lastAttempt: attemptAt },
        [...emittedGapReasons].map(reason => gap(reason, attemptAt)));
      await report('cycle_started', { mode, resumed, aliases, overdueMs, maxCycleSeconds: search.maxCycleSeconds,
        gapPossible: processRestart });
      for (; pages < budget && !signal.aborted;) {
        if (Date.now() >= deadline || budgetController.signal.aborted) {
          timedOut = true;
          stopReason = 'time_budget';
          break;
        }
        const cursorKey = JSON.stringify(cursor);
        if (cursors.has(cursorKey)) {
          failed = true;
          stopReason = 'repeated_cursor';
          break;
        }
        cursors.add(cursorKey);
        let result: CollectPageResult;
        try {
          result = await this.scheduler.collect(adapter, { url: search.url, requestTimeoutSeconds: search.requestTimeoutSeconds }, cursor, cycleSignal);
        } catch (error) {
          if (!signal.aborted && budgetController.signal.aborted && isCancellation(error, cycleSignal)) {
            timedOut = true;
            stopReason = 'time_budget';
            break;
          }
          throw error;
        }
        pages += 1;
        lastDiagnostics = result.diagnostics;
        const pageEstimate = availablePages(result.diagnostics);
        if (pageEstimate !== null) availablePagesEstimate = Math.max(availablePagesEstimate ?? 0, pageEstimate);
        sourceLimited ||= result.diagnostics.coverageLimited === true;
        const valid = result.records.filter((record) => validListing(record, search.source));
        const invalid = result.records.length - valid.length;
        invalidRecords += invalid;
        records += valid.length;
        const pageIds = new Set(valid.map(record => JSON.stringify([record.source, record.externalId])));
        const fingerprint = JSON.stringify([...pageIds].sort());
        const repeatedPage = valid.length > 0 && fingerprints.has(fingerprint);
        if (valid.length > 0) fingerprints.add(fingerprint);
        const success = result.outcome === 'success' || result.outcome === 'empty';
        const repeatedCursor = !result.endReached && result.nextCursor !== null && cursors.has(JSON.stringify(result.nextCursor));
        const badPagination = result.endReached ? result.nextCursor !== null : result.nextCursor === null || repeatedCursor;
        const pageVerified = success && invalid === 0 && !repeatedPage && !badPagination;
        if (pageVerified) {
          const duplicateIds = [...pageIds].filter(id => seenIds.has(id)).length;
          overlapRecords += duplicateIds;
          paginationShiftObserved ||= duplicateIds > 0;
          for (const id of pageIds) {
            seenIds.add(id);
            windowOverlap ||= windowIds.has(id);
            if (!resumed && pages <= search.overlapPages) candidateWindow.add(id);
          }
        }
        const pageStopReason = !success ? result.outcome : invalid > 0 ? 'invalid_records' : repeatedPage ? 'repeated_page' : repeatedCursor ? 'repeated_cursor' : 'invalid_pagination';
        const observedGapReasons = new Set<string>();
        if (sourceLimited) observedGapReasons.add('source_limit');
        if (paginationShiftObserved) observedGapReasons.add('pagination_shift');
        const newlyObservedGaps = [...observedGapReasons].filter(reason => !emittedGapReasons.has(reason));
        let events: MonitorEvent[] = [];
        if (!pageVerified) {
          // Сначала отказ/backoff: crash после полезного page commit не должен
          // потерять уже известный Retry-After. Непроверенный cursor не меняется.
          const errorAt = new Date().toISOString();
          await this.store.updateQuery(search.id, {
            nextRunAt: nextRunAt(), failureCount: initial.failureCount + 1, resumeCursor: cursor,
            coverage: { ...initial.coverage, mode, status: 'error', outcome: pageStopReason, stopReason: pageStopReason,
              pages, records, invalidRecords, sourceDiagnostics: result.diagnostics, requiresFullScan: true,
              gapPossible: true, gapReason: pageStopReason,
              lastGap: { since: gapSinceAt(errorAt), until: errorAt, reason: pageStopReason } },
          }, [gap(pageStopReason, errorAt), ...newlyObservedGaps.map(reason => gap(reason, errorAt))]);
        } else if (newlyObservedGaps.length > 0) {
          // Конкретное ограничение уже обнаружено: сохраняем до page/events и
          // внешних callbacks, чтобы crash не оставил только будущий restart gap.
          const observedAt = new Date().toISOString();
          await this.store.updateQuery(search.id, {}, newlyObservedGaps.map(reason => gap(reason, observedAt)));
        }
        for (const reason of newlyObservedGaps) emittedGapReasons.add(reason);
        // Даже при отказе сохраняем пригодные записи, но остаёмся на непроверенной странице.
        if (valid.length > 0 || success) {
          events = await this.store.commitPage(search.id, runId, cursor, valid, pageVerified ? result.nextCursor : cursor);
        }
        for (const event of events) await this.callbacks.onEvent?.(event);
        await report('page', { cursor, outcome: result.outcome, records: valid.length, invalidRecords: invalid, diagnostics: result.diagnostics });
        if (!pageVerified) {
          failed = true;
          stopReason = pageStopReason;
          break;
        }
        cursor = result.nextCursor;
        if (result.endReached) {
          exhausted = true;
          stopReason = 'available_end';
          break;
        }
        if (!full && pages >= search.overlapPages && !windowOverlap) {
          // A burst displaced the previous top window. Do not claim a healthy
          // poll; use the remaining sweep budget, never stop on a single ID.
          windowOverflow = true;
          full = true;
          mode = 'catch_up';
          budget = search.maxPagesPerSweep;
        }
      }
    } catch (error) {
      if (isCancellation(error, signal)) {
        failed = true;
        stopReason = 'interrupted';
      } else throw error;
    } finally {
      clearTimeout(budgetTimer);
    }
    if (signal.aborted) {
      failed = true;
      stopReason = 'interrupted';
    }

    const finishedAt = new Date().toISOString();
    const verifiedFull = full && !resumed && exhausted && !failed && !timedOut && !paginationShiftObserved;
    const pollSuccess = !full && !failed && !timedOut && !paginationShiftObserved;
    const requiresFullScan = resumed || failed || timedOut || paginationShiftObserved || (full && !verifiedFull);
    const budgetExhausted = full && !exhausted && !failed && !timedOut && pages >= budget;
    if (budgetExhausted && windowOverflow) stopReason = 'window_overflow';
    if (exhausted && paginationShiftObserved && !failed) stopReason = 'pagination_shift';
    const baselineNeedsBudgetIncrease = !initial.baselineComplete && !verifiedFull
      && (initial.coverage.baselineNeedsBudgetIncrease === true || budgetExhausted
        || availablePagesEstimate !== null && availablePagesEstimate > search.maxPagesPerSweep);
    const baselineNeedsTimeBudgetIncrease = !initial.baselineComplete && !verifiedFull
      && (timedOut || resumed && initial.coverage.baselineNeedsTimeBudgetIncrease === true);
    const gapPossible = resumed || failed || timedOut || paginationShiftObserved || sourceLimited || (full && !verifiedFull)
      || processRestart;
    const gapReason = timedOut ? 'time_budget' : failed ? stopReason : paginationShiftObserved ? 'pagination_shift'
      : resumed ? 'resume_is_not_a_full_snapshot' : sourceLimited ? 'source_limit'
      : full && !verifiedFull ? stopReason : processRestart ? 'process_restart' : null;
    // coverage сохраняет прежнее основное основание, а история фиксирует каждое
    // выявленное ограничение. Например, deadline не скрывает уже найденный cap
    // источника или сдвиг страниц. Повтор reason в цикле обновляет один gapId.
    const gapReasons = new Set<string>();
    if (gapReason !== null) gapReasons.add(gapReason);
    if (processRestart) gapReasons.add('process_restart');
    if (timedOut) gapReasons.add('time_budget');
    if (paginationShiftObserved) gapReasons.add('pagination_shift');
    if (resumed) gapReasons.add('resume_is_not_a_full_snapshot');
    if (sourceLimited) gapReasons.add('source_limit');
    if (windowOverflow && !verifiedFull) gapReasons.add('window_overflow');
    if (full && !verifiedFull && stopReason !== 'available_end') gapReasons.add(stopReason);
    const requiredAction = baselineNeedsTimeBudgetIncrease ? 'increase_maxCycleSeconds_or_narrow_query'
      : baselineNeedsBudgetIncrease ? 'increase_maxPagesPerSweep_or_narrow_query'
      : windowOverflow && !verifiedFull ? 'increase_budgets_or_narrow_query' : null;
    const coverage = {
      mode, pages, records, invalidRecords, stopReason, aliases, overdueMs,
      maxCycleSeconds: search.maxCycleSeconds, elapsedMs: Date.now() - startedAt, timeBudgetExhausted: timedOut,
      windowOverflow, windowOverlap, paginationShiftObserved, overlapRecords,
      windowIds: verifiedFull || pollSuccess ? [...candidateWindow] : previousWindow,
      startedAt: new Date(startedAt).toISOString(), finishedAt,
      availableExhausted: exhausted, coverageLimited: sourceLimited,
      status: failed ? 'error' : sourceLimited || timedOut || paginationShiftObserved || (full && !verifiedFull) ? 'partial' : verifiedFull ? 'available_exhausted' : 'window',
      outcome: failed ? stopReason : timedOut || paginationShiftObserved || (full && !verifiedFull) ? 'partial' : 'success',
      resumed, requiresFullScan, baselineNeedsBudgetIncrease, baselineNeedsTimeBudgetIncrease, availablePagesEstimate,
      requiredAction,
      gapPossible, gapReason,
      lastGap: gapPossible ? { since: gapSinceAt(finishedAt), until: finishedAt, reason: gapReason } : initial.coverage.lastGap ?? null,
      sourceDiagnostics: lastDiagnostics,
    };
    await this.store.updateQuery(search.id, {
      coverage,
      nextRunAt: nextRunAt(),
      baselineComplete: initial.baselineComplete || verifiedFull,
      lastExhaustedScan: verifiedFull ? finishedAt : initial.lastExhaustedScan,
      lastSuccess: verifiedFull || pollSuccess ? finishedAt : initial.lastSuccess,
      failureCount: timedOut ? initial.failureCount
        : failed && stopReason !== 'interrupted' ? initial.failureCount + 1 : failed ? initial.failureCount : 0,
      resumeCursor: exhausted || pollSuccess ? null : cursor,
    }, [...gapReasons].map(reason => gap(reason, finishedAt)));
    const enrichment = await this.enrich(search, signal, deadline,
      (verifiedFull || pollSuccess) && !sourceLimited, report);
    if (enrichment !== null) {
      await this.store.updateQuery(search.id, { coverage: { ...coverage, enrichment }, nextRunAt: nextRunAt() });
      await report('details_finished', enrichment);
    }
    await report('cycle_finished', { ...coverage, ...(enrichment ? { enrichment } : {}), baselineComplete: initial.baselineComplete || verifiedFull });
    return { startedAt, failed };
  }

  private async enrich(search: Search, signal: AbortSignal, deadline: number, catalogueHealthy: boolean,
    report: (type: string, fields: Record<string, unknown>) => Promise<void>): Promise<Record<string, unknown> | null> {
    const limit = search.maxDetailsPerCycle ?? 0;
    if (limit === 0) return null;
    const startedAt = Date.now();
    const adapter = this.registry.get(search.source);
    const summary = { limit, selection: 'saved_search', candidates: 0, attempted: 0, succeeded: 0, failed: 0,
      stopReason: 'completed', elapsedMs: 0 };
    const finish = (stopReason: string) => {
      summary.stopReason = stopReason;
      summary.elapsedMs = Date.now() - startedAt;
      return summary;
    };
    if (!catalogueHealthy) return finish('catalogue_not_healthy');
    if (!adapter.capabilities().details || !adapter.getDetails) return finish('unsupported');
    if (signal.aborted) return finish('interrupted');
    if (Date.now() >= deadline) return finish('time_budget');
    if (this.scheduler.availableAt(search.source) > Date.now()) return finish('source_backoff');
    const candidates = this.store.detailsCandidates(search.id, limit, startedAt);
    summary.candidates = candidates.length;
    if (candidates.length === 0) return finish('no_candidates');
    const controller = new AbortController();
    const detailsSignal = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(new DOMException('Бюджет времени обогащения исчерпан', 'TimeoutError')),
      Math.max(1, Math.ceil(deadline - Date.now())));
    let stopReason = 'completed';
    try {
      for (const listing of candidates) {
        if (signal.aborted) { stopReason = 'interrupted'; break; }
        if (controller.signal.aborted || Date.now() >= deadline) { stopReason = 'time_budget'; break; }
        if (this.scheduler.availableAt(search.source) > Date.now()) { stopReason = 'source_backoff'; break; }
        // Claim survives a crash during FIFO/HTTP. An unknown result cannot be retried immediately after restart.
        const attemptedAt = new Date().toISOString();
        const retryAt = new Date(deadline + search.requestTimeoutSeconds * 1_000).toISOString();
        const attemptId = await this.store.beginDetailsAttempt(search.id, listing, attemptedAt, retryAt);
        if (attemptId === null) continue;
        if (signal.aborted) { stopReason = 'interrupted'; break; }
        if (controller.signal.aborted || Date.now() >= deadline) { stopReason = 'time_budget'; break; }
        summary.attempted += 1;
        await report('details_started', { externalId: listing.externalId, attemptId });
        let result: CollectDetailsResult;
        try {
          result = await this.scheduler.details(adapter, { externalId: listing.externalId, url: listing.url,
            requestTimeoutSeconds: search.requestTimeoutSeconds }, detailsSignal);
        } catch (error) {
          if (isCancellation(error, detailsSignal)) {
            stopReason = signal.aborted ? 'interrupted' : 'time_budget';
            break;
          }
          throw error;
        }
        // Scheduler retains a received result through health fsync even if stop/deadline fires while writing.
        const success = result.outcome === 'success';
        const nextRetryAt = success ? null : new Date(Math.max(this.scheduler.availableAt(search.source),
          Date.now() + 300_000)).toISOString();
        await this.store.finishDetailsAttempt(search.source, listing.externalId, attemptId, result, nextRetryAt);
        if (success) summary.succeeded += 1;
        else summary.failed += 1;
        await report('details_result', { externalId: listing.externalId, attemptId, outcome: result.outcome,
          titleMatches: result.record ? result.record.title === listing.title : null,
          retryAt: nextRetryAt, diagnostics: result.diagnostics });
        if (!success) { stopReason = 'source_failure'; break; }
      }
    } finally { clearTimeout(timer); }
    if (signal.aborted) stopReason = 'interrupted';
    else if (controller.signal.aborted || Date.now() >= deadline) stopReason = 'time_budget';
    return finish(stopReason);
  }
}
