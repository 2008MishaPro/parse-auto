import type { Listing } from './contracts.ts';

const nullableText = (value: unknown) => value === null || typeof value === 'string';
const nullableInteger = (value: unknown) => value === null
  || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));

function validEnrichment(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const enrichment = value as Record<string, unknown>;
  return timestamp(enrichment.observedAt) && Array.isArray(enrichment.fields) && enrichment.fields.length > 0
    && enrichment.fields.every(field => ['make', 'model', 'year', 'mileageKm'].includes(field))
    && new Set(enrichment.fields).size === enrichment.fields.length;
}

export function validListing(record: unknown, source: string): record is Listing {
  if (!record || typeof record !== 'object') return false;
  const r = record as Partial<Listing>;
  let validUrl = false;
  try { validUrl = ['https:', 'http:'].includes(new URL(r.url ?? '').protocol); } catch { /* Invalid DTO is diagnosed by its caller. */ }
  return r.source === source && typeof r.externalId === 'string' && r.externalId.length > 0 && validUrl
    && typeof r.title === 'string' && nullableInteger(r.priceMinor) && nullableText(r.currency)
    && timestamp(r.observedAt) && (r.publishedAt === null || timestamp(r.publishedAt))
    && !!r.vehicle && nullableText(r.vehicle.make) && nullableText(r.vehicle.model)
    && nullableInteger(r.vehicle.year) && nullableInteger(r.vehicle.mileageKm)
    && !!r.provenance && typeof r.provenance === 'object'
    && Object.values(r.provenance).every(value => typeof value === 'string')
    && validEnrichment(r.enrichment);
}
