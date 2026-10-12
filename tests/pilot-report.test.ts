import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Listing } from '../src/core/contracts.ts';
import { FileStore } from '../src/core/store.ts';

const entry = fileURLToPath(new URL('../scripts/pilot-report.ts', import.meta.url));
const prefix = resolve(join(tmpdir(), 'carradar-pilot-report-'));

function run(directory: string, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Pilot report timeout: ${stderr}`)); }, 10_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
  });
}

test('pilot report follows canonical bindings, counts repeated stdout events and marks a dead supervisor inactive', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(prefix), 'cleanup stays in its task temporary directory');
    await rm(directory, { recursive: true, force: true });
  });
  const runDir = join(directory, 'run');
  await mkdir(runDir);
  const configPath = join(directory, 'config.json');
  const url = 'https://fixture.invalid/cars';
  const started = Date.now() - 600_000;
  const at = (seconds: number) => new Date(started + seconds * 1000).toISOString();
  const listing = (priceMinor: number, second: number): Listing => ({
    source: 'fixture', externalId: 'one', url: 'https://fixture.invalid/one', title: 'Fixture car',
    priceMinor, currency: 'RUB', observedAt: at(second), publishedAt: null,
    vehicle: { make: null, model: null, year: null, mileageKm: null }, provenance: {},
  });
  const store = await FileStore.open(join(directory, 'state'));
  try {
    await store.bindSearches([{ id: '__proto__', source: 'fixture', url, enabled: true }]);
    await store.commitPage('__proto__', 'baseline', null, [listing(100, 2)], null);
    await store.updateQuery('__proto__', { baselineComplete: true });
    await store.bindSearches([{ id: 'constructor', source: 'fixture', url, enabled: true }]);
    await store.commitPage('constructor', 'poll', null, [listing(200, 122)], null);
  } finally { await store.close(); }
  const state = await FileStore.inspect(join(directory, 'state'));
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0]!.searchId, '__proto__');
  assert.equal(Object.entries(state.searchBindings).find(([alias]) => alias === 'constructor')![1].storageId, '__proto__');
  await writeFile(configPath, JSON.stringify({ dataDir: './state', searches: [
    { id: 'constructor', source: 'fixture', url, intervalSeconds: 120 },
  ] }));

  // Windows can reuse an exited child's PID for a later report process.
  // Use a valid positive PID and verify that it is absent on this host.
  const deadPid = 2_147_483_647;
  assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
  const runId = randomUUID();
  const status = {
    version: 1, runId, status: 'stopped', pid: deadPid, childPid: null, attempts: 1,
    startedAt: at(0), updatedAt: at(150), deadline: at(86_400), lastExit: { at: at(150), code: 0, signal: null },
    lastError: null, restartAt: null, stopReason: 'requested', memory: { supervisor: null, child: null },
  };
  await writeFile(join(runDir, 'status.json'), JSON.stringify(status));
  const diagnostics = [
    { type: 'cycle_started', at: at(3), searchId: '__proto__', overdueMs: 2 },
    { type: 'cycle_finished', at: at(20), startedAt: at(1), searchId: '__proto__', mode: 'baseline', outcome: 'success',
      stopReason: 'end', elapsedMs: 19_000, pages: 1, records: 1, invalidRecords: 0 },
    { type: 'cycle_started', at: at(126), searchId: '__proto__', overdueMs: 5 },
    { type: 'cycle_finished', at: at(140), startedAt: at(121), searchId: '__proto__', mode: 'constructor', outcome: '__proto__',
      stopReason: 'toString', elapsedMs: 19_000, pages: 2, records: 3, invalidRecords: 1 },
  ];
  await writeFile(join(runDir, 'diagnostics.jsonl'), `${diagnostics.map(row => JSON.stringify(row)).join('\n')}\n`);
  await writeFile(join(runDir, 'supervisor.jsonl'), `${JSON.stringify({ runId, type: 'constructor' })}\n`);
  await writeFile(join(runDir, 'events.jsonl'), `${JSON.stringify(state.events[0])}\n${JSON.stringify(state.events[0])}\n`);
  const reportPath = join(directory, 'report.json');
  const result = await run(directory, '--config', configPath, '--run-dir', runDir, '--report', reportPath);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.deepEqual(Object.keys(report.searches), ['__proto__']);
  const metrics = report.searches.__proto__;
  assert.deepEqual(metrics.aliases, ['constructor']);
  assert.equal(metrics.starts, 2);
  assert.equal(metrics.finishes, 2);
  assert.deepEqual(metrics.intervalsSeconds, { count: 1, min: 120, max: 120, mean: 120 });
  assert.deepEqual(metrics.modes, { baseline: 1, constructor: 1 });
  assert.equal(Object.hasOwn(metrics.outcomes, '__proto__'), true);
  assert.equal(metrics.outcomes.__proto__, 1);
  assert.equal(metrics.stopReasons.toString, 1);
  assert.equal(report.lifecycle.constructor, 1);
  assert.equal(report.emittedEventsDuringRun, 2);
  assert.equal(report.emittedUniqueEventsDuringRun, 1);
  assert.equal(report.duplicateEventEmissions, 1);
  assert.equal(report.accumulatedState.events, 1);
  assert.equal(report.elapsedSeconds, 150);
  assert.equal(report.duration24HoursReached, false);
  assert.equal(report.acceptanceComplete, false);
  assert.equal(report.supervisor.status, 'stopped');
  assert.equal(report.supervisor.processAlive, false);
  assert.equal(JSON.parse(result.stdout).status, 'stopped');

  // A durable "running" status left after a parent crash cannot imply that
  // collection is still active when the actual PID has already exited.
  await writeFile(join(runDir, 'status.json'), JSON.stringify({ ...status, status: 'running' }));
  const staleResult = await run(directory, '--config', configPath, '--run-dir', runDir, '--report', reportPath);
  assert.equal(staleResult.code, 0, staleResult.stderr);
  const stale = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(stale.supervisor.status, 'running');
  assert.equal(stale.supervisor.processAlive, false);
  assert.equal(stale.duration24HoursReached, false);
  assert.equal(stale.acceptanceComplete, false);
});
