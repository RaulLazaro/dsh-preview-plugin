import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Session-scoped preview state: purged when its session closes, capped with
 * LRU eviction, and never evicting the session whose preview tab is polling.
 *
 * The host half mounts against a temporary DSH_HOME (the user's real state file
 * must never be touched), a listener table stands in for the DSH event catalog
 * (`session/disposed`), and two fixture dev servers make the frontend-port →
 * backend-ports mapping observable through the proxy's injected script
 * (`var BACKENDS = [...]`).
 */

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

/** The backend-port list the proxy injects into HTML: `var BACKENDS = ["3001"]`. */
function backendsIn(html) {
  const match = /var BACKENDS = \[([^\]]*)\]/.exec(html);
  assert.ok(match, 'the proxy interceptor was not injected into the HTML');
  return JSON.parse(`[${match[1]}]`);
}

async function startUpstreams() {
  const handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>app</title></head><body><h1>APP</h1></body></html>');
  };
  const first = http.createServer(handler);
  const second = http.createServer(handler);
  const [firstPort, secondPort] = await Promise.all([listen(first), listen(second)]);
  return {
    first: { server: first, port: firstPort },
    second: { server: second, port: secondPort },
  };
}

/**
 * Mount the plugin's host half. `ctx.on` records listeners per event so a test
 * can play DSH's part and emit `session/disposed` for a given session id.
 */
async function mountHost() {
  const routes = [];
  const listeners = new Map();
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => {};
    },
    webServer: {
      register: (def) => { routes.push(def); return () => {}; },
      registerUpgrade: () => () => {},
    },
  };
  // A distinct specifier per mount: Node caches modules per URL.
  const mod = await import(`../lib/index.js?mount=${Date.now()}${Math.random()}`);
  mod.apply(ctx);

  const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    for (const route of routes) {
      if (pathname === route.path || pathname.startsWith(route.path + '/')) return route.handler(req, res);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no route');
  });
  const port = await listen(server);
  const apiUrl = (suffix = '') => `http://127.0.0.1:${port}/api/preview-port${suffix}`;
  const forSession = (sessionId) => (sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '');

  return {
    get: async (sessionId) => (await fetch(apiUrl(forSession(sessionId)))).json(),
    post: (body, sessionId) => fetch(apiUrl(forSession(sessionId)), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    /** What DSH emits when a session leaves the store: `(session) => …`, session.id. */
    dispose: (sessionId) => {
      for (const listener of listeners.get('session/disposed') ?? []) listener({ id: sessionId });
    },
    proxy: async (targetPort) => (await fetch(`http://127.0.0.1:${port}/preview/${targetPort}/`)).text(),
    close: () => close(server),
  };
}

/** Run one test body against a fresh mount over a temporary DSH_HOME. */
async function withHost(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-preview-state-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let host;
  try {
    host = await mountHost();
    await fn(host);
  } finally {
    if (host) await host.close();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  }
}

/** Run one test body under a specific DSH_PREVIEW_MAX_SESSIONS (undefined = unset). */
async function withMaxSessions(value, fn) {
  const previous = process.env.DSH_PREVIEW_MAX_SESSIONS;
  if (value === undefined) delete process.env.DSH_PREVIEW_MAX_SESSIONS;
  else process.env.DSH_PREVIEW_MAX_SESSIONS = String(value);
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.DSH_PREVIEW_MAX_SESSIONS;
    else process.env.DSH_PREVIEW_MAX_SESSIONS = previous;
  }
}

let upstreams;

before(async () => { upstreams = await startUpstreams(); });
after(async () => {
  if (!upstreams) return;
  await close(upstreams.first.server);
  await close(upstreams.second.server);
});

test('a disposed session’s preview config is purged', async () => {
  await withHost(async (host) => {
    await host.post({ port: 4001, backendPorts: [4002] }, 's1');
    assert.deepEqual(await host.get('s1'), { port: '4001', backendPorts: ['4002'] });

    host.dispose('s1');

    // Without an entry the answer falls back to the global config — the point
    // of the purge is that nothing of s1 is left behind.
    assert.deepEqual(await host.get('s1'), { port: null, backendPorts: [] });
  });
});

test('purging a session releases the port mapping it owned', async () => {
  await withHost(async (host) => {
    const port = upstreams.first.port;
    await host.post({ port, backendPorts: [3001] }, 's1');
    assert.deepEqual(backendsIn(await host.proxy(port)), ['3001'], 'the session owns the mapping while it lives');

    host.dispose('s1');

    assert.deepEqual(backendsIn(await host.proxy(port)), [], 'nothing justifies the mapping anymore');
  });
});

test('a port another session still claims keeps its mapping', async () => {
  await withHost(async (host) => {
    const port = upstreams.first.port;
    await host.post({ port, backendPorts: [3002] }, 's2');
    await host.post({ port, backendPorts: [3001] }, 's1'); // last write wins while both live
    assert.deepEqual(backendsIn(await host.proxy(port)), ['3001']);

    host.dispose('s1');
    assert.deepEqual(backendsIn(await host.proxy(port)), ['3002'], 're-derived from the surviving session');

    host.dispose('s2');
    assert.deepEqual(backendsIn(await host.proxy(port)), [], 'with no claimant left the mapping is dropped');
  });
});

test('the global port keeps its mapping when a session over it is purged', async () => {
  await withHost(async (host) => {
    const port = upstreams.first.port;
    await host.post({ port, backendPorts: [3001] });
    await host.post({ port, backendPorts: [9999] }, 's1');
    assert.deepEqual(backendsIn(await host.proxy(port)), ['9999']);

    host.dispose('s1');

    assert.deepEqual(backendsIn(await host.proxy(port)), ['3001'], 'the global config is authoritative for its own port');
  });
});

test('a session that moves to another port releases the previous one', async () => {
  await withHost(async (host) => {
    const first = upstreams.first.port;
    const second = upstreams.second.port;
    await host.post({ port: first, backendPorts: [3001] }, 's1');
    await host.post({ port: second, backendPorts: [3002] }, 's1');

    assert.deepEqual(backendsIn(await host.proxy(second)), ['3002']);
    assert.deepEqual(backendsIn(await host.proxy(first)), [], 'the port the session left has no claimant');
  });
});

test('changing the global port releases the mapping it left behind', async () => {
  await withHost(async (host) => {
    const first = upstreams.first.port;
    const second = upstreams.second.port;
    await host.post({ port: first, backendPorts: [3001] });
    await host.post({ port: second, backendPorts: [3002] });

    assert.deepEqual(backendsIn(await host.proxy(second)), ['3002']);
    assert.deepEqual(backendsIn(await host.proxy(first)), [], 'a replaced global port must not leak an entry');
  });
});

test('sessions beyond the cap are evicted least-recently-written first', async () => {
  await withMaxSessions(2, async () => {
    await withHost(async (host) => {
      await host.post({ port: 4001 }, 's1');
      await host.post({ port: 4002 }, 's2');
      await host.post({ port: 4003 }, 's3');

      assert.deepEqual(await host.get('s1'), { port: null, backendPorts: [] },
        'the least recently written session is gone');
      assert.equal((await host.get('s2')).port, '4002');
      assert.equal((await host.get('s3')).port, '4003');
    });
  });
});

test('the session whose preview is polling is never evicted', async () => {
  await withMaxSessions(2, async () => {
    await withHost(async (host) => {
      await host.post({ port: 4001 }, 's1');
      await host.post({ port: 4002 }, 's2');
      // The preview tab of s1 polls its config: that is the session on screen.
      await host.get('s1');
      await host.post({ port: 4003 }, 's3');

      assert.equal((await host.get('s1')).port, '4001', 'the active session kept its entry');
      assert.deepEqual(await host.get('s2'), { port: null, backendPorts: [] },
        'the next-oldest session gave up its slot instead');
      assert.equal((await host.get('s3')).port, '4003');
    });
  });
});

test('an active session that is disposed stops being protected', async () => {
  await withMaxSessions(2, async () => {
    await withHost(async (host) => {
      await host.get('s1');   // s1’s preview tab polls: s1 becomes active
      host.dispose('s1');     // …and then its session closes
      await host.post({ port: 4001 }, 's1');
      await host.post({ port: 4002 }, 's2');
      await host.post({ port: 4003 }, 's3');

      assert.deepEqual(await host.get('s1'), { port: null, backendPorts: [] },
        'a closed session must not pin a slot forever');
      assert.equal((await host.get('s2')).port, '4002');
      assert.equal((await host.get('s3')).port, '4003');
    });
  });
});

test('the cap defaults to 64 tracked sessions', async () => {
  await withMaxSessions(undefined, async () => {
    await withHost(async (host) => {
      for (let i = 1; i <= 65; i += 1) await host.post({ port: 4000 + i }, `s${i}`);

      assert.deepEqual(await host.get('s1'), { port: null, backendPorts: [] },
        'the 65th session pushed the oldest one out');
      assert.equal((await host.get('s2')).port, '4002', 'the default cap must be 64, not 32 or 128');
      assert.equal((await host.get('s65')).port, '4065');
    });
  });
});

test('an unusable cap value falls back to the default', async () => {
  await withMaxSessions('0', async () => {
    await withHost(async (host) => {
      // "0" is unusable — at least the active session must always fit — so it
      // falls back to the default of 64 rather than disabling storage.
      for (let i = 1; i <= 65; i += 1) await host.post({ port: 4000 + i }, `s${i}`);

      assert.deepEqual(await host.get('s1'), { port: null, backendPorts: [] });
      assert.equal((await host.get('s2')).port, '4002');
      assert.equal((await host.get('s65')).port, '4065');
    });
  });
});
