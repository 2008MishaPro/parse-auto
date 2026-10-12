import type { Listing, Outcome } from './contracts.ts';

/** One global claim/result per source identity, independent of query checkpoints. */
export interface DetailsState {
  source: string;
  externalId: string;
  catalogTitle: string;
  attemptId: string;
  attemptedAt: string;
  retryAt: string | null;
  outcome: 'pending' | Outcome;
  /** Last successfully parsed card; failures never erase earlier evidence. */
  record: Listing | null;
}

const outcomes = new Set<string>(['pending', 'success', 'empty', 'partial', 'blocked', 'auth_required',
  'rate_limited', 'schema_changed', 'transport_error', 'timeout']);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function assertDetailsState(value: unknown, assertListing: (value: unknown) => asserts value is Listing): asserts value is DetailsState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректное состояние карточки');
  const state = value as Record<string, unknown>;
  if (typeof state.source !== 'string' || !state.source || typeof state.externalId !== 'string' || !state.externalId
    || typeof state.catalogTitle !== 'string' || typeof state.attemptId !== 'string' || !state.attemptId
    || !timestamp(state.attemptedAt) || !(state.retryAt === null || timestamp(state.retryAt))
    || typeof state.outcome !== 'string' || !outcomes.has(state.outcome)
    || !Object.hasOwn(state, 'record') || state.outcome === 'pending' && state.retryAt === null
    || state.retryAt !== null && Date.parse(state.retryAt as string) < Date.parse(state.attemptedAt)) {
    throw new Error('Некорректные поля состояния карточки');
  }
  if (state.record !== null) {
    assertListing(state.record);
    if (state.record.source !== state.source || state.record.externalId !== state.externalId) throw new Error('Карточка принадлежит другой identity');
  }
  if (state.outcome === 'success' && state.record === null) throw new Error('Успех карточки без записи');
}

export function detailsEligible(state: DetailsState | undefined, catalogTitle: string, now: number): boolean {
  if (!state) return true;
  if (state.outcome === 'success' && (state.catalogTitle === catalogTitle || state.record?.title === catalogTitle)) return false;
  // A pending request/cooldown applies to this identity even if another query
  // observes a different title while its first request is still in progress.
  return state.retryAt === null || now >= Date.parse(state.retryAt);
}

/** View only: catalog fields and its comparison/price history remain untouched. */
export function overlayVehicle(catalog: Listing, details: DetailsState | undefined): Listing {
  const card = details?.record;
  if (!card || card.title !== catalog.title) return catalog;
  // Matching text alone does not override two incompatible confirmed values.
  // In that case even the missing make/model cannot safely be borrowed.
  for (const field of ['make', 'model', 'year', 'mileageKm'] as const) {
    if (catalog.vehicle[field] !== null && card.vehicle[field] !== null && catalog.vehicle[field] !== card.vehicle[field]) return catalog;
  }
  const fields: Array<keyof Listing['vehicle']> = [];
  const vehicle = { ...catalog.vehicle };
  const provenance = { ...catalog.provenance };
  for (const field of ['make', 'model', 'year', 'mileageKm'] as const) {
    if (catalog.vehicle[field] !== null || card.vehicle[field] === null) continue;
    // Keep the type-specific assignment explicit rather than widening vehicle.
    if (field === 'make' || field === 'model') vehicle[field] = card.vehicle[field];
    else vehicle[field] = card.vehicle[field];
    const path = `vehicle.${field}`;
    if (card.provenance[path] !== undefined) provenance[path] = card.provenance[path];
    else delete provenance[path];
    fields.push(field);
  }
  if (!fields.length) return catalog;
  return { ...catalog, vehicle, provenance, enrichment: { observedAt: card.observedAt, fields } };
}
