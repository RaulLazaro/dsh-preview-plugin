import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { apply } from '../lib/index.js';

/**
 * Time bounds of the /preview proxy.
 *
 * The old timeout stopped as soon as the upstream sent its headers, so a dev
 * server that went quiet while streaming — a restart, a wedged transform —
 * held the preview request (and its socket) open forever. And a failure after
 * the first byte used to go through `json(res, 502, …)`, i.e. `writeHead` on a
 * response that already had one, which throws on top of the original error.
 *
 * The bound is a *stall* timeout: refreshed by every chunk, so a slow but
 * talking upstream is never cut off.
 */

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const HTML = '<!doctype html><html><head><title>slow</title></head><body><h1>SLOW</h1></body></html>';

function startUpstream() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    res.on('error', () => {}); // the proxy is allowed to walk away mid-response

    if (pathname === '/stall-html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.write(HTML.slice(0, 20));
      return; // never ends
    }
    if (pathname === '/stall-stream') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial');
      return; // never ends
    }
    if (pathname === '/drip') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      let sent = 0;
      const id = setInterval(() => {
        sent += 1;
        res.write(`chunk-${sent} `);
        if (sent === 5) { clearInterval(id); res.end('done'); }
      }, 150);
      res.on('close', () => clearInterval(id));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('alive');
  });
  return listen(server).then((port) => ({ server, port }));
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

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
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

/** A response that stops mid-body: resolve how the client saw it, never hang. */
function getAndWatch(port, path) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve({ outcome: 'completed', status: res.statusCode }));
      res.on('aborted', () => resolve({ outcome: 'aborted' }));
      res.on('error', (err) => resolve({ outcome: 'error', message: err.message }));
    });
    req.on('error', (err) => resolve({ outcome: 'request-error', message: err.message }));
    req.end();
  });
}

async function withTimeoutEnv(ms, fn) {
  const previous = process.env.DSH_PREVIEW_TIMEOUT_MS;
  process.env.DSH_PREVIEW_TIMEOUT_MS = String(ms);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.DSH_PREVIEW_TIMEOUT_MS;
    else process.env.DSH_PREVIEW_TIMEOUT_MS = previous;
  }
}

let upstream;
let proxy;

before(async () => {
  upstream = await startUpstream();
  proxy = await startProxy();
});

after(async () => {
  if (proxy) { proxy.server.closeAllConnections(); await new Promise((r) => proxy.server.close(r)); }
  if (upstream) { upstream.server.closeAllConnections(); await new Promise((r) => upstream.server.close(r)); }
});

test('an upstream that goes silent before the page is finished answers 502', { timeout: 5000 }, async () => {
  await withTimeoutEnv(400, async () => {
    const started = Date.now();
    const res = await get(proxy.port, `/preview/${upstream.port}/stall-html`);
    assert.equal(res.status, 502);
    assert.match(res.body, /upstream timeout/);
    assert.ok(Date.now() - started < 3000, 'the reply must arrive while the upstream is still silent');
  });
});

test('an upstream that stalls mid-stream is torn down and the proxy survives', { timeout: 5000 }, async () => {
  await withTimeoutEnv(400, async () => {
    const result = await getAndWatch(proxy.port, `/preview/${upstream.port}/stall-stream`);
    assert.ok(['aborted', 'error', 'request-error'].includes(result.outcome),
      `expected the client connection to be torn down, saw ${JSON.stringify(result)}`);

    // The headers were already on the wire: the only safe answer is tearing the
    // response down — and the process must still be serving afterwards.
    const alive = await get(proxy.port, `/preview/${upstream.port}/`);
    assert.equal(alive.status, 200);
    assert.equal(alive.body, 'alive');
  });
});

test('a slow but talking upstream is never cut off', { timeout: 5000 }, async () => {
  await withTimeoutEnv(500, async () => {
    const res = await get(proxy.port, `/preview/${upstream.port}/drip`);
    assert.equal(res.status, 200);
    assert.equal(res.body, 'chunk-1 chunk-2 chunk-3 chunk-4 chunk-5 done');
  });
});
