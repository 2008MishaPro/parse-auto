import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { getHtml } from '../src/transport/http.ts';

test('HTTP сохраняет Retry-After и отменяет чтение незавершённого тела', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/busy') { response.writeHead(429, { 'Retry-After': '17' }); response.end('busy'); }
    else { response.writeHead(200); response.write('unfinished'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const busy = await getHtml(`${url}/busy`, 5, new AbortController().signal);
    assert.equal(busy.status, 429);
    assert.equal(busy.retryAfterSeconds, 17);
    const controller = new AbortController();
    const reading = getHtml(`${url}/hang`, 5, controller.signal);
    const timer = setTimeout(() => controller.abort(), 50);
    try { await assert.rejects(reading, { name: 'AbortError' }); }
    finally { clearTimeout(timer); }
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
