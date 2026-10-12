import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadConfiguration } from '../src/config.ts';
import { FileStore } from '../src/core/store.ts';
import { AvitoAdapter } from '../src/integrations/avito/adapter.ts';
import { activeSourceBackoff, verifyAvitoCard } from './card-verification.ts';

// Bounded card verification; it never writes listings/events or changes a checkpoint.
const { values } = parseArgs({ options: {
  config: { type: 'string', default: 'searches.example.json' },
  limit: { type: 'string', default: '3' },
  report: { type: 'string', default: 'data/reports/card-check.json' },
} });
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error('--limit: от 1 до 5');
const config = await loadConfiguration(values.config);
const query = config.searches.find(search => search.enabled && search.source === 'avito');
if (!query) throw new Error('Нужен активный поиск Авито в конфигурации');
const adapter = new AvitoAdapter();
const controller = new AbortController();
const stop = (): void => controller.abort();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const startedAt = new Date().toISOString();
const checks: Array<ReturnType<typeof verifyAvitoCard>> = [];
let catalogue: Record<string, unknown> | null = null;
let success = false;
let fetchSucceeded = false;
let failure: string | null = null;
let sourceBackoff: ReturnType<typeof activeSourceBackoff> = null;
const checkSourceBackoff = async (): Promise<void> => {
  const saved = await FileStore.inspect(config.dataDir);
  sourceBackoff = activeSourceBackoff(saved.sources[query.source]?.blockedUntil);
  if (sourceBackoff) throw new Error('source_backoff');
};
try {
  await checkSourceBackoff();
  const page = await adapter.collectPage(query, null, controller.signal);
  catalogue = { outcome: page.outcome, records: page.records.length, diagnostics: page.diagnostics };
  if (page.outcome !== 'success' || !page.records.length) throw new Error(`catalogue_${page.outcome}`);
  for (const listing of page.records.slice(0, limit)) {
    await checkSourceBackoff();
    const card = await adapter.getDetails(listing.externalId, listing.url, controller.signal, query.requestTimeoutSeconds);
    const check = verifyAvitoCard(listing, card);
    checks.push(check);
    // No immediate retry after an access failure. The normal monitor owns backoff.
    if (!check.fetchSucceeded) break;
  }
  fetchSucceeded = checks.length === Math.min(limit, page.records.length) && checks.every(check => check.fetchSucceeded);
  success = fetchSucceeded && checks.every(check => check.comparisonStatus === 'match');
} catch (error) { failure = error instanceof Error ? error.message : 'unknown'; }
finally {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  const report = resolve(values.report);
  await mkdir(dirname(report), { recursive: true });
  await writeFile(report, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(),
    success, fetchSucceeded, failure, sourceBackoff, catalogue, checks }, null, 2));
  process.stdout.write(`${JSON.stringify({ report, success, fetchSucceeded, checked: checks.length, failure, sourceBackoff })}\n`);
  process.exitCode = success ? 0 : 2;
}
