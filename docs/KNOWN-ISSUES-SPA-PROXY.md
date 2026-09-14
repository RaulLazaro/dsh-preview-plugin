# Known Issues: SPA Proxy with Multi-App Monorepos

**Affected apps:** Any app with a separate backend on a different port (e.g., Astro + Payload CMS, Next.js + Express, Vite + API server)

**Reported:** 2026-09-14  
**Tested with:** laptop-comparator (Astro :4321 + Payload CMS :3001)

---

## Problem Summary

When previewing a frontend that depends on a backend running on a different port, **most things break**:

- Navigation links return 404
- Static assets (JS, CSS, images) return 404
- API calls fail (CORS or wrong origin)
- SPA client-side routing doesn't work

## Root Cause Analysis

The current proxy intercepts `fetch()` and `XMLHttpRequest.open()` and rewrites relative URLs (`/path` → `/preview/4321/path`). The `<base href>` tag handles most static assets.

**However, 3 classes of URLs are NOT intercepted:**

### 1. Absolute API URLs (the biggest issue)

Frontend code makes API calls with absolute URLs:

```typescript
// apps/web/src/lib/auth.ts
const API_URL = import.meta.env.PUBLIC_PAYLOAD_URL || 'http://localhost:3001'
const res = await fetch(`${API_URL}/api/users/login`, { ... })
```

The interceptor only rewrites strings starting with `/`:

```javascript
function rewriteUrl(u) {
  if (typeof u === "string" && u.startsWith("/") && !u.startsWith(PREFIX))
    return PREFIX + u.slice(1);
  return u;  // ← absolute URLs pass through unchanged
}
```

**Result:** `http://localhost:3001/api/users/login` stays as-is → browser tries to reach port 3001 directly → fails (different origin, CORS blocked, or port unreachable).

### 2. Navigation Links (hardcoded absolute paths)

Astro pages use `getRelativeLocaleUrl()` which generates absolute paths:

```astro
<a href={getRelativeLocaleUrl(locale, '/laptops')}>Portátiles</a>
<!-- Renders as: <a href="/laptops">Portátiles</a> -->
```

The `<base href="/preview/4321/">` should handle this, but:
- If the HTML is fetched through the proxy, the `<base>` tag is injected ✅
- If the HTML is generated client-side (SPA navigation), the `<base>` may not apply correctly

### 3. Asset URLs in HTML

```html
<script src="/_astro/chunk.abc123.js"></script>
<link href="/_astro/style.xyz789.css" rel="stylesheet">
```

The `<base href="/preview/4321/">` tag handles these correctly IF the `<head>` contains the base tag. The current `injectBase()` function does this.

## Reproduction

1. Start a multi-app project:
   ```bash
   # Terminal 1: Backend
   cd apps/payload && pnpm dev  # port 3001
   
   # Terminal 2: Frontend
   cd apps/web && pnpm dev      # port 4321
   ```

2. Set preview port to `4321` in DSH

3. Open the Preview tab — the page loads but:
   - Navigation links (`/laptops`, `/compare`) → 404
   - Login/register forms fail (API calls to `:3001` bypass proxy)
   - Price charts don't load (data fetched from `:3001`)
   - Search doesn't work (Typesense via `:3001`)

## Suggested Fixes

### Option A: Proxy all configured ports (recommended)

Instead of proxying a single port, proxy multiple ports based on a configuration:

```json
{
  "preview": {
    "ports": {
      "frontend": 4321,
      "backend": 3001
    }
  }
}
```

The proxy would:
- `/preview/4321/*` → `http://localhost:4321/*` (frontend)
- `/preview/3001/*` → `http://localhost:3001/*` (backend)
- Rewrite absolute URLs in HTML: `http://localhost:3001` → `/preview/3001`
- Rewrite `fetch("http://localhost:3001/...")` → `fetch("/preview/3001/...")`

### Option B: Rewrite absolute URLs in intercepted fetch

Extend the `INTERCEPT_SCRIPT` to also catch absolute URLs pointing to known backend ports:

```javascript
var BACKEND_PORTS = [3001]; // configurable
var _fetch = window.fetch;
window.fetch = function(input, init) {
  if (typeof input === "string") {
    for (var i = 0; i < BACKEND_PORTS.length; i++) {
      var pattern = "http://localhost:" + BACKEND_PORTS[i];
      if (input.startsWith(pattern)) {
        input = "/preview/" + BACKEND_PORTS[i] + input.slice(pattern.length);
        break;
      }
    }
    // ... existing relative URL rewriting
  }
};
```

### Option C: Environment variable override (app-side fix)

The app could be configured to use relative URLs when loaded in the preview iframe:

```typescript
// Detect if running inside DSH preview
const isPreview = window !== window.parent && window.location.pathname.startsWith('/preview/')

// Use relative API URL when in preview
const API_URL = isPreview 
  ? '/preview/3001'  // proxied backend
  : import.meta.env.PUBLIC_PAYLOAD_URL || 'http://localhost:3001'
```

This is a per-app fix, not a plugin fix, but would work immediately.

## Files Involved

| File | Role |
|------|------|
| `lib/index.js` | Server-side proxy (`/preview/:port/*`) + `<base>` injection |
| `lib/client.js` | Client-side UI (port input, iframe, polling) |
| `INTERCEPT_SCRIPT` in `index.js` | `fetch()` and `XMLHttpRequest.open()` interception |

## Current Behavior vs Expected

| What | Current | Expected |
|------|---------|----------|
| Relative URLs (`/path`) | ✅ Rewritten to `/preview/4321/path` | ✅ |
| Absolute frontend URLs (`http://localhost:4321/path`) | ❌ Pass through unchanged | Should rewrite |
| Absolute backend URLs (`http://localhost:3001/api/...`) | ❌ Pass through unchanged | Should proxy through `/preview/3001/` |
| `<base href>` for assets | ✅ Injected in `<head>` | ✅ |
| Navigation links (client-side) | ⚠️ Depends on `<base>` tag | Should always work |
| CORS headers | ✅ Added by proxy | ✅ |
