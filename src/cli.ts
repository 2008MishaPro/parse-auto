import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { loadConfiguration } from './config.ts';
import { MonitorService } from './core/monitor.ts';
import { FileStore } from './core/store.ts';
import { createAdapterRegistry } from './integrations/registry.ts';
import { installChildLifecycle } from './supervision/child-lifecycle.ts';

const controller = new AbortController();
// Install before async config/store startup so a lost supervisor cannot leave an orphan.
const releaseLifecycle = installChildLifecycle(controller);

const help = `CarRadar — постоянный мониторинг Авито (Node.js 24.19+)

pnpm monitor start --config searches.json            постоянный сбор до Ctrl+C
pnpm monitor start --config searches.json --once     один диагностический цикл
pnpm monitor status --data-dir ./data/state         состояние, привязки ID и охват
pnpm monitor export --data-dir ./data/state          все накопленные объявления
pnpm monitor export --search-id ID --format json    объявления сохранённого поиска
pnpm monitor export --search-id ID --events         события сохранённого поиска
pnpm monitor export --search-id ID --gaps           история возможных пропусков поиска
pnpm monitor compact --data-dir ./data/state        снимок и сжатие журнала

Настройки применяются при перезапуске. enabled=false ставит поиск на паузу.
start сохраняет страницы до вывода событий. Логи идут в stderr, данные — в stdout.
export читает ./data/state по умолчанию; --search-id принимает сохранённый ID или alias.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', default: 'searches.json' },
      'data-dir': { type: 'string', default: './data/state' },
      'search-id': { type: 'string' },
      once: { type: 'boolean', default: false },
      events: { type: 'boolean', default: false },
      gaps: { type: 'boolean', default: false },
      format: { type: 'string', default: 'jsonl' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) { process.stdout.write(help); return; }
  if (positionals.length > 1) throw new Error('Ожидается одна команда: start, status, export или compact');
  const command = positionals[0] ?? 'start';
  if (values['search-id'] !== undefined && command !== 'export') throw new Error('--search-id поддерживается только командой export');
  if (command === 'compact') {
    const directory = resolve(values['data-dir']);
    const store = await FileStore.open(directory);
    try {
      await store.compact();
    } finally {
      await store.close();
    }
    const state = await FileStore.inspect(directory);
    process.stdout.write(`${JSON.stringify({ compacted: true, sequence: state.sequence, records: state.records.length, events: state.events.length })}\n`);
    return;
  }
  if (command === 'status' || command === 'export') {
    const state = await FileStore.inspect(resolve(values['data-dir']), values['search-id']);
    if (command === 'status') {
      process.stdout.write(`${JSON.stringify({ sequence: state.sequence, records: state.records.length, events: state.events.length,
        searchBindings: state.searchBindings, sources: state.sources, gaps: state.gaps, queries: state.queries }, null, 2)}\n`);
    } else {
      if (values.format !== 'jsonl' && values.format !== 'json') throw new Error('--format: jsonl или json');
      if (values.events && values.gaps) throw new Error('--events и --gaps нельзя использовать вместе');
      const rows = values.events ? state.events : values.gaps ? state.gaps : state.records;
      if (values.format === 'json') process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      else for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
    }
    return;
  }
  if (command !== 'start') throw new Error(`Неизвестная команда: ${command}`);
  const config = await loadConfiguration(values.config);
  const registry = createAdapterRegistry();
  for (const search of config.searches) registry.get(search.source);
  const store = await FileStore.open(config.dataDir);
  try {
    const monitor = new MonitorService(registry, store, config.searches, {
      onEvent: event => { process.stdout.write(`${JSON.stringify(event)}\n`); },
      onDiagnostic: diagnostic => { process.stderr.write(`${JSON.stringify(diagnostic)}\n`); },
    });
    await monitor.run(controller.signal, { once: values.once });
    if (values.once) {
      const failed = config.searches.filter(search => search.enabled).some(search => {
        const coverage = store.getQuery(search.id).coverage;
        return coverage.status === 'partial' || coverage.status === 'error' || coverage.outcome === 'blocked' || coverage.outcome === 'schema_changed';
      });
      if (failed) process.exitCode = 2;
    }
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ level: 'error', message })}\n`);
  process.exitCode = 1;
}).finally(() => {
  releaseLifecycle();
  if (process.connected) process.disconnect();
});
