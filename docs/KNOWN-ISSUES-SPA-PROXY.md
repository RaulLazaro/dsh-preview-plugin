# SPA Proxy: Multi-App Monorepo Support

**Status: ✅ Resolved** (v1.1.0, 2026-09-14; fragment links, resources and API writes in v1.2.0–v1.2.1; proxy hardening in v1.3.1)

## Original Problem

When previewing a frontend that depends on a backend running on a different port, the SPA proxy broke:

- Navigation links returned 404
- API calls to backend ports failed (CORS or wrong origin)
- SPA client-side routing didn't work (full page reloads)

## What Was Fixed

### 1. Absolute URL rewriting (PR #2)

The interceptor now rewrites absolute URLs pointing to configured backend ports:

```javascript
// Before: http://localhost:3001/api/... → passes through unchanged
// After:  http://localhost:3001/api/... → /preview/3001/api/...
```

Also rewrites absolute frontend URLs:

```javascript
// Before: http://localhost:4321/path → passes through unchanged
// After:  http://localhost:4321/path → /preview/4321/path
```

### 2. SPA navigation routing

The proxy now detects static assets by file extension and serves them directly. For all other paths (SPA navigation), it serves the root HTML from the dev server so the client-side router handles routing.

```
/preview/4321/laptops     → serves root HTML (SPA route)
/preview/4321/_astro/app.js → proxies asset directly
/preview/4321/favicon.svg  → proxies asset directly
```

> Historical note: the "always serve the root HTML" rule was later dropped
> because it broke Vite's extension-less URLs (`/@vite/client`, `/@id/…`).
> §13 below reintroduces a narrower rule — only when the upstream really
> answers `404` — with regression tests.

### 3. Clean URLs for SPA router

The iframe keeps the real proxy path (`/preview/4321/laptops`) — an earlier attempt
to strip it with `history.replaceState` was removed (see git history) because it
desynchronised the address bar from what was actually loaded. The proxy strips the
prefix server-side instead, so the router only ever sees upstream paths.

### 4. Agent tool

The `set_preview_port` tool lets the agent configure ports programmatically:

```
set_preview_port(port: 4321, backendPorts: [3001])
```

### 5. Fragment links (`#section`) sent the visitor to the site root (v1.2.0)

- **Symptom.** On any page below the root — e.g. `/es/privacy` — clicking one of its
  own in-page links (`#cookies`, the `#main-content` skip link, `href="#"`) left the
  page and landed on the home page.
- **Cause.** The proxy injects `<base href="/preview/4321/">`. A fragment reference is
  resolved against the **document base URL**, so from `/preview/4321/es/privacy` the
  browser computed `/preview/4321/#cookies`: a different *path*, therefore a full
  navigation — the proxy served the root HTML.
- **Fix.** The injected interceptor handles fragment-only links itself
  (`preventDefault` + same-document `location.hash`, which the `<base>` cannot affect).
  Cross-page links that carry a fragment (`/other#target`) keep working, and a
  fragment whose target is rendered after load is retried for a few seconds.
- **Regression tests.** `test/preview-proxy.test.mjs` (fixture site + Playwright).

### 6. Root-relative images and `srcset` 404'd (v1.2.0)

- **Symptom.** Product images rendered (the site prefixes them itself) but store logos
  were broken: `GET http://<dsh-host>/api/media/file/store-amazon-es.svg → 404`, while
  `/preview/4321/api/media/file/...` answered 200.
- **Cause.** A `<base href="/preview/4321/">` only affects **truly relative** URLs.
  Anything starting with `/` resolves against the **origin**, so `/api/media/...` asked
  the DSH host for a file that only exists on the dev server. The proxy rewrote
  `<script src>` and `<link href>` server-side and anchors on click, but nothing rewrote
  resource attributes — so `<img src>`, `srcset`, `poster` and JS-inserted nodes were
  left pointing at the origin root. The site worked around it in its own code, which is
  why only the images rebuilt later (after its boot script had run) were affected.
- **Fix.** Root-relative resource URLs are now rewritten in two layers: the initial HTML
  is rewritten server-side, and the injected interceptor rewrites them at runtime —
  `setAttribute` is wrapped, and a `MutationObserver` covers nodes inserted later
  (`innerHTML`, `new Image()`, dynamically added stylesheets). 22/22 images load on the
  laptop-comparator listing page with no 4xx at all.
- **Regression test.** `root-relative resources load through the proxy` in
  `test/preview-proxy.test.mjs` (static `<img>`, `<picture><source srcset>`, `poster`,
  `new Image()`, `innerHTML`, injected stylesheet).

### 7. Writes never reached the API (v1.2.1)

- **Symptom.** In the preview, logging in or submitting a form did nothing useful: the
  API answered `403 {"errors":[{"message":"You are not allowed to perform this action."}]}`
  — Payload's reply to a **GET** on a POST-only route.
- **Cause.** The proxy issued `fetch(targetUrl, { headers })` with no `method` and no
  body, so every request reached the upstream as a GET, and `PUT`/`PATCH`/`DELETE` were
  rejected with 405 before that. A direct POST to the same route returns 400
  ("This field is required: email"), which is how the two were told apart.
- **Fix.** The proxy now forwards the method, the request headers (minus hop-by-hop ones)
  and the body, and returns `Set-Cookie`, `Location` and `Allow` upstream. HTML rewriting
  is limited to GET/HEAD so an API response that happens to be HTML is left alone.
- **Regression tests.** `the proxy forwards the HTTP method and the request body` and
  `the proxy passes request cookies through and returns upstream cookies`.

### 8. A site that already prefixes its own URLs got a double prefix (v1.2.2)

- **Symptom.** Every stylesheet and image in the preview 404'd on
  `/preview/4321/preview/4321/_astro/...`.
- **Cause.** The site's build was emitting `/preview/4321/...` URLs already (a build
  with a base path). The proxy's `<link href>` and CSS `url(/...)` rules prefixed
  unconditionally, while the `src`/`srcset` rules checked first — so the same HTML was
  rewritten twice.
- **Fix.** Every prefix rule now goes through `prefixRootRelative()`, which leaves
  absolute (`//host/...`) and already-prefixed URLs alone. The proxy is idempotent, so
  it works whether the app emits root-relative or preview-prefixed URLs.
- **Regression test.** `an already-prefixed URL is not prefixed twice` (the fixture
  serves a page whose HTML already carries the prefix, plus nested asset paths).

### 9. Navigation left the preview, and the port config died with the process (v1.3.0)

- **Symptom.** Three kinds of navigation escaped `/preview/PORT/` and landed on the DSH
  origin: the app's own forms (`<form action="/laptops">`), its `history.pushState`
  calls, and links with `target="_blank"`. Separately, the port configuration was lost
  on every DSH restart because the plugin only kept it in memory.
- **Cause (navigation).** Only anchors and `fetch`/XHR were rewritten. A form action, a
  history entry or a new tab is not a click on a link, so nothing prefixed them.
- **Cause (state).** `globalPort`/`globalBackendPorts` were module-level variables and
  the host half is re-imported on every restart.
- **Fix.** The interceptor also rewrites `action`, wraps `history.pushState` /
  `history.replaceState` and `window.open`, and prefixes the `href` of links that open
  elsewhere before letting the browser follow them. The config is written to
  `${DSH_HOME:-~/.dsh}/preview-plugin.json` on every change and read when the plugin
  mounts, so a restart keeps previewing the same thing.
- **Hard limit.** `location.href`, `location.assign` and `location.replace` are
  `[LegacyUnforgeable]`: Chrome installs them as non-configurable own properties of the
  `location` object, so no injected script can rewrite them. The preview tab detects the
  escape and loads that path under the proxy again (amber notice), but the durable fix
  belongs in the app (build the URL from its base) — see the README.
- **Regression tests.** `navigation APIs keep the preview prefix`,
  `an app that leaves the proxy is brought back inside it` and
  `test/host-state.test.mjs` (fresh mount per restart, corrupt file tolerated).

### 10. Any web site could read the proxied dev servers (v1.3.1)

- **Symptom.** The proxy answered every response — and every preflight — with
  `access-control-allow-origin: *`.
- **Cause.** Convenience for local development, added before the proxy grew its
  current shape. A wildcard `ACAO` means the browser hands the response body to
  *any* page that asks, so a web site the user visits could walk
  `http://<dsh-host>:<port>/preview/1…/`, learn which loopback ports are alive
  and read what they serve, all from the user's own browser.
- **Fix.** The preview is same-origin by design (the iframe lives on the DSH
  origin), so CORS now only echoes an `Origin` that matches the DSH `Host`
  header, and a cross-origin preflight is refused with `403`. Requests without
  an `Origin` header are unaffected.
- **Regression tests.** `a foreign origin cannot read proxied responses`,
  `a cross-origin preflight is refused`, `the DSH origin itself is still answered`.

### 11. The proxy buffered anything it was asked to forward (v1.3.1)

- **Symptom.** A request body of any size was read into memory before it was
  forwarded, and `/preview/<n>` accepted `<n>` values that are not TCP ports
  (`99999`), which only failed later as a confusing `502`.
- **Cause.** No bound on `readRawBody()`, and the port check was a `^\d{1,5}$
  regex instead of a range.
- **Fix.** Bodies are capped (8 MiB for the proxy, 64 KiB for the port API;
  `DSH_PREVIEW_MAX_BODY_BYTES` overrides both) and answered with `413` +
  `connection: close` — checked against the declared `Content-Length` first and
  again mid-stream for chunked requests. Every entry point (proxy, WebSocket
  upgrade, port API, `set_preview_port` tool) now validates the port as
  1–65535, and out-of-range values posted to the API are dropped instead of
  stored.
- **Regression tests.** `ports outside 1-65535 are refused before anything is
  dialled`, `a request body over the cap is refused instead of buffered`,
  `the port config endpoint refuses oversized bodies too`.

### 12. A wedged dev server held a preview request open forever (v1.3.1)

- **Symptom.** Saving a file that made the dev server restart, or any upstream
  that went silent mid-response, left the preview hanging with no answer; a
  failure after the first byte could also throw `ERR_HTTP_HEADERS_SENT` while
  reporting it.
- **Cause.** The 15 s timer stopped the moment the upstream sent its headers,
  so the body phase had no bound at all, and the error path always called
  `writeHead()` even when bytes were already on the wire.
- **Fix.** One timer governs the whole exchange, refreshed on every chunk
  (a *stall* timeout, so a slow but talking upstream is never cut): silent
  before the first byte → `502 upstream timeout`; silent after → the response is
  torn down. Errors after the first byte destroy the response instead of
  writing a second status line.
- **Regression tests.** `an upstream that goes silent before the page is
  finished answers 502`, `an upstream that stalls mid-stream is torn down and
  the proxy survives`, `a slow but talking upstream is never cut off`.

### 13. Deep links the dev server 404'd never booted the SPA (v1.3.1)

- **Symptom.** Refreshing a client-side route (e.g. `/preview/4321/shop/laptop`
  on a dev server without a history fallback) showed the dev server's `404`
  instead of the app, so the router never started.
- **Cause.** Since v1.1.0 the proxy passes everything straight through — which
  was the right fix for §2's broken extension-less Vite URLs, but it also
  dropped the documented SPA fallback (README: "SPA navigation serves root
  HTML").
- **Fix.** The root HTML is used only when *all* of these hold: the upstream
  really answered `404`, the request is a `GET`/`HEAD` whose `Accept` includes
  `text/html` (a top-level navigation), and the path has no file extension. The
  browser keeps the deep link; the shell is fetched from `/` and injected as
  usual. Missing assets, API `404`s, `POST`s and every path the dev server does
  serve keep their real answer — the regression that forced §2's revert.
- **Regression tests.** `test/spa-fallback.test.mjs`: the shell for an unknown
  deep link, the real `404` for a missing asset, an API `404`, a rejected
  `POST`, and a served extension-less path (`/src/main`).

## Configuration

What to preview is set via:

- **UI**: the **URL** field (port, path, proxy path or dev-server URL) plus the
  comma-separated **Backend** ports field
- **API**: `POST /api/preview-port { "port": 4321, "backendPorts": [3001] }`
- **Tool**: `set_preview_port(port: 4321, backendPorts: [3001])`

## Testing

Tested with laptop-comparator (Astro :4321 + Payload CMS :3001):

| Scenario | Before | After |
|----------|--------|-------|
| Relative URLs (`/path`) | ✅ | ✅ |
| Absolute frontend URLs | ❌ 404/bypass | ✅ Rewritten |
| Absolute backend URLs | ❌ CORS/bypass | ✅ Proxied |
| SPA navigation | ❌ Full reload | ✅ Client-side |
| Static assets | ✅ | ✅ |
| CORS headers | ✅ | ✅ |
