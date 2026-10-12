import type { CollectDetailsResult, Listing } from '../src/core/contracts.ts';

function knownMatch<T>(left: T | null, right: T | null): boolean | null {
  return left === null || right === null ? null : left === right;
}

function vehicleProvenance(listing: Listing): Record<string, string> {
  return Object.fromEntries(Object.entries(listing.provenance).filter(([field]) => field.startsWith('vehicle.')));
}

// A different observation is a comparison mismatch, not a failed HTTP/parser.
export function verifyAvitoCard(listing: Listing, details: CollectDetailsResult) {
  const fetchSucceeded = details.outcome === 'success' && details.record !== null;
  const card = fetchSucceeded ? details.record : null;
  const sourceMatches = card ? card.source === listing.source : null;
  const idMatches = card ? card.externalId === listing.externalId : null;
  const titleMatches = card ? card.title === listing.title : null;
  const currencyMatches = card ? knownMatch(listing.currency, card.currency) : null;
  const fullPriceMatches = card && listing.currency === 'RUB' && card.currency === 'RUB'
    ? knownMatch(listing.priceMinor, card.priceMinor) : null;
  const yearMatches = card ? knownMatch(listing.vehicle.year, card.vehicle.year) : null;
  const mileageMatches = card ? knownMatch(listing.vehicle.mileageKm, card.vehicle.mileageKm) : null;
  const mismatchedFields = Object.entries({
    source: sourceMatches, externalId: idMatches, title: titleMatches,
    currency: currencyMatches, priceMinor: fullPriceMatches,
    'vehicle.year': yearMatches, 'vehicle.mileageKm': mileageMatches,
  }).filter(([, matches]) => matches === false).map(([field]) => field);
  const comparisonStatus = !fetchSucceeded ? 'not_compared'
    : mismatchedFields.length ? 'mismatch'
    : fullPriceMatches === null ? 'unverified' : 'match';
  return {
    externalId: listing.externalId, outcome: details.outcome, fetchSucceeded, comparisonStatus,
    sourceMatches, idMatches, titleMatches, fullPriceMatches, currencyMatches, yearMatches, mileageMatches,
    idAndFullPriceMatch: sourceMatches === true && idMatches === true && fullPriceMatches === true,
    mismatchedFields,
    catalogTitle: listing.title, cardTitle: card?.title ?? null,
    catalogPriceMinor: listing.priceMinor, cardPriceMinor: card?.priceMinor ?? null,
    catalogVehicle: listing.vehicle, cardVehicle: card?.vehicle ?? null,
    catalogVehicleProvenance: vehicleProvenance(listing),
    cardVehicleProvenance: card ? vehicleProvenance(card) : null,
    diagnostics: details.diagnostics,
  };
}

export function activeSourceBackoff(blockedUntil: string | null | undefined, now = Date.now()) {
  if (blockedUntil === null || blockedUntil === undefined) return null;
  const deadline = Date.parse(blockedUntil);
  return deadline > now ? { blockedUntil, remainingSeconds: Math.ceil((deadline - now) / 1000) } : null;
}
