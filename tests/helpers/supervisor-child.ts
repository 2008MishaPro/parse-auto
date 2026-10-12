import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Listing } from '../../src/core/contracts.ts';
import { FileStore } from '../../src/core/store.ts';
import { installChildLifecycle } from '../../src/supervision/child-lifecycle.ts';

const [directory, mode = 'normal', stopDelay = '0'] = process.argv.slice(2);
if (!directory) throw new Error('Fixture directory is required');
const controller = new AbortController();
const removeLifecycle = installChildLifecycle(controller, 50);
await mkdir(directory, { recursive: true });
const historyPath = join(directory, 'child-history.jsonl');
const history = async (type: string, fields: Record<string, unknown> = {}) => {
  await appendFile(historyPath, `${JSON.stringify({ type, pid: process.pid, at: Date.now(), ...fields })}\n`);
};
await history('started');

if (mode === 'rapid-fail' || mode === 'rapid-clean') {
  const code = mode === 'rapid-clean' ? 0 : 17;
  process.stderr.write(`${JSON.stringify({ fixture: 'rapid-failure', pid: process.pid })}\n`);
  await history('exiting', { code });
  process.exit(code);
}

const store = await FileStore.open(join(directory, 'state'));
const row = (priceMinor: number, second = 0, externalId = 'one'): Listing => ({
  source: 'fixture', externalId, url: `https://fixture.invalid/${externalId}`, title: `Car ${externalId}`,
  priceMinor, currency: 'RUB', observedAt: new Date(Date.UTC(2026, 9, 11, 0, 0, second)).toISOString(),
  publishedAt: null, vehicle: { make: null, model: null, year: null, mileageKm: null }, provenance: {},
});

let stage = 'normal';
if (mode === 'recover-crash') {
  const marker = join(directory, 'crash-once');
  let crashedBefore = false;
  try { await readFile(marker); crashedBefore = true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!crashedBefore) {
    await store.commitPage('cars', 'baseline', null, [row(100)], null);
    await store.updateQuery('cars', { baselineComplete: true });
    await store.commitPage('cars', 'changed', null, [row(200, 1), row(500, 1, 'two')], 'p2');
    await writeFile(marker, 'committed-before-process-crash');
    await history('durable-before-crash', { state: await FileStore.inspect(join(directory, 'state')) });
    process.stdout.write(`${JSON.stringify({ fixture: 'committed', pid: process.pid })}\n`);
    process.stderr.write(`${JSON.stringify({ fixture: 'forced-exit', pid: process.pid })}\n`);
    process.exit(23);
  }
  const before = await FileStore.inspect(join(directory, 'state'));
  const replayEvents = await store.commitPage('cars', 'changed', null, [row(200, 1), row(500, 1, 'two')], 'p2');
  const afterReplay = await FileStore.inspect(join(directory, 'state'));
  await history('restored', { baselineComplete: before.queries.cars!.baselineComplete,
    resumeCursor: before.queries.cars!.resumeCursor, activeRunId: before.queries.cars!.activeRunId,
    eventIds: before.events.map(event => event.eventId), replayEvents,
    replayUnchanged: JSON.stringify(before) === JSON.stringify(afterReplay) });
  await store.commitPage('cars', 'changed', 'p2', [row(200, 2), row(700, 2, 'three')], 'p3');
  stage = 'restarted';
}

process.stdout.write(`${JSON.stringify({ fixture: 'ready', pid: process.pid, stage })}\n`);
process.stderr.write(`${JSON.stringify({ fixture: 'diagnostic', pid: process.pid, stage })}\n`);
await history('ready', { stage });
if (mode === 'flood-log') {
  process.stderr.write(`${JSON.stringify({ fixture: 'log-flood', payload: 'x'.repeat(40_000) })}\n`);
}

let stopped = false;
const keepAlive = setInterval(() => {}, 1000);
async function stop(reason: string): Promise<void> {
  if (stopped) return;
  stopped = true;
  clearInterval(keepAlive);
  await history('stop-received', { reason });
  await new Promise(resolve => setTimeout(resolve, Number(stopDelay)));
  await store.updateQuery('cars', { coverage: { fixtureStopped: true, stopReason: reason } });
  await store.close();
  await history('closed', { reason });
  removeLifecycle();
  if (process.connected) process.disconnect();
}

if (mode !== 'ignore-stop') {
  controller.signal.addEventListener('abort', () => { void stop('lifecycle'); }, { once: true });
  if (controller.signal.aborted) await stop('lifecycle');
}
