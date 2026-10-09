# Changelog

All notable changes to `dsh-preview-plugin` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.3.2 — 2026-10-09

### Fixed

- **Per-session preview state is purged when its session closes.** The host
  now listens for DSH's `session/disposed` and drops everything the session
  contributed: its entry in the in-memory maps, plus any frontend-port →
  backend-ports mapping only that session justified. Previously nothing
  reacted to a session closing, so a long-lived box collected orphaned
  entries forever.
- **A port mapping never outlives what justifies it.** The mapping is
  re-derived from the state that remains — the global config is authoritative
  for its own port, otherwise the most recently written surviving session —
  and dropped when nothing points at the port anymore. Changing the global
  port or moving a session to another frontend port now releases the mapping
  it replaced instead of leaking it.

### Added

- **A hard cap on tracked sessions with LRU eviction** as a safety net for
  sessions whose `session/disposed` never arrives: `DSH_PREVIEW_MAX_SESSIONS`
  (default 64; values below 1 fall back to the default) bounds the per-session
  maps, evicting the least recently written session first. The *active*
  session — the one whose preview tab last polled
  `GET /api/preview-port?sessionId=…`, i.e. the session on screen — is never
  evicted, and a disposed active session stops being protected.

### Tests

- 46 → 57 tests: `test/session-state.test.mjs` covers the purge on
  `session/disposed`, port-mapping ownership (session, shared and global),
  eviction over the cap and the active-session exemption.

## 1.3.1 — 2026-10-08

### Security

- **CORS on `/preview/:port/*` is same-origin only.** The proxy used to answer
  every response (and every preflight) with `access-control-allow-origin: *`,
  which told the browser it could hand a proxied response to *any* page: a web
  site the user visited could enumerate every loopback port behind DSH and read
  what those ports serve. The `Origin` is now echoed only when it matches the
  DSH `Host` header, and a cross-origin preflight is refused with `403`.
- **Ports must be real TCP ports (1–65535)** at every entry point: the proxy,
  the WebSocket upgrade, the port API and the `set_preview_port` tool. Out-of-
  range values posted to the API are dropped instead of stored.

### Fixed

- **Request bodies are bounded.** A body larger than the cap (8 MiB for the
  proxy, 64 KiB for the port API; `DSH_PREVIEW_MAX_BODY_BYTES` overrides) is
  answered with `413` and a closed connection instead of being buffered
  without a limit — checked against the declared `Content-Length` first and
  again mid-stream for chunked uploads.
- **The upstream exchange is bounded end to end.** The 15 s timer used to stop
  the moment the headers arrived, leaving the body phase unbounded; it is now a
  stall timeout refreshed on every chunk (`DSH_PREVIEW_TIMEOUT_MS`, default
  15000), so a wedged dev server answers `502 upstream timeout` instead of
  hanging, while a slow but talking upstream is never cut off.
- **A failure after the first byte tears the response down** instead of calling
  `writeHead()` on a response that already had one (`ERR_HTTP_HEADERS_SENT`).
- **SPA fallback is back, narrowly scoped.** A top-level HTML navigation
  (`Accept` includes `text/html`, no file extension) that the dev server
  answers with `404` is served the app shell so client-side routes boot again.
  Missing assets, API `404`s, writes and every path the dev server does serve
  keep their real answer — the extension-less Vite URLs (`/@vite/client`,
  `/@id/…`) that forced the earlier revert are untouched.

### Changed

- `npm test` now runs `node --test test/*.mjs`, the same command as CI.
- README and `docs/KNOWN-ISSUES-SPA-PROXY.md` describe the actual routing,
  limit and CORS rules (§10–§13).

### Tests

- 32 → 46 tests: `test/proxy-security.test.mjs`, `test/proxy-timeout.test.mjs`
  and `test/spa-fallback.test.mjs`.

## 1.3.0 — 2026-09-18

### Added

- The port configuration persists to `${DSH_HOME:-~/.dsh}/preview-plugin.json`
  and is restored on the next DSH start (a corrupt file is ignored).
- Navigation stays inside the proxy: form actions, `history.pushState` /
  `history.replaceState`, `window.open` and links that open a new tab all keep
  the `/preview/:port/` prefix; the tab brings back an iframe that escaped through
  `location.href`.

### Fixed

- A URL that already carries the preview prefix is never prefixed twice.
- The proxy forwards the request method, headers and body, and returns
  `Set-Cookie`, `Location` and `Allow`, so logins and API writes work.

## 1.2.x — 2026-09-17/18

- Fragment links (`#section`) jump inside the page instead of reloading the
  site root, including targets rendered after load.
- Root-relative resources (`src`, `srcset`, `poster`, resource `<link href>`)
  are rewritten server-side and at runtime, so images and lazy stylesheets load.
- The editable URL bar accepts a port, a path, a proxy path or a dev-server URL
  and follows navigation inside the iframe.

## 1.1.0 — 2026-09-14

- Multi-app monorepo support: absolute frontend/backend URLs are rewritten
  through the proxy, an import map and a WebSocket mock cover Vite/Astro dev
  servers, and the `set_preview_port` tool configures ports for the agent.
