export const name = 'dsh-preview';
export const inject = ['webServer'];

export function apply(ctx) {
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
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing url parameter' }));
            return;
          }

          let parsed;
          try {
            parsed = new URL(target);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid url' }));
            return;
          }

          if (!['http:', 'https:'].includes(parsed.protocol)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'only http/https allowed' }));
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
              const pump = async () => {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) { res.end(); return; }
                  res.write(value);
                }
              };
              await pump();
            } else {
              const text = await upstream.text();
              res.end(text);
            }
          } catch (err) {
            const msg = err?.name === 'AbortError'
              ? 'upstream timeout'
              : `fetch failed: ${err?.message ?? err}`;
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: msg }));
          }
        },
      });
    } catch (err) {
      console.error('[dsh-preview] /api/preview-proxy route registration failed:', err);
      return () => {};
    }
  });
}
