import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { apply } from '../lib/index.js';

/**
 * Request-side hardening of the /preview proxy.
 *
 * The proxy's only target is 127.0.0.1, so the things that can go wrong are
 * the *other* ends of the exchange: which web sites are allowed to read what a
 * local dev server answers (CORS), how big a port number we are willing to
 * build a URL from, and how much of a request body we are willing to hold in
 * memory before forwarding it.
 */

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const PAGE = '<!doctype html><html><head><title>fixture</title></head><body><h1>FIXTURE</h1></body></html>';

function startUpstream() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/echo') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, received: Buffer.concat(chunks).toString('utf8') }));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return listen(server).then((port) => ({ server, port }));
}

/** Mount the plugin's host half against a minimal webServer stub. */
function startProxy() {
  const routes = [];
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
    on: () => () => {},
    webServer: {
      register: (def) => { routes.push(def); return () => {}; },
      registerUpgrade: () => () => {},
    },
  };
  apply(ctx);

  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    for (const route of routes) {
      if (pathname === route.path || pathname.startsWith(route.path + '/')) return route.handler(req, res);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no route');
  });
  return listen(server).then((port) => ({ server, port }));
}

/** Raw request so tests can set (and omit) headers no browser would send. */
function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let upstream;
let proxy;
let base;

before(async () => {
  upstream = await startUpstream();
  proxy = await startProxy();
  base = `http://127.0.0.1:${proxy.port}`;
});

after(async () => {
  if (proxy) { proxy.server.closeAllConnections(); await new Promise((r) => proxy.server.close(r)); }
  if (upstream) { upstream.server.closeAllConnections(); await new Promise((r) => upstream.server.close(r)); }
});

test('a foreign origin cannot read proxied responses', async () => {
  const res = await request(proxy.port, `/preview/${upstream.port}/`, {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(res.status, 200, 'the request itself still works');
  assert.equal(res.headers['access-control-allow-origin'], undefined,
    'a foreign origin must not be told it may read a local dev server');
  assert.equal(res.headers['access-control-allow-methods'], undefined);
  const serialized = JSON.stringify(res.headers);
  assert.ok(!serialized.includes('*'), `no wildcard CORS header may remain: ${serialized}`);
});

test('a cross-origin preflight is refused', async () => {
  const res = await request(proxy.port, `/preview/${upstream.port}/`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://evil.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(res.status, 403);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.match(res.body, /cross-origin/);
});

test('the DSH origin itself is still answered', async () => {
  const origin = `http://127.0.0.1:${proxy.port}`;
  const res = await request(proxy.port, `/preview/${upstream.port}/echo`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'content-length': '2' },
    body: '{}',
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], origin,
    'the preview tab runs on the DSH origin and must keep working');
  assert.equal(res.headers.vary, 'origin');

  const preflight = await request(proxy.port, `/preview/${upstream.port}/`, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], origin);
});

test('ports outside 1-65535 are refused before anything is dialled', async () => {
  for (const bad of ['99999', '0', '00000', 'abc']) {
    const res = await request(proxy.port, `/preview/${bad}/`);
    assert.equal(res.status, 400, `port "${bad}" must be refused`);
    assert.match(res.body, /invalid port/);
  }
});

test('a request body over the cap is refused instead of buffered', async () => {
  const previous = process.env.DSH_PREVIEW_MAX_BODY_BYTES;
  process.env.DSH_PREVIEW_MAX_BODY_BYTES = '1024';
  try {
    // Declared length over the cap: refused without reading a single chunk.
    const declared = await request(proxy.port, `/preview/${upstream.port}/echo`, {
      method: 'POST',
      headers: { 'content-length': String(8192) },
      body: 'x'.repeat(8192),
    });
    assert.equal(declared.status, 413);
    assert.match(declared.body, /request body exceeds 1024 bytes/);
    assert.equal(declared.headers.connection, 'close');

    // Same payload without a declared length (chunked): caught mid-stream.
    const chunked = await request(proxy.port, `/preview/${upstream.port}/echo`, {
      method: 'POST',
      body: 'y'.repeat(8192),
    });
    assert.equal(chunked.status, 413);
    assert.match(chunked.body, /request body exceeds 1024 bytes/);

    // A body under the cap still reaches the app.
    const small = await request(proxy.port, `/preview/${upstream.port}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    assert.equal(small.status, 200);
    assert.equal(JSON.parse(small.body).received, JSON.stringify({ hello: 'world' }));
  } finally {
    if (previous === undefined) delete process.env.DSH_PREVIEW_MAX_BODY_BYTES;
    else process.env.DSH_PREVIEW_MAX_BODY_BYTES = previous;
  }
});

test('the port config endpoint refuses oversized bodies too', async () => {
  const res = await request(proxy.port, '/api/preview-port', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port: 4321 }).padEnd(100 * 1024, ' '),
  });
  assert.equal(res.status, 413);
  assert.match(res.body, /request body exceeds \d+ bytes/);
});
