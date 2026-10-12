import type { Listing } from '../../core/contracts.ts';
import { asObject } from './extract.ts';

interface TitleVehicle { year: number | null; mileageKm: number | null }
interface VehicleEvidence { vehicle: Listing['vehicle']; provenance: Record<string, string> }
interface GaVehicle { make: string; model: string; year: number; mileageKm: number; index: number }

const numberText = '(?:0|[1-9]\\d*|[1-9]\\d{0,2}(?:[ \\u00a0\\u202f]\\d{3})+)';
const mileagePattern = new RegExp(`^(${numberText})[ \\u00a0\\u202f]км$`, 'u');
// Both forms were observed in Avito titles. Other status/approximation text
// cannot be removed to manufacture a matching year or mileage.
const titlePattern = new RegExp(`^[^\\r\\n]+, (\\d{4})(?:, битый)?, (${numberText})[ \\u00a0\\u202f]км$`, 'u');

function yearNumber(value: unknown, observedAt: string): number | null {
  if (typeof value !== 'string' || value.length !== 4 || !/^\d{4}$/u.test(value)) return null;
  const observationYear = new Date(observedAt).getUTCFullYear();
  const year = Number(value);
  return Number.isSafeInteger(observationYear) && year >= 1886 && year <= observationYear + 1 ? year : null;
}

function mileageNumber(value: unknown): number | null {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/u.test(value)) return null;
  const match = mileagePattern.exec(value);
  if (!match) return null;
  const number = Number(match[1]!.replace(/[ \u00a0\u202f]/gu, ''));
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function parseAvitoVehicleTitle(title: unknown, observedAt: string): TitleVehicle {
  const unknown = { year: null, mileageKm: null };
  if (typeof title !== 'string' || /[\x00-\x1f\x7f]/u.test(title)) return unknown;
  const match = titlePattern.exec(title.trim());
  if (!match) return unknown;
  const year = yearNumber(match[1], observedAt);
  const mileageKm = mileageNumber(`${match[2]} км`);
  return year !== null && mileageKm !== null ? { year, mileageKm } : unknown;
}

export function avitoTitleVehicle(title: string, observedAt: string, titlePath: string): VehicleEvidence {
  const parsed = parseAvitoVehicleTitle(title, observedAt);
  return {
    vehicle: { make: null, model: null, ...parsed },
    provenance: parsed.year !== null && parsed.mileageKm !== null ? {
      'vehicle.year': `${titlePath} (strict vehicle title suffix)`,
      'vehicle.mileageKm': `${titlePath} (strict vehicle title suffix)`,
    } : {},
  };
}

function name(value: unknown): string | null {
  // Names are accepted only from the observed flat SSR attributes. Their
  // boundaries are then checked against the ID-validated card title.
  return typeof value === 'string' && value.length <= 100 && value === value.trim()
    && /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ()_.&+\-/\u00a0\u202f]*$/u.test(value) ? value : null;
}

function plainSpaces(value: string): string { return value.replace(/[\u00a0\u202f]/gu, ' '); }

function titlePrefixMatches(title: string, candidate: GaVehicle): boolean {
  const text = plainSpaces(title.trim());
  const prefix = `${plainSpaces(candidate.make)} ${plainSpaces(candidate.model)}`;
  if (!text.startsWith(prefix)) return false;
  const boundary = text[prefix.length];
  return boundary === undefined || boundary === ' ' || boundary === ',';
}

export function avitoCardVehicle(title: string, observedAt: string, buyer: Record<string, unknown>, buyerPath: string): VehicleEvidence {
  const fallback = avitoTitleVehicle(title, observedAt, `${buyerPath}.item.title`);
  if (fallback.vehicle.year === null || fallback.vehicle.mileageKm === null || !Array.isArray(buyer.ga)) return fallback;
  const candidates: GaVehicle[] = [];
  for (const [index, value] of buyer.ga.entries()) {
    const entry = asObject(value);
    if (!entry) continue;
    const make = name(entry.brand);
    const model = name(entry.model);
    const year = yearNumber(entry.year, observedAt);
    const mileageKm = mileageNumber(entry.mileage);
    if (make !== null && model !== null && year !== null && mileageKm !== null) {
      candidates.push({ make, model, year, mileageKm, index });
    }
  }
  if (!candidates.length) return fallback;
  // Do not silently select a matching block while hiding a different complete
  // vehicle block. Identical repetitions can be confirmed by the first path.
  const signatures = new Set(candidates.map(value => JSON.stringify([value.make, value.model, value.year, value.mileageKm])));
  const candidate = candidates[0]!;
  if (signatures.size !== 1 || candidate.year !== fallback.vehicle.year
    || candidate.mileageKm !== fallback.vehicle.mileageKm || !titlePrefixMatches(title, candidate)) return fallback;
  const path = `${buyerPath}.ga[${candidate.index}]`;
  return {
    vehicle: { make: candidate.make, model: candidate.model, year: candidate.year, mileageKm: candidate.mileageKm },
    provenance: {
      'vehicle.make': `${path}.brand`, 'vehicle.model': `${path}.model`,
      'vehicle.year': `${path}.year`, 'vehicle.mileageKm': `${path}.mileage`,
    },
  };
}
