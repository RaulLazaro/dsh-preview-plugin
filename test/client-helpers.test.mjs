import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url));

/**
 * The client half is a browser bundle: it registers itself on
 * window.__ModuleLoader__ and receives `require` from the loader. Stub both so
 * its pure helpers can be exercised in Node.
 */
function loadClient() {
  let definition = null;
  globalThis.window = {
    location: { host: 'dsh.example:3080', origin: 'http://dsh.example:3080', protocol: 'http:' },
    __ModuleLoader__: { load: (def) => { definition = def; } },
  };
  new Function(readFileSync(clientPath, 'utf8'))();
  assert.ok(definition, 'the bundle did not register itself on window.__ModuleLoader__');
  const fakeReact = {
    useState() {}, useRef() {}, useCallback() {}, useEffect() {}, createElement() {},
  };
  const mod = definition.factory((id) => {
    if (id === 'react') return fakeReact;
    throw new Error(`unexpected require("${id}")`);
  });
  return mod.__internals;
}

const api = loadClient();

test('previewPathFor builds proxy paths', () => {
  assert.equal(api.previewPathFor('4321', '/'), '/preview/4321/');
  assert.equal(api.previewPathFor('4321', '/laptops?page=2#top'), '/preview/4321/laptops?page=2#top');
  assert.equal(api.previewPathFor('4321', 'laptops'), '/preview/4321/laptops');
  assert.equal(api.previewPathFor('', '/laptops'), '');
});

test('parseBackendPorts ignores junk', () => {
  assert.deepEqual(api.parseBackendPorts('3001, 3002'), ['3001', '3002']);
  assert.deepEqual(api.parseBackendPorts('3001, nope, '), ['3001']);
  assert.deepEqual(api.parseBackendPorts(''), []);
});

test('resolveTarget accepts a bare port', () => {
  assert.deepEqual(api.resolveTarget('4321', '', ''), { port: '4321', path: '/' });
  assert.deepEqual(api.resolveTarget(' 4321 ', '3000', ''), { port: '4321', path: '/' });
});

test('resolveTarget accepts a port with a path', () => {
  assert.deepEqual(api.resolveTarget('4321/laptops', '', ''), { port: '4321', path: '/laptops' });
});

test('resolveTarget accepts a path on the current port', () => {
  const current = '/preview/4321/';
  assert.deepEqual(api.resolveTarget('/laptops', '4321', current), { port: '4321', path: '/laptops' });
  assert.deepEqual(api.resolveTarget('laptops?a=1', '4321', current), { port: '4321', path: '/laptops?a=1' });
});

test('resolveTarget accepts a proxy path', () => {
  assert.deepEqual(api.resolveTarget('/preview/4321/laptops', '9999', ''), { port: '4321', path: '/laptops' });
});

test('resolveTarget accepts a dev-server URL', () => {
  assert.deepEqual(
    api.resolveTarget('http://localhost:4321/laptops?page=2', '', ''),
    { port: '4321', path: '/laptops?page=2' },
  );
  assert.deepEqual(
    api.resolveTarget('http://127.0.0.1:3001/api/health', '', ''),
    { port: '3001', path: '/api/health' },
  );
});

test('resolveTarget accepts a full preview URL', () => {
  assert.deepEqual(
    api.resolveTarget('http://dsh.example:3080/preview/4321/es/privacy#cookies', '', ''),
    { port: '4321', path: '/es/privacy#cookies' },
  );
});

test('resolveTarget keeps the current path for bare query/fragment input', () => {
  const current = '/preview/4321/es/privacy';
  assert.deepEqual(api.resolveTarget('?page=2', '4321', current), { port: '4321', path: '/es/privacy?page=2' });
  assert.deepEqual(api.resolveTarget('#cookies', '4321', current), { port: '4321', path: '/es/privacy#cookies' });
  // ...and does not double-prefix when the suffix is applied to a proxy path
  assert.equal(api.previewPathFor('4321', api.resolveTarget('#cookies', '4321', current).path), '/preview/4321/es/privacy#cookies');
});

test('resolveTarget rejects what cannot be previewed', () => {
  assert.ok(api.resolveTarget('', '4321', '').error);
  assert.ok(api.resolveTarget('https://example.com/page', '4321', '').error);
  assert.ok(api.resolveTarget('not a url', '', '').error);
  assert.ok(api.resolveTarget('http://[::bad', '4321', '').error);
});

test('inPreviewPath strips only the matching prefix', () => {
  assert.equal(api.inPreviewPath('/preview/4321/es/privacy?x=1', '4321'), '/es/privacy');
  assert.equal(api.inPreviewPath('/preview/4321/', '4321'), '/');
  assert.equal(api.inPreviewPath('/plain/path', '4321'), '/plain/path');
});
