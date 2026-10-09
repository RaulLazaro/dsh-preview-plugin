import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { apply } from '../lib/index.js';

/**
 * SPA fallback: a deep link the dev server answers with 404 is a client-side
 * route, so the proxy serves the app shell and the router boots.
 *
 * The rule has to stay narrow — an earlier version served the root HTML for
 * *every* non-asset path and broke Vite's extension-less URLs (`/@vite/client`,
 * `/@id/…`). Here the shell is only used when the upstream really answered
 * 404, the request is a top-level HTML navigation, and the path has no file
 * extension; everything the dev server does serve passes through untouched.
 */

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const SHELL = '<!doctype html><html><head><title>shell</title></head><body><h1>SHELL</h1></body></html>';

function startUpstream() {
  const shellRequests = [];
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/') {
      shellRequests.push(req.url);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(SHELL);
      return;
    }
    if (pathname === '/src/main') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('export const x = 1;');
      return;
    }
    if (pathname === '/api/items') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"nope"}');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return listen(server).then((port) => ({ server, port, shellRequests }));
}

/** Mount the plugin's host half against a minimal webServer stub. */
function startProxy() {
  const routes = [];
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
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

const NAVIGATION = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

function request(port, path, { method = 'GET', headers = {} } = {}) {
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
    req.end();
  });
}

let upstream;
let proxy;
let base;

before(async () => {
  upstream = await startUpstream();
  proxy = await startProxy();
  base = `/preview/${upstream.port}`;
});

after(async () => {
  if (proxy) { proxy.server.closeAllConnections(); await new Promise((r) => proxy.server.close(r)); }
  if (upstream) { upstream.server.closeAllConnections(); await new Promise((r) => upstream.server.close(r)); }
});

test('a deep link the dev server does not know serves the app shell', async () => {
  upstream.shellRequests.length = 0;
  const res = await request(proxy.port, `${base}/shop/laptop?tab=specs`, {
    headers: { accept: NAVIGATION },
  });
  assert.equal(res.status, 200, 'the shell is the answer, not the 404');
  assert.match(res.body, /<h1>SHELL<\/h1>/);
  assert.match(res.body, new RegExp(`<base href="${base}/">`));
  assert.match(res.body, /jumpToFragmentWithRetry/, 'the interceptor is injected as usual');
  // The shell itself was fetched from the root; the visitor keeps the deep link.
  assert.deepEqual(upstream.shellRequests, ['/']);
});

test('an asset that really is missing keeps its 404', async () => {
  const res = await request(proxy.port, `${base}/missing.js`, { headers: { accept: NAVIGATION } });
  assert.equal(res.status, 404);
  assert.equal(res.body, 'not found');
});

test('an API 404 is never replaced by the shell', async () => {
  const res = await request(proxy.port, `${base}/api/items`, { headers: { accept: '*/*' } });
  assert.equal(res.status, 404);
  assert.equal(res.body, '{"error":"nope"}');
});

test('a write that the upstream rejects keeps its 404', async () => {
  const res = await request(proxy.port, `${base}/api/things`, {
    method: 'POST',
    headers: { accept: NAVIGATION, 'content-type': 'application/json' },
  });
  assert.equal(res.status, 404);
  assert.equal(res.body, 'not found');
});

test('paths the dev server does serve are passed through untouched', async () => {
  const res = await request(proxy.port, `${base}/src/main`, { headers: { accept: '*/*' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/javascript');
  assert.equal(res.body, 'export const x = 1;', 'the shell must never mask a served resource');
});
