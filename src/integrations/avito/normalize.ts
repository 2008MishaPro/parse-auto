import type { Listing } from '../../core/contracts.ts';
import { asObject } from './extract.ts';
import { avitoTitleVehicle } from './vehicle.ts';

export function avitoUrl(value: string, base?: string): URL | null {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || !['www.avito.ru', 'avito.ru'].includes(url.hostname)
      || url.port || url.username || url.password || url.hash || /[\\\x00-\x20]/.test(value)
      || !/^\/[^/]+\/avtomobili(?:\/|(?:-[^/]*)?$|$)/.test(url.pathname)) return null;
    return url;
  } catch { return null; }
}

export interface NormalizedItem {
  record: Listing | null;
  reason: string | null;
}

function fullPrice(value: unknown): { priceMinor: number | null; currency: string | null } {
  const price = asObject(value);
  const unknown = { priceMinor: null, currency: null };
  if (!price || price.hasValue !== true || price.enabled !== true
    || typeof price.value !== 'number' || !Number.isSafeInteger(price.value) || price.value < 0
    || !Number.isSafeInteger(price.value * 100)) return unknown;
  // The catalog value alone does not distinguish the full price from a loan,
  // down payment or a lower bound. Confirm the displayed RUB amount as well.
  const text = typeof price.fullString === 'string' ? price.fullString.trim() : '';
  const priceLabels = [price.fullString, price.string, price.postfix, asObject(price.title)?.full,
    asObject(price.title)?.short, price.titleDative].filter((v): v is string => typeof v === 'string').join(' ');
  if (/(?:^|\s)от\s|кредит|взнос|аванс|рассроч|\/\s*(?:мес|месяц)|в\s+месяц|ежемесяч|loan|down\s*payment/iu.test(priceLabels)) return unknown;
  const match = /^([\d\s\u00a0\u202f]+)\s*(?:₽|руб(?:\.|лей)?|RUB)$/iu.exec(text);
  if (!match || Number(match[1]!.replace(/\s/gu, '')) !== price.value) return unknown;
  return { priceMinor: price.value * 100, currency: 'RUB' };
}

export function normalizeAvitoItem(value: unknown, pageUrl: string, observedAt: string): NormalizedItem {
  const item = asObject(value);
  if (!item) return { record: null, reason: 'item_not_object' };
  if (item.type !== 'item') return { record: null, reason: 'unknown_item_type' };
  if (item.categoryId !== 9) return { record: null, reason: 'unexpected_category' };
  const externalId = typeof item.id === 'number' && Number.isSafeInteger(item.id) && item.id > 0
    ? String(item.id) : typeof item.id === 'string' && /^[1-9]\d*$/.test(item.id) ? item.id : null;
  if (!externalId) return { record: null, reason: 'invalid_id' };
  if (typeof item.title !== 'string' || !item.title.trim()) return { record: null, reason: 'missing_title' };
  const url = typeof item.urlPath === 'string' ? avitoUrl(item.urlPath, pageUrl) : null;
  if (!url || !url.pathname.includes('/avtomobili/') || !url.pathname.endsWith(`_${externalId}`)) {
    return { record: null, reason: 'invalid_listing_url' };
  }
  const price = fullPrice(item.priceDetailed);
  const vehicle = avitoTitleVehicle(item.title.trim(), observedAt, 'loaderData.data.catalog.items[].title');
  return {
    record: {
      source: 'avito', externalId, url: url.href, title: item.title.trim(), ...price,
      observedAt, publishedAt: null,
      vehicle: vehicle.vehicle,
      provenance: {
        externalId: 'loaderData.data.catalog.items[].id',
        url: 'loaderData.data.catalog.items[].urlPath',
        title: 'loaderData.data.catalog.items[].title',
        ...(price.priceMinor !== null ? { priceMinor: 'priceDetailed.value + confirmed fullString RUB', currency: 'priceDetailed.fullString' } : {}),
        ...vehicle.provenance,
      },
    },
    reason: null,
  };
}
