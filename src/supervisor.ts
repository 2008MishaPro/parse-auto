import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { loadConfiguration } from './config.ts';
import { createAdapterRegistry } from './integrations/registry.ts';
import { readSupervisorStatus, requestSupervisorStop, runSupervisor, supervisorProcessAlive } from './supervision/supervisor.ts';

const help = `CarRadar — автоматический перезапуск одного процесса мониторинга

pnpm supervisor run --config searches.json --run-dir ./data/run
pnpm supervisor run --config searches.json --run-dir ./data/run --duration-seconds 86400
pnpm supervisor status --run-dir ./data/run
pnpm supervisor stop --run-dir ./data/run

run работает до остановки или указанного срока. Настройки сбора берутся из config.
events.jsonl содержит stdout, diagnostics.jsonl — stderr, supervisor.jsonl — состояние процесса.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', default: 'searches.json' },
      'run-dir': { type: 'string', default: './data/run' },
      'duration-seconds': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) { process.stdout.write(help); return; }
  if (positionals.length > 1) throw new Error('Ожидается одна команда: run, status или stop');
  const command = positionals[0] ?? 'run';
  const runDir = resolve(values['run-dir']);
  if (command === 'status') {
    const status = await readSupervisorStatus(runDir);
    process.stdout.write(`${JSON.stringify(status === null ? null : { ...status, processAlive: supervisorProcessAlive(status) }, null, 2)}\n`);
    return;
  }
  if (command === 'stop') {
    process.stdout.write(`${JSON.stringify({ requested: await requestSupervisorStop(runDir) })}\n`);
    return;
  }
  if (command !== 'run') throw new Error(`Неизвестная команда: ${command}`);
  const durationSeconds = values['duration-seconds'] === undefined ? undefined : Number(values['duration-seconds']);
  if (durationSeconds !== undefined && (!/^\d+$/.test(values['duration-seconds']!) || !Number.isSafeInteger(durationSeconds) || durationSeconds < 1)) {
    throw new Error('--duration-seconds: требуется положительное целое число');
  }
  const configPath = resolve(values.config);
  // Permanent configuration errors are rejected once, before any restart loop.
  const config = await loadConfiguration(configPath);
  const registry = createAdapterRegistry();
  for (const search of config.searches) registry.get(search.source);
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const status = await runSupervisor({ runDir, configPath, durationSeconds, signal: controller.signal });
    process.stdout.write(`${JSON.stringify(status)}\n`);
    if (status.status === 'halted') process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
