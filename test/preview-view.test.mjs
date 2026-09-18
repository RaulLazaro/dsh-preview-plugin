import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Window } from 'happy-dom';

/**
 * Component test for the Preview tab.
 *
 * The client half is a browser bundle (it registers on window.__ModuleLoader__
 * and loads React from the host's module system), so it is booted the same way
 * the GUI boots it: a fake window with a module loader, real React, happy-dom.
 */

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url));

const PORT = '4321';
const ORIGIN = 'http://dsh.example:3080';

/** Minimal stand-in for what the injected proxy leaves in the iframe. */
function fakeIframeLocation(path) {
  const [pathname, hash = ''] = path.split('#');
  const [p, search = ''] = pathname.split('?');
  return {
    pathname: p,
    search: search ? `?${search}` : '',
    hash: hash ? `#${hash}` : '',
    reload() { this.reloads = (this.reloads || 0) + 1; },
  };
}

async function mount({ port = PORT, iframePath = '/preview/4321/' } = {}) {
  const win = new Window({ url: `${ORIGIN}/` });
  const requests = [];
  const opened = [];

  win.localStorage.setItem('dsh.preview.port', port);
  win.localStorage.setItem('dsh.preview.backendPorts', '3001');
  win.fetch = async (url, init) => {
    requests.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return { json: async () => ({}) };
  };
  win.open = (url) => { opened.push(url); return null; };

  // The iframe is never really navigated: hand the component a location object.
  const iframeLocation = fakeIframeLocation(iframePath);
  Object.defineProperty(win.HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get() { return { location: iframeLocation }; },
  });

  const globals = ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Event', 'Node', 'fetch'];
  const saved = {};
  const define = (key, value) => {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  };
  for (const key of globals) define(key, key === 'fetch' ? win.fetch : win[key]);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  let definition = null;
  win.__ModuleLoader__ = { load: (def) => { definition = def; } };
  new Function(readFileSync(clientPath, 'utf8'))();

  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');

  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  const root = createRoot(host);
  const mod = definition.factory((id) => {
    if (id === 'react') return React;
    throw new Error(`unexpected require("${id}")`);
  });

  // The tab component is registered through the slots service.
  let PreviewView = null;
  mod.apply({ slots: { inject: (_name, fn) => fn(), register: (_def, Component) => { PreviewView = Component; } } });
  assert.ok(PreviewView, 'the plugin did not register a conversation view');

  await act(async () => { root.render(React.createElement(PreviewView, { sessionId: 's1' })); });

  const ui = {
    win, requests, opened, iframeLocation, act,
    input: () => host.querySelector('input'),
    backend: () => host.querySelectorAll('input')[1],
    iframe: () => host.querySelector('iframe'),
    button: (label) => [...host.querySelectorAll('button')].find((b) => b.textContent === label),
    text: () => host.textContent,
    async type(element, value) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
        setter.call(element, value);
        element.dispatchEvent(new win.Event('input', { bubbles: true }));
      });
    },
    async click(element) {
      await act(async () => { element.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); });
    },
    async keydown(element, key) {
      await act(async () => { element.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true })); });
    },
    async fireLoad() {
      await act(async () => { ui.iframe().dispatchEvent(new win.Event('load', { bubbles: true })); });
    },
    async unmount() {
      await act(async () => { root.unmount(); });
      for (const key of globals) {
        if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
        else delete globalThis[key];
      }
      await win.happyDOM.close().catch(() => {});
    },
  };
  return ui;
}

test('renders the address bar and the iframe for the stored port', async () => {
  const ui = await mount();
  try {
    assert.equal(ui.input().value, '/preview/4321/');
    assert.equal(ui.iframe().getAttribute('src'), '/preview/4321/');
    assert.match(ui.text(), /Frontend: 4321/);
    assert.match(ui.text(), /Backend: 3001/);
  } finally { await ui.unmount(); }
});

test('the address bar navigates the iframe to a path', async () => {
  const ui = await mount();
  try {
    await ui.type(ui.input(), '/laptops?page=2');
    await ui.click(ui.button('Go'));
    assert.equal(ui.iframe().getAttribute('src'), '/preview/4321/laptops?page=2');
    assert.equal(ui.input().value, '/preview/4321/laptops?page=2');
  } finally { await ui.unmount(); }
});

test('a dev-server URL switches the previewed port', async () => {
  const ui = await mount();
  try {
    await ui.type(ui.input(), 'http://localhost:9999/compare?ids=a,b');
    await ui.keydown(ui.input(), 'Enter');
    assert.equal(ui.iframe().getAttribute('src'), '/preview/9999/compare?ids=a,b');
    const post = ui.requests.find((r) => r.body && r.body.port === '9999');
    assert.ok(post, 'the port change was not reported to the host');
    assert.deepEqual(post.body.backendPorts, ['3001']);
    assert.match(ui.text(), /Frontend: 9999/);
  } finally { await ui.unmount(); }
});

test('a bare fragment is kept on the current page', async () => {
  const ui = await mount({ iframePath: '/preview/4321/es/privacy' });
  try {
    await ui.fireLoad();
    assert.equal(ui.input().value, '/preview/4321/es/privacy');
    await ui.type(ui.input(), '#cookies');
    await ui.click(ui.button('Go'));
    assert.equal(ui.iframe().getAttribute('src'), '/preview/4321/es/privacy#cookies');
  } finally { await ui.unmount(); }
});

test('the address bar follows in-iframe navigation', async () => {
  const ui = await mount({ iframePath: '/preview/4321/es/privacy#cookies' });
  try {
    await ui.fireLoad();
    assert.equal(ui.input().value, '/preview/4321/es/privacy#cookies');
  } finally { await ui.unmount(); }
});

test('what cannot be previewed is reported instead of silently loading', async () => {
  const ui = await mount();
  try {
    await ui.type(ui.input(), 'https://example.com/page');
    await ui.click(ui.button('Go'));
    assert.match(ui.text(), /Only local dev servers/);
    assert.equal(ui.iframe().getAttribute('src'), '/preview/4321/');
  } finally { await ui.unmount(); }
});

test('reload and open-in-new-tab act on the current page', async () => {
  const ui = await mount({ iframePath: '/preview/4321/compare?ids=a' });
  try {
    await ui.fireLoad();
    await ui.click(ui.button('\u21bb'));
    assert.equal(ui.iframeLocation.reloads, 1);
    await ui.click(ui.button('\u2197'));
    assert.deepEqual(ui.opened, [`${ORIGIN}/preview/4321/compare?ids=a`]);
  } finally { await ui.unmount(); }
});
