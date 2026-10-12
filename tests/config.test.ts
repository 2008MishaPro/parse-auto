import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfiguration } from '../src/config.ts';

test('config отвергает дубли ID и бюджет меньше overlap, сохраняет фильтры URL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'carradar-config-'));
  try {
    const path = join(directory, 'searches.json');
    const row = { id: 'cars', source: 'avito', url: 'https://www.avito.ru/moskva/avtomobili?s=104&q=Honda' };
    await writeFile(path, JSON.stringify({ searches: [row, row] }));
    await assert.rejects(loadConfiguration(path), /Повторяющийся/);
    await writeFile(path, JSON.stringify({ searches: [{ ...row, maxPagesPerSweep: 1 }] }));
    await assert.rejects(loadConfiguration(path), /overlapPages/);
    await writeFile(path, JSON.stringify({ searches: [row] }));
    const config = await loadConfiguration(path);
    assert.equal(config.searches[0].url, row.url);
    assert.equal(config.searches[0].maxCycleSeconds, 90);
    assert.equal(config.searches[0].maxDetailsPerCycle, 0);
    assert.equal(config.dataDir, join(directory, 'data', 'state'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('config допускает 0..10 карточек за цикл и не подменяет нечисловое значение дефолтом', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'carradar-config-'));
  try {
    const path = join(directory, 'searches.json');
    const row = { id: 'cars', source: 'avito', url: 'https://www.avito.ru/moskva/avtomobili' };
    for (const maxDetailsPerCycle of [null, '2', true, false, -1, 1.5, 11]) {
      await writeFile(path, JSON.stringify({ searches: [{ ...row, maxDetailsPerCycle }] }));
      await assert.rejects(loadConfiguration(path), /maxDetailsPerCycle: ожидается целое число от 0 до 10/);
    }
    for (const maxDetailsPerCycle of [0, 2, 10]) {
      await writeFile(path, JSON.stringify({ searches: [{ ...row, maxDetailsPerCycle }] }));
      const config = await loadConfiguration(path);
      assert.equal(config.searches[0].maxDetailsPerCycle, maxDetailsPerCycle);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('config проверяет границы общего времени цикла', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'carradar-config-'));
  try {
    const path = join(directory, 'searches.json');
    const row = { id: 'cars', source: 'avito', url: 'https://www.avito.ru/moskva/avtomobili' };
    for (const maxCycleSeconds of [0, 1.5, '90', 86_401]) {
      await writeFile(path, JSON.stringify({ searches: [{ ...row, maxCycleSeconds }] }));
      await assert.rejects(loadConfiguration(path), /maxCycleSeconds: ожидается целое число от 1 до 86400/);
    }
    for (const maxCycleSeconds of [1, 86_400]) {
      await writeFile(path, JSON.stringify({ searches: [{ ...row, maxCycleSeconds }] }));
      const config = await loadConfiguration(path);
      assert.equal(config.searches[0].maxCycleSeconds, maxCycleSeconds);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
