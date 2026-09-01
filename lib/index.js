export const name = 'dsh-preview';
export const inject = ['webServer'];

let globalPort = null;
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

const INTERCEPT_SCRIPT = `
<script>
(function(){
  var PREFIX = "/preview/PORT/";
  function rewriteUrl(u){
    if(typeof u==="string" && u.startsWith("/") && !u.startsWith(PREFIX))
      return PREFIX + u.slice(1);
    return u;
  }
  var _fetch = window.fetch;
  window.fetch = function(input,init){
    if(typeof input==="string") input = rewriteUrl(input);
    else if(input instanceof Request) input = new Request(rewriteUrl(input.url), input);
    return _fetch.call(this,input,init);
  };
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m,u){
    return _open.call(this,m,rewriteUrl(u));
  };
})();
</script>`;

function injectBase(html, port) {
  const baseTag = `<base href="/preview/${port}/">`;
  const script = INTERCEPT_SCRIPT.replace(/PORT/g, String(port));
  if (html.includes('<head>')) {
    return html.replace('<head>', '<head>\n' + baseTag + '\n' + script);
  }
  if (html.includes('<HEAD>')) {
    return html.replace('<HEAD>', '<HEAD>\n' + baseTag + '\n' + script);
  }
  return baseTag + '\n' + script + '\n' + html;
}

async function proxyFetch(targetUrl, port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const upstream = await fetch(targetUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'DSH-Preview/1.0' },
    });
    clearTimeout(timeout);
    return upstream;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

export function apply(ctx) {
  // Port management endpoint
  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'prefix',
        path: '/api/preview-port',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '', 'http://localhost');
          const sessionId = url.searchParams.get('sessionId');

          if (req.method === 'GET') {
            const port = sessionId
              ? (sessionPorts.get(sessionId) ?? globalPort)
              : globalPort;
            return json(res, 200, { port: port || null });
          }

          if (req.method === 'POST') {
            try {
              const body = await readBody(req);
              const { port } = JSON.parse(body);
              const val = (port === null || port === undefined) ? null : String(port);
              if (sessionId) {
                sessionPorts.set(sessionId, val);
              } else {
                globalPort = val;
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

  // Path-based transparent proxy: /preview/:port/*
  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'prefix',
        path: '/preview',
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'POST') {
            res.writeHead(405);
            res.end('method not allowed');
            return;
          }

          const url = new URL(req.url ?? '', 'http://localhost');
          const parts = url.pathname.replace(/^\/preview\//, '').split('/');
          const port = parts.shift();

          if (!port || !/^\d{1,5}$/.test(port)) {
            json(res, 400, { error: 'invalid port in /preview/:port/*' });
            return;
          }

          const targetPath = '/' + parts.join('/') + url.search;
          const targetUrl = `http://127.0.0.1:${port}${targetPath}`;

          try {
            const upstream = await proxyFetch(targetUrl, port);
            const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
            const isHtml = contentType.includes('text/html');

            const headers = {
              'content-type': contentType,
              'cache-control': 'no-cache',
              'access-control-allow-origin': '*',
              'access-control-allow-methods': 'GET, POST, OPTIONS',
              'access-control-allow-headers': '*',
            };

            if (isHtml) {
              const html = await upstream.text();
              const injected = injectBase(html, port);
              res.writeHead(upstream.status, { ...headers, 'content-type': 'text/html; charset=utf-8' });
              res.end(injected);
            } else {
              res.writeHead(upstream.status, headers);
              if (upstream.body) {
                const reader = upstream.body.getReader();
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) { res.end(); return; }
                  res.write(value);
                }
              } else {
                res.end();
              }
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
      console.error('[dsh-preview] /preview proxy route registration failed:', err);
      return () => {};
    }
  });
}
