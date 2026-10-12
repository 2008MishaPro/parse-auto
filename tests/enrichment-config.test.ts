import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { Search, SourceAdapter } from '../src/core/contracts.ts';
import { Crawler } from '../src/core/crawler.ts';
import { MonitorService } from '../src/core/monitor.ts';
import { AdapterRegistry } from '../src/core/registry.ts';
import { FileStore } from '../src/core/store.ts';

function search(id: string, overrides: Partial<Search> = {}): Search {
  return {
    id, source: 'sim', url: 'https://example.test/cars', enabled: true,
    intervalSeconds: 120, overlapPages: 2, sweepIntervalSeconds: 1800,
    maxPagesPerSweep: 10, requestTimeoutSeconds: 30, maxCycleSeconds: 90,
    ...overrides,
  };
}

function registry(): AdapterRegistry {
  const adapter: SourceAdapter = {
    id: 'sim',
    capabilities() { return { pagination: 'cursor', sort: ['newest'], publishedAt: false, details: false }; },
    async collectPage() { throw new Error('Тест объединения не должен обращаться к адаптеру'); },
  };
  return new AdapterRegistry().register(adapter);
}

test('monitor отвергает нечисловые и выходящие за границы бюджеты, включая отключённый поиск', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'carradar-enrichment-config-'));
  const store = await FileStore.open(directory);
  try {
    for (const value of [null, '2', true, false, -1, 1.5, 11, Number.NaN, Infinity]) {
      for (const enabled of [true, false]) {
        assert.throws(() => new MonitorService(registry(), store, [search('a', {
          enabled, maxDetailsPerCycle: value as number,
        })]), /maxDetailsPerCycle ожидает целое число от 0 до 10/);
      }
    }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('monitor передаёт один бюджет точного URL: максимум aliases без суммирования и дефолт 0', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'carradar-enrichment-config-'));
  const store = await FileStore.open(directory);
  const calls: Array<{ search: Search; aliases: string[] }> = [];
  t.mock.method(Crawler.prototype, 'crawl', async (query: Search, _signal: AbortSignal, _first: boolean, aliases: string[]) => {
    calls.push({ search: structuredClone(query), aliases: [...aliases] });
  });
  try {
    const monitor = new MonitorService(registry(), store, [
      search('z', { maxDetailsPerCycle: 2 }),
      search('a', { maxDetailsPerCycle: 3 }),
      search('duplicate-max', { maxDetailsPerCycle: 3 }),
      search('old-config'),
      search('disabled', { enabled: false, maxDetailsPerCycle: 10 }),
      search('other-url', { url: 'https://example.test/other-cars' }),
      search('zero-budget', { url: 'https://example.test/zero-cars', maxDetailsPerCycle: 0 }),
      search('maximum-budget', { url: 'https://example.test/max-cars', maxDetailsPerCycle: 10 }),
    ], { requestIntervalMs: 0 });
    await monitor.run(new AbortController().signal, { once: true });
    assert.equal(calls.length, 4);
    const merged = calls.find(call => call.search.url === 'https://example.test/cars')!;
    assert.equal(merged.search.maxDetailsPerCycle, 3);
    assert.deepEqual(merged.aliases, ['a', 'duplicate-max', 'old-config', 'z']);
    assert.equal(calls.find(call => call.search.id === 'other-url')!.search.maxDetailsPerCycle, 0);
    assert.equal(calls.find(call => call.search.id === 'zero-budget')!.search.maxDetailsPerCycle, 0);
    assert.equal(calls.find(call => call.search.id === 'maximum-budget')!.search.maxDetailsPerCycle, 10);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
