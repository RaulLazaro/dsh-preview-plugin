# SPA Proxy: Multi-App Monorepo Support

**Status: ✅ Resolved** (v1.1.0, 2026-09-14)

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

The interceptor calls `history.replaceState` to strip the `/preview/PORT/` prefix from the iframe URL, so the SPA router sees clean paths:

```
Browser URL: /preview/4321/laptops
Router sees: /laptops
```

### 4. Agent tool

The `set_preview_port` tool lets the agent configure ports programmatically:

```
set_preview_port(port: 4321, backendPorts: [3001])
```

## Configuration

Backend ports are configured via:

- **UI**: Enter comma-separated ports in the "Backend" field
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
