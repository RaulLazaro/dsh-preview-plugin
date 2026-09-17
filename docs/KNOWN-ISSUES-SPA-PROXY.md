# SPA Proxy: Multi-App Monorepo Support

**Status: ✅ Resolved** (v1.1.0, 2026-09-14; fragment links in v1.2.0)

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
