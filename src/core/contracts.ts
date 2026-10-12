export type Outcome = 'success' | 'empty' | 'partial' | 'blocked' | 'auth_required' | 'rate_limited' | 'schema_changed' | 'transport_error' | 'timeout';

export interface Listing {
  source: string;
  externalId: string;
  url: string;
  title: string;
  priceMinor: number | null;
  currency: string | null;
  observedAt: string;
  publishedAt: string | null;
  vehicle: { make: string | null; model: string | null; year: number | null; mileageKm: number | null };
  provenance: Record<string, string>;
  enrichment?: { observedAt: string; fields: Array<keyof Listing['vehicle']> };
}

export interface CollectPageResult {
  outcome: Outcome;
  records: Listing[];
  nextCursor: string | null;
  endReached: boolean;
  diagnostics: Record<string, unknown>;
  retryAfterSeconds: number | null;
}

export interface CollectDetailsResult {
  outcome: Outcome;
  record: Listing | null;
  diagnostics: Record<string, unknown>;
  retryAfterSeconds: number | null;
}

export interface SourceAdapter {
  id: string;
  capabilities(): { pagination: string; sort: string[]; publishedAt: boolean; details: boolean };
  collectPage(query: { url: string; requestTimeoutSeconds: number }, cursor: string | null, signal: AbortSignal): Promise<CollectPageResult>;
  getDetails?(externalId: string, url: string, signal: AbortSignal, requestTimeoutSeconds?: number): Promise<CollectDetailsResult>;
}

export interface Search {
  id: string;
  source: string;
  url: string;
  enabled: boolean;
  intervalSeconds: number;
  overlapPages: number;
  sweepIntervalSeconds: number;
  maxPagesPerSweep: number;
  requestTimeoutSeconds: number;
  maxCycleSeconds: number;
  maxDetailsPerCycle?: number;
}
