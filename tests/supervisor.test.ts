import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as nodeTest } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FileStore } from '../src/core/store.ts';
import { readSupervisorStatus, requestSupervisorStop, runSupervisor } from '../src/supervision/supervisor.ts';

const childEntry = fileURLToPath(new URL('./helpers/supervisor-child.ts', import.meta.url));
const parentEntry = fileURLToPath(new URL('./helpers/supervisor-parent.ts', import.meta.url));
const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const supervisorEntry = fileURLToPath(new URL('../src/supervisor.ts', import.meta.url));
const prefix = resolve(join(tmpdir(), 'carradar-supervisor-'));
type SupervisorOptions = Parameters<typeof runSupervisor>[0];
type Row = Record<string, any>;
const test = (name: string, action: (t: TestContext) => Promise<void>) => nodeTest(name, { timeout: 15_000 }, action);

const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, description: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value: T;
  do {
    value = await read();
    if (check(value)) return value;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(`${description}: ${JSON.stringify(value!)}`);
}

async function jsonl(path: string): Promise<Row[]> {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function temporary(t: TestContext, mode = 'normal', stopDelay = 0) {
  const directory = await mkdtemp(prefix);
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ dataDir: './fixture/state', searches: [
    { id: 'paused', source: 'avito', url: 'https://www.avito.ru/moskva/avtomobili', enabled: false },
  ] }));
  const fixture = join(directory, 'fixture');
  const runDir = join(directory, 'run');
  const options: SupervisorOptions = {
    runDir, configPath, childEntry, childArgs: [fixture, mode, String(stopDelay)],
    restartMinMs: 20, restartMaxMs: 40, maxRapidFailures: 3, rapidFailureWindowMs: 60_000,
    stopGraceMs: 2000, pollMs: 20, memorySampleMs: 50,
  };
  t.after(async () => {
    await requestSupervisorStop(runDir).catch(() => {});
    await eventually(() => readSupervisorStatus(runDir), value => value === null || value.status === 'stopped' || value.status === 'halted'
      || (!alive(value.pid) && (value.childPid === null || !alive(value.childPid))), 'supervisor cleanup', 5000).catch(() => {});
    for (const row of await jsonl(join(fixture, 'child-history.jsonl'))) {
      if (row.type === 'started' && typeof row.pid === 'number' && alive(row.pid)) {
        process.kill(row.pid);
        await eventually(async () => alive(row.pid), value => !value, 'fixture child cleanup');
      }
    }
    assert.ok(resolve(directory).startsWith(prefix), 'cleanup stays inside its task temporary directory');
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, fixture, runDir, configPath, options };
}

async function ready(fixture: string, stage?: string): Promise<Row[]> {
  return eventually(() => jsonl(join(fixture, 'child-history.jsonl')),
    rows => rows.some(row => row.type === 'ready' && (stage === undefined || row.stage === stage)), 'child ready');
}

async function crash(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

test('requested IPC stop waits for the child to flush and close; status and output streams describe the stopped process', async t => {
  const context = await temporary(t, 'normal', 150);
  assert.equal(await readSupervisorStatus(context.runDir), null);
  assert.equal(await requestSupervisorStop(context.runDir), false);
  const running = runSupervisor(context.options);
  t.after(async () => { await requestSupervisorStop(context.runDir); await running; });
  const rows = await ready(context.fixture);
  const pid = rows.find(row => row.type === 'ready')!.pid as number;
  const status = await eventually(() => readSupervisorStatus(context.runDir),
    value => value?.status === 'running' && value.childPid === pid && value.memory.child !== null, 'running status with memory');
  assert.equal(status!.pid, process.pid);
  assert.equal(status!.attempts, 1);
  assert.ok(status!.memory.supervisor!.rss > 0);
  const stoppedAt = Date.now();
  assert.equal(await requestSupervisorStop(context.runDir), true);
  const ended = await running;
  assert.ok(Date.now() - stoppedAt >= 100, 'supervisor waited for delayed store close');
  assert.equal(ended.status, 'stopped');
  assert.equal(ended.stopReason, 'requested');
  assert.equal(ended.childPid, null);
  assert.equal(ended.attempts, 1);
  assert.equal(ended.lastExit?.code, 0);
  assert.equal(alive(pid), false);
  assert.equal((await FileStore.inspect(join(context.fixture, 'state'))).queries.cars!.coverage.fixtureStopped, true);
  const reopened = await FileStore.open(join(context.fixture, 'state'));
  await reopened.close();
  const history = await jsonl(join(context.fixture, 'child-history.jsonl'));
  assert.equal(history.filter(row => row.type === 'closed').length, 1);
  const events = await jsonl(join(context.runDir, 'events.jsonl'));
  const diagnostics = await jsonl(join(context.runDir, 'diagnostics.jsonl'));
  assert.ok(events.some(row => row.fixture === 'ready'));
  assert.ok(!events.some(row => row.fixture === 'diagnostic'));
  assert.ok(diagnostics.some(row => row.fixture === 'diagnostic'));
  assert.ok(!diagnostics.some(row => row.fixture === 'ready'));
  assert.deepEqual(await readSupervisorStatus(context.runDir), ended);
});

test('duration stop and abort both complete child lifecycle without a restart', async t => {
  for (const reason of ['duration', 'signal'] as const) {
    const context = await temporary(t);
    const controller = new AbortController();
    const running = runSupervisor({ ...context.options, ...(reason === 'duration' ? { durationSeconds: 1 } : { signal: controller.signal }) });
    t.after(async () => { controller.abort(); await requestSupervisorStop(context.runDir); await running; });
    await ready(context.fixture);
    if (reason === 'signal') controller.abort();
    const ended = await running;
    assert.equal(ended.status, 'stopped');
    assert.equal(ended.stopReason, reason);
    assert.equal(ended.attempts, 1);
    assert.equal(ended.lastExit?.code, 0);
    const rows = await jsonl(join(context.fixture, 'child-history.jsonl'));
    assert.equal(rows.filter(row => row.type === 'closed').length, 1);
  }
});

test('forced process exit restarts after exit and replays the real baseline, cursor and exactly-once events', async t => {
  const context = await temporary(t, 'recover-crash');
  const running = runSupervisor(context.options);
  t.after(async () => { await requestSupervisorStop(context.runDir); await running; });
  const rows = await ready(context.fixture, 'restarted');
  const started = rows.filter(row => row.type === 'started');
  assert.equal(started.length, 2);
  assert.equal(alive(started[0]!.pid), false, 'old child is dead before replacement is ready');
  assert.notEqual(started[0]!.pid, started[1]!.pid);
  const restored = rows.find(row => row.type === 'restored')!;
  assert.equal(restored.baselineComplete, true);
  assert.equal(restored.resumeCursor, 'p2');
  assert.equal(restored.activeRunId, 'changed');
  assert.equal(restored.eventIds.length, 2);
  assert.deepEqual(restored.replayEvents, []);
  assert.equal(restored.replayUnchanged, true);
  const state = await FileStore.inspect(join(context.fixture, 'state'));
  assert.equal(state.queries.cars!.resumeCursor, 'p3');
  assert.equal(state.records.length, 3);
  assert.deepEqual(state.events.map(event => event.type), ['price_changed', 'discovered', 'discovered']);
  assert.deepEqual(state.events.slice(0, 2).map(event => event.eventId), restored.eventIds);
  assert.equal(new Set(state.events.map(event => event.eventId)).size, 3);
  const active = await readSupervisorStatus(context.runDir);
  assert.equal(active!.attempts, 2);
  assert.equal(active!.lastExit?.code, 23);
  assert.equal(active!.childPid, started[1]!.pid);
  await requestSupervisorStop(context.runDir);
  const ended = await running;
  assert.equal(ended.attempts, 2);
  assert.equal(ended.status, 'stopped');
});

test('a second supervisor is rejected while the first owns the run directory', async t => {
  const context = await temporary(t);
  const running = runSupervisor(context.options);
  t.after(async () => { await requestSupervisorStop(context.runDir); await running; });
  await ready(context.fixture);
  await assert.rejects(runSupervisor(context.options), /supervisor|работает|занят|lock/i);
  const rows = await jsonl(join(context.fixture, 'child-history.jsonl'));
  assert.equal(rows.filter(row => row.type === 'started').length, 1);
  await requestSupervisorStop(context.runDir);
  await running;
});

test('parent crash leaves no orphan, then a dead-owner lock is recovered without overlapping children', async t => {
  const context = await temporary(t, 'normal', 80);
  const optionsPath = join(context.directory, 'options.json');
  const crashFile = join(context.directory, 'crash-parent');
  await writeFile(optionsPath, JSON.stringify({ ...context.options, crashFile }));
  const parent = spawn(process.execPath, [parentEntry, optionsPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  parent.stderr!.on('data', chunk => { errors += chunk.toString(); });
  parent.stdout!.resume();
  t.after(() => crash(parent));
  const rows = await ready(context.fixture);
  const orphanPid = rows.find(row => row.type === 'ready')!.pid as number;
  const exited = once(parent, 'exit');
  await writeFile(crashFile, 'exit-without-supervisor-finally');
  const [code] = await exited;
  assert.equal(code, 29);
  assert.equal(parent.exitCode === null && parent.signalCode === null, false, errors);
  await eventually(async () => alive(orphanPid), value => !value, 'IPC orphan exited');
  const orphanHistory = await jsonl(join(context.fixture, 'child-history.jsonl'));
  // Some Windows process containers terminate descendants together with the
  // parent. Explicit channel-close tests below prove graceful IPC cleanup.
  assert.equal(orphanHistory.filter(row => row.type === 'started').length, 1);
  const reopened = await FileStore.open(join(context.fixture, 'state'));
  await reopened.close();
  const running = runSupervisor(context.options);
  t.after(async () => { await requestSupervisorStop(context.runDir); await running; });
  await eventually(() => jsonl(join(context.fixture, 'child-history.jsonl')),
    current => current.filter(row => row.type === 'ready').length === 2, 'replacement supervisor ready');
  const status = await readSupervisorStatus(context.runDir);
  assert.equal(status!.pid, process.pid);
  assert.notEqual(status!.childPid, orphanPid);
  assert.equal(status!.attempts, 1);
  await requestSupervisorStop(context.runDir);
  await running;
});

test('production child lifecycle closes the store on IPC disconnect, including disconnect before module startup', async t => {
  for (const early of [false, true]) {
    const context = await temporary(t);
    const child = spawn(process.execPath, [childEntry, context.fixture, 'normal', '20'],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, CARRADAR_SUPERVISED: '1' } });
    t.after(() => crash(child));
    const closed = once(child, 'exit');
    if (!early) await ready(context.fixture);
    child.disconnect();
    const [code] = await closed;
    assert.equal(code, 0);
    const rows = await jsonl(join(context.fixture, 'child-history.jsonl'));
    assert.equal(rows.filter(row => row.type === 'stop-received').length, 1);
    assert.equal(rows.filter(row => row.type === 'closed').length, 1);
    const store = await FileStore.open(join(context.fixture, 'state'));
    await store.close();
  }
});

test('a dead-parent lock still protects its recorded live child until the child is proven dead', async t => {
  const context = await temporary(t);
  const deadParent = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const deadPid = deadParent.pid!;
  await once(deadParent, 'close');
  assert.equal(alive(deadPid), false);
  const child = spawn(process.execPath, [childEntry, context.fixture, 'normal', '20'],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, CARRADAR_SUPERVISED: '1' } });
  t.after(() => crash(child));
  await ready(context.fixture);
  const runId = randomUUID();
  const lockDirectory = join(context.runDir, 'supervisor.lock');
  await mkdir(lockDirectory, { recursive: true });
  const ownerPath = join(lockDirectory, `owner-${runId}.json`);
  const ownerText = JSON.stringify({ pid: deadPid, runId });
  const statusText = JSON.stringify({ version: 1, runId, pid: deadPid, status: 'running', childPid: child.pid });
  await writeFile(ownerPath, ownerText);
  await writeFile(join(context.runDir, 'status.json'), statusText);
  await assert.rejects(runSupervisor(context.options), /child|дочер|жив|заверш|нельзя/i);
  assert.equal(await readFile(ownerPath, 'utf8'), ownerText);
  assert.equal(await readFile(join(context.runDir, 'status.json'), 'utf8'), statusText);
  assert.equal((await jsonl(join(context.fixture, 'child-history.jsonl'))).filter(row => row.type === 'started').length, 1);
  const closed = once(child, 'exit');
  child.disconnect();
  await closed;
  const running = runSupervisor(context.options);
  t.after(async () => { await requestSupervisorStop(context.runDir); await running; });
  await eventually(() => jsonl(join(context.fixture, 'child-history.jsonl')),
    rows => rows.filter(row => row.type === 'ready').length === 2, 'safe stale lock recovery');
  await requestSupervisorStop(context.runDir);
  assert.equal((await running).status, 'stopped');
});

test('unknown or corrupt lock ownership is preserved and rejected before spawning any child', async t => {
  for (const variant of ['unknown-file', 'malformed-json', 'invalid-pid']) {
    const context = await temporary(t);
    const runId = randomUUID();
    const lockDirectory = join(context.runDir, 'supervisor.lock');
    await mkdir(lockDirectory, { recursive: true });
    const ownerPath = join(lockDirectory, variant === 'unknown-file' ? 'unknown-owner' : `owner-${runId}.json`);
    const value = variant === 'malformed-json' ? '{' : JSON.stringify({ pid: 0, runId });
    await writeFile(ownerPath, value);
    await assert.rejects(runSupervisor(context.options), /lock|блокиров|владел/i);
    assert.equal(await readFile(ownerPath, 'utf8'), value);
    assert.deepEqual(await jsonl(join(context.fixture, 'child-history.jsonl')), []);
    assert.equal(await readSupervisorStatus(context.runDir), null);
  }
});

for (const mode of ['rapid-fail', 'rapid-clean']) test(`repeated ${mode} exits halt at the configured bound instead of restarting forever`, async t => {
  const context = await temporary(t, mode);
  const startedAt = Date.now();
  const ended = await runSupervisor(context.options);
  assert.equal(ended.status, 'halted');
  assert.equal(ended.attempts, 3);
  assert.equal(ended.childPid, null);
  assert.equal(ended.lastExit?.code, mode === 'rapid-clean' ? 0 : 17);
  assert.ok(Date.now() - startedAt >= 40, 'bounded restart delays were applied');
  const rows = await jsonl(join(context.fixture, 'child-history.jsonl'));
  assert.equal(rows.filter(row => row.type === 'started').length, 3);
  assert.ok(rows.filter(row => row.type === 'started').every(row => !alive(row.pid)));
  assert.deepEqual(await readSupervisorStatus(context.runDir), ended);
});

test('an unresponsive child is terminated after grace and is not restarted when stopping', async t => {
  const context = await temporary(t, 'ignore-stop');
  const running = runSupervisor({ ...context.options, stopGraceMs: 100 });
  t.after(async () => { await requestSupervisorStop(context.runDir); await running; });
  const rows = await ready(context.fixture);
  const pid = rows.find(row => row.type === 'ready')!.pid as number;
  await requestSupervisorStop(context.runDir);
  const ended = await running;
  assert.equal(ended.status, 'stopped');
  assert.equal(ended.stopReason, 'requested');
  assert.equal(ended.attempts, 1);
  assert.equal(alive(pid), false);
  const reopened = await FileStore.open(join(context.fixture, 'state'));
  await reopened.close();
  assert.equal((await jsonl(join(context.fixture, 'child-history.jsonl'))).filter(row => row.type === 'started').length, 1);
});

test('invalid timing options reject before creating a lock or starting a child', async t => {
  const context = await temporary(t);
  await assert.rejects(runSupervisor({ ...context.options, restartMinMs: -1 }), /restart|параметр|невер|допуст|полож|требуется/i);
  assert.deepEqual(await jsonl(join(context.fixture, 'child-history.jsonl')), []);
  await assert.rejects(access(join(context.runDir, 'supervisor.lock')), { code: 'ENOENT' });
});

test('CLI rejects malformed configuration and unsupported source before a child or run directory exists', async t => {
  const context = await temporary(t);
  const configurations = [
    { dataDir: './fixture/state', searches: [] },
    { dataDir: './fixture/state', searches: [{ id: 'one', source: 'unknown-source', url: 'https://fixture.invalid/cars' }] },
  ];
  for (const config of configurations) {
    await writeFile(context.configPath, JSON.stringify(config));
    const child = spawn(process.execPath, [supervisorEntry, 'run', '--config', context.configPath, '--run-dir', context.runDir],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const timeout = setTimeout(() => child.kill(), 5000);
    const [code] = await once(child, 'close');
    clearTimeout(timeout);
    assert.equal(code, 1, stderr);
    assert.equal(stdout, '');
    assert.ok(JSON.parse(stderr).message);
    await assert.rejects(access(context.runDir), { code: 'ENOENT' });
    await assert.rejects(access(join(context.fixture, 'state')), { code: 'ENOENT' });
  }
});

test('the real CLI closes its paused FileStore after supervisor IPC stop without an HTTP request', async t => {
  const context = await temporary(t);
  const running = runSupervisor({ ...context.options, childEntry: cliEntry,
    childArgs: ['start', '--config', context.configPath] });
  t.after(async () => { await requestSupervisorStop(context.runDir); await running; });
  const stateDirectory = join(context.fixture, 'state');
  await eventually(() => FileStore.inspect(stateDirectory), state => state.sequence >= 2 && state.queries.paused !== undefined,
    'real CLI saved paused search');
  const status = await readSupervisorStatus(context.runDir);
  assert.equal(status!.attempts, 1);
  await requestSupervisorStop(context.runDir);
  const ended = await running;
  assert.equal(ended.status, 'stopped');
  assert.equal(ended.lastExit?.code, 0);
  const store = await FileStore.open(stateDirectory);
  await store.close();
  const diagnostics = await jsonl(join(context.runDir, 'diagnostics.jsonl'));
  assert.ok(diagnostics.every(row => !('url' in row) && !('httpStatus' in row)));
});

test('a previous run stop request cannot stop the new run sharing its log directory', async t => {
  const context = await temporary(t);
  const first = runSupervisor(context.options);
  t.after(async () => { await requestSupervisorStop(context.runDir); await first; });
  await ready(context.fixture);
  await requestSupervisorStop(context.runDir);
  const firstEnded = await first;
  const request = JSON.parse(await readFile(join(context.runDir, 'stop.json'), 'utf8'));
  assert.equal(request.runId, firstEnded.runId);
  const second = runSupervisor(context.options);
  t.after(async () => { await requestSupervisorStop(context.runDir); await second; });
  await eventually(() => jsonl(join(context.fixture, 'child-history.jsonl')),
    rows => rows.filter(row => row.type === 'ready').length === 2, 'new run ignores old request');
  const secondActive = await readSupervisorStatus(context.runDir);
  assert.notEqual(secondActive!.runId, firstEnded.runId);
  assert.equal(secondActive!.status, 'running');
  await requestSupervisorStop(context.runDir);
  const ended = await second;
  assert.equal(ended.stopReason, 'requested');
  assert.equal(ended.attempts, 1);
});

test('log growth limit stops and closes the active child while preserving both output files', async t => {
  const context = await temporary(t, 'flood-log');
  const ended = await runSupervisor({ ...context.options, maxLogBytes: 20_000 });
  assert.equal(ended.status, 'halted');
  assert.equal(ended.stopReason, 'log_limit');
  assert.equal(ended.attempts, 1);
  assert.equal(ended.lastExit?.code, 0);
  const rows = await jsonl(join(context.fixture, 'child-history.jsonl'));
  assert.ok(rows.some(row => row.type === 'closed'));
  assert.ok((await readFile(join(context.runDir, 'diagnostics.jsonl'), 'utf8')).includes('log-flood'));
  assert.ok((await readFile(join(context.runDir, 'events.jsonl'), 'utf8')).includes('ready'));
  const reopened = await FileStore.open(join(context.fixture, 'state'));
  await reopened.close();
});
