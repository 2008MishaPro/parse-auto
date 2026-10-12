import type { CollectDetailsResult, CollectPageResult, Outcome, SourceAdapter } from './contracts.ts';
import type { SourceState } from './store.ts';
import { validListing } from './listing-validation.ts';

export function abortError(): Error {
  return new DOMException('Мониторинг остановлен', 'AbortError');
}

export function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (error === signal.reason || error instanceof Error && error.name === 'AbortError');
}

export async function waitUntil(time: number, signal: AbortSignal): Promise<void> {
  while (Date.now() < time) {
    if (signal.aborted) throw abortError();
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, Math.min(time - Date.now(), 2_147_483_647));
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
  if (signal.aborted) throw abortError();
}

interface RequestResult {
  outcome: Outcome;
  retryAfterSeconds: number | null;
  deliver: () => void;
}

interface Request {
  requestTimeoutSeconds: number;
  execute: (signal: AbortSignal) => Promise<RequestResult>;
  failure: (outcome: Outcome, diagnostics: Record<string, unknown>) => RequestResult;
  signal: AbortSignal;
  reject: (error: unknown) => void;
  detachAbort: () => void;
}

interface SourceQueue {
  source: string;
  pending: Request[];
  running: boolean;
  nextRequestAt: number;
  blockedUntil: number;
  failures: number;
  state: SourceState;
  persisted: boolean;
}

export interface SourcePersistence {
  getSource(source: string): SourceState | null;
  updateSource(source: string, state: SourceState): Promise<void>;
}

/** Одна FIFO на источник для страниц и необязательных карточек. */
export class SourceScheduler {
  private queues = new Map<string, SourceQueue>();
  private requestIntervalMs: number;
  private persistence: SourcePersistence | undefined;
  private fatal: { error: unknown } | null = null;
  private fatalController = new AbortController();

  constructor(requestIntervalMs = 2_000, persistence?: SourcePersistence) {
    if (!Number.isFinite(requestIntervalMs) || requestIntervalMs < 0) throw new Error('Неверный интервал запросов');
    this.requestIntervalMs = requestIntervalMs;
    this.persistence = persistence;
  }

  private queue(source: string): SourceQueue {
    let queue = this.queues.get(source);
    if (!queue) {
      const restored = this.persistence?.getSource(source) ?? null;
      const state: SourceState = restored ? structuredClone(restored) : {
        failureCount: 0, blockedUntil: null, lastAttempt: null, lastSuccess: null, lastOutcome: null,
      };
      queue = { source, pending: [], running: false, nextRequestAt: 0,
        blockedUntil: Date.parse(state.blockedUntil ?? '') || 0, failures: state.failureCount,
        state, persisted: restored !== null };
      this.queues.set(source, queue);
    }
    return queue;
  }

  restoreBackoff(source: string, failures: number, nextRunAt: string | null): void {
    const queue = this.queue(source);
    // An exact source checkpoint wins over older per-query counters, including
    // a successfully reset checkpoint. Legacy state is merged only once.
    if (queue.persisted || failures === 0) return;
    queue.failures = Math.max(queue.failures, failures);
    queue.blockedUntil = Math.max(queue.blockedUntil, Date.parse(nextRunAt ?? '') || 0);
    queue.state.failureCount = queue.failures;
    queue.state.blockedUntil = queue.blockedUntil > 0 ? new Date(queue.blockedUntil).toISOString() : null;
    queue.state.legacyEstimate = true;
  }

  availableAt(source: string): number {
    return this.queue(source).blockedUntil;
  }

  collect(adapter: SourceAdapter, query: { url: string; requestTimeoutSeconds: number }, cursor: string | null, signal: AbortSignal): Promise<CollectPageResult> {
    return this.enqueue<CollectPageResult>(adapter.id, query.requestTimeoutSeconds, signal,
      requestSignal => adapter.collectPage(query, cursor, requestSignal),
      (outcome, diagnostics) => ({ outcome, records: [], nextCursor: null, endReached: false, retryAfterSeconds: null, diagnostics }));
  }

  details(adapter: SourceAdapter, query: { externalId: string; url: string; requestTimeoutSeconds: number }, signal: AbortSignal): Promise<CollectDetailsResult> {
    if (!adapter.getDetails) return Promise.reject(new Error(`Источник ${adapter.id} не поддерживает карточки`));
    return this.enqueue<CollectDetailsResult>(adapter.id, query.requestTimeoutSeconds, signal,
      async requestSignal => {
        const result = await adapter.getDetails!(query.externalId, query.url, requestSignal, query.requestTimeoutSeconds);
        if (result.outcome === 'success' && (!validListing(result.record, adapter.id) || result.record.externalId !== query.externalId)) {
          return { outcome: 'schema_changed', record: null, retryAfterSeconds: result.retryAfterSeconds,
            diagnostics: { ...result.diagnostics, reason: 'invalid_details_record' } };
        }
        return result;
      },
      (outcome, diagnostics) => ({ outcome, record: null, retryAfterSeconds: null, diagnostics }));
  }

  private enqueue<T extends CollectPageResult | CollectDetailsResult>(source: string, requestTimeoutSeconds: number,
    signal: AbortSignal, execute: (signal: AbortSignal) => Promise<T>, failure: (outcome: Outcome, diagnostics: Record<string, unknown>) => T): Promise<T> {
    if (this.fatal) return Promise.reject(this.fatal.error);
    if (signal.aborted) return Promise.reject(abortError());
    const queue = this.queue(source);
    return new Promise((resolve, reject) => {
      const wrap = (result: T): RequestResult => ({ outcome: result.outcome, retryAfterSeconds: result.retryAfterSeconds,
        deliver: () => resolve(result) });
      const request: Request = { requestTimeoutSeconds, signal, reject, detachAbort: () => {},
        execute: async requestSignal => wrap(await execute(requestSignal)),
        failure: (outcome, diagnostics) => wrap(failure(outcome, diagnostics)) };
      const cancel = () => {
        // Remove only a waiter. An active operation retains the queue until its
        // adapter has stopped, so cancellation cannot start parallel requests.
        const index = queue.pending.indexOf(request);
        if (index < 0) return;
        queue.pending.splice(index, 1);
        request.detachAbort();
        reject(abortError());
      };
      request.detachAbort = () => signal.removeEventListener('abort', cancel);
      signal.addEventListener('abort', cancel, { once: true });
      queue.pending.push(request);
      if (signal.aborted) cancel();
      void this.drain(queue);
    });
  }

  private async drain(queue: SourceQueue): Promise<void> {
    if (queue.running) return;
    queue.running = true;
    try {
      while (queue.pending.length > 0) {
        const request = queue.pending.shift()!;
        request.detachAbort();
        try {
          // Migration must be durable before the first request; retaining the
          // FIFO while saving also prevents another request overtaking it.
          if (this.persistence && !queue.persisted && queue.state.legacyEstimate) {
            await this.persist(queue, queue.state);
            queue.persisted = true;
          }
          this.throwIfFatal();
          const requestSignal = AbortSignal.any([request.signal, this.fatalController.signal]);
          await waitUntil(Math.max(queue.nextRequestAt, queue.blockedUntil), requestSignal);
          this.throwIfFatal();
          const attemptedAt = Date.now();
          queue.nextRequestAt = attemptedAt + this.requestIntervalMs;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new DOMException('Таймаут запроса', 'TimeoutError')), request.requestTimeoutSeconds * 1_000);
          let result: RequestResult;
          try {
            result = await request.execute(AbortSignal.any([requestSignal, controller.signal]));
          } catch (error) {
            this.throwIfFatal();
            if (request.signal.aborted) throw abortError();
            result = request.failure(controller.signal.aborted ? 'timeout' : 'transport_error',
              { message: error instanceof Error ? error.message : String(error) });
          } finally {
            clearTimeout(timer);
          }
          this.throwIfFatal();
          if (request.signal.aborted) throw abortError();
          const completedAt = Date.now();
          const state: SourceState = { ...queue.state, lastAttempt: new Date(attemptedAt).toISOString(), lastOutcome: result.outcome };
          if (result.outcome === 'success' || result.outcome === 'empty') {
            state.failureCount = 0;
            state.blockedUntil = null;
            state.lastSuccess = new Date(completedAt).toISOString();
            delete state.legacyEstimate;
          } else {
            state.failureCount += 1;
            const exponential = Math.min(300_000, 10_000 * 2 ** Math.min(state.failureCount - 1, 10));
            const retryAfter = Math.max(0, result.retryAfterSeconds ?? 0) * 1_000;
            state.blockedUntil = new Date(Math.max(queue.blockedUntil, completedAt + Math.max(exponential, retryAfter))).toISOString();
          }
          await this.persist(queue, state);
          queue.persisted ||= this.persistence !== undefined;
          queue.state = state;
          queue.failures = state.failureCount;
          queue.blockedUntil = Date.parse(state.blockedUntil ?? '') || 0;
          this.throwIfFatal();
          // A received result owns its durable write. A stop or cycle deadline
          // during fsync must still allow the caller to save its useful page.
          result.deliver();
        } catch (error) {
          request.reject(this.fatal ? this.fatal.error : error);
        }
      }
    } finally {
      queue.running = false;
    }
  }

  private throwIfFatal(): void {
    if (this.fatal) throw this.fatal.error;
  }

  private async persist(queue: SourceQueue, state: SourceState): Promise<void> {
    if (!this.persistence) return;
    if (this.fatal) throw this.fatal.error;
    try {
      await this.persistence.updateSource(queue.source, structuredClone(state));
    } catch (error) {
      if (!this.fatal) {
        this.fatal = { error };
        this.fatalController.abort();
        for (const waitingQueue of this.queues.values()) {
          for (const request of waitingQueue.pending.splice(0)) {
            request.detachAbort();
            request.reject(error);
          }
        }
      }
      throw this.fatal.error;
    }
  }
}
