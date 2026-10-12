import type { Search } from './contracts.ts';
import { Crawler, type CrawlerCallbacks } from './crawler.ts';
import { AdapterRegistry } from './registry.ts';
import { isCancellation, SourceScheduler, waitUntil } from './scheduler.ts';
import { FileStore } from './store.ts';

export interface MonitorOptions extends CrawlerCallbacks {
  requestIntervalMs?: number;
}

interface CombinedSearch {
  search: Search;
  aliases: string[];
}

function combineSearches(searches: Search[]): CombinedSearch[] {
  const ids = new Set<string>();
  const groups = new Map<string, CombinedSearch>();
  for (const search of [...searches].sort((a, b) => a.id.localeCompare(b.id))) {
    if (ids.has(search.id)) throw new Error(`Повтор id поиска: ${search.id}`);
    ids.add(search.id);
    if (search.maxDetailsPerCycle !== undefined && (typeof search.maxDetailsPerCycle !== 'number'
      || !Number.isSafeInteger(search.maxDetailsPerCycle) || search.maxDetailsPerCycle < 0 || search.maxDetailsPerCycle > 10)) {
      throw new Error(`Поиск ${search.id}: maxDetailsPerCycle ожидает целое число от 0 до 10`);
    }
    if (!search.enabled) continue;
    if (!search.id || !search.source || !Number.isFinite(search.intervalSeconds) || search.intervalSeconds <= 0
      || !Number.isFinite(search.sweepIntervalSeconds) || search.sweepIntervalSeconds <= 0
      || !Number.isInteger(search.overlapPages) || search.overlapPages < 1
      || !Number.isInteger(search.maxPagesPerSweep) || search.maxPagesPerSweep < 1
      || !Number.isFinite(search.requestTimeoutSeconds) || search.requestTimeoutSeconds <= 0
      || !Number.isFinite(search.maxCycleSeconds) || search.maxCycleSeconds <= 0) throw new Error(`Неверные параметры поиска: ${search.id}`);
    const key = JSON.stringify([search.source, search.url]);
    const group = groups.get(key);
    if (!group) groups.set(key, { search: { ...search, maxDetailsPerCycle: search.maxDetailsPerCycle ?? 0 }, aliases: [search.id] });
    else {
      group.aliases.push(search.id);
      group.search.intervalSeconds = Math.min(group.search.intervalSeconds, search.intervalSeconds);
      group.search.sweepIntervalSeconds = Math.min(group.search.sweepIntervalSeconds, search.sweepIntervalSeconds);
      group.search.overlapPages = Math.max(group.search.overlapPages, search.overlapPages);
      group.search.maxPagesPerSweep = Math.max(group.search.maxPagesPerSweep, search.maxPagesPerSweep);
      group.search.requestTimeoutSeconds = Math.max(group.search.requestTimeoutSeconds, search.requestTimeoutSeconds);
      group.search.maxCycleSeconds = Math.max(group.search.maxCycleSeconds, search.maxCycleSeconds);
      group.search.maxDetailsPerCycle = Math.max(group.search.maxDetailsPerCycle ?? 0, search.maxDetailsPerCycle ?? 0);
    }
  }
  return [...groups.values()];
}

export class MonitorService {
  private store: FileStore;
  private searches: CombinedSearch[];
  private scheduler: SourceScheduler;
  private crawler: Crawler;
  private running = false;
  private registrations: Search[];

  constructor(registry: AdapterRegistry, store: FileStore, searches: Search[], options: MonitorOptions = {}) {
    this.store = store;
    this.registrations = structuredClone(searches);
    this.searches = combineSearches(searches);
    for (const { search } of this.searches) registry.get(search.source);
    this.scheduler = new SourceScheduler(options.requestIntervalMs, {
      getSource: store.getSource.bind(store),
      updateSource: store.updateSource.bind(store),
    });
    this.crawler = new Crawler(registry, store, this.scheduler, options);
  }

  async run(signal: AbortSignal, { once = false }: { once?: boolean } = {}): Promise<void> {
    if (this.running) throw new Error('MonitorService уже запущен');
    this.running = true;
    const controller = new AbortController();
    const runSignal = AbortSignal.any([signal, controller.signal]);
    let tasks: Promise<void>[] = [];
    try {
      // Bind all aliases atomically before HTTP, then reuse the original root
      // even if it has been removed or disabled in the current configuration.
      const bindings = await this.store.bindSearches(this.registrations);
      // The source checkpoint survives removal of a failing query. Migrate all
      // retained legacy queries before allowing any source to perform HTTP.
      await this.store.ensureSources(this.registrations);
      const searches = this.searches.map(group => ({ ...group, search: { ...group.search, id: bindings[group.search.id]! } }));
      tasks = searches.map(async ({ search, aliases }) => {
        let first = true;
        while (!runSignal.aborted) {
          const state = this.store.getQuery(search.id);
          // После рестарта делаем догон; сохранённый backoff отменой процесса не сбрасывается.
          const due = first ? this.scheduler.availableAt(search.source) : Date.parse(state.nextRunAt ?? '') || 0;
          if (!once) await waitUntil(due, runSignal);
          if (runSignal.aborted) break;
          await this.crawler.crawl(search, runSignal, first, aliases);
          first = false;
          if (once) return;
        }
      });
      await Promise.all(tasks);
    } catch (error) {
      controller.abort();
      const completed = await Promise.allSettled(tasks);
      // A user stop may reject a waiting query before another query's durable
      // write fails. Wait for all owners and preserve that fatal disk error.
      const failure = completed.find((result): result is PromiseRejectedResult =>
        result.status === 'rejected' && !isCancellation(result.reason, runSignal));
      if (failure) throw failure.reason;
      if (!isCancellation(error, signal)) throw error;
    } finally {
      this.running = false;
    }
  }
}
