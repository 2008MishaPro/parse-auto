export interface HtmlResponse {
  status: number;
  url: string;
  body: string;
  retryAfterSeconds: number | null;
  transportDiagnostics?: Record<string, unknown>;
}

export function retryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  const seconds = raw === null ? NaN : /^\d+$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : null;
}

export async function getHtml(url: string, timeoutSeconds: number, signal: AbortSignal): Promise<HtmlResponse> {
  const timeout = AbortSignal.timeout(timeoutSeconds * 1000);
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, timeout]),
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  return {
    status: response.status,
    url: response.url,
    body: await response.text(),
    retryAfterSeconds: retryAfterSeconds(response.headers),
  };
}
