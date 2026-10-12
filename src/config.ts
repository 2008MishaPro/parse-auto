import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Search } from './core/contracts.ts';

export interface Configuration { dataDir: string; searches: Search[] }

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}: ожидается объект`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name}: ожидается непустая строка`);
  return value;
}

function integer(value: unknown, fallback: number, name: string, maximum = 86400): number {
  const result = value ?? fallback;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new Error(`${name}: ожидается целое число от 1 до ${maximum}`);
  }
  return result;
}

function detailsBudget(value: unknown): number {
  const result = value === undefined ? 0 : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0 || result > 10) {
    throw new Error('maxDetailsPerCycle: ожидается целое число от 0 до 10');
  }
  return result;
}

export async function loadConfiguration(path: string): Promise<Configuration> {
  const absolute = resolve(path);
  const config = object(JSON.parse(await readFile(absolute, 'utf8')), 'config');
  if (!Array.isArray(config.searches) || config.searches.length === 0) throw new Error('searches: нужен хотя бы один поиск');
  const ids = new Set<string>();
  const searches = config.searches.map((value, index): Search => {
    const row = object(value, `searches[${index}]`);
    const id = text(row.id, 'id');
    if (ids.has(id)) throw new Error(`Повторяющийся id поиска: ${id}`);
    ids.add(id);
    const url = text(row.url, 'url');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error(`Поиск ${id}: требуется HTTPS URL без credentials и fragment`);
    if (row.enabled !== undefined && typeof row.enabled !== 'boolean') throw new Error(`Поиск ${id}: enabled должен быть boolean`);
    const maxPagesPerSweep = integer(row.maxPagesPerSweep, 30, 'maxPagesPerSweep', 10000);
    const overlapPages = integer(row.overlapPages, 2, 'overlapPages', 10000);
    if (overlapPages > maxPagesPerSweep) throw new Error(`Поиск ${id}: overlapPages больше maxPagesPerSweep`);
    return {
      id, source: text(row.source, 'source'), url, enabled: row.enabled !== false,
      intervalSeconds: integer(row.intervalSeconds, 120, 'intervalSeconds'),
      overlapPages, maxPagesPerSweep,
      sweepIntervalSeconds: integer(row.sweepIntervalSeconds, 1800, 'sweepIntervalSeconds', 604800),
      requestTimeoutSeconds: integer(row.requestTimeoutSeconds, 30, 'requestTimeoutSeconds', 300),
      maxCycleSeconds: integer(row.maxCycleSeconds, 90, 'maxCycleSeconds'),
      maxDetailsPerCycle: detailsBudget(row.maxDetailsPerCycle),
    };
  });
  return { dataDir: resolve(dirname(absolute), text(config.dataDir ?? './data/state', 'dataDir')), searches };
}
