import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfiguration } from '../src/config.ts';
import { AdapterRegistry } from '../src/core/registry.ts';
import { MonitorService } from '../src/core/monitor.ts';
import { FileStore } from '../src/core/store.ts';
import { AvitoAdapter } from '../src/integrations/avito/adapter.ts';
import { AvitoHttpSession } from '../src/integrations/avito/http-session.ts';

// Explicit bounded diagnostic run. The product CLI itself always watches until stopped.
const { values } = parseArgs({ options: {
  config: { type: 'string', default: 'searches.example.json' },
  seconds: { type: 'string', default: '130' },
  report: { type: 'string', default: 'data-smoke/live-report.json' },
  'compact-after-batches': { type: 'string' },
} });
const seconds = Number(values.seconds);
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) throw new Error('--seconds: от 1 до 3600');
const config = await loadConfiguration(values.config);
const compactAfterBatches = values['compact-after-batches'] === undefined ? undefined : Number(values['compact-after-batches']);
if (compactAfterBatches !== undefined && (!Number.isSafeInteger(compactAfterBatches) || compactAfterBatches < 1)) throw new Error('--compact-after-batches: положительное целое число');
const requests: Array<Record<string, unknown>> = [];
const httpRequests: Array<Record<string, unknown>> = [];
const runs: Array<Record<string, unknown>> = [];
let events = 0;
const registry = new AdapterRegistry();
const session = new AvitoHttpSession({ fetch: async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  const started = performance.now();
  const request: Record<string, unknown> = { startedAt: new Date().toISOString(), method: init?.method ?? 'GET',
    origin: target.origin, path: target.pathname };
  httpRequests.push(request);
  try {
    const response = await fetch(input, init);
    request.status = response.status;
    return response;
  } catch (error) {
    request.error = error instanceof Error ? error.name : 'unknown';
    throw error;
  } finally { request.durationToHeadersMs = Math.round(performance.now() - started); }
} });
registry.register(new AvitoAdapter(async (url, timeout, signal) => {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  try {
    const response = await session.getHtml(url, timeout, signal);
    requests.push({ startedAt, durationMs: Math.round(performance.now() - start), status: response.status,
      bytes: Buffer.byteLength(response.body), ...response.transportDiagnostics });
    return response;
  } catch (error) {
    requests.push({ startedAt, durationMs: Math.round(performance.now() - start), error: error instanceof Error ? error.name : 'unknown' });
    throw error;
  }
}));
const store = await FileStore.open(config.dataDir, { compactAfterBatches });
const controller = new AbortController();
const stop = (): void => controller.abort();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const startedAt = new Date().toISOString();
const timer = setTimeout(stop, seconds * 1000);
let peakRss = process.memoryUsage().rss;
const memoryTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 1000);
try {
  const monitor = new MonitorService(registry, store, config.searches, {
    onEvent: () => { events++; },
    onDiagnostic: diagnostic => { runs.push(diagnostic); process.stderr.write(`${JSON.stringify(diagnostic)}\n`); },
  });
  await monitor.run(controller.signal);
} finally {
  clearTimeout(timer);
  clearInterval(memoryTimer);
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  await store.close();
  const state = await FileStore.inspect(config.dataDir);
  const enriched = state.records.filter(record => record.enrichment?.fields.length);
  const enrichment = {
    records: enriched.length,
    samples: enriched.slice(0, 5).map(record => ({ source: record.source, externalId: record.externalId,
      observedAt: record.observedAt, vehicle: record.vehicle, enrichment: record.enrichment,
      provenance: Object.fromEntries(Object.entries(record.provenance).filter(([field]) => field.startsWith('vehicle.'))) })),
  };
  const report = resolve(values.report);
  await mkdir(resolve(report, '..'), { recursive: true });
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  await writeFile(report, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), requestedSeconds: seconds,
    requests, httpRequests, runs, emittedEvents: events, records: state.records.length, events: state.events.length,
    sequence: state.sequence, searchBindings: state.searchBindings, sources: state.sources, gaps: state.gaps, queries: state.queries,
    enrichment, memory: process.memoryUsage(), peakSampledRss: peakRss }, null, 2));
  process.stdout.write(`${JSON.stringify({ report, requests: requests.length, httpRequests: httpRequests.length,
    records: state.records.length, events: state.events.length })}\n`);
}
