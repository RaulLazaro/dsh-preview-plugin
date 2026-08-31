export const name = 'dsh-preview';
export const inject = ['webServer'];

const sessionPorts = new Map();

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function apply(ctx) {
  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'prefix',
        path: '/api/preview-port',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '', 'http://localhost');
          const sessionId = url.searchParams.get('sessionId');

          if (!sessionId) {
            return json(res, 400, { error: 'missing sessionId' });
          }

          if (req.method === 'GET') {
            const port = sessionPorts.get(sessionId);
            return json(res, 200, { port: port || null });
          }

          if (req.method === 'POST') {
            try {
              const body = await readBody(req);
              const { port } = JSON.parse(body);
              if (port === null || port === undefined) {
                sessionPorts.delete(sessionId);
              } else {
                sessionPorts.set(sessionId, String(port));
              }
              return json(res, 200, { ok: true });
            } catch {
              return json(res, 400, { error: 'invalid body' });
            }
          }

          res.writeHead(405);
          res.end('method not allowed');
        },
      });
    } catch (err) {
      console.error('[dsh-preview] /api/preview-port route registration failed:', err);
      return () => {};
    }
  });

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'prefix',
        path: '/api/preview-proxy',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405);
            res.end('method not allowed');
            return;
          }

          const url = new URL(req.url ?? '', 'http://localhost');
          const target = url.searchParams.get('url');

          if (!target) {
            json(res, 400, { error: 'missing url parameter' });
            return;
          }

          let parsed;
          try {
            parsed = new URL(target);
          } catch {
            json(res, 400, { error: 'invalid url' });
            return;
          }

          if (!['http:', 'https:'].includes(parsed.protocol)) {
            json(res, 400, { error: 'only http/https allowed' });
            return;
          }

          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);

            const upstream = await fetch(parsed.href, {
              signal: controller.signal,
              headers: { 'User-Agent': 'DSH-Preview/1.0' },
            });
            clearTimeout(timeout);

            const contentType = upstream.headers.get('content-type') ?? 'text/html';
            res.writeHead(upstream.status, {
              'content-type': contentType,
              'cache-control': 'no-cache',
            });

            if (upstream.body) {
              const reader = upstream.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) { res.end(); return; }
                res.write(value);
              }
            } else {
              const text = await upstream.text();
              res.end(text);
            }
          } catch (err) {
            const msg = err?.name === 'AbortError'
              ? 'upstream timeout'
              : `fetch failed: ${err?.message ?? err}`;
            json(res, 502, { error: msg });
          }
        },
      });
    } catch (err) {
      console.error('[dsh-preview] /api/preview-proxy route registration failed:', err);
      return () => {};
    }
  });
}
