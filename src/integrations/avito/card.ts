import type { Listing } from '../../core/contracts.ts';
import { asObject, decodeEntities } from './extract.ts';
import { avitoUrl } from './normalize.ts';
import { avitoCardVehicle } from './vehicle.ts';

const buyerPath = "window.__staticRouterHydrationData.loaderData['catalog-or-main-or-item'].buyerItem";
const itemPath = `${buyerPath}.item`;

export interface ParsedAvitoCard {
  record: Listing | null;
  reason: string | null;
}

function cardState(html: string): { buyer: Record<string, unknown> | null; reason: string } {
  let foundAssignment = false;
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    // Only the observed JSON string expression is accepted. Never execute page JS.
    for (const assignment of script[1]!.matchAll(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(\s*("(?:[^"\\]|\\.)*")\s*\)/g)) {
      foundAssignment = true;
      try {
        const state = asObject(JSON.parse(JSON.parse(assignment[1]!)));
        const loader = asObject(state?.loaderData);
        const route = asObject(loader?.['catalog-or-main-or-item']);
        const buyer = asObject(route?.buyerItem);
        if (buyer) return { buyer, reason: '' };
      } catch { /* A different valid state may follow this script. */ }
    }
  }
  return { buyer: null, reason: foundAssignment ? 'invalid_card_state' : 'card_state_not_found' };
}

function cardPrice(item: Record<string, unknown>, buyer: Record<string, unknown>): { priceMinor: number | null; currency: string | null } {
  const unknown = { priceMinor: null, currency: null };
  const price = asObject(item.formattedPrice);
  if (!price || price.isHasValue !== true || typeof item.price !== 'number' || !Number.isSafeInteger(item.price)
    || item.price < 0 || !Number.isSafeInteger(item.price * 100) || price.value !== item.price
    || price.currencySign !== '₽' || typeof price.formatedString !== 'string') return unknown;
  const displayed = decodeEntities(price.formatedString).trim();
  const labels = [displayed, price.string, price.postfix, price.normalizedPricePostFix, price.rubPricePostfix,
    buyer.priceString].filter((value): value is string => typeof value === 'string').join(' ');
  if (/(?:^|\s)от\s|кредит|взнос|аванс|рассроч|\/\s*(?:мес|месяц)|в\s+месяц|ежемесяч|loan|down\s*payment/iu.test(labels)) return unknown;
  if ([price.postfix, price.normalizedPricePostFix].some(value => value !== undefined && value !== null && value !== '')) return unknown;
  if (price.rubPricePostfix !== undefined && price.rubPricePostfix !== '₽') return unknown;
  const amount = /^([\d\s\u00a0\u202f]+)\s*₽$/u.exec(displayed);
  if (!amount || Number(amount[1]!.replace(/\s/gu, '')) !== item.price) return unknown;
  if (typeof buyer.priceString === 'string' && decodeEntities(buyer.priceString).trim() !== displayed) return unknown;
  return { priceMinor: item.price * 100, currency: 'RUB' };
}

export function parseAvitoCard(html: string, pageUrl: string, externalId: string, observedAt = new Date().toISOString()): ParsedAvitoCard {
  const fail = (reason: string): ParsedAvitoCard => ({ record: null, reason });
  if (!/^[1-9]\d*$/u.test(externalId)) return fail('invalid_expected_id');
  const page = avitoUrl(pageUrl);
  if (!page || !page.pathname.includes('/avtomobili/') || !page.pathname.endsWith(`_${externalId}`)) return fail('invalid_card_url');
  const state = cardState(html);
  if (!state.buyer) return fail(state.reason);
  const item = asObject(state.buyer.item);
  if (!item) return fail('card_item_not_found');
  const id = typeof item.id === 'number' && Number.isSafeInteger(item.id) && item.id > 0 ? String(item.id)
    : typeof item.id === 'string' && /^[1-9]\d*$/u.test(item.id) ? item.id : null;
  if (!id || id !== externalId) return fail('card_id_mismatch');
  const category = asObject(item.category);
  if (item.categoryId !== 9 || (category && (category.id !== 9 || category.isCars !== true))) return fail('unexpected_card_category');
  const url = typeof item.url === 'string' ? avitoUrl(item.url, page.href) : null;
  if (!url || url.origin !== page.origin || url.pathname !== page.pathname || !url.pathname.endsWith(`_${id}`)) return fail('card_listing_url_mismatch');
  if (typeof item.title !== 'string' || !item.title.trim()) return fail('card_title_not_found');
  const price = cardPrice(item, state.buyer);
  const vehicle = avitoCardVehicle(item.title.trim(), observedAt, state.buyer, buyerPath);
  return {
    record: {
      source: 'avito', externalId: id, url: url.href, title: item.title.trim(), ...price,
      observedAt, publishedAt: null,
      vehicle: vehicle.vehicle,
      provenance: {
        externalId: `${itemPath}.id`, url: `${itemPath}.url`, title: `${itemPath}.title`,
        ...(price.priceMinor !== null ? {
          priceMinor: `${itemPath}.price + formattedPrice.value + confirmed formatedString RUB`,
          currency: `${itemPath}.formattedPrice.currencySign + formatedString`,
        } : {}),
        ...vehicle.provenance,
      },
    },
    reason: null,
  };
}
