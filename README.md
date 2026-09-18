# DSH Preview Plugin

Live preview tab for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — embed any dev server in an iframe with transparent SPA proxying.

## Features

- **Path-based SPA proxy**: `/preview/:port/*` rewrites all routes so the embedded app works as if served from the DSH host
- **Editable URL bar**: type a port, a path, a proxy path or a dev-server URL to move the preview wherever you need; the bar follows links clicked inside the page
- **Multi-app monorepo support**: Configure backend ports to proxy API calls through the same iframe (e.g. Astro frontend + Payload CMS backend)
- **Smart routing**: Static assets (JS, CSS, images) are proxied directly; SPA navigation serves root HTML so the client-side router handles routing
- **Fragment-link safe**: `#section` links jump inside the page instead of reloading the site root, and anchors rendered after load are still reached
- **Root-relative resources work**: `/assets/photo.png`, `srcset` and `poster` are rewritten too, so images and lazy-loaded stylesheets load instead of 404ing against the DSH host
- **Absolute URL rewriting**: Intercepts `fetch()` and `XMLHttpRequest.open()` to rewrite both relative and absolute URLs (e.g. `http://localhost:3001/api/...` → `/preview/3001/api/...`)
- **Real API traffic**: Method, body, cookies and `Set-Cookie` are forwarded, so the embedded app can log in, submit forms and use `PUT`/`PATCH`/`DELETE` — not just serve pages
- **Agent tool**: `set_preview_port` tool lets the agent configure ports programmatically when starting dev servers
- **Global or per-session ports**: Set ports globally or per conversation session via the API
- **Auto-sync**: The preview tab polls the host for agent-set port changes
- **Sandboxed iframe**: `allow-scripts allow-same-origin allow-forms allow-popups` for secure embedding

## Installation

### 1. Add as a dependency

In your DSH web profile's `package.json`:

```json
{
  "dependencies": {
    "dsh-preview-plugin": "file:~/workspace/dsh-preview-plugin"
  }
}
```

### 2. Add to bundles

In your profile's `package.json`, add `dsh-preview-plugin` to the `dsh.profile.bundles` array:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-preview-plugin"
      ]
    }
  }
}
```

### 3. Restart DSH

```bash
systemctl restart dsh
```

## Usage

### Basic (single server)

1. Start your dev server on the VPS (e.g. `npm run dev -- --host 0.0.0.0 --port 3000`)
2. Open the **Preview** tab in DSH Web GUI
3. Type the port (e.g. `3000`) in the **URL** field and click **Go**

The field then switches to the page being shown (e.g. `/preview/3000/laptops?page=2#specs`),
so you can edit it at any time and press **Enter** to load something else.

### Navigating

The **URL** field accepts all of these:

| You type | It loads |
|----------|----------|
| `4321` | port 4321, root page |
| `4321/laptops` | port 4321, `/laptops` |
| `/laptops?page=2` | that path on the port already in use |
| `laptops` | same as `/laptops` |
| `?page=2` / `#specs` | the current page with that query/fragment |
| `/preview/4321/laptops` | a proxy path, as-is |
| `http://localhost:4321/laptops` | the dev-server URL |

Non-local URLs are rejected (the proxy only reaches `127.0.0.1`). **↻** reloads the
page currently shown, **↗** opens it in a browser tab of its own.

### Multi-app monorepo

1. Start both servers:
   ```bash
   # Backend (e.g. Payload CMS)
   cd apps/backend && pnpm dev  # port 3001
   
   # Frontend (e.g. Astro)
   cd apps/web && pnpm dev      # port 4321
   ```

2. Open the **Preview** tab
3. Type `4321` in **URL** and `3001` in **Backend** (comma-separated for multiple)
4. Click **Go** — API calls to `http://localhost:3001/api/...` are automatically proxied through `/preview/3001/api/...`

### Agent tool

The agent can configure ports programmatically using the `set_preview_port` tool:

```
set_preview_port(port: 4321, backendPorts: [3001])
```

This updates the interceptor script and client UI automatically.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/preview-port` | Get the current global port and backend ports |
| `GET` | `/api/preview-port?sessionId=<id>` | Get ports for a session (falls back to global) |
| `POST` | `/api/preview-port` | Set global ports (`{ "port": 4321, "backendPorts": [3001] }`) |
| `POST` | `/api/preview-port?sessionId=<id>` | Set ports for a session |

## How It Works

1. The host registers three routes on the DSH web server:
   - `/api/preview-port` — port management
   - `/preview/:port/*` — transparent proxy
2. **Static assets** (files with extensions like `.js`, `.css`, `.png`) are proxied directly from the requested path
3. **SPA navigation** (all other paths) serves the root HTML from the dev server, so the client-side router handles routing
4. For HTML responses, it injects:
   - `<base href="/preview/:port/">` for relative URL resolution
   - An interceptor script that:
     - Handles fragment links (`#section`) itself: with a `<base>` tag they would otherwise
       resolve to `/preview/:port/#section`, a *different path*, and reload the site root
       instead of jumping inside the page. Targets that appear later (SPA sections) are
       retried for a few seconds.
     - Rewrites `fetch()` and `XMLHttpRequest.open()` URLs (relative, absolute frontend, and absolute backend)
     - Rewrites root-relative resource URLs (`src`, `srcset`, `poster`, `data-src`, and
       resource `<link href>`) on nodes added by JS — a `<base>` tag only affects truly
       relative URLs, so `"/assets/x.png"` would otherwise be fetched from the DSH host
5. Resource URLs in the initial HTML are rewritten server-side, before the page is sent
6. Requests keep their method, headers and body, and `Set-Cookie` comes back, so
   sessions and writes work inside the preview
7. For non-HTML responses, it streams the response directly

## Testing

```bash
pnpm install
pnpm test
```

`node --test` runs three suites:

| Suite | What it covers |
|-------|----------------|
| `test/client-helpers.test.mjs` | URL/port parsing (`resolveTarget`) and proxy-path helpers |
| `test/preview-view.test.mjs` | The Preview tab component with real React and happy-dom |
| `test/preview-proxy.test.mjs` | The proxy end-to-end against a fixture site with Playwright (skipped when Chromium is unavailable) |

## Security Notes

- The proxy only targets `127.0.0.1` — no external SSRF possible
- The iframe is sandboxed with `allow-scripts allow-same-origin allow-forms allow-popups`
- Port validation enforces 1–5 digit numbers only
- Backend ports are validated and stored per frontend port
- CORS headers are set for local development convenience

## License

MIT
