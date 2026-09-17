import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { apply } from '../lib/index.js';

/**
 * End-to-end regression tests for the /preview proxy.
 *
 * A fixture site stands in for a dev server and the real proxy (same code the
 * host half mounts) is served on a second port. The assertions that matter are
 * about fragment links: the proxy injects <base href="/preview/PORT/">, so
 * "#section" must NOT be allowed to resolve into a different path.
 */

function page(title, body) {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}
const tall = (id, label) => `<section id="${id}" style="min-height:1500px;background:#eee">${label}</section>`;

const FIXTURE = {
  '/': page('home', `
    <h1 id="home-h1">HOME</h1>
    <a id="same" href="#section-a">jump same page</a>
    <a id="empty" href="#">empty hash</a>
    <a id="to-other-hash" href="/other#target">other + hash</a>
    <a id="to-other" href="/other">other</a>
    ${tall('section-a', 'SECTION A')}
  `),
  '/sub': page('sub', `
    <h1 id="sub-h1">SUB</h1>
    <a id="same" href="#section-a">jump same page</a>
    <a id="empty" href="#">empty hash</a>
    <div style="min-height:1500px"></div>
    ${tall('section-a', 'SECTION A')}
  `),
  '/other': page('other', `
    <h1 id="other-h1">OTHER</h1>
    ${tall('spacer', 'SPACER')}
    <section id="target" style="min-height:400px;background:#ddd">TARGET</section>
  `),
  '/late': page('late', `
    <h1 id="late-h1">LATE</h1>
    <div style="min-height:1500px"></div>
    <script>setTimeout(function(){
      var d=document.createElement('div');d.id='late-target';d.style.minHeight='300px';
      document.body.appendChild(d);
    },400);</script>
  `),
};

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function startFixture() {
  const server = http.createServer((req, res) => {
    const body = FIXTURE[new URL(req.url, 'http://localhost').pathname];
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
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

let fixture;
let proxy;
let browser;
let base;
let skipBrowser = null;

before(async () => {
  fixture = await startFixture();
  proxy = await startProxy();
  base = `http://127.0.0.1:${proxy.port}/preview/${fixture.port}`;
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    skipBrowser = 'playwright-core is not installed (run: pnpm install)';
    return;
  }
  try {
    browser = await chromium.launch();
  } catch (err) {
    skipBrowser = `cannot launch chromium: ${err.message.split('\n')[0]}`;
  }
});

after(async () => {
  if (browser) await browser.close();
  if (proxy) await new Promise((r) => proxy.server.close(r));
  if (fixture) await new Promise((r) => fixture.server.close(r));
});

async function withPage(fn) {
  const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const browserPage = await context.newPage();
  try {
    return await fn(browserPage);
  } finally {
    await context.close();
  }
}

const snapshot = (browserPage) => browserPage.evaluate(() => ({
  url: location.href,
  hash: location.hash,
  scrollY: Math.round(window.scrollY),
  heading: (document.querySelector('h1') || {}).textContent,
  sectionTop: (() => {
    const el = document.getElementById('section-a');
    return el ? Math.round(el.getBoundingClientRect().top) : null;
  })(),
}));

test('fragment link on a sub page stays on that page', async (t) => {
  if (skipBrowser) return t.skip(skipBrowser);
  await withPage(async (browserPage) => {
    await browserPage.goto(`${base}/sub`, { waitUntil: 'load' });
    await browserPage.click('#same');
    await browserPage.waitForTimeout(300);
    const state = await snapshot(browserPage);
    assert.equal(state.heading, 'SUB', `left the page (${state.url})`);
    assert.equal(state.hash, '#section-a');
    assert.ok(state.scrollY > 500, `did not scroll to the fragment (scrollY=${state.scrollY})`);
    assert.ok(Math.abs(state.sectionTop) < 200, `fragment is out of view (top=${state.sectionTop})`);
  });
});

test('href="#" does not navigate to the site root', async (t) => {
  if (skipBrowser) return t.skip(skipBrowser);
  await withPage(async (browserPage) => {
    await browserPage.goto(`${base}/sub`, { waitUntil: 'load' });
    await browserPage.click('#empty');
    await browserPage.waitForTimeout(300);
    const state = await snapshot(browserPage);
    assert.equal(state.heading, 'SUB', `left the page (${state.url})`);
  });
});

test('cross-page link with a fragment lands on the fragment', async (t) => {
  if (skipBrowser) return t.skip(skipBrowser);
  await withPage(async (browserPage) => {
    await browserPage.goto(`${base}/`, { waitUntil: 'load' });
    await browserPage.click('#to-other-hash');
    await browserPage.waitForTimeout(500);
    const state = await snapshot(browserPage);
    assert.equal(state.heading, 'OTHER', `wrong page (${state.url})`);
    assert.equal(state.hash, '#target');
    assert.ok(state.scrollY > 1000, `did not scroll to the target (scrollY=${state.scrollY})`);
  });
});

test('plain links still navigate', async (t) => {
  if (skipBrowser) return t.skip(skipBrowser);
  await withPage(async (browserPage) => {
    await browserPage.goto(`${base}/`, { waitUntil: 'load' });
    await browserPage.click('#to-other');
    await browserPage.waitForTimeout(300);
    assert.equal((await snapshot(browserPage)).heading, 'OTHER');
  });
});

test('a fragment whose target renders later is still reached', async (t) => {
  if (skipBrowser) return t.skip(skipBrowser);
  await withPage(async (browserPage) => {
    await browserPage.goto(`${base}/late#late-target`, { waitUntil: 'load' });
    await browserPage.waitForTimeout(1500);
    const state = await snapshot(browserPage);
    assert.ok(state.scrollY > 1000, `did not scroll to the late target (scrollY=${state.scrollY})`);
  });
});

test('the proxy injects the base tag and the interceptor only into HTML', async () => {
  const html = await (await fetch(`${base}/sub`)).text();
  assert.match(html, new RegExp(`<base href="/preview/${fixture.port}/">`));
  assert.match(html, /jumpToFragmentWithRetry/);
});
