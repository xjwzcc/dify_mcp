'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createProxy } = require('../scripts/dev-fc-proxy.cjs');

test('local FC proxy preserves cloud sessions and rejects foreign browser requests', async t => {
  const received = [];
  const cloud = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (req.url === '/hotel/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"connected":true}\n\n'); return;
    }
    if (req.url === '/catering/api/snapshot' && req.headers.cookie !== 'session=test') {
      res.writeHead(401); return res.end('{}');
    }
    res.writeHead(200, { 'Content-Type': 'application/json',
      'Set-Cookie': 'session=test; HttpOnly; SameSite=Strict; Secure; Domain=example.test; Path=/catering/' });
    res.end(JSON.stringify({ ok: true, storage: 'oss' }));
  });
  cloud.listen(0, '127.0.0.1'); await once(cloud, 'listening');
  const origin = `http://127.0.0.1:${cloud.address().port}`;
  const proxy = createProxy(origin);
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const base = `http://127.0.0.1:${proxy.address().port}`;
  t.after(() => { proxy.closeAllConnections(); proxy.close(); cloud.closeAllConnections(); cloud.close(); });
  await t.test('serves local assets and blocks private files', async () => {
    assert.match(await (await fetch(base + '/')).text(), /教学/);
    assert.match(await (await fetch(base + '/hotel/student')).text(), /online\.js/);
    // Opening a local page from another website must remain possible.
    assert.equal((await fetch(base + '/catering/student', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
    for (const file of ['/data/bootstrap.json', '/scripts/dev-fc-proxy.cjs', '/hotel/../../package.json'])
      assert.equal((await fetch(base + file)).status, 404);
    assert.equal(received.length, 0);
  });
  await t.test('forwards body, cloud Origin, cookie and status without trusting spoofed headers', async () => {
    const data = JSON.stringify({ name: '中文🧪代理' });
    const response = await fetch(base + '/catering/api/login?test=1', { method: 'POST', body: data,
      headers: { Origin: base, Cookie: 'session=test', 'Content-Type': 'application/json', 'X-FC-Client-IP': 'spoof', 'X-Forwarded-Host': 'evil.test' } });
    assert.equal(response.status, 200);
    const last = received.at(-1);
    assert.equal(last.path, '/catering/api/login?test=1');
    assert.equal(last.body, data); assert.equal(last.headers.origin, origin);
    assert.equal(last.headers.cookie, 'session=test');
    assert.equal(last.headers['x-fc-client-ip'], undefined); assert.equal(last.headers['x-forwarded-host'], undefined);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\/catering\//);
    assert.doesNotMatch(cookie, /Secure|Domain=/i);
  });
  await t.test('serves the account center and proxies unified account APIs', async () => {
    assert.match(await (await fetch(base + '/accounts/')).text(), /统一账号/);
    assert.equal((await fetch(base + '/accounts/app.js')).status, 200);
    const response = await fetch(base + '/accounts/api/session');
    assert.equal(response.status, 200); assert.equal(received.at(-1).path, '/accounts/api/session');
    const count = received.length;
    assert.equal((await fetch(base + '/catering/api/account-bridge', { method: 'POST', body: '{}' })).status, 404);
    assert.equal(received.length, count);
  });
  await t.test('authenticates the local catering iframe using the cloud session', async () => {
    assert.equal((await fetch(base + '/catering/original.html')).status, 401);
    const ok = await fetch(base + '/catering/original.html', { headers: { Cookie: 'session=test' } });
    assert.equal(ok.status, 200); assert.match(await ok.text(), /<!doctype html/i);
  });
  await t.test('blocks cross-origin and DNS rebinding requests before forwarding', async () => {
    const count = received.length;
    for (const headers of [{ Origin: 'https://evil.test' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'evil.test' }]) {
      // fetch may replace Host/Sec-Fetch-*; use raw HTTP to exercise the actual headers.
      const status = await new Promise((resolve, reject) => {
        const req = http.request(base + '/hotel/api/state', { method: 'PUT', headers }, res => {
          res.resume(); res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject); req.end('{}');
      });
      assert.equal(status, 403, JSON.stringify(headers));
    }
    assert.equal(received.length, count);
  });
  await t.test('streams SSE without waiting for the cloud connection to close', async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 3000);
    try {
      const response = await fetch(base + '/hotel/api/events', { signal: abort.signal });
      assert.match(response.headers.get('content-type'), /event-stream/);
      const reader = response.body.getReader();
      assert.match(Buffer.from((await reader.read()).value).toString(), /connected/);
      await reader.cancel();
    } finally { clearTimeout(timer); abort.abort(); }
  });
});
