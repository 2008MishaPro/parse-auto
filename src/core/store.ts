import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CollectDetailsResult, Listing } from './contracts.ts';
import { assertDetailsState, detailsEligible, overlayVehicle } from './details-state.ts';
import type { DetailsState } from './details-state.ts';
export type { DetailsState } from './details-state.ts';
import { assertQueryKey, assertSearchBindings, planSearchBindings } from './search-groups.ts';
import type { SearchBinding, SearchRegistration } from './search-groups.ts';
import { assertGap, assertGapInput, assertSourceState, emptySource, gapIdentity } from './health-state.ts';
import type { CoverageGap, GapInput, SourceState } from './health-state.ts';
export type { CoverageGap, GapInput, SourceState } from './health-state.ts';

export type MonitorEvent = {
  eventId: string;
  sequence: number;
  type: 'discovered' | 'price_changed' | 'details_changed';
  searchId: string;
  source: string;
  externalId: string;
  observedAt: string;
  previousPriceMinor?: number | null;
  priceMinor: number | null;
};

export interface QueryState {
  baselineComplete: boolean;
  lastAttempt: string | null;
  lastSuccess: string | null;
  lastExhaustedScan: string | null;
  nextRunAt: string | null;
  failureCount: number;
  coverage: Record<string, unknown>;
  resumeCursor: string | null;
  activeRunId: string | null;
  queryKey: string | null;
}

type PageBatch = {
  type: 'page';
  searchId: string;
  runId: string;
  cursor: string | null;
  nextCursor: string | null;
  records: Listing[];
  events: MonitorEvent[];
};
type QueryBatch = { type: 'query'; searchId: string; patch: Partial<QueryState>; gaps?: CoverageGap[] };
type BindingBatch = { type: 'search_bindings'; queries: Array<[string, string]>; bindings: Array<[string, SearchBinding]> };
type SourceBatch = { type: 'source_states'; sources: Array<[string, SourceState]>; initializeGaps?: true; legacyGaps?: CoverageGap[] };
type DetailsBatch = { type: 'details_state'; state: DetailsState };
type Batch = PageBatch | QueryBatch | BindingBatch | SourceBatch | DetailsBatch;
type Anchor = { type: 'anchor'; snapshotChecksum: string };
type SnapshotPayload = {
  queries: Record<string, QueryState>;
  records: Listing[];
  searchRecords: Array<[string, Listing[]]>;
  knownPrices: Array<[string, Array<[string, number]>]>;
  pages: string[];
  events: MonitorEvent[];
  searchBindings?: Array<[string, SearchBinding]>;
  sources?: Array<[string, SourceState]>;
  gaps?: CoverageGap[];
  gapsInitialized?: boolean;
  detailsStates?: DetailsState[];
};
type State = {
  sequence: number;
  queries: Record<string, QueryState>;
  records: Map<string, Listing>;
  searchRecords: Map<string, Map<string, Listing>>;
  knownPrices: Map<string, Map<string, number>>;
  pages: Set<string>;
  events: MonitorEvent[];
  searchBindings: Map<string, SearchBinding>;
  sources: Map<string, SourceState>;
  gaps: Map<string, CoverageGap>;
  gapsInitialized: boolean;
  detailsStates: Map<string, DetailsState>;
};

const JOURNAL = 'journal.ndjson';
const SNAPSHOT = 'snapshot.json';
const LOCK = 'writer.lock';
const emptyQuery = (): QueryState => ({
  baselineComplete: false, lastAttempt: null, lastSuccess: null, lastExhaustedScan: null,
  nextRunAt: null, failureCount: 0, coverage: {}, resumeCursor: null, activeRunId: null, queryKey: null,
});
const emptyState = (): State => ({ sequence: 0, queries: Object.create(null), records: new Map(), searchRecords: new Map(), knownPrices: new Map(), pages: new Set(), events: [], searchBindings: new Map(), sources: new Map(), gaps: new Map(), gapsInitialized: false, detailsStates: new Map() });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = (record: Pick<Listing, 'source' | 'externalId'>) => JSON.stringify([record.source, record.externalId]);
const pageKey = (searchId: string, runId: string, cursor: string | null) => JSON.stringify([searchId, runId, cursor]);
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableString = (value: unknown) => value === null || typeof value === 'string';

function assertListing(value: unknown): asserts value is Listing {
  if (!object(value) || typeof value.source !== 'string' || !value.source || typeof value.externalId !== 'string' || !value.externalId
    || typeof value.url !== 'string' || typeof value.title !== 'string'
    || !(value.priceMinor === null || (typeof value.priceMinor === 'number' && Number.isSafeInteger(value.priceMinor) && value.priceMinor >= 0))
    || !nullableString(value.currency) || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))
    || !nullableString(value.publishedAt) || !object(value.vehicle) || !object(value.provenance)) {
    throw new Error('Некорректная запись объявления в файловом состоянии');
  }
  const vehicle = value.vehicle;
  if (!nullableString(vehicle.make) || !nullableString(vehicle.model)
    || ![vehicle.year, vehicle.mileageKm].every(v => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0))
    || !Object.values(value.provenance).every(v => typeof v === 'string')) {
    throw new Error('Некорректные поля объявления в файловом состоянии');
  }
  if (value.enrichment !== undefined) {
    const enrichment = value.enrichment;
    if (!object(enrichment) || typeof enrichment.observedAt !== 'string' || !Number.isFinite(Date.parse(enrichment.observedAt))
      || !Array.isArray(enrichment.fields) || !enrichment.fields.length
      || !enrichment.fields.every(field => ['make', 'model', 'year', 'mileageKm'].includes(field as string))
      || new Set(enrichment.fields).size !== enrichment.fields.length) throw new Error('Некорректные метаданные обогащения');
  }
}

function assertPatch(value: unknown): asserts value is Partial<QueryState> {
  if (!object(value)) throw new Error('Некорректное состояние поиска');
  for (const [key, field] of Object.entries(value)) {
    if (['lastAttempt', 'lastSuccess', 'lastExhaustedScan', 'nextRunAt', 'resumeCursor', 'activeRunId', 'queryKey'].includes(key)) {
      if (!nullableString(field)) throw new Error(`Некорректное поле состояния поиска: ${key}`);
    } else if (key === 'baselineComplete') {
      if (typeof field !== 'boolean') throw new Error('Некорректный baselineComplete');
    } else if (key === 'failureCount') {
      if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) throw new Error('Некорректный failureCount');
    } else if (key === 'coverage') {
      if (!object(field)) throw new Error('Некорректный coverage');
    } else throw new Error(`Неизвестное поле состояния поиска: ${key}`);
  }
}

function assertEvent(value: unknown, sequence: number): asserts value is MonitorEvent {
  if (!object(value) || typeof value.eventId !== 'string' || !value.eventId || value.sequence !== sequence
    || typeof value.searchId !== 'string' || !value.searchId
    || !['discovered', 'price_changed', 'details_changed'].includes(value.type as string)
    || typeof value.source !== 'string' || !value.source || typeof value.externalId !== 'string' || !value.externalId
    || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))
    || !(value.priceMinor === null || (typeof value.priceMinor === 'number' && Number.isSafeInteger(value.priceMinor) && value.priceMinor >= 0))
    || (value.type === 'price_changed' && !(typeof value.previousPriceMinor === 'number'
      && Number.isSafeInteger(value.previousPriceMinor) && value.previousPriceMinor >= 0))) throw new Error('Некорректное событие');
}

function parseSources(value: unknown): Map<string, SourceState> {
  if (!Array.isArray(value)) throw new Error('Некорректный реестр источников');
  const sources = new Map<string, SourceState>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0] || sources.has(entry[0])) {
      throw new Error('Некорректное или повторное состояние источника');
    }
    assertSourceState(entry[1]); sources.set(entry[0], entry[1]);
  }
  return sources;
}

function assertGaps(value: unknown, sequence: number, exactSequence = false): asserts value is CoverageGap[] {
  if (!Array.isArray(value)) throw new Error('Некорректная история пропусков');
  const ids = new Set<string>();
  for (const gap of value) {
    assertGap(gap, sequence);
    if (ids.has(gap.gapId) || exactSequence && gap.sequence !== sequence) throw new Error('Повтор или неверный sequence периода пропусков');
    ids.add(gap.gapId);
  }
}

function applyGap(state: State, gap: CoverageGap): void {
  const binding = state.searchBindings.get(gap.searchId);
  if (!Object.hasOwn(state.queries, gap.searchId) || binding && binding.storageId !== gap.searchId) throw new Error('История пропусков использует неизвестный или неканонический поиск');
  const previous = state.gaps.get(gap.gapId);
  if (previous && (previous.since === null && gap.since !== null
    || previous.since !== null && gap.since !== null && Date.parse(gap.since) > Date.parse(previous.since)
    || Date.parse(previous.until) > Date.parse(gap.until) || previous.sequence >= gap.sequence)) {
    throw new Error('Период пропусков потерял сохранённые границы');
  }
  state.gaps.set(gap.gapId, gap);
}

function assertBatch(value: unknown, sequence: number): asserts value is Batch {
  if (object(value) && value.type === 'details_state') {
    assertDetailsState(value.state, assertListing);
    return;
  }
  if (object(value) && value.type === 'source_states') {
    parseSources(value.sources);
    if (Object.hasOwn(value, 'initializeGaps') && value.initializeGaps !== true
      || value.legacyGaps !== undefined && value.initializeGaps !== true
      || value.initializeGaps === true && !Array.isArray(value.legacyGaps)) throw new Error('Некорректная инициализация истории пропусков');
    if (value.legacyGaps !== undefined) assertGaps(value.legacyGaps, sequence, true);
    return;
  }
  if (object(value) && value.type === 'search_bindings') {
    if (!Array.isArray(value.queries) || !Array.isArray(value.bindings)) throw new Error('Некорректный batch привязок');
    const queryIds = new Set<string>();
    for (const entry of value.queries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0] || queryIds.has(entry[0])) throw new Error('Некорректная query привязок');
      assertQueryKey(entry[1]); queryIds.add(entry[0]);
    }
    parseBindings(value.bindings);
    return;
  }
  if (!object(value) || typeof value.searchId !== 'string' || !value.searchId) throw new Error('Некорректный batch');
  if (value.type === 'query') {
    assertPatch(value.patch);
    if (value.gaps !== undefined) {
      assertGaps(value.gaps, sequence, true);
      for (const gap of value.gaps as CoverageGap[]) if (gap.searchId !== value.searchId) throw new Error('Gap принадлежит другому поиску');
    }
  } else if (value.type === 'page') {
    if (typeof value.runId !== 'string' || !value.runId || !nullableString(value.cursor) || !nullableString(value.nextCursor)
      || !Array.isArray(value.records) || !Array.isArray(value.events)) throw new Error('Некорректный page batch');
    value.records.forEach(assertListing);
    for (const event of value.events) {
      assertEvent(event, sequence);
      if (event.searchId !== value.searchId) throw new Error('Событие принадлежит другому поиску');
    }
  } else throw new Error('Неизвестный тип batch');
}

function applyBatch(state: State, batch: Batch, sequence: number) {
  if (batch.type === 'details_state') {
    const key = identity(batch.state);
    if (!state.records.has(key)) throw new Error('Состояние карточки без сохранённого объявления');
    state.detailsStates.set(key, batch.state);
    state.sequence = sequence;
    return;
  }
  if (batch.type === 'source_states') {
    if (batch.initializeGaps && state.gapsInitialized) throw new Error('Повтор инициализации истории пропусков');
    for (const gap of batch.legacyGaps ?? []) applyGap(state, gap);
    for (const [source, health] of batch.sources) state.sources.set(source, health);
    if (batch.initializeGaps) state.gapsInitialized = true;
    state.sequence = sequence;
    return;
  }
  if (batch.type === 'search_bindings') {
    for (const [id, key] of batch.queries) {
      const query = state.queries[id] ??= emptyQuery();
      if (query.queryKey !== null && query.queryKey !== key) throw new Error('Batch изменяет сохранённый queryKey');
      query.queryKey = key;
    }
    for (const [id, binding] of batch.bindings) {
      if (state.searchBindings.has(id)) throw new Error('Повтор постоянной привязки поиска');
      state.searchBindings.set(id, binding);
    }
    assertSearchBindings(state.queries, state.searchBindings);
    for (const [id, key] of batch.queries) {
      if (state.searchBindings.get(id)?.storageId !== id || state.searchBindings.get(id)?.queryKey !== key) throw new Error('Новый root не имеет собственной привязки');
    }
    state.sequence = sequence;
    return;
  }
  const root = state.searchBindings.get(batch.searchId);
  if (root && root.storageId !== batch.searchId) throw new Error('Committed batch использует alias вместо исходного ID группы');
  const query = state.queries[batch.searchId] ??= emptyQuery();
  if (batch.type === 'query') {
    const binding = state.searchBindings.get(batch.searchId);
    if (binding && Object.hasOwn(batch.patch, 'queryKey') && batch.patch.queryKey !== binding.queryKey) throw new Error('Batch изменяет привязанный source/URL');
    if (batch.patch.queryKey !== null && batch.patch.queryKey !== undefined
      && [...state.searchBindings.values()].some(value => value.queryKey === batch.patch.queryKey && value.storageId !== batch.searchId)) {
      throw new Error('Batch создаёт отдельный root уже привязанной группы');
    }
    Object.assign(query, batch.patch);
    for (const gap of batch.gaps ?? []) applyGap(state, gap);
  } else {
    let membership = state.searchRecords.get(batch.searchId);
    if (!membership) state.searchRecords.set(batch.searchId, membership = new Map());
    let knownPrices = state.knownPrices.get(batch.searchId);
    if (!knownPrices) state.knownPrices.set(batch.searchId, knownPrices = new Map());
    for (const record of batch.records) {
      const key = identity(record);
      const current = state.records.get(key);
      if (!current || Date.parse(record.observedAt) > Date.parse(current.observedAt)) state.records.set(key, record);
      const previous = membership.get(key);
      if (!previous || Date.parse(record.observedAt) > Date.parse(previous.observedAt)) {
        membership.set(key, record);
        if (record.priceMinor !== null) knownPrices.set(key, record.priceMinor);
      }
    }
    query.resumeCursor = batch.nextCursor;
    query.activeRunId = batch.runId;
    state.pages.add(pageKey(batch.searchId, batch.runId, batch.cursor));
    state.events.push(...batch.events);
  }
  state.sequence = sequence;
}

function encodeEnvelope(sequence: number, payload: Batch | Anchor | SnapshotPayload): string {
  const data = { version: 1 as const, sequence, payload };
  return JSON.stringify({ ...data, checksum: hash(JSON.stringify(data)) }) + '\n';
}

function decodeEnvelope(text: string): { version: 1; sequence: number; payload: unknown; checksum: string } {
  const value: unknown = JSON.parse(text);
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0
    || typeof value.checksum !== 'string'
    || value.checksum !== hash(JSON.stringify({ version: value.version, sequence: value.sequence, payload: value.payload }))) {
    throw new Error('Нарушена последовательность или контрольная сумма');
  }
  return value as { version: 1; sequence: number; payload: unknown; checksum: string };
}

function snapshotState(sequence: number, payload: unknown): State {
  if (!object(payload) || !object(payload.queries) || !Array.isArray(payload.records) || !Array.isArray(payload.searchRecords)
    || !Array.isArray(payload.knownPrices) || !Array.isArray(payload.pages) || !Array.isArray(payload.events)) {
    throw new Error('Некорректная структура снимка');
  }
  const state = emptyState();
  state.sequence = sequence;
  const membershipIds = new Set<string>();
  for (const [searchId, query] of Object.entries(payload.queries)) {
    if (!searchId || !object(query) || Object.keys(emptyQuery()).some(key => !Object.hasOwn(query, key))) throw new Error('Неполное состояние поиска в снимке');
    assertPatch(query);
    state.queries[searchId] = query as unknown as QueryState;
  }
  if (payload.searchBindings !== undefined) {
    state.searchBindings = parseBindings(payload.searchBindings);
    assertSearchBindings(state.queries, state.searchBindings);
  }
  if (payload.sources !== undefined) state.sources = parseSources(payload.sources);
  if (payload.gapsInitialized !== undefined && typeof payload.gapsInitialized !== 'boolean') throw new Error('Некорректный признак миграции истории пропусков');
  if (payload.gapsInitialized === true && !Array.isArray(payload.gaps)) throw new Error('В снимке отсутствует инициализированная история пропусков');
  state.gapsInitialized = payload.gapsInitialized === true;
  if (payload.gaps !== undefined) {
    assertGaps(payload.gaps, sequence);
    for (const gap of payload.gaps) applyGap(state, gap);
  }
  for (const record of payload.records) {
    assertListing(record);
    const key = identity(record);
    if (state.records.has(key)) throw new Error('Повтор объявления в снимке');
    state.records.set(key, record);
  }
  for (const entry of payload.searchRecords) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !state.queries[entry[0]]
      || !Array.isArray(entry[1]) || state.searchRecords.has(entry[0])) throw new Error('Некорректная принадлежность объявлений поиску');
    const membership = new Map<string, Listing>();
    for (const record of entry[1]) {
      assertListing(record);
      const key = identity(record);
      const global = state.records.get(key);
      if (membership.has(key) || !global || Date.parse(global.observedAt) < Date.parse(record.observedAt)) throw new Error('Некорректная запись поиска в снимке');
      membership.set(key, record);
      membershipIds.add(key);
    }
    state.searchRecords.set(entry[0], membership);
  }
  if (membershipIds.size !== state.records.size) throw new Error('В снимке есть объявления без принадлежности поиску');
  if (payload.detailsStates !== undefined) {
    if (!Array.isArray(payload.detailsStates)) throw new Error('Некорректный реестр карточек в снимке');
    for (const details of payload.detailsStates) {
      assertDetailsState(details, assertListing);
      const key = identity(details);
      if (!state.records.has(key) || state.detailsStates.has(key)) throw new Error('Повтор или неизвестное объявление карточки в снимке');
      state.detailsStates.set(key, details);
    }
  }
  for (const entry of payload.knownPrices) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !state.searchRecords.has(entry[0])
      || !Array.isArray(entry[1]) || state.knownPrices.has(entry[0])) throw new Error('Некорректные подтверждённые цены поиска');
    const prices = new Map<string, number>();
    for (const pair of entry[1]) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !state.searchRecords.get(entry[0])!.has(pair[0])
        || prices.has(pair[0]) || typeof pair[1] !== 'number' || !Number.isSafeInteger(pair[1]) || pair[1] < 0) throw new Error('Некорректная подтверждённая цена');
      prices.set(pair[0], pair[1]);
    }
    for (const [key, record] of state.searchRecords.get(entry[0])!) {
      if (record.priceMinor !== null && prices.get(key) !== record.priceMinor) throw new Error('Подтверждённая цена не соответствует записи поиска');
    }
    state.knownPrices.set(entry[0], prices);
  }
  if (state.searchRecords.size !== state.knownPrices.size) throw new Error('В снимке пропущены подтверждённые цены поиска');
  const pageSearches = new Set<string>();
  for (const key of payload.pages) {
    if (typeof key !== 'string' || state.pages.has(key)) throw new Error('Повтор или некорректный ключ страницы снимка');
    const page: unknown = JSON.parse(key);
    if (!Array.isArray(page) || page.length !== 3 || typeof page[0] !== 'string' || !state.searchRecords.has(page[0])
      || typeof page[1] !== 'string' || !page[1] || !nullableString(page[2]) || JSON.stringify(page) !== key) throw new Error('Некорректный ключ страницы снимка');
    state.pages.add(key);
    pageSearches.add(page[0]);
  }
  if (pageSearches.size !== state.searchRecords.size) throw new Error('В снимке пропущены ключи обработанных страниц');
  const eventIds = new Set<string>();
  let lastSequence = 0;
  for (const event of payload.events) {
    if (!object(event) || !Number.isSafeInteger(event.sequence) || (event.sequence as number) < 1
      || (event.sequence as number) > sequence || (event.sequence as number) < lastSequence) throw new Error('Некорректная последовательность события снимка');
    assertEvent(event, event.sequence as number);
    if (!state.queries[event.searchId] || !state.searchRecords.get(event.searchId)?.has(identity(event))
      || eventIds.has(event.eventId)) throw new Error('Повтор или неизвестное событие снимка');
    eventIds.add(event.eventId);
    state.events.push(event);
    lastSequence = event.sequence;
  }
  return state;
}

function parseBindings(value: unknown): Map<string, SearchBinding> {
  if (!Array.isArray(value)) throw new Error('Некорректный реестр привязок поиска');
  const bindings = new Map<string, SearchBinding>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0] || bindings.has(entry[0])
      || !object(entry[1]) || typeof entry[1].storageId !== 'string' || !entry[1].storageId
      || Object.keys(entry[1]).some(key => !['queryKey', 'storageId'].includes(key))) throw new Error('Некорректная или повторная привязка поиска');
    assertQueryKey(entry[1].queryKey);
    bindings.set(entry[0], { queryKey: entry[1].queryKey, storageId: entry[1].storageId });
  }
  return bindings;
}

async function readSnapshot(directory: string): Promise<{ state: State; checksum: string | null }> {
  let text: string;
  try { text = await readFile(join(directory, SNAPSHOT), 'utf8'); } catch (error) {
    if (errorCode(error) === 'ENOENT') return { state: emptyState(), checksum: null };
    throw error;
  }
  try {
    const envelope = decodeEnvelope(text);
    return { state: snapshotState(envelope.sequence, envelope.payload), checksum: envelope.checksum };
  } catch (error) { throw new Error('Повреждён снимок файлового состояния. Запись остановлена.', { cause: error }); }
}

class PairChanged extends Error {}

async function replaceCommittedFile(temporary: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, destination); return; } catch (error) {
      // Windows can briefly deny replacement while a status/export reader (or
      // filesystem scanner) holds the destination. Both committed files stay
      // intact during this bounded retry; persistent failure remains fatal.
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(errorCode(error) ?? '') || attempt >= 20) throw error;
      await new Promise<void>(done => setTimeout(done, Math.min(10 * (attempt + 1), 100)));
    }
  }
}

async function replay(directory: string): Promise<{ state: State; committedBytes: number; totalBytes: number; snapshotSequence: number }> {
  // A reader may load the old snapshot immediately before the writer replaces
  // the journal. Its newer anchor forces a fresh read of both files.
  for (let attempt = 0; attempt < 8; attempt++) {
    try { return await replayPair(directory); } catch (error) {
      if (!(error instanceof PairChanged)) throw error;
    }
  }
  throw new Error('Не удалось прочитать согласованную пару снимка и журнала; проверьте наличие снимка или повторите чтение');
}

async function replayPair(directory: string): Promise<{ state: State; committedBytes: number; totalBytes: number; snapshotSequence: number }> {
  const snapshot = await readSnapshot(directory);
  const state = snapshot.state;
  const snapshotSequence = state.sequence;
  let buffer: Buffer;
  try { buffer = await readFile(join(directory, JOURNAL)); } catch (error) {
    if (errorCode(error) === 'ENOENT' && snapshot.checksum === null) return { state, committedBytes: 0, totalBytes: 0, snapshotSequence };
    if (errorCode(error) === 'ENOENT') throw new Error('Журнал отсутствует при существующем снимке');
    throw error;
  }
  let offset = 0;
  let lineNumber = 0;
  let journalSequence = 0;
  const journalPages = new Set<string>();
  while (offset < buffer.length) {
    const newline = buffer.indexOf(10, offset);
    if (newline < 0) break; // Незавершённый хвост никогда не считается commit.
    lineNumber++;
    try {
      const envelope = decodeEnvelope(buffer.subarray(offset, newline).toString('utf8'));
      if (object(envelope.payload) && envelope.payload.type === 'anchor') {
        if (lineNumber !== 1 || typeof envelope.payload.snapshotChecksum !== 'string') throw new Error('Некорректный anchor журнала');
        if (envelope.sequence > snapshotSequence || snapshot.checksum === null) throw new PairChanged();
        if (envelope.sequence === snapshotSequence && envelope.payload.snapshotChecksum !== snapshot.checksum) throw new Error('Anchor не соответствует снимку');
        journalSequence = envelope.sequence;
      } else {
        if (envelope.sequence !== journalSequence + 1) throw new Error('Нарушена последовательность журнала');
        assertBatch(envelope.payload, envelope.sequence);
        if (envelope.payload.type === 'page') {
          const key = pageKey(envelope.payload.searchId, envelope.payload.runId, envelope.payload.cursor);
          if (journalPages.has(key) || envelope.sequence > snapshotSequence && state.pages.has(key)) throw new Error('Повтор committed страницы в журнале');
          journalPages.add(key);
        }
        if (envelope.sequence > snapshotSequence) applyBatch(state, envelope.payload, envelope.sequence);
        journalSequence = envelope.sequence;
      }
    } catch (error) {
      if (error instanceof PairChanged) throw error;
      throw new Error(`Повреждён committed журнал, строка ${lineNumber}. Запись остановлена.`, { cause: error });
    }
    offset = newline + 1;
  }
  if (snapshot.checksum !== null && journalSequence < snapshotSequence) {
    throw new Error('Повреждён committed журнал: он не подтверждает последовательность снимка');
  }
  return { state, committedBytes: offset, totalBytes: buffer.length, snapshotSequence };
}

type LockOwner = { pid: number; token: string };
type WriterLock = { directory: string; ownerName: string };
async function releaseLock(lock: WriterLock): Promise<void> {
  // Удаляется только уникальный owner данного экземпляра, не lock преемника.
  try { await unlink(join(lock.directory, lock.ownerName)); } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  try { await rmdir(lock.directory); } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '')) throw error;
  }
}
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    // EPERM и любой неопределённый результат не разрешают удаление lock.
    return true;
  }
}

async function acquireLock(dataDir: string): Promise<WriterLock> {
  const token = randomUUID();
  const lockDirectory = join(dataDir, LOCK);
  const candidate = join(dataDir, `.writer-${token}`);
  const ownerName = `owner-${token}.json`;
  await mkdir(candidate);
  let published = false;
  try {
    const ownerFile = await open(join(candidate, ownerName), 'wx');
    try { await ownerFile.writeFile(JSON.stringify({ pid: process.pid, token })); await ownerFile.sync(); } finally { await ownerFile.close(); }
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        // Публикуется готовый непустой каталог: нет окна mkdir → owner.
        await rename(candidate, lockDirectory);
        published = true;
        return { directory: lockDirectory, ownerName };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(errorCode(error) ?? '')) throw error;
      }
      let names: string[];
      try { names = await readdir(lockDirectory); } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
      if (names.length === 0) {
        // Уже удалён owner при close/recovery; rmdir не удалит новый непустой lock.
        try { await rmdir(lockDirectory); } catch (error) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '')) throw error;
        }
        continue;
      }
      if (names.length !== 1 || !/^owner-[0-9a-f-]+\.json$/.test(names[0]!)) throw new Error(`Неизвестная блокировка каталога данных: ${lockDirectory}`);
      const staleOwnerName = names[0]!;
      let owner: LockOwner;
      try { owner = JSON.parse(await readFile(join(lockDirectory, staleOwnerName), 'utf8')) as LockOwner; } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw new Error('Повреждён writer lock; автоматическое удаление запрещено', { cause: error });
      }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || `owner-${owner.token}.json` !== staleOwnerName) throw new Error('Некорректный владелец writer lock');
      if (isAlive(owner.pid)) throw new Error(`Каталог данных уже занят процессом ${owner.pid}`);
      try { await unlink(join(lockDirectory, staleOwnerName)); } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
      try { await rmdir(lockDirectory); } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '')) throw error;
      }
    }
    throw new Error('Не удалось получить writer lock после конкурентного восстановления');
  } finally {
    if (!published) {
      await unlink(join(candidate, ownerName)).catch(error => { if (errorCode(error) !== 'ENOENT') throw error; });
      await rmdir(candidate).catch(error => { if (errorCode(error) !== 'ENOENT') throw error; });
    }
  }
}

function detailsChanged(previous: Listing, latest: Listing): boolean {
  // URL сохраняется полностью, но tracking/context не является изменением объявления.
  // Currency может стать unknown вместе с ценой при неполном распознавании.
  // Для nullable-полей сравниваются только два подтверждённых наблюдения.
  // Через unknown-промежуток изменение не устанавливаем; фактический DTO сохраняется целиком.
  const knownChanged = (before: string | number | null, after: string | number | null) =>
    before !== null && after !== null && before !== after;
  return previous.title !== latest.title
    || knownChanged(previous.publishedAt, latest.publishedAt)
    || knownChanged(previous.vehicle.make, latest.vehicle.make)
    || knownChanged(previous.vehicle.model, latest.vehicle.model)
    || knownChanged(previous.vehicle.year, latest.vehicle.year)
    || knownChanged(previous.vehicle.mileageKm, latest.vehicle.mileageKm);
}

export interface FileStoreOptions {
  compactAfterBatches?: number;
  compactAfterBytes?: number;
}

export class FileStore {
  #state: State;
  #journal: FileHandle;
  #lock: WriterLock;
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #poisoned: unknown = null;
  #directory: string;
  #journalBytes: number;
  #snapshotSequence: number;
  #compactAfterBatches: number;
  #compactAfterBytes: number;

  private constructor(state: State, journal: FileHandle, lock: WriterLock, directory: string,
    journalBytes: number, snapshotSequence: number, options: Required<FileStoreOptions>) {
    this.#state = state;
    this.#journal = journal;
    this.#lock = lock;
    this.#directory = directory;
    this.#journalBytes = journalBytes;
    this.#snapshotSequence = snapshotSequence;
    this.#compactAfterBatches = options.compactAfterBatches;
    this.#compactAfterBytes = options.compactAfterBytes;
  }

  static async open(dataDir: string, options: FileStoreOptions = {}): Promise<FileStore> {
    const thresholds = { compactAfterBatches: options.compactAfterBatches ?? 1000, compactAfterBytes: options.compactAfterBytes ?? 8 * 1024 * 1024 };
    if (!Object.values(thresholds).every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Неверные пороги сжатия файлового состояния');
    const directory = resolve(dataDir);
    await mkdir(directory, { recursive: true });
    const lock = await acquireLock(directory);
    let journal: FileHandle | undefined;
    try {
      const path = join(directory, JOURNAL);
      const { state, committedBytes, totalBytes, snapshotSequence } = await replay(directory);
      if (committedBytes !== totalBytes) {
        // Windows append-handle не разрешает ftruncate: восстановление отдельным r+.
        const recovery = await open(path, 'r+');
        try { await recovery.truncate(committedBytes); await recovery.sync(); } finally { await recovery.close(); }
      }
      journal = await open(path, 'a+');
      return new FileStore(state, journal, lock, directory, committedBytes, snapshotSequence, thresholds);
    } catch (error) {
      await journal?.close();
      await releaseLock(lock);
      throw error;
    }
  }

  /** A search selection uses persisted membership; reading never acquires a writer lock. */
  static async inspect(dataDir: string, searchId?: string): Promise<{ sequence: number; queries: Record<string, QueryState>; records: Listing[]; events: MonitorEvent[]; searchBindings: Record<string, SearchBinding>; sources: Record<string, SourceState>; gaps: CoverageGap[]; detailsStates: DetailsState[] }> {
    if (searchId !== undefined && (typeof searchId !== 'string' || !searchId.trim())) throw new Error('searchId: ожидается непустой ID поиска');
    const { state } = await replay(resolve(dataDir));
    const storageId = searchId === undefined ? undefined : state.searchBindings.get(searchId)?.storageId ?? searchId;
    if (storageId !== undefined && !Object.hasOwn(state.queries, storageId)) throw new Error(`Неизвестный поиск: ${searchId}`);
    const raw = storageId === undefined ? [...state.records.values()] : [...state.searchRecords.get(storageId)?.values() ?? []];
    const records = raw.map(record => overlayVehicle(record, state.detailsStates.get(identity(record))));
    const selected = new Set(raw.map(identity));
    const detailsStates = [...state.detailsStates].filter(([key]) => selected.has(key)).map(([, details]) => details);
    const events = storageId === undefined ? state.events : state.events.filter(event => event.searchId === storageId);
    const gaps = [...state.gaps.values()].filter(gap => storageId === undefined || gap.searchId === storageId);
    return structuredClone({ sequence: state.sequence, queries: state.queries, records, events,
      searchBindings: Object.fromEntries(state.searchBindings), sources: Object.fromEntries(state.sources), gaps, detailsStates });
  }

  getDetailsState(source: string, externalId: string): DetailsState | null {
    return structuredClone(this.#state.detailsStates.get(identity({ source, externalId })) ?? null);
  }

  /** All saved members participate; untouched identities precede the oldest eligible attempts. */
  detailsCandidates(searchId: string, limit: number, now: number): Listing[] {
    if (typeof searchId !== 'string' || !searchId.trim()
      || !Number.isSafeInteger(limit) || limit < 0 || !Number.isFinite(now)) throw new Error('Некорректный отбор карточек');
    const membership = this.#state.searchRecords.get(this.#storageId(searchId));
    if (!limit) return [];
    const untouched: Listing[] = [];
    const attempted: Array<{ record: Listing; attemptedAt: number }> = [];
    for (const record of membership?.values() ?? []) {
      const details = this.#state.detailsStates.get(identity(record));
      if (!Object.values(record.vehicle).some(value => value === null)
        || !detailsEligible(details, record.title, now)) continue;
      if (!details) untouched.push(record);
      else attempted.push({ record, attemptedAt: Date.parse(details.attemptedAt) });
    }
    // Stable sort keeps membership order when two persisted attempts share a timestamp.
    attempted.sort((left, right) => left.attemptedAt - right.attemptedAt);
    return structuredClone([...untouched, ...attempted.map(value => value.record)].slice(0, limit));
  }

  beginDetailsAttempt(searchId: string, listing: Listing, attemptedAt: string, retryAt: string): Promise<string | null> {
    const input = structuredClone(listing);
    return this.#enqueue(async () => {
      assertListing(input);
      if (!searchId || !Number.isFinite(Date.parse(attemptedAt)) || !Number.isFinite(Date.parse(retryAt))
        || Date.parse(retryAt) <= Date.parse(attemptedAt)) throw new Error('Некорректное время попытки карточки');
      const record = this.#state.searchRecords.get(this.#storageId(searchId))?.get(identity(input));
      if (!record || record.title !== input.title || record.observedAt !== input.observedAt
        || !Object.values(record.vehicle).some(value => value === null)) return null;
      const previous = this.#state.detailsStates.get(identity(record));
      if (!detailsEligible(previous, record.title, Date.parse(attemptedAt))) return null;
      const details: DetailsState = { source: record.source, externalId: record.externalId,
        catalogTitle: record.title, attemptId: randomUUID(), attemptedAt, retryAt, outcome: 'pending', record: previous?.record ?? null };
      await this.#append({ type: 'details_state', state: details });
      return details.attemptId;
    });
  }

  finishDetailsAttempt(source: string, externalId: string, attemptId: string, result: CollectDetailsResult, retryAt: string | null): Promise<void> {
    const input = structuredClone(result);
    return this.#enqueue(async () => {
      const key = identity({ source, externalId });
      const previous = this.#state.detailsStates.get(key);
      if (!previous || previous.attemptId !== attemptId) throw new Error('Результат карточки не соответствует сохранённой попытке');
      if (input.record !== null) {
        assertListing(input.record);
        if (input.record.source !== source || input.record.externalId !== externalId) throw new Error('Результат карточки принадлежит другой identity');
      }
      if (input.outcome === 'success' && input.record === null) throw new Error('Успех карточки без записи');
      const details: DetailsState = { ...previous, outcome: input.outcome, retryAt,
        record: input.outcome === 'success' ? input.record : previous.record };
      assertDetailsState(details, assertListing);
      // A replayed result for the same completed claim does not create a batch.
      if (previous.outcome !== 'pending') return;
      await this.#append({ type: 'details_state', state: details });
    });
  }

  getSource(source: string): SourceState | null { return structuredClone(this.#state.sources.get(source) ?? null); }

  updateSource(source: string, health: SourceState): Promise<void> {
    const input = structuredClone(health);
    return this.#enqueue(async () => {
      if (typeof source !== 'string' || !source) throw new Error('Пустой ID источника');
      assertSourceState(input);
      await this.#append({ type: 'source_states', sources: [[source, input]] });
    });
  }

  /** Bootstrap old state once; an existing source record always wins over query counters. */
  ensureSources(searches: SearchRegistration[]): Promise<void> {
    const input = structuredClone(searches);
    return this.#enqueue(async () => {
      const bySource = new Map<string, Set<string>>();
      const add = (source: string, id?: string) => {
        const ids = bySource.get(source) ?? new Set<string>();
        if (id) ids.add(id);
        bySource.set(source, ids);
      };
      for (const [id, query] of Object.entries(this.#state.queries)) {
        if (query.queryKey !== null) {
          assertQueryKey(query.queryKey);
          add((JSON.parse(query.queryKey) as [string, string])[0], id);
        }
      }
      for (const search of input) {
        if (typeof search.source !== 'string' || !search.source || typeof search.id !== 'string' || !search.id) throw new Error('Некорректная регистрация источника');
        add(search.source, this.#storageId(search.id));
      }
      const sources: Array<[string, SourceState]> = [];
      const latest = (values: Array<string | null>) => {
        const times = values.map(value => Date.parse(value ?? '')).filter(Number.isFinite);
        return times.length ? new Date(Math.max(...times)).toISOString() : null;
      };
      for (const [source, ids] of bySource) {
        if (this.#state.sources.has(source)) continue;
        const queries = [...ids].map(id => this.#state.queries[id]).filter((query): query is QueryState => query !== undefined);
        const failureCount = queries.reduce((count, query) => Math.max(count, query.failureCount), 0);
        sources.push([source, { ...emptySource(), failureCount,
          blockedUntil: latest(queries.filter(query => query.failureCount > 0).map(query => query.nextRunAt)),
          lastAttempt: latest(queries.map(query => query.lastAttempt)), lastSuccess: latest(queries.map(query => query.lastSuccess)),
          ...(failureCount > 0 ? { legacyEstimate: true } : {}),
        }]);
      }
      const legacyGaps: CoverageGap[] = [];
      if (!this.#state.gapsInitialized) for (const [searchId, query] of Object.entries(this.#state.queries)) {
        const old = query.coverage.lastGap;
        if (!object(old)) continue;
        const gap: GapInput = { runId: `legacy:${hash(JSON.stringify([searchId, old.since, old.until, old.reason]))}`,
          since: old.since as string | null, until: old.until as string, reason: old.reason as string };
        // Free-form old coverage may not contain a usable period. Keep it in
        // coverage but do not invent a history record from unknown fields.
        try { assertGapInput(gap); } catch { continue; }
        if ([...this.#state.gaps.values()].some(saved => saved.searchId === searchId && saved.reason === gap.reason
          && saved.since === gap.since && Date.parse(saved.until) >= Date.parse(gap.until))) continue;
        legacyGaps.push({ ...gap, searchId, gapId: gapIdentity(searchId, gap.runId, gap.reason), sequence: this.#state.sequence + 1 });
      }
      if (sources.length || !this.#state.gapsInitialized) await this.#append({ type: 'source_states', sources,
        ...(!this.#state.gapsInitialized ? { initializeGaps: true, legacyGaps } : {}),
      });
    });
  }

  getQuery(searchId: string): QueryState {
    return structuredClone(this.#state.queries[this.#storageId(searchId)] ?? emptyQuery());
  }

  #storageId(searchId: string): string { return this.#state.searchBindings.get(searchId)?.storageId ?? searchId; }

  bindSearches(searches: SearchRegistration[]): Promise<Record<string, string>> {
    const input = structuredClone(searches);
    return this.#enqueue(async () => {
      const plan = planSearchBindings(this.#state.queries, this.#state.searchBindings, input);
      if (plan.queries.length || plan.bindings.length) await this.#append({ type: 'search_bindings', queries: plan.queries, bindings: plan.bindings });
      return structuredClone(plan.resolved);
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closePromise) return Promise.reject(new Error('Файловое состояние закрывается'));
    const result = this.#queue.then(() => {
      if (this.#closed) throw new Error('Файловое состояние закрыто');
      if (this.#poisoned) throw new Error('Запись файлового состояния остановлена после ошибки диска; необходим перезапуск', { cause: this.#poisoned });
      return operation();
    });
    this.#queue = result.then(() => {}, () => {});
    return result;
  }

  async #append(batch: Batch): Promise<void> {
    const sequence = this.#state.sequence + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error('Исчерпан безопасный sequence файлового состояния');
    const line = encodeEnvelope(sequence, batch);
    try {
      await this.#journal.writeFile(line, 'utf8');
      await this.#journal.sync();
    } catch (error) {
      this.#poisoned = error;
      throw new Error('Не удалось устойчиво сохранить batch; дальнейшая запись остановлена', { cause: error });
    }
    applyBatch(this.#state, batch, sequence);
    this.#journalBytes += Buffer.byteLength(line);
    if (sequence - this.#snapshotSequence >= this.#compactAfterBatches || this.#journalBytes >= this.#compactAfterBytes) await this.#compact();
  }

  async #compact(): Promise<void> {
    const token = randomUUID();
    const snapshotTemp = join(this.#directory, `.snapshot-${token}.tmp`);
    const journalTemp = join(this.#directory, `.journal-${token}.tmp`);
    const payload: SnapshotPayload = {
      queries: this.#state.queries, records: [...this.#state.records.values()],
      searchRecords: [...this.#state.searchRecords].map(([key, records]) => [key, [...records.values()]]),
      knownPrices: [...this.#state.knownPrices].map(([key, prices]) => [key, [...prices]]),
      pages: [...this.#state.pages], events: this.#state.events,
      searchBindings: [...this.#state.searchBindings],
      sources: [...this.#state.sources], gaps: [...this.#state.gaps.values()], gapsInitialized: this.#state.gapsInitialized,
      detailsStates: [...this.#state.detailsStates.values()],
    };
    try {
      const snapshotText = encodeEnvelope(this.#state.sequence, payload);
      const snapshot = decodeEnvelope(snapshotText);
      // Validate the full round-trip before replacing any committed file.
      snapshotState(snapshot.sequence, snapshot.payload);
      const durableTemp = async (path: string, text: string) => {
        const file = await open(path, 'wx');
        try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
      };
      await durableTemp(snapshotTemp, snapshotText);
      await replaceCommittedFile(snapshotTemp, join(this.#directory, SNAPSHOT));
      const anchor = encodeEnvelope(snapshot.sequence, { type: 'anchor', snapshotChecksum: snapshot.checksum });
      await durableTemp(journalTemp, anchor);
      // Close all temp/old handles before Windows rename. Every failure leaves
      // either the old journal or a complete new anchored journal on disk.
      await this.#journal.close();
      await replaceCommittedFile(journalTemp, join(this.#directory, JOURNAL));
      this.#journal = await open(join(this.#directory, JOURNAL), 'a+');
      this.#snapshotSequence = snapshot.sequence;
      this.#journalBytes = Buffer.byteLength(anchor);
    } catch (error) {
      this.#poisoned = error;
      throw new Error('Не удалось устойчиво сжать файловое состояние; дальнейшая запись остановлена', { cause: error });
    } finally {
      // Unique temporary files are never inputs to recovery. Cleanup is best
      // effort; committed snapshot/journal are never removed on an error.
      await Promise.all([snapshotTemp, journalTemp].map(path => unlink(path).catch(() => {})));
    }
  }

  compact(): Promise<void> {
    return this.#enqueue(() => this.#compact());
  }

  commitPage(searchId: string, runId: string, cursor: string | null, records: Listing[], nextCursor: string | null): Promise<MonitorEvent[]> {
    // Copy before queuing, so caller mutation cannot change the pending durable batch.
    const input = structuredClone(records);
    return this.#enqueue(async () => {
      if (!searchId || !runId || !nullableString(cursor) || !nullableString(nextCursor)) throw new Error('Некорректный идентификатор page commit');
      searchId = this.#storageId(searchId);
      input.forEach(assertListing);
      if (this.#state.pages.has(pageKey(searchId, runId, cursor))) return [];
      const query = this.getQuery(searchId);
      const membership = new Map(this.#state.searchRecords.get(searchId));
      const knownPrices = this.#state.knownPrices.get(searchId);
      const global = new Map(this.#state.records);
      const accepted: Listing[] = [];
      const events: MonitorEvent[] = [];
      const unique = new Map<string, Listing>();
      for (const record of input) {
        const previous = unique.get(identity(record));
        if (!previous || Date.parse(record.observedAt) > Date.parse(previous.observedAt)) unique.set(identity(record), record);
      }
      for (const incoming of unique.values()) {
        const key = identity(incoming);
        const current = global.get(key);
        const previous = membership.get(key);
        const latest = current && Date.parse(current.observedAt) >= Date.parse(incoming.observedAt) ? current : incoming;
        const previousKnownPrice = knownPrices?.get(key);
        // A stale page can establish baseline membership, but cannot revert a known observation.
        if (previous && Date.parse(incoming.observedAt) <= Date.parse(previous.observedAt)) continue;
        if (previous && current && Date.parse(incoming.observedAt) < Date.parse(current.observedAt)) continue;
        accepted.push(latest);
        membership.set(key, latest);
        if (!current || Date.parse(latest.observedAt) > Date.parse(current.observedAt)) global.set(key, latest);
        if (!query.baselineComplete) continue;
        const addEvent = (type: MonitorEvent['type']) => events.push({
          eventId: hash(JSON.stringify([searchId, runId, cursor, key, type])),
          sequence: this.#state.sequence + 1, type, searchId, source: latest.source, externalId: latest.externalId,
          observedAt: latest.observedAt, priceMinor: latest.priceMinor,
          ...(type === 'price_changed' ? { previousPriceMinor: previousKnownPrice! } : {}),
        });
        if (!previous) addEvent('discovered');
        else {
          // null сообщает неизвестную цену; сравниваются только две подтверждённые цены.
          if (latest.priceMinor !== null && previousKnownPrice !== undefined && previousKnownPrice !== latest.priceMinor) addEvent('price_changed');
          if (detailsChanged(previous, latest)) addEvent('details_changed');
        }
      }
      await this.#append({ type: 'page', searchId, runId, cursor, nextCursor, records: accepted, events });
      return structuredClone(events);
    });
  }

  updateQuery(searchId: string, patch: Partial<QueryState>, gaps?: GapInput | GapInput[]): Promise<void> {
    const copy = structuredClone(patch);
    const gapInputs = structuredClone(gaps === undefined ? [] : Array.isArray(gaps) ? gaps : [gaps]);
    return this.#enqueue(async () => {
      if (!searchId) throw new Error('Пустой searchId');
      searchId = this.#storageId(searchId);
      assertPatch(copy);
      const binding = this.#state.searchBindings.get(searchId);
      if (binding && Object.hasOwn(copy, 'queryKey') && copy.queryKey !== binding.queryKey) throw new Error('Поиск изменил привязанный source/URL; создайте новый id');
      if (copy.queryKey !== null && copy.queryKey !== undefined
        && [...this.#state.searchBindings.values()].some(value => value.queryKey === copy.queryKey && value.storageId !== searchId)) {
        throw new Error('Нельзя создать отдельный root уже привязанной группы');
      }
      const updates = new Map<string, CoverageGap>();
      for (const gap of gapInputs) {
        assertGapInput(gap);
        const gapId = gapIdentity(searchId, gap.runId, gap.reason);
        const previous = updates.get(gapId) ?? this.#state.gaps.get(gapId);
        const since = previous ? previous.since === null || gap.since === null ? null
          : Date.parse(previous.since) < Date.parse(gap.since) ? previous.since : gap.since : gap.since;
        updates.set(gapId, { ...gap, since, until: previous && Date.parse(previous.until) > Date.parse(gap.until) ? previous.until : gap.until,
          gapId, searchId, sequence: this.#state.sequence + 1 });
      }
      await this.#append({ type: 'query', searchId, patch: copy, ...(updates.size ? { gaps: [...updates.values()] } : {}) });
    });
  }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      await this.#queue;
      this.#closed = true;
      try { await this.#journal.close(); } finally { await releaseLock(this.#lock); }
    })();
    return this.#closePromise;
  }
}
