# SPA Proxy: Multi-App Monorepo Support

**Status: ✅ Resolved** (v1.1.0, 2026-09-14; fragment links, resources and API writes in v1.2.0–v1.2.1)

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
