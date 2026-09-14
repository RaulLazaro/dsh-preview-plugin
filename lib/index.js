export const name = 'dsh-preview';
export const inject = ['webServer'];

let globalPort = null;
let globalBackendPorts = [];
const sessionPorts = new Map();
const sessionBackendPorts = new Map();
const portBackendPorts = new Map(); // frontend port → backend ports

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
  var BACKEND_PORTS = [__BACKEND_PORTS__];
  function rewriteUrl(u){
    if(typeof u!=="string") return u;
    // Rewrite absolute URLs pointing to configured backend ports
    for(var i=0;i<BACKEND_PORTS.length;i++){
      var bp=BACKEND_PORTS[i];
      var patterns=["http://localhost:"+bp,"http://127.0.0.1:"+bp];
      for(var j=0;j<patterns.length;j++){
        if(u===patterns[j]) return "/preview/"+bp+"/";
        if(u.startsWith(patterns[j]+"/")) return "/preview/"+bp+"/"+u.slice(patterns[j].length+1);
      }
    }
    // Rewrite absolute URL pointing to the frontend port itself
    var fp="http://localhost:PORT",fp2="http://127.0.0.1:PORT";
    if(u===fp||u===fp2) return PREFIX;
    if(u.startsWith(fp+"/")) return PREFIX+u.slice(fp.length+1);
    if(u.startsWith(fp2+"/")) return PREFIX+u.slice(fp2.length+1);
    // Rewrite relative URLs
    if(u.startsWith("/")&&!u.startsWith(PREFIX)) return PREFIX+u.slice(1);
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

function injectBase(html, port, backendPorts) {
  const baseTag = `<base href="/preview/${port}/">`;
  const bpJson = JSON.stringify(backendPorts || []);
  const script = INTERCEPT_SCRIPT.replace('[__BACKEND_PORTS__]', bpJson).replace(/PORT/g, String(port));
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
  // Register model-visible tool for agent to set preview ports
  ctx.effect(() => {
    const tool = harness.defineTool({
      name: 'set_preview_port',
      description: 'Configure the DSH Preview tab ports. Set the frontend port and optional backend ports for multi-app monorepos. The preview iframe will proxy requests to all configured ports.',
      parameters: {
        type: 'object',
        properties: {
          port: {
            type: 'number',
            description: 'Frontend dev server port to preview (e.g. 4321)',
          },
          backendPorts: {
            type: 'array',
            items: { type: 'number' },
            description: 'Backend server ports to proxy (e.g. [3001, 3002]). Absolute URLs pointing to these ports will be rewritten to go through the proxy.',
          },
        },
        required: ['port'],
      },
      async execute(args) {
        const port = args.port;
        const backendPorts = args.backendPorts || [];
        if (!port || !/^\d{1,5}$/.test(String(port))) {
          return { error: 'Invalid port number' };
        }
        // Store in plugin state
        const val = String(port);
        const bp = backendPorts.map(p => String(p)).filter(p => /^\d{1,5}$/.test(p));
        globalPort = val;
        globalBackendPorts = bp;
        portBackendPorts.set(val, bp);
        console.log(`[dsh-preview] Tool: set port=${val} backendPorts=[${bp.join(',')}]`);
        return { ok: true, port: val, backendPorts: bp, previewUrl: `/preview/${val}/` };
      },
    });
    return () => harness.registerTool(ctx, tool);
  });

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
            const bp = sessionId
              ? (sessionBackendPorts.get(sessionId) || globalBackendPorts)
              : globalBackendPorts;
            return json(res, 200, { port: port || null, backendPorts: bp });
          }

          if (req.method === 'POST') {
            try {
              const body = await readBody(req);
              const { port, backendPorts } = JSON.parse(body);
              const val = (port === null || port === undefined) ? null : String(port);
              const bp = Array.isArray(backendPorts)
                ? backendPorts.map(p => String(p)).filter(p => /^\d{1,5}$/.test(p))
                : [];
              if (sessionId) {
                sessionPorts.set(sessionId, val);
                sessionBackendPorts.set(sessionId, bp);
              } else {
                globalPort = val;
                globalBackendPorts = bp;
              }
              // Store backend ports by frontend port for proxy handler access
              if (val) portBackendPorts.set(val, bp);
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
          // Handle CORS preflight
          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'access-control-allow-origin': '*',
              'access-control-allow-methods': 'GET, POST, OPTIONS',
              'access-control-allow-headers': '*',
            });
            res.end();
            return;
          }

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
              const bp = portBackendPorts.get(port) || [];
              const injected = injectBase(html, port, bp);
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
