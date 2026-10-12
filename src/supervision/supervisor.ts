import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MemorySample { at: string; rss: number; heapUsed: number; uptimeMs: number }
export interface SupervisorStatus {
  version: 1;
  runId: string;
  status: 'running' | 'waiting' | 'stopping' | 'stopped' | 'halted';
  pid: number;
  childPid: number | null;
  attempts: number;
  startedAt: string;
  deadline: string | null;
  updatedAt: string;
  lastExit: { at: string; code: number | null; signal: NodeJS.Signals | null } | null;
  lastError: string | null;
  restartAt: string | null;
  stopReason: 'requested' | 'duration' | 'signal' | 'log_limit' | 'error' | null;
  memory: { supervisor: MemorySample | null; child: MemorySample | null };
  peakSampledSupervisorRss: number;
  peakSampledChildRss: number;
}
export interface SupervisorOptions {
  runDir: string;
  configPath: string;
  durationSeconds?: number;
  signal?: AbortSignal;
  // Only the programmatic API permits test fixtures and shorter timings.
  childEntry?: string;
  childArgs?: string[];
  restartMinMs?: number;
  restartMaxMs?: number;
  maxRapidFailures?: number;
  rapidFailureWindowMs?: number;
  stopGraceMs?: number;
  pollMs?: number;
  memorySampleMs?: number;
  maxLogBytes?: number;
}
interface Lock { directory: string; ownerName: string }
interface ChildRun { process: ChildProcess; closed: Promise<void>; isClosed: boolean; started: number; error: Error | null }

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function alive(pid: number): boolean | null {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : null;
  }
}
function integer(value: number, name: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name}: требуется целое число >= ${minimum}`);
  return value;
}

async function releaseLock(lock: Lock): Promise<void> {
  try { await unlink(join(lock.directory, lock.ownerName)); } catch (error) { if (!isMissing(error)) throw error; }
  try { await rmdir(lock.directory); } catch (error) {
    if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
  }
}

async function acquireLock(runDir: string, runId: string): Promise<Lock> {
  await mkdir(runDir, { recursive: true });
  const directory = join(runDir, 'supervisor.lock');
  const candidate = join(runDir, `.supervisor-lock-${runId}`);
  const ownerName = `owner-${runId}.json`;
  await mkdir(candidate);
  let acquired = false;
  try {
    const file = await open(join(candidate, ownerName), 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ pid: process.pid, runId })); await file.sync(); } finally { await file.close(); }
    for (let attempt = 0; attempt < 8; attempt++) {
      try { await rename(candidate, directory); acquired = true; return { directory, ownerName }; } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      let names: string[];
      try { names = await readdir(directory); } catch (error) { if (isMissing(error)) continue; throw error; }
      if (names.length === 0) {
        try { await rmdir(directory); } catch (error) {
          if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
        }
        continue;
      }
      if (names.length !== 1 || !/^owner-[0-9a-f-]{36}\.json$/.test(names[0]!)) throw new Error('Неизвестная блокировка supervisor; автоматическое удаление запрещено');
      const staleOwnerName = names[0]!;
      let owner: { pid?: unknown; runId?: unknown };
      try { owner = JSON.parse(await readFile(join(directory, staleOwnerName), 'utf8')); } catch (error) {
        if (isMissing(error)) continue;
        throw new Error('Повреждён supervisor lock; автоматическое удаление запрещено', { cause: error });
      }
      if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || `owner-${owner.runId}.json` !== staleOwnerName) {
        throw new Error('Некорректный владелец supervisor lock');
      }
      if (alive(Number(owner.pid)) !== false) throw new Error(`Supervisor уже запущен или PID ${owner.pid} нельзя проверить`);
      // A dead parent can leave a child briefly closing/fsyncing its store. Do not
      // launch its successor until the recorded child has definitely exited.
      const previous = await readSupervisorStatus(runDir);
      if (previous !== null && previous.runId === owner.runId && previous.childPid !== null) {
        if (!Number.isSafeInteger(previous.childPid) || previous.childPid <= 0) throw new Error('Некорректный childPid прежнего supervisor');
        if (alive(previous.childPid) !== false) throw new Error(`Прежний дочерний процесс PID ${previous.childPid} ещё работает или его нельзя проверить`);
      }
      // Only this exact proven-dead owner is removed; a successor has a different name.
      try { await unlink(join(directory, staleOwnerName)); } catch (error) { if (!isMissing(error)) throw error; }
      try { await rmdir(directory); } catch (error) {
        if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
      }
    }
    throw new Error('Не удалось получить supervisor lock после конкурентного восстановления');
  } finally {
    if (!acquired) await releaseLock({ directory: candidate, ownerName });
  }
}

async function replaceFile(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); } finally { await file.close(); }
  try {
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; } catch (error) {
        if (attempt >= 19 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(100, 10 * (attempt + 1))));
      }
    }
  } finally {
    try { await unlink(temporary); } catch (error) { if (!isMissing(error)) throw error; }
  }
}

export async function readSupervisorStatus(runDir: string): Promise<SupervisorStatus | null> {
  let value: unknown;
  try { value = JSON.parse(await readFile(join(resolve(runDir), 'status.json'), 'utf8')); } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 ||
      !('runId' in value) || typeof value.runId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.runId) ||
      !('pid' in value) || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 ||
      !('status' in value) || !['running', 'waiting', 'stopping', 'stopped', 'halted'].includes(String(value.status))) {
    throw new Error('Некорректный status.json supervisor');
  }
  return value as SupervisorStatus;
}

/** A read-only liveness observation; null means the OS did not prove either state. */
export function supervisorProcessAlive(status: SupervisorStatus): boolean | null { return alive(status.pid); }

export async function requestSupervisorStop(runDir: string): Promise<boolean> {
  const status = await readSupervisorStatus(runDir);
  if (!status || status.status === 'stopped' || status.status === 'halted' || alive(status.pid) === false) return false;
  await replaceFile(join(resolve(runDir), 'stop.json'), { version: 1, runId: status.runId, requestedAt: new Date().toISOString() });
  return true;
}

/** One foreground supervisor, one child at a time. Never changes the data writer lock. */
export async function runSupervisor(options: SupervisorOptions): Promise<SupervisorStatus> {
  const runDir = resolve(options.runDir);
  const restartMin = integer(options.restartMinMs ?? 5_000, 'restartMinMs');
  const restartMax = integer(options.restartMaxMs ?? 60_000, 'restartMaxMs');
  if (restartMax < restartMin) throw new Error('restartMaxMs меньше restartMinMs');
  const failureLimit = integer(options.maxRapidFailures ?? 5, 'maxRapidFailures');
  const failureWindow = integer(options.rapidFailureWindowMs ?? 600_000, 'rapidFailureWindowMs');
  const grace = integer(options.stopGraceMs ?? 10_000, 'stopGraceMs');
  const pollMs = integer(options.pollMs ?? 1_000, 'pollMs');
  const sampleMs = integer(options.memorySampleMs ?? 10_000, 'memorySampleMs');
  const maxLogBytes = integer(options.maxLogBytes ?? 256 * 1024 * 1024, 'maxLogBytes');
  if (options.durationSeconds !== undefined) integer(options.durationSeconds, 'durationSeconds');
  const started = Date.now();
  const deadline = options.durationSeconds === undefined ? null : started + options.durationSeconds * 1_000;
  if (deadline !== null && (!Number.isSafeInteger(deadline) || Number.isNaN(new Date(deadline).valueOf()))) throw new Error('durationSeconds слишком велик');
  const status: SupervisorStatus = {
    version: 1, runId: randomUUID(), status: 'waiting', pid: process.pid, childPid: null, attempts: 0,
    startedAt: new Date(started).toISOString(), deadline: deadline === null ? null : new Date(deadline).toISOString(),
    updatedAt: new Date(started).toISOString(), lastExit: null, lastError: null, restartAt: null, stopReason: null,
    memory: { supervisor: null, child: null },
    peakSampledSupervisorRss: 0, peakSampledChildRss: 0,
  };
  const lock = await acquireLock(runDir, status.runId);
  let lifecycle: FileHandle | undefined;
  let events: FileHandle | undefined;
  let diagnostics: FileHandle | undefined;
  let child: ChildRun | null = null;
  let lastSample = 0;
  const recentFailures: number[] = [];

  const publish = async (type: string): Promise<void> => {
    status.updatedAt = new Date().toISOString();
    await lifecycle!.writeFile(`${JSON.stringify({ type, ...status })}\n`);
    await lifecycle!.sync();
    await replaceFile(join(runDir, 'status.json'), status);
  };
  const pause = async (until: number, active?: ChildRun): Promise<void> => {
    const deadlineWait = deadline === null || status.stopReason !== null ? Infinity : deadline - Date.now();
    const wait = Math.max(1, Math.min(pollMs, until - Date.now(), deadlineWait));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const wake = new Promise<void>(resolve => {
      timer = setTimeout(resolve, wait);
      abort = resolve;
      options.signal?.addEventListener('abort', abort, { once: true });
    });
    try { await Promise.race(active ? [wake, active.closed] : [wake]); } finally {
      clearTimeout(timer);
      if (abort) options.signal?.removeEventListener('abort', abort);
    }
  };
  const checkStop = async (): Promise<boolean> => {
    if (status.stopReason !== null) return true;
    if (options.signal?.aborted) status.stopReason = 'signal';
    else if (deadline !== null && Date.now() >= deadline) status.stopReason = 'duration';
    else {
      try {
        const request = JSON.parse(await readFile(join(runDir, 'stop.json'), 'utf8')) as { version?: unknown; runId?: unknown };
        if (request.version === 1 && request.runId === status.runId) status.stopReason = 'requested';
      } catch (error) { if (!isMissing(error)) throw new Error('Некорректный запрос остановки supervisor', { cause: error }); }
    }
    const sizes = await Promise.all([events!, diagnostics!, lifecycle!].map(async file => (await file.stat()).size));
    if (sizes.some(size => size >= maxLogBytes)) {
      status.stopReason = 'log_limit';
      status.lastError = `Лог достиг лимита ${maxLogBytes} bytes; требуется архивирование перед новым запуском`;
    }
    return status.stopReason !== null;
  };
  const sample = async (active: ChildRun | null): Promise<void> => {
    if (Date.now() - lastSample < sampleMs) return;
    lastSample = Date.now();
    const memory = process.memoryUsage();
    status.memory.supervisor = { at: new Date().toISOString(), rss: memory.rss, heapUsed: memory.heapUsed, uptimeMs: Date.now() - started };
    status.peakSampledSupervisorRss = Math.max(status.peakSampledSupervisorRss, memory.rss);
    if (active?.process.connected && !active.isClosed) {
      active.process.send({ type: 'carradar_sample' }, error => { if (error && !active.isClosed) active.error = error; });
    }
    await publish('memory');
  };
  const stopChild = async (active: ChildRun): Promise<void> => {
    if (active.isClosed) return;
    status.status = 'stopping';
    status.restartAt = null;
    await publish('stopping');
    if (active.process.connected) {
      active.process.send({ type: 'carradar_stop' }, error => { if (error && !active.isClosed) active.error = error; });
    }
    const forceAt = Date.now() + grace;
    while (!active.isClosed && Date.now() < forceAt) await pause(forceAt, active);
    if (!active.isClosed) {
      await publish('force_kill');
      // On Windows kill is forceful; only used after IPC grace, then wait for close.
      active.process.kill('SIGKILL');
      await active.closed;
    }
  };
  const spawnChild = (): ChildRun => {
    const entry = options.childEntry ?? fileURLToPath(new URL('../cli.ts', import.meta.url));
    const args = options.childArgs ?? ['start', '--config', resolve(options.configPath)];
    const process = fork(entry, args, {
      stdio: ['ignore', events!.fd, diagnostics!.fd, 'ipc'], windowsHide: true,
      env: { ...globalThis.process.env, CARRADAR_SUPERVISED: '1' },
    });
    let complete!: () => void;
    const active: ChildRun = { process, closed: new Promise(resolve => { complete = resolve; }), isClosed: false, started: Date.now(), error: null };
    process.on('error', error => { active.error = error; });
    process.on('message', (value: unknown) => {
      if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'carradar_memory' ||
          !('rss' in value) || !Number.isSafeInteger(value.rss) || Number(value.rss) < 0 ||
          !('heapUsed' in value) || !Number.isSafeInteger(value.heapUsed) || Number(value.heapUsed) < 0) return;
      status.memory.child = { at: new Date().toISOString(), rss: Number(value.rss), heapUsed: Number(value.heapUsed), uptimeMs: Date.now() - active.started };
      status.peakSampledChildRss = Math.max(status.peakSampledChildRss, Number(value.rss));
    });
    process.once('close', (code, signal) => {
      active.isClosed = true;
      status.lastExit = { at: new Date().toISOString(), code, signal };
      complete();
    });
    return active;
  };

  try {
    lifecycle = await open(join(runDir, 'supervisor.jsonl'), 'a', 0o600);
    events = await open(join(runDir, 'events.jsonl'), 'a', 0o600);
    diagnostics = await open(join(runDir, 'diagnostics.jsonl'), 'a', 0o600);
    await publish('started');
    while (!(await checkStop())) {
      child = spawnChild();
      status.attempts++;
      status.childPid = child.process.pid ?? null;
      status.status = 'running';
      status.restartAt = null;
      status.memory.child = null;
      await publish('spawned');
      while (!child.isClosed && !(await checkStop())) {
        await sample(child);
        await pause(Date.now() + pollMs, child);
      }
      if (!child.isClosed) await stopChild(child);
      await child.closed;
      status.childPid = null;
      if (child.error) status.lastError = child.error.message;
      else if (status.stopReason === null) {
        status.lastError = `Дочерний процесс неожиданно завершился: code=${status.lastExit?.code ?? 'null'}, signal=${status.lastExit?.signal ?? 'null'}`;
      }
      await publish('child_closed');
      if (await checkStop()) break;
      const now = Date.now();
      // A child that exits without a stop is a failure even with exit code 0.
      const runtime = now - child.started;
      if (runtime >= failureWindow) recentFailures.length = 0;
      else recentFailures.push(now);
      while (recentFailures.length && recentFailures[0]! < now - failureWindow) recentFailures.shift();
      if (recentFailures.length >= failureLimit) {
        status.status = 'halted';
        status.stopReason = 'error';
        status.lastError = `Дочерний процесс завершился ${recentFailures.length} раз за ${failureWindow} ms; требуется исправление`;
        break;
      }
      const delay = Math.min(restartMax, restartMin * 2 ** Math.max(0, recentFailures.length - 1));
      const restartAt = now + delay;
      status.status = 'waiting';
      status.restartAt = new Date(restartAt).toISOString();
      await publish('restart_wait');
      while (Date.now() < restartAt && !(await checkStop())) {
        await sample(null);
        await pause(restartAt);
      }
    }
    status.childPid = null;
    status.restartAt = null;
    status.status = status.stopReason === 'error' || status.stopReason === 'log_limit' ? 'halted' : 'stopped';
    await publish(status.status);
    return structuredClone(status);
  } catch (error) {
    status.lastError = errorText(error);
    status.stopReason = 'error';
    if (child && !child.isClosed) {
      // Cleanup cannot depend on a writable status/log file.
      if (child.process.connected) child.process.send({ type: 'carradar_stop' }, () => {});
      const forceAt = Date.now() + grace;
      while (!child.isClosed && Date.now() < forceAt) await pause(forceAt, child);
      if (!child.isClosed) { child.process.kill('SIGKILL'); await child.closed; }
    }
    status.childPid = null;
    status.restartAt = null;
    status.status = 'halted';
    if (lifecycle) { try { await publish('halted'); } catch { /* Original disk/error remains authoritative. */ } }
    throw error;
  } finally {
    const results = await Promise.allSettled([events?.close(), diagnostics?.close(), lifecycle?.close()]);
    await releaseLock(lock);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
