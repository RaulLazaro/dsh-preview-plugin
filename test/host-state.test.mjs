import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The port config is state the user set on purpose, so it has to outlive the
 * process: the host half is re-imported on every DSH restart. These tests mount
 * the plugin twice against a temporary DSH_HOME and check the file in between.
 */

async function mountFresh() {
  const routes = [];
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    server,
    port,
    url: (suffix = '') => `http://127.0.0.1:${port}/api/preview-port${suffix}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('the preview port config outlives a restart', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-preview-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let first;
  let second;
  try {
    first = await mountFresh();
    const empty = await (await fetch(first.url())).json();
    assert.deepEqual(empty, { port: null, backendPorts: [] });

    await fetch(first.url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 4321, backendPorts: [3001] }),
    });

    const saved = JSON.parse(await fs.readFile(path.join(home, 'preview-plugin.json'), 'utf8'));
    assert.deepEqual(saved, { port: '4321', backendPorts: ['3001'] });
    await first.close();
    first = null;

    // A fresh mount stands in for the host half being imported after a restart.
    second = await mountFresh();
    const restored = await (await fetch(second.url())).json();
    assert.deepEqual(restored, { port: '4321', backendPorts: ['3001'] });

    // Per-session answers still fall back to the restored global.
    const perSession = await (await fetch(second.url('?sessionId=unknown'))).json();
    assert.deepEqual(perSession, { port: '4321', backendPorts: ['3001'] });
  } finally {
    if (first) await first.close();
    if (second) await second.close();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('a corrupt state file does not stop the plugin from mounting', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-preview-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  let mounted;
  try {
    await fs.writeFile(path.join(home, 'preview-plugin.json'), '{not json');
    mounted = await mountFresh();
    const state = await (await fetch(mounted.url())).json();
    assert.deepEqual(state, { port: null, backendPorts: [] });
  } finally {
    if (mounted) await mounted.close();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
});
