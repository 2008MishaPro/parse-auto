import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AvitoHttpSession } from '../src/integrations/avito/http-session.ts';

const origin = 'https://www.avito.ru';
const card = `${origin}/moskva/avtomobili/avtomobil_123`;
const blocked = '<html><script src="/web/3/firewallPow/get"></script><script src="/web/3/firewallPow/verify"></script></html>';
const signal = () => new AbortController().signal;
interface Call { url: string; init: RequestInit; headers: Headers }
interface Reply { status?: number; body?: string; headers?: Array<[string, string]> }

function response(url: string, reply: Reply = {}): Response {
  const headers = new Headers();
  for (const [name, value] of reply.headers ?? []) headers.append(name, value);
  const result = new Response(reply.body ?? 'ok', { status: reply.status ?? 200, headers });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

function fakeFetch(handler: (call: Call, index: number) => Response | Promise<Response>): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const call = { url, init, headers: new Headers(init.headers) };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch, calls };
}

function token(payload: unknown): string {
  return `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature-secret`;
}

function json(value: unknown): string { return JSON.stringify(value); }
function body(call: Call): Record<string, unknown> { return JSON.parse(String(call.init.body)) as Record<string, unknown>; }
function cookies(call: Call): Record<string, string> {
  return Object.fromEntries((call.headers.get('cookie') ?? '').split(';').filter(Boolean).map(part => {
    const value = part.trim();
    const separator = value.indexOf('=');
    return [value.slice(0, separator), value.slice(separator + 1)];
  }));
}

test('439: штатная проверка передаёт cookies, проверяет proof и возвращает только повторно загруженную страницу', async () => {
  const challengeCookie = 'challenge-cookie-secret';
  const jwt = token({ id: 'proof-id-secret', compl: 1 });
  const stub = fakeFetch((call, index) => {
    if (index === 0) return response(call.url, { status: 439, body: blocked, headers: [['set-cookie', `pow_challenge=${challengeCookie}; Path=/; Secure`], ['set-cookie', 'first=session-secret; Path=/']] });
    if (index === 1) {
      assert.equal(new URL(call.url).pathname, '/web/3/firewallPow/get');
      assert.equal(call.init.method, 'POST');
      assert.deepEqual(body(call), { challenge: challengeCookie });
      assert.equal(cookies(call).first, 'session-secret');
      return response(call.url, { body: json({ success: { result: { challenge_jwt: jwt } } }), headers: [['set-cookie', 'middle=middle-secret; Path=/']] });
    }
    if (index === 2) {
      assert.equal(new URL(call.url).pathname, '/web/3/firewallPow/verify');
      assert.equal(call.init.method, 'POST');
      const proof = body(call);
      assert.equal(proof.challenge, jwt);
      assert.equal(typeof proof.nonce, 'number');
      assert.ok(Number.isSafeInteger(proof.nonce));
      assert.ok(createHash('sha256').update(`proof-id-secret:${proof.nonce}`).digest('hex').startsWith('0'));
      assert.equal(cookies(call).middle, 'middle-secret');
      return response(call.url, { body: json({ success: { result: { verified: true } } }), headers: [['set-cookie', 'verified=verified-secret; Path=/']] });
    }
    assert.equal(index, 3);
    assert.equal(call.url, card);
    assert.equal(cookies(call).pow_solved, '1');
    assert.equal(cookies(call).verified, 'verified-secret');
    return response(call.url, { body: '<html>real card</html>' });
  });
  const result = await new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 }).getHtml(card, 5, signal());
  assert.equal(result.status, 200);
  assert.equal(result.body, '<html>real card</html>');
  assert.equal(result.transportDiagnostics?.accessCheck, 'passed');
  assert.equal(result.transportDiagnostics?.httpRequests, 4);
  const diagnostics = json(result.transportDiagnostics);
  for (const secret of [challengeCookie, jwt, 'proof-id-secret', 'session-secret', 'middle-secret', 'verified-secret']) assert.ok(!diagnostics.includes(secret));
});

test('cookies обновляются даже при HTTP отказе; Domain, Path, Max-Age и Expires ограничивают передачу', async () => {
  const stub = fakeFetch((call, index) => {
    if (index === 0) return response(call.url, { status: 403, headers: [
      ['set-cookie', 'host=host-secret; Path=/'],
      ['set-cookie', 'domain=domain-secret; Domain=.avito.ru; Path=/'],
      ['set-cookie', 'section=section-secret; Path=/moskva'],
      ['set-cookie', 'secure=secure-secret; Secure; Path=/'],
      ['set-cookie', 'wrong=wrong-secret; Domain=other.example; Path=/'],
      ['set-cookie', 'expired=expired-secret; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'],
      ['set-cookie', 'deleted=deleted-secret; Max-Age=0; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Path=/'],
      ['set-cookie', 'maxage=kept-secret; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'],
    ] });
    return response(call.url);
  });
  const session = new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 });
  assert.equal((await session.getHtml(card, 5, signal())).status, 403);
  await session.getHtml(`${origin}/moskva/avtomobili/next_124`, 5, signal());
  assert.deepEqual(cookies(stub.calls[1]!), { host: 'host-secret', domain: 'domain-secret', section: 'section-secret', secure: 'secure-secret', maxage: 'kept-secret' });
  await session.getHtml(`${origin}/moskvabad/avtomobili/next_125`, 5, signal());
  assert.equal(cookies(stub.calls[2]!).section, undefined);
  await session.getHtml('https://avito.ru/moskva/avtomobili/next_126', 5, signal());
  assert.deepEqual(cookies(stub.calls[3]!), { domain: 'domain-secret' });
});

test('Set-Cookie same-origin редиректа применяется к следующему запросу; редиректы выполняются вручную', async () => {
  const stub = fakeFetch((call, index) => {
    assert.equal(call.init.redirect, 'manual');
    if (index === 0) return response(call.url, { status: 302, headers: [['location', '/moskva/avtomobili/canonical_123'], ['set-cookie', 'redirect=session-secret; Path=/']] });
    assert.equal(call.url, `${origin}/moskva/avtomobili/canonical_123`);
    assert.equal(cookies(call).redirect, 'session-secret');
    return response(call.url, { body: 'canonical card' });
  });
  const result = await new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 }).getHtml(card, 5, signal());
  assert.equal(result.status, 200);
  assert.equal(result.body, 'canonical card');
  assert.equal(stub.calls.length, 2);
});

test('Secure cookies не отправляются через downgrade redirect; HTTP вход отклоняется до fetch', async () => {
  const stub = fakeFetch(call => response(call.url, { status: 302, headers: [['location', 'http://www.avito.ru/moskva/avtomobili/other_124'], ['set-cookie', 'private=secure-secret; Secure; Path=/']] }));
  const session = new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 });
  const result = await session.getHtml(card, 5, signal());
  assert.equal(result.status, 302);
  assert.equal(stub.calls.length, 1);
  await assert.rejects(session.getHtml('http://www.avito.ru/moskva/avtomobili/other_124', 5, signal()), /invalid_avito_url/);
  assert.equal(stub.calls.length, 1);
});

test('cookies без Path имеют путь каталога; замена и Max-Age=0 удаляют прежнее значение', async () => {
  const stub = fakeFetch((call, index) => {
    if (index === 0) return response(call.url, { headers: [['set-cookie', 'implicit=implicit-secret'], ['set-cookie', 'replace=old-secret; Path=/']] });
    if (index === 1) {
      assert.equal(cookies(call).implicit, 'implicit-secret');
      assert.equal(cookies(call).replace, 'old-secret');
      return response(call.url, { status: 403, headers: [['set-cookie', 'replace=new-secret; Path=/']] });
    }
    if (index === 2) {
      assert.equal(cookies(call).implicit, undefined);
      assert.equal(cookies(call).replace, 'new-secret');
      return response(call.url, { status: 429, headers: [['set-cookie', 'replace=deleted; Path=/; Max-Age=0']] });
    }
    assert.equal(cookies(call).replace, undefined);
    return response(call.url);
  });
  const session = new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 });
  await session.getHtml(card, 5, signal());
  await session.getHtml(`${origin}/moskva/avtomobili/next_124`, 5, signal());
  await session.getHtml(`${origin}/spb/avtomobili/next_125`, 5, signal());
  await session.getHtml(card, 5, signal());
});

test('Max-Age истекает между обращениями сессии', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const stub = fakeFetch((call, index) => {
    if (index === 0) return response(call.url, { headers: [['set-cookie', 'short=expires-secret; Max-Age=1; Path=/']] });
    assert.equal(cookies(call).short, index === 1 ? 'expires-secret' : undefined);
    return response(call.url);
  });
  const session = new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 });
  await session.getHtml(card, 5, signal());
  now += 500;
  await session.getHtml(card, 5, signal());
  now += 501;
  await session.getHtml(card, 5, signal());
});

test('редирект на другой origin не выполняется и cookies не покидают источник', async () => {
  const stub = fakeFetch((call) => {
    assert.equal(new URL(call.url).origin, origin);
    return response(call.url, { status: 302, headers: [['location', 'https://other.example/collect'], ['set-cookie', 'private=private-secret; Path=/']] });
  });
  const result = await new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 }).getHtml(card, 5, signal());
  assert.equal(result.status, 302);
  assert.equal(stub.calls.length, 1);
  assert.ok(!json(result.transportDiagnostics).includes('private-secret'));
});

test('HTTP редиректы ограничены тремя переходами', async () => {
  const stub = fakeFetch((call, index) => response(call.url, { status: 302, headers: [['location', `/moskva/avtomobili/step_${index + 1}`]] }));
  const result = await new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 }).getHtml(card, 5, signal());
  assert.equal(result.status, 302);
  assert.equal(stub.calls.length, 4);
});

test('Retry-After у same-origin редиректа запрещает немедленный следующий GET', async () => {
  const stub = fakeFetch(call => response(call.url, { status: 302, headers: [['location', '/moskva/avtomobili/canonical_123'], ['retry-after', '17']] }));
  const result = await new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 }).getHtml(card, 5, signal());
  assert.equal(result.status, 302);
  assert.equal(result.retryAfterSeconds, 17);
  assert.equal(result.transportDiagnostics?.httpRequests, 1);
  assert.equal(stub.calls.length, 1);
});

test('429 не запускает проверку доступа; Retry-After сохраняется', async () => {
  const stub = fakeFetch(call => response(call.url, { status: 429, body: blocked, headers: [['retry-after', '27'], ['set-cookie', 'pow_challenge=challenge-secret; Path=/']] }));
  const result = await new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 }).getHtml(card, 5, signal());
  assert.equal(result.status, 429);
  assert.equal(result.retryAfterSeconds, 27);
  assert.equal(stub.calls.length, 1);
});

test('Retry-After у узнаваемого439 запрещает немедленный POST проверки доступа', async () => {
  const stub = fakeFetch(call => response(call.url, { status: 439, body: blocked, headers: [['retry-after', '17'], ['set-cookie', 'pow_challenge=delayed-secret; Path=/']] }));
  const result = await new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 }).getHtml(card, 5, signal());
  assert.equal(result.status, 439);
  assert.equal(result.retryAfterSeconds, 17);
  assert.equal(result.transportDiagnostics?.accessCheck, 'failed');
  assert.equal(result.transportDiagnostics?.accessCheckReason, 'retry_after');
  assert.equal(result.transportDiagnostics?.httpRequests, 1);
  assert.equal(stub.calls.length, 1);
});

test('неизвестная439-разметка не запускает endpoint проверки', async () => {
  const stub = fakeFetch(call => response(call.url, { status: 439, body: '<html>другой отказ</html>', headers: [['set-cookie', 'pow_challenge=secret; Path=/']] }));
  const result = await new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 }).getHtml(card, 5, signal());
  assert.equal(result.status, 439);
  assert.equal(stub.calls.length, 1);
});

test('узнаваемый439 без pow_challenge возвращает явный отказ без POST', async () => {
  const stub = fakeFetch(call => response(call.url, { status: 439, body: blocked }));
  const result = await new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 }).getHtml(card, 5, signal());
  assert.equal(result.status, 439);
  assert.equal(result.transportDiagnostics?.accessCheck, 'failed');
  assert.equal(result.transportDiagnostics?.accessCheckReason, 'challenge_cookie_missing');
  assert.equal(stub.calls.length, 1);
});

test('повторный439 после verified остаётся отказом и не запускает второй challenge', async () => {
  const jwt = token({ id: 'repeat-proof', compl: 1 });
  const stub = fakeFetch((call, index) => {
    if (index === 0 || index === 3) return response(call.url, { status: 439, body: blocked, headers: [['set-cookie', 'pow_challenge=repeat-secret; Path=/']] });
    return response(call.url, { body: json({ success: { result: index === 1 ? { challenge_jwt: jwt } : { verified: true } } }) });
  });
  const result = await new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 }).getHtml(card, 5, signal());
  assert.equal(result.status, 439);
  assert.equal(result.transportDiagnostics?.accessCheck, 'failed');
  assert.equal(result.transportDiagnostics?.httpRequests, 4);
  assert.equal(stub.calls.length, 4);
});

test('HTTP200 с повторной страницей проверки не считается доступной карточкой', async () => {
  const jwt = token({ id: 'soft-refusal-proof', compl: 1 });
  const stub = fakeFetch((call, index) => {
    if (index === 0) return response(call.url, { status: 439, body: blocked, headers: [['set-cookie', 'pow_challenge=soft-secret; Path=/']] });
    if (index === 3) return response(call.url, { body: blocked });
    return response(call.url, { body: json({ success: { result: index === 1 ? { challenge_jwt: jwt } : { verified: true } } }) });
  });
  const result = await new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 }).getHtml(card, 5, signal());
  assert.equal(result.status, 200);
  assert.equal(result.transportDiagnostics?.accessCheck, 'failed');
  assert.equal(result.transportDiagnostics?.accessCheckReason, 'page_still_refused');
  assert.equal(stub.calls.length, 4);
});

test('отказы endpoint проверки сохраняют настоящий HTTP статус, Retry-After и cookies', async t => {
  for (const stage of ['get', 'verify'] as const) for (const status of [401, 403, 429, 439, 503]) await t.test(`${stage}: HTTP ${status}`, async () => {
    const jwt = token({ id: 'error-proof', compl: 1 });
    const failedIndex = stage === 'get' ? 1 : 2;
    const stub = fakeFetch((call, index) => {
      if (index === 0) return response(call.url, { status: 439, body: blocked, headers: [['set-cookie', 'pow_challenge=error-secret; Path=/']] });
      if (index === failedIndex) return response(call.url, { status, body: 'endpoint refused', headers: [['retry-after', '31'], ['set-cookie', 'failed=retained-secret; Path=/']] });
      if (index === failedIndex + 1) { assert.equal(cookies(call).failed, 'retained-secret'); return response(call.url); }
      return response(call.url, { body: json({ success: { result: { challenge_jwt: jwt } } }) });
    });
    const session = new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 });
    const result = await session.getHtml(card, 5, signal());
    assert.equal(result.status, status);
    assert.equal(result.retryAfterSeconds, 31);
    assert.equal(result.transportDiagnostics?.accessCheck, 'failed');
    assert.equal(stub.calls.length, failedIndex + 1);
    assert.ok(!json(result.transportDiagnostics).includes('retained-secret'));
    await session.getHtml(card, 5, signal());
    assert.equal(stub.calls.length, failedIndex + 2);
  });
});

test('невалидный challenge возвращает исходный439 без verify и без секретов в диагностике', async t => {
  const cases = [
    ['не JSON', '{bad-json'],
    ['API success=false', json({ success: false, result: { challenge_jwt: token({ id: 'secret-id', compl: 1 }) } })],
    ['не JWT', json({ success: { result: { challenge_jwt: 'secret-not-jwt' } } })],
    ['нет id', json({ success: { result: { challenge_jwt: token({ compl: 1 }) } } })],
    ['сложность вне диапазона', json({ success: { result: { challenge_jwt: token({ id: 'secret-id', compl: 6 }) } } })],
    ['сложность дробная', json({ success: { result: { challenge_jwt: token({ id: 'secret-id', compl: 1.5 }) } } })],
  ];
  for (const [name, challenge] of cases) await t.test(name!, async () => {
    const stub = fakeFetch((call, index) => {
      assert.ok(index < 2);
      return response(call.url, index === 0 ? { status: 439, body: blocked, headers: [['set-cookie', 'pow_challenge=secret-cookie; Path=/']] } : { body: challenge });
    });
    const result = await new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 }).getHtml(card, 5, signal());
    assert.equal(result.status, 439);
    assert.equal(result.body, blocked);
    assert.equal(result.transportDiagnostics?.accessCheck, 'failed');
    assert.equal(stub.calls.length, 2);
    const diagnostics = json(result.transportDiagnostics);
    assert.ok(!diagnostics.includes('secret-cookie'));
    assert.ok(!diagnostics.includes('secret-id'));
    assert.ok(!diagnostics.includes('secret-not-jwt'));
  });
});

test('verified=false не считается успехом и не вызывает reload', async () => {
  const jwt = token({ id: 'unverified-proof', compl: 1 });
  const stub = fakeFetch((call, index) => response(call.url, index === 0
    ? { status: 439, body: blocked, headers: [['set-cookie', 'pow_challenge=unverified-secret; Path=/']] }
    : { body: json({ success: { result: index === 1 ? { challenge_jwt: jwt } : { verified: false } } }) }));
  const result = await new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 }).getHtml(card, 5, signal());
  assert.equal(result.status, 439);
  assert.equal(result.transportDiagnostics?.accessCheck, 'failed');
  assert.equal(stub.calls.length, 3);
});

test('исчерпание maxPowAttempts останавливает CPU работу без verify', async () => {
  const id = 'bounded-proof-1';
  assert.ok(!createHash('sha256').update(`${id}:0`).digest('hex').startsWith('00000'));
  assert.ok(!createHash('sha256').update(`${id}:1`).digest('hex').startsWith('00000'));
  const stub = fakeFetch((call, index) => {
    assert.ok(index < 2);
    return response(call.url, index === 0 ? { status: 439, body: blocked, headers: [['set-cookie', 'pow_challenge=bounded-secret; Path=/']] } : { body: json({ success: { result: { challenge_jwt: token({ id, compl: 5 }) } } }) });
  });
  const result = await new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0, maxPowAttempts: 1 }).getHtml(card, 5, signal());
  assert.equal(result.status, 439);
  assert.equal(result.transportDiagnostics?.accessCheck, 'failed');
  assert.equal(stub.calls.length, 2);
});

test('запросы одной сессии исполняются FIFO без параллельных fetch', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let active = 0;
  let maxActive = 0;
  const stub = fakeFetch(async (call, index) => {
    active++;
    maxActive = Math.max(maxActive, active);
    if (index === 0) await held;
    active--;
    return response(call.url, index === 0 ? { headers: [['set-cookie', 'ordered=first-secret; Path=/']] } : {});
  });
  const session = new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 });
  const first = session.getHtml(`${card}?first`, 5, signal());
  const second = session.getHtml(`${card}?second`, 5, signal());
  const third = session.getHtml(`${card}?third`, 5, signal());
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(stub.calls.length, 1);
  release();
  await Promise.all([first, second, third]);
  assert.equal(maxActive, 1);
  assert.deepEqual(stub.calls.map(call => new URL(call.url).search), ['?first', '?second', '?third']);
  assert.equal(cookies(stub.calls[1]!).ordered, 'first-secret');
});

test('AbortSignal отменяет ожидание throttle до следующего HTTP запроса', async () => {
  const stub = fakeFetch(call => response(call.url));
  const session = new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 500 });
  await session.getHtml(card, 5, signal());
  const controller = new AbortController();
  const pending = session.getHtml(card, 5, controller.signal);
  const timer = setTimeout(() => controller.abort(), 15);
  try { await assert.rejects(pending, { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
  assert.equal(stub.calls.length, 1);
});

test('отмена очереди немедленно освобождает вызывающего, сохраняя FIFO для остальных', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const stub = fakeFetch(async (call, index) => {
    if (index === 0) await held;
    return response(call.url);
  });
  const session = new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 });
  const first = session.getHtml(`${card}?first`, 5, signal());
  const controller = new AbortController();
  const second = session.getHtml(`${card}?cancelled`, 5, controller.signal);
  const third = session.getHtml(`${card}?third`, 5, signal());
  controller.abort();
  try {
    await assert.rejects(second, { name: 'AbortError' });
    assert.equal(stub.calls.length, 1);
  } finally { release(); }
  await Promise.all([first, third]);
  assert.deepEqual(stub.calls.map(call => new URL(call.url).search), ['?first', '?third']);
});

test('отмена чтения тела завершает операцию и позволяет следующий запрос сессии', async () => {
  const stub = fakeFetch((call, index) => {
    const result = response(call.url);
    if (index === 0) Object.defineProperty(result, 'text', { value: () => new Promise<string>((_resolve, reject) => {
      const abort = () => reject(call.init.signal!.reason);
      if (call.init.signal?.aborted) abort();
      else call.init.signal?.addEventListener('abort', abort, { once: true });
    }) });
    return result;
  });
  const session = new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 });
  const controller = new AbortController();
  const pending = session.getHtml(card, 5, controller.signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal((await session.getHtml(card, 5, signal())).status, 200);
  assert.equal(stub.calls.length, 2);
});

test('общий timeout включает запрос challenge, не только исходный GET', async () => {
  const stub = fakeFetch((call, index) => {
    if (index === 0) return response(call.url, { status: 439, body: blocked, headers: [['set-cookie', 'pow_challenge=timeout-secret; Path=/']] });
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(call.init.signal!.reason);
      if (call.init.signal?.aborted) abort();
      else call.init.signal?.addEventListener('abort', abort, { once: true });
    });
  });
  const keepAlive = setTimeout(() => {}, 1_000);
  try { await assert.rejects(new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0 }).getHtml(card, 0.03, signal()), { name: 'TimeoutError' }); }
  finally { clearTimeout(keepAlive); }
  assert.equal(stub.calls.length, 2);
});

test('CPU proof отдаёт управление и реагирует на отмену', async () => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stub = fakeFetch((call, index) => {
    if (index === 0) return response(call.url, { status: 439, body: blocked, headers: [['set-cookie', 'pow_challenge=cancel-secret; Path=/']] });
    assert.equal(index, 1);
    timer = setTimeout(() => controller.abort(), 1);
    return response(call.url, { body: json({ success: { result: { challenge_jwt: token({ id: 'cancel-proof-cpu', compl: 5 }) } } }) });
  });
  try { await assert.rejects(new AvitoHttpSession({ fetch: stub.fetch, minRequestIntervalMs: 0, maxPowAttempts: 2_000_000 }).getHtml(card, 5, controller.signal), { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
  assert.equal(stub.calls.length, 2);
});
