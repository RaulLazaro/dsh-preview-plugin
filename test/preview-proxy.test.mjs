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
  '/media': page('media', `
    <h1 id="media-h1">MEDIA</h1>
    <img id="static" src="/asset/static.png" width="4" height="4" alt="">
    <picture>
      <source srcset="/asset/source.png 1x">
      <img id="picture" src="/asset/picture.png" width="4" height="4" alt="">
    </picture>
    <video id="video" poster="/asset/poster.png" width="4" height="4"></video>
    <div id="slot"></div>
    <script>
      var created = new Image();
      created.id = 'dynamic'; created.width = 4; created.height = 4;
      created.src = '/asset/dynamic.png';
      document.body.appendChild(created);
      setTimeout(function(){
        document.getElementById('slot').innerHTML = '<img id="late" src="/asset/late.png" width="4" height="4" alt="">';
        var link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = '/asset/extra.css';
        document.head.appendChild(link);
      }, 200);
    </script>
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

// A 1x1 PNG: real bytes, so `naturalWidth` proves the image actually loaded.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function startFixture() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/echo') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          contentType: req.headers['content-type'] || null,
          cookie: req.headers.cookie || null,
          body: raw ? JSON.parse(raw) : null,
        }));
      });
      return;
    }
    if (pathname === '/setcookie') {
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'preview_probe=42; Path=/' });
      res.end('cookie set');
      return;
    }
    if (pathname.startsWith('/asset/')) {
      if (pathname.endsWith('.css')) {
        res.writeHead(200, { 'content-type': 'text/css' });
        res.end('#media-h1 { color: rgb(1, 2, 3); }');
      } else {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG);
      }
      return;
    }
    const body = FIXTURE[pathname];
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
  // Anything the page asked for and did not get: a proxied site must not 404.
  browserPage.failedResponses = [];
  browserPage.on('response', (r) => {
    if (r.status() >= 400) browserPage.failedResponses.push(`${r.status()} ${r.url()}`);
  });
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

test('root-relative resources load through the proxy', async (t) => {
  if (skipBrowser) return t.skip(skipBrowser);
  await withPage(async (browserPage) => {
    await browserPage.goto(`${base}/media`, { waitUntil: 'load' });
    await browserPage.waitForTimeout(1500);
    const state = await browserPage.evaluate(() => ({
      images: [...document.images].map((i) => ({ src: i.getAttribute('src'), loaded: i.complete && i.naturalWidth > 0 })),
      stylesheet: (() => {
        const link = document.querySelector('link[rel="stylesheet"][href*="extra.css"]');
        return link && link.getAttribute('href');
      })(),
      colour: getComputedStyle(document.getElementById('media-h1')).color,
    }));
    assert.equal(state.images.length, 4, `expected 4 images, got ${state.images.length}`);
    for (const image of state.images) {
      assert.ok(
        String(image.src).startsWith(`/preview/${fixture.port}/`),
        `${image.src} was not proxied (root-relative URLs ignore the base tag)`,
      );
      assert.ok(image.loaded, `${image.src} did not load`);
    }
    assert.equal(state.stylesheet, `/preview/${fixture.port}/asset/extra.css`);
    assert.equal(state.colour, 'rgb(1, 2, 3)', 'the injected stylesheet did not apply');
    assert.deepEqual(browserPage.failedResponses, []);
  });
});

test('the proxy forwards the HTTP method and the request body', async (t) => {
  if (skipBrowser) return t.skip(skipBrowser);
  await withPage(async (browserPage) => {
    await browserPage.goto(`${base}/media`, { waitUntil: 'load' });
    const result = await browserPage.evaluate(async (port) => {
      const call = async (method, body) => {
        const init = { method };
        if (body !== undefined) {
          init.headers = { 'content-type': 'application/json' };
          init.body = JSON.stringify(body);
        }
        return (await fetch(`/preview/${port}/echo`, init)).json();
      };
      return {
        post: await call('POST', { hello: 'world' }),
        put: await call('PUT', { n: 1 }),
        patch: await call('PATCH', { n: 2 }),
        delete: await call('DELETE'),
      };
    }, fixture.port);
    assert.equal(result.post.method, 'POST');
    assert.deepEqual(result.post.body, { hello: 'world' });
    assert.equal(result.put.method, 'PUT');
    assert.deepEqual(result.put.body, { n: 1 });
    assert.equal(result.patch.method, 'PATCH');
    assert.equal(result.delete.method, 'DELETE');
  });
});

test('the proxy passes request cookies through and returns upstream cookies', async (t) => {
  if (skipBrowser) return t.skip(skipBrowser);
  await withPage(async (browserPage) => {
    await browserPage.goto(`${base}/media`, { waitUntil: 'load' });
    const result = await browserPage.evaluate(async (port) => {
      await fetch(`/preview/${port}/setcookie`);
      const seen = await (await fetch(`/preview/${port}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
      return { cookie: document.cookie, upstreamSaw: seen.cookie };
    }, fixture.port);
    assert.match(result.cookie, /preview_probe=42/);
    assert.match(String(result.upstreamSaw), /preview_probe=42/);
  });
});

test('the proxy injects the base tag and the interceptor only into HTML', async () => {
  const html = await (await fetch(`${base}/sub`)).text();
  assert.match(html, new RegExp(`<base href="/preview/${fixture.port}/">`));
  assert.match(html, /jumpToFragmentWithRetry/);
});
