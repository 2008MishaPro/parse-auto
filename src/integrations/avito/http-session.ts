import { createHash } from 'node:crypto';
import { setImmediate as yieldTask, setTimeout as delay } from 'node:timers/promises';
import type { HtmlResponse } from '../../transport/http.ts';
import { retryAfterSeconds } from '../../transport/http.ts';
import { asObject } from './extract.ts';
import { avitoUrl } from './normalize.ts';

interface Cookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expiresAt: number | null;
}

interface SessionOptions {
  fetch?: typeof globalThis.fetch;
  minRequestIntervalMs?: number;
  maxPowAttempts?: number;
}

// Only the native public-page check observed on Avito is supported. No downloaded
// scripts are executed; an unknown check is returned to the adapter as blocked.
export class AvitoHttpSession {
  private readonly nativeFetch: typeof globalThis.fetch;
  private readonly minRequestIntervalMs: number;
  private readonly maxPowAttempts: number;
  private readonly cookies = new Map<string, Cookie>();
  private lastRequestAt = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: SessionOptions = {}) {
    this.nativeFetch = options.fetch ?? globalThis.fetch;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? 2000;
    this.maxPowAttempts = options.maxPowAttempts ?? 2_000_000;
    if (!Number.isFinite(this.minRequestIntervalMs) || this.minRequestIntervalMs < 0
      || !Number.isSafeInteger(this.maxPowAttempts) || this.maxPowAttempts < 1) throw new Error('invalid_avito_session_limits');
  }

  readonly getHtml = async (url: string, timeoutSeconds: number, signal: AbortSignal): Promise<HtmlResponse> => {
    const target = avitoUrl(url);
    if (!target) throw new Error('invalid_avito_url');
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error('invalid_avito_timeout');
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.ceil(timeoutSeconds * 1000)))]);
    deadline.throwIfAborted();
    const operation = this.tail.then(async () => {
      deadline.throwIfAborted();
      return await this.readPage(target, deadline);
    });
    // A cancelled waiter keeps its FIFO position internally, while its caller
    // receives cancellation immediately. No successor can overlap the owner.
    this.tail = operation.then(() => {}, () => {});
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(deadline.reason);
      deadline.addEventListener('abort', onAbort, { once: true });
      if (deadline.aborted) onAbort();
    });
    try {
      return await Promise.race([operation, cancelled]);
    } finally { deadline.removeEventListener('abort', onAbort); }
  };

  private cookieKey(cookie: Cookie): string { return `${cookie.domain}|${cookie.path}|${cookie.name}`; }

  private receiveCookies(url: URL, headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      if (line.length > 4096) continue;
      const [pair = '', ...attributes] = line.split(';');
      const equal = pair.indexOf('=');
      if (equal <= 0) continue;
      const name = pair.slice(0, equal).trim();
      const value = pair.slice(equal + 1).trim();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\x00-\x20\x7f;,]/.test(value)) continue;
      const slash = url.pathname.lastIndexOf('/');
      const cookie: Cookie = {
        name, value, domain: url.hostname, hostOnly: true,
        path: slash > 0 ? url.pathname.slice(0, slash) : '/', secure: false, expiresAt: null,
      };
      let maxAge: number | null = null;
      let invalidDomain = false;
      for (const rawAttribute of attributes) {
        const separator = rawAttribute.indexOf('=');
        const attribute = (separator < 0 ? rawAttribute : rawAttribute.slice(0, separator)).trim().toLowerCase();
        const content = separator < 0 ? '' : rawAttribute.slice(separator + 1).trim();
        if (attribute === 'domain') {
          const domain = content.toLowerCase().replace(/^\./, '');
          if (!['avito.ru', 'www.avito.ru'].includes(domain)
            || !(url.hostname === domain || url.hostname.endsWith(`.${domain}`))) invalidDomain = true;
          else { cookie.domain = domain; cookie.hostOnly = false; }
        } else if (attribute === 'path' && content.startsWith('/')) cookie.path = content;
        else if (attribute === 'secure') cookie.secure = true;
        else if (attribute === 'max-age' && /^-?\d+$/.test(content)) maxAge = Number(content);
        else if (attribute === 'expires') {
          const expires = Date.parse(content);
          if (Number.isFinite(expires)) cookie.expiresAt = expires;
        }
      }
      if (invalidDomain) continue;
      if (maxAge !== null && Number.isFinite(maxAge)) cookie.expiresAt = Date.now() + maxAge * 1000;
      if (!value || (cookie.expiresAt !== null && cookie.expiresAt <= Date.now())) this.cookies.delete(this.cookieKey(cookie));
      else if (this.cookies.size < 128 || this.cookies.has(this.cookieKey(cookie))) this.cookies.set(this.cookieKey(cookie), cookie);
    }
  }

  private matchingCookies(url: URL): Cookie[] {
    const matched: Cookie[] = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= Date.now()) { this.cookies.delete(key); continue; }
      const domainMatches = cookie.hostOnly ? url.hostname === cookie.domain
        : url.hostname === cookie.domain || url.hostname.endsWith(`.${cookie.domain}`);
      const pathMatches = url.pathname === cookie.path || (url.pathname.startsWith(cookie.path)
        && (cookie.path.endsWith('/') || url.pathname[cookie.path.length] === '/'));
      if (domainMatches && pathMatches && (!cookie.secure || url.protocol === 'https:')) matched.push(cookie);
    }
    return matched.sort((left, right) => right.path.length - left.path.length);
  }

  private async request(url: URL, init: RequestInit, signal: AbortSignal, counters: { httpRequests: number }): Promise<HtmlResponse> {
    let target = url;
    for (let hop = 0; ; hop++) {
      signal.throwIfAborted();
      const wait = Math.max(0, this.minRequestIntervalMs - (Date.now() - this.lastRequestAt));
      if (wait) await delay(wait, undefined, { signal });
      signal.throwIfAborted();
      const headers = new Headers(init.headers);
      const cookies = this.matchingCookies(target);
      if (cookies.length) headers.set('Cookie', cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '));
      this.lastRequestAt = Date.now();
      counters.httpRequests++;
      const response = await this.nativeFetch(target.href, { ...init, headers, signal, redirect: 'manual' });
      this.receiveCookies(target, response.headers);
      const result: HtmlResponse = { status: response.status, url: target.href, body: await response.text(),
        retryAfterSeconds: retryAfterSeconds(response.headers) };
      const location = response.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) return result;
      // A verification POST must never be forwarded. Cookie-bearing GETs stay
      // on the original origin and retain intermediate response cookies.
      if (init.method === 'POST' || hop >= 3 || (result.retryAfterSeconds !== null && result.retryAfterSeconds > 0)) return result;
      let next: URL;
      try { next = new URL(location, target); } catch { return result; }
      if (next.origin !== url.origin || next.username || next.password || next.hash) return result;
      target = next;
    }
  }

  private async solve(id: string, complexity: number, signal: AbortSignal): Promise<number | null> {
    const prefix = '0'.repeat(complexity);
    for (let nonce = 0; nonce < this.maxPowAttempts; nonce++) {
      if (nonce % 1024 === 0) { await yieldTask(); signal.throwIfAborted(); }
      if (createHash('sha256').update(`${id}:${nonce}`).digest('hex').startsWith(prefix)) return nonce;
    }
    return null;
  }

  private async readPage(url: URL, signal: AbortSignal): Promise<HtmlResponse> {
    const counters = { httpRequests: 0 };
    const startedAt = Date.now();
    const initial = await this.request(url, { headers: { Accept: 'text/html,application/xhtml+xml' } }, signal, counters);
    let check: 'passed' | 'failed' | null = null;
    const finish = (response: HtmlResponse, reason?: string): HtmlResponse => ({ ...response,
      transportDiagnostics: { ...counters, ...(check ? { accessCheck: check } : {}),
        ...(reason ? { accessCheckReason: reason } : {}), elapsedMs: Date.now() - startedAt } });
    if (initial.status !== 439 || !initial.body.includes('/web/3/firewallPow/get')
      || !initial.body.includes('/web/3/firewallPow/verify')) return finish(initial);
    check = 'failed';
    // The source's explicit pause takes precedence over an automatic page check;
    // return it to the monitor so shared/persisted backoff can be applied.
    if (initial.retryAfterSeconds !== null && initial.retryAfterSeconds > 0) return finish(initial, 'retry_after');
    const challengeUrl = new URL(initial.url);
    const challenge = this.matchingCookies(challengeUrl).find(cookie => cookie.name === 'pow_challenge')?.value;
    if (!challenge) return finish(initial, 'challenge_cookie_missing');
    const post = async (path: string, body: Record<string, unknown>): Promise<HtmlResponse> => this.request(new URL(path, url), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
    }, signal, counters);
    const task = await post('/web/3/firewallPow/get', { challenge });
    if (task.status !== 200) return finish(task, 'challenge_request_refused');
    let jwt: unknown;
    let payload: Record<string, unknown> | null;
    try {
      const data = task.body.length <= 16384 ? asObject(JSON.parse(task.body)) : null;
      jwt = asObject(asObject(data?.success)?.result)?.challenge_jwt;
      if (typeof jwt !== 'string' || jwt.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) {
        return finish(initial, 'invalid_challenge');
      }
      payload = asObject(JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')));
    } catch { return finish(initial, 'invalid_challenge'); }
    if (!payload || typeof payload.id !== 'string' || payload.id.length < 1 || payload.id.length > 256
      || typeof payload.compl !== 'number' || !Number.isInteger(payload.compl) || payload.compl < 1 || payload.compl > 5) {
      return finish(initial, 'unsupported_challenge');
    }
    const nonce = await this.solve(payload.id, payload.compl, signal);
    if (nonce === null) return finish(initial, 'challenge_work_limit');
    const verified = await post('/web/3/firewallPow/verify', { challenge: jwt, nonce });
    if (verified.status !== 200) return finish(verified, 'verification_request_refused');
    let accepted = false;
    try {
      const data = verified.body.length <= 16384 ? asObject(JSON.parse(verified.body)) : null;
      accepted = asObject(asObject(data?.success)?.result)?.verified === true;
    } catch { /* A malformed verification response is still blocked. */ }
    if (!accepted) return finish(initial, 'verification_failed');
    const solved: Cookie = { name: 'pow_solved', value: '1', domain: url.hostname,
      hostOnly: true, path: '/', secure: true, expiresAt: Date.now() + 10_000 };
    this.cookies.set(this.cookieKey(solved), solved);
    const reloaded = await this.request(url, { headers: { Accept: 'text/html,application/xhtml+xml' } }, signal, counters);
    if (reloaded.status < 200 || reloaded.status >= 300
      || (reloaded.body.includes('/web/3/firewallPow/get') && reloaded.body.includes('/web/3/firewallPow/verify'))) {
      return finish(reloaded, 'page_still_refused');
    }
    check = 'passed';
    return finish(reloaded);
  }
}
