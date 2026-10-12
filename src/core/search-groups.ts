export interface SearchBinding { queryKey: string; storageId: string }
export interface SearchRegistration { id: string; source: string; url: string; enabled: boolean }
type StoredQuery = { queryKey: string | null; coverage: Record<string, unknown> };
export interface BindingPlan {
  queries: Array<[string, string]>;
  bindings: Array<[string, SearchBinding]>;
  resolved: Record<string, string>;
}

export function assertQueryKey(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new Error('Некорректный queryKey группы поиска');
  const parts: unknown = JSON.parse(value);
  if (!Array.isArray(parts) || parts.length !== 2 || !parts.every(part => typeof part === 'string' && part.length > 0)
    || JSON.stringify(parts) !== value) throw new Error('Некорректный queryKey группы поиска');
}

export function assertSearchBindings(queries: Record<string, StoredQuery>, bindings: Map<string, SearchBinding>): void {
  const groups = new Map<string, string>();
  for (const [alias, binding] of bindings) {
    if (!alias || !binding || typeof binding.storageId !== 'string' || !binding.storageId) throw new Error('Некорректная привязка поиска');
    assertQueryKey(binding.queryKey);
    if (queries[binding.storageId]?.queryKey !== binding.queryKey) throw new Error('Привязка поиска не соответствует сохранённой query');
    const root = bindings.get(binding.storageId);
    if (root?.storageId !== binding.storageId || root.queryKey !== binding.queryKey) throw new Error('В привязках отсутствует исходный ID группы');
    if (groups.has(binding.queryKey) && groups.get(binding.queryKey) !== binding.storageId) throw new Error('Один queryKey имеет несколько групп');
    groups.set(binding.queryKey, binding.storageId);
    if (alias !== binding.storageId && Object.hasOwn(queries, alias)) throw new Error('Alias конфликтует с отдельной сохранённой query');
  }
  for (const [id, query] of Object.entries(queries)) {
    if (query.queryKey === null) continue;
    const root = groups.get(query.queryKey);
    if (root !== undefined && root !== id) throw new Error('Привязанная группа имеет несколько сохранённых query');
    if (Array.isArray(query.coverage.aliases)) for (const alias of query.coverage.aliases) {
      if (typeof alias === 'string' && bindings.has(alias) && bindings.get(alias)!.queryKey !== query.queryKey) {
        throw new Error('Привязка конфликтует с запомненным alias старого поиска');
      }
    }
  }
}

/** Selects an existing root without moving membership or rewriting old events. */
export function planSearchBindings(queries: Record<string, StoredQuery>, existing: Map<string, SearchBinding>, searches: SearchRegistration[]): BindingPlan {
  assertSearchBindings(queries, existing);
  const planned = new Map(existing);
  const queryCopies: Record<string, StoredQuery> = Object.assign(Object.create(null), queries);
  const changedQueries: Array<[string, string]> = [];
  const resolved: Record<string, string> = Object.create(null);
  const groups = new Map<string, SearchRegistration[]>();
  const ids = new Set<string>();
  const rootsByKey = new Map<string, string[]>();
  const remembered = new Map<string, Set<string>>();
  const remember = (alias: string, key: string) => {
    const keys = remembered.get(alias) ?? new Set<string>();
    keys.add(key); remembered.set(alias, keys);
  };
  for (const [root, query] of Object.entries(queries)) {
    if (query.queryKey === null) continue;
    assertQueryKey(query.queryKey);
    const roots = rootsByKey.get(query.queryKey) ?? [];
    roots.push(root); rootsByKey.set(query.queryKey, roots);
    remember(root, query.queryKey);
    if (Array.isArray(query.coverage.aliases)) for (const alias of query.coverage.aliases) {
      if (typeof alias === 'string' && alias) remember(alias, query.queryKey);
    }
  }
  for (const search of [...searches].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!search.id || typeof search.id !== 'string' || ids.has(search.id) || typeof search.source !== 'string' || !search.source
      || typeof search.url !== 'string' || !search.url || typeof search.enabled !== 'boolean') throw new Error('Некорректный или повторный ID регистрации поиска');
    ids.add(search.id);
    const key = JSON.stringify([search.source, search.url]);
    const bound = existing.get(search.id);
    const saved = queries[search.id];
    if (bound && bound.queryKey !== key || saved?.queryKey !== null && saved?.queryKey !== undefined && saved.queryKey !== key
      || [...remembered.get(search.id) ?? []].some(oldKey => oldKey !== key)) {
      throw new Error(`Поиск ${search.id} изменил source/URL; создайте новый id для других фильтров`);
    }
    const group = groups.get(key) ?? [];
    group.push(search); groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const roots = rootsByKey.get(key) ?? [];
    if (roots.length > 1) throw new Error(`Неоднозначная история поиска: несколько сохранённых query имеют один source/URL (${roots.join(', ')})`);
    const bound = [...existing.values()].find(binding => binding.queryKey === key);
    const preferred = group.find(search => search.enabled) ?? group[0]!;
    const storageId = bound?.storageId ?? roots[0] ?? preferred.id;
    const old = queries[storageId];
    if (old?.queryKey !== null && old?.queryKey !== undefined && old.queryKey !== key) throw new Error(`ID ${storageId} занят другим сохранённым поиском`);
    const aliases = new Set([storageId, ...group.map(search => search.id)]);
    if (old && Array.isArray(old.coverage.aliases)) for (const alias of old.coverage.aliases) {
      if (typeof alias === 'string' && alias) aliases.add(alias);
    }
    for (const alias of aliases) {
      const current = planned.get(alias);
      if (current && (current.queryKey !== key || current.storageId !== storageId)
        || [...remembered.get(alias) ?? []].some(oldKey => oldKey !== key)
        || alias !== storageId && Object.hasOwn(queries, alias)) throw new Error(`Конфликт сохранённой привязки поиска ${alias}; история не объединена`);
      planned.set(alias, { queryKey: key, storageId });
    }
    if (!old || old.queryKey === null) {
      changedQueries.push([storageId, key]);
      queryCopies[storageId] = { queryKey: key, coverage: old?.coverage ?? {} };
    }
    for (const search of group) resolved[search.id] = storageId;
  }
  assertSearchBindings(queryCopies, planned);
  return { queries: changedQueries, bindings: [...planned].filter(([id]) => !existing.has(id)), resolved };
}
