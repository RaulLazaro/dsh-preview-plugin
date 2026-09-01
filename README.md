# DSH Preview Plugin

Live preview tab for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) — embed any dev server in an iframe with transparent SPA proxying.

## Features

- **Path-based SPA proxy**: `/preview/:port/*` rewrites all routes so the embedded app works as if served from the DSH host
- **`<base>` + fetch/XHR interception**: Injects a `<base href>` tag and intercepts `fetch()` and `XMLHttpRequest.open()` for full SPA + backend support
- **Global or per-session ports**: Set a port globally or per conversation session via the API
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

### 2. Register the plugin

In your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-preview
      name: 'dsh-preview-plugin'
```

### 3. Restart DSH

```bash
dsh web
```

## Usage

1. Start your dev server on the VPS (e.g. `npm run dev -- --host 0.0.0.0 --port 3000`)
2. Open the **Preview** tab in DSH Web GUI
3. Enter the port number (e.g. `3000`) and click **Go**
4. The iframe will load the app through the transparent proxy

### API

The plugin exposes a port management API:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/preview-port` | Get the current global port |
| `GET` | `/api/preview-port?sessionId=<id>` | Get port for a session (falls back to global) |
| `POST` | `/api/preview-port` | Set global port (`{ "port": 3000 }`) |
| `POST` | `/api/preview-port?sessionId=<id>` | Set port for a session |

## How It Works

1. The host registers two routes on the DSH web server:
   - `/api/preview-port` — port management
   - `/preview/:port/*` — transparent proxy
2. When a request hits `/preview/:port/path`, it fetches `http://127.0.0.1:port/path`
3. For HTML responses, it injects a `<base href="/preview/:port/">` and a script that rewrites `fetch()` and `XMLHttpRequest.open()` URLs
4. For non-HTML responses (JS, CSS, images, etc.), it streams the response directly

## Security Notes

- The proxy only targets `127.0.0.1` — no external SSRF possible
- The iframe is sandboxed with `allow-scripts allow-same-origin allow-forms allow-popups`
- Port validation enforces 1–5 digit numbers only
- CORS headers are set for local development convenience

## License

MIT
