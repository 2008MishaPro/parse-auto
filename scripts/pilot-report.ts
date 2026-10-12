import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { loadConfiguration } from '../src/config.ts';
import { FileStore } from '../src/core/store.ts';
import { readSupervisorStatus, supervisorProcessAlive } from '../src/supervision/supervisor.ts';

const { values } = parseArgs({ options: {
  config: { type: 'string', default: 'searches.json' },
  'run-dir': { type: 'string', default: 'data/run' },
  report: { type: 'string', default: 'data/reports/pilot.json' },
} });
const config = await loadConfiguration(values.config);
const runDir = resolve(values['run-dir']);
const status = await readSupervisorStatus(runDir);
if (!status) throw new Error('Нет status.json supervisor: сначала запустите пилот');
const state = await FileStore.inspect(config.dataDir);
const inspectedAt = new Date().toISOString();
const started = Date.parse(status.startedAt);
const finished = status.status === 'stopped' || status.status === 'halted' ? Date.parse(status.updatedAt) : Date.parse(inspectedAt);
const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const malformedLogLines = dictionary<number>();
async function* rows(name: string): AsyncGenerator<Record<string, unknown>> {
  const stream = createReadStream(join(runDir, name), { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row: unknown;
      try { row = JSON.parse(line); } catch { malformedLogLines[name] = (malformedLogLines[name] ?? 0) + 1; continue; }
      if (row && typeof row === 'object' && !Array.isArray(row)) yield row as Record<string, unknown>;
      else malformedLogLines[name] = (malformedLogLines[name] ?? 0) + 1;
    }
  } finally { lines.close(); stream.destroy(); }
}
interface SearchReport {
  aliases: string[];
  starts: number; finishes: number; firstStart: string | null; lastFinish: string | null;
  intervalsSeconds: { count: number; min: number | null; max: number | null; mean: number | null };
  maxOverdueMs: number; maxElapsedMs: number; pages: number; observedRecords: number; invalidRecords: number;
  modes: Record<string, number>; outcomes: Record<string, number>; stopReasons: Record<string, number>;
  paginationShifts: number; timeBudgets: number; windowOverflows: number;
}
function searchReport(): SearchReport { return {
  aliases: [],
  starts: 0, finishes: 0, firstStart: null, lastFinish: null, intervalsSeconds: { count: 0, min: null, max: null, mean: null },
  maxOverdueMs: 0, maxElapsedMs: 0, pages: 0, observedRecords: 0, invalidRecords: 0,
  modes: dictionary<number>(), outcomes: dictionary<number>(), stopReasons: dictionary<number>(),
  paginationShifts: 0, timeBudgets: 0, windowOverflows: 0,
}; }
const searches = dictionary<SearchReport>();
for (const search of config.searches) {
  const binding = Object.hasOwn(state.searchBindings, search.id) ? state.searchBindings[search.id] : undefined;
  const id = binding?.storageId ?? search.id;
  (searches[id] ??= searchReport()).aliases.push(search.id);
}
const startTimes = new Map<string, number[]>();
const count = (counts: Record<string, number>, key: unknown): void => { const name = String(key ?? 'unknown'); counts[name] = (counts[name] ?? 0) + 1; };
const numeric = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
let reportedNativeHttpRequests = 0;
let pagesWithoutHttpCount = 0;
let otherDiagnostics = 0;
for await (const row of rows('diagnostics.jsonl')) {
  const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
  if (!Number.isFinite(at)) { otherDiagnostics++; continue; }
  if (at < started || at > finished) continue;
  const id = String(row.searchId);
  const search = searches[id] ??= searchReport();
  if (row.type === 'cycle_started') {
    search.starts++;
    search.firstStart ??= String(row.at);
    const starts = startTimes.get(id) ?? [];
    starts.push(at);
    startTimes.set(id, starts);
    search.maxOverdueMs = Math.max(search.maxOverdueMs, numeric(row.overdueMs));
  } else if (row.type === 'cycle_finished') {
    search.finishes++;
    search.lastFinish = String(row.at);
    // A completed cycle supplies its actual start before persistence/diagnostic output.
    // For a crashed unfinished cycle only the observed start diagnostic is available.
    const actualStart = typeof row.startedAt === 'string' ? Date.parse(row.startedAt) : NaN;
    const starts = startTimes.get(id);
    if (Number.isFinite(actualStart) && starts?.length) {
      starts[starts.length - 1] = actualStart;
      if (starts.length === 1) search.firstStart = String(row.startedAt);
    }
    search.maxElapsedMs = Math.max(search.maxElapsedMs, numeric(row.elapsedMs));
    search.pages += numeric(row.pages);
    search.observedRecords += numeric(row.records);
    search.invalidRecords += numeric(row.invalidRecords);
    count(search.modes, row.mode); count(search.outcomes, row.outcome); count(search.stopReasons, row.stopReason);
    if (row.paginationShiftObserved === true) search.paginationShifts++;
    if (row.timeBudgetExhausted === true) search.timeBudgets++;
    if (row.windowOverflow === true) search.windowOverflows++;
  } else if (row.type === 'page') {
    const diagnostic = row.diagnostics as Record<string, unknown> | undefined;
    if (typeof diagnostic?.httpRequests === 'number') reportedNativeHttpRequests += numeric(diagnostic.httpRequests);
    else pagesWithoutHttpCount++;
  }
}
for (const [id, starts] of startTimes) {
  const stats = searches[id]!.intervalsSeconds;
  let sum = 0;
  for (let index = 1; index < starts.length; index++) {
    const interval = (starts[index]! - starts[index - 1]!) / 1000;
    stats.count++;
    stats.min = Math.min(stats.min ?? interval, interval);
    stats.max = Math.max(stats.max ?? interval, interval);
    sum += interval;
  }
  if (stats.count) stats.mean = sum / stats.count;
}
const lifecycle = dictionary<number>();
for await (const row of rows('supervisor.jsonl')) if (row.runId === status.runId) count(lifecycle, row.type);
const emittedEventIds = new Set<string>();
let emittedEventsDuringRun = 0;
for await (const row of rows('events.jsonl')) {
  const at = typeof row.observedAt === 'string' ? Date.parse(row.observedAt) : NaN;
  if (at >= started && at <= finished && typeof row.eventId === 'string') {
    emittedEventsDuringRun++;
    emittedEventIds.add(row.eventId);
  }
}
const report = {
  inspectedAt, runDir, dataDir: config.dataDir, supervisor: { ...status, processAlive: supervisorProcessAlive(status) },
  elapsedSeconds: Math.max(0, (finished - started) / 1000),
  duration24HoursReached: finished - started >= 86_400_000,
  acceptanceComplete: false,
  acceptanceNote: 'Длительность сама по себе не закрывает E2: оценить ошибки, пропуски, память, интервалы и независимые контрольные сверки.',
  searches, lifecycle, reportedNativeHttpRequests, pagesWithoutHttpCount, otherDiagnostics, malformedLogLines,
  emittedUniqueEventsDuringRun: emittedEventIds.size,
  emittedEventsDuringRun,
  duplicateEventEmissions: emittedEventsDuringRun - emittedEventIds.size,
  accumulatedState: { sequence: state.sequence, records: state.records.length, events: state.events.length,
    sources: state.sources, gaps: state.gaps, queries: state.queries },
};
const path = resolve(values.report);
await mkdir(dirname(path), { recursive: true });
await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ report: path, elapsedSeconds: report.elapsedSeconds, duration24HoursReached: report.duration24HoursReached,
  status: status.status, records: state.records.length, events: state.events.length, searches })}\n`);
