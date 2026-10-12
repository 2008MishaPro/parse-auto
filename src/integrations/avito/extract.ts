export interface AvitoCatalog {
  items: unknown[];
  pager: Record<string, unknown> | null;
  count: number | null;
  totalCount: number | null;
  mainCount: number | null;
  totalElements: number | null;
  itemsOnPage: number | null;
  itemsOnPageMainSection: number | null;
  encoding: 'json' | 'html_entities';
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Decode only when the script itself is entity-encoded. Valid JSON string content
// (including a literal &amp; in a title or URL) must remain untouched.
export function decodeEntities(value: string): string {
  const named: Record<string, string> = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>', nbsp: '\u00a0' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt|nbsp);/gi, (match, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? match;
    const code = entity[1]?.toLowerCase() === 'x'
      ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : match;
  });
}

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attributes);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

function* ssrStates(html: string): Generator<{ loader: Record<string, unknown>; data: Record<string, unknown>; encoding: AvitoCatalog['encoding'] }> {
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (attribute(script[1]!, 'type') !== 'mime/invalid' || attribute(script[1]!, 'data-mfe-state') !== 'true') continue;
    let parsed: unknown;
    let encoding: AvitoCatalog['encoding'] = 'json';
    try {
      parsed = JSON.parse(script[2]!);
    } catch {
      try {
        parsed = JSON.parse(decodeEntities(script[2]!));
        encoding = 'html_entities';
      } catch { continue; }
    }
    const loader = asObject(asObject(parsed)?.loaderData);
    const data = asObject(loader?.data);
    if (loader && data) yield { loader, data, encoding };
  }
}

export function extractAvitoRedirect(html: string): { target: string | null } | null {
  for (const { loader, data } of ssrStates(html)) {
    if (data.redirected === true || loader.isSuspenseRedirect === true || typeof loader.redirect === 'string') {
      return { target: typeof loader.redirect === 'string' ? loader.redirect : typeof data.url === 'string' ? data.url : null };
    }
  }
  return null;
}

export function extractAvitoCatalog(html: string): AvitoCatalog | null {
  for (const { data, encoding } of ssrStates(html)) {
    const catalog = asObject(data.catalog);
    if (!catalog || !Array.isArray(catalog.items)) continue;
    return {
      items: catalog.items,
      pager: asObject(catalog.pager),
      count: count(data?.count),
      totalCount: count(data?.totalCount),
      mainCount: count(data?.mainCount),
      totalElements: count(data?.totalElements),
      itemsOnPage: count(data?.itemsOnPage),
      itemsOnPageMainSection: count(data?.itemsOnPageMainSection),
      encoding,
    };
  }
  return null;
}
