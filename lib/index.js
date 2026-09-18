import http from 'http';

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

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

// Never forward these upstream: they describe the hop to us rather than the
// request, and undici negotiates (and decompresses) the encoding itself.
const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authorization', 'proxy-authenticate', 'te', 'trailer',
  'content-length', 'accept-encoding',
]);

function forwardableHeaders(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase()) || value === undefined) continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  if (!headers['user-agent']) headers['user-agent'] = 'DSH-Preview/1.0';
  return headers;
}

const INTERCEPT_SCRIPT = `
<script>
(function(){
  // Unregister any service worker inside the iframe — DSH's PWA SW
  // intercepts all fetches and serves cached content, breaking the proxy
  if('serviceWorker' in navigator){
    navigator.serviceWorker.getRegistrations().then(function(regs){
      regs.forEach(function(r){ r.unregister(); });
    });
  }
  // Also clear the DSH PWA cache
  if('caches' in window){
    caches.keys().then(function(names){
      names.forEach(function(n){ caches.delete(n); });
    });
  }
  var PREFIX = "/preview/PORT/";
  var BACKENDS = [__BACKEND_PORTS__];
  // Override WebSocket — return mock that pretends to be connected
  // Vite HMR needs readyState=OPEN and onopen event to proceed
  var _WS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    var listeners = {};
    var ws = {
      send: function(){},
      close: function(){ this.readyState = 3; },
      addEventListener: function(type, fn){
        if(!listeners[type]) listeners[type]=[];
        listeners[type].push(fn);
      },
      removeEventListener: function(type, fn){
        if(listeners[type]) listeners[type]=listeners[type].filter(function(f){return f!==fn;});
      },
      dispatchEvent: function(evt){
        var type = evt.type || evt;
        if(listeners[type]) listeners[type].forEach(function(fn){ fn(evt); });
        var prop = 'on'+type;
        if(typeof this[prop]==='function') this[prop](evt);
        return true;
      },
      readyState: 1,
      CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3,
      onopen: null, onclose: null, onmessage: null, onerror: null,
      protocol: '', bufferedAmount: 0, extensions: '', binaryType: 'blob',
      url: url || ''
    };
    // Fire onopen asynchronously so Vite HMR client proceeds
    setTimeout(function(){
      ws.readyState = 1;
      var evt = { type: 'open' };
      if(typeof ws.onopen==='function') ws.onopen(evt);
      if(listeners.open) listeners.open.forEach(function(fn){ fn(evt); });
    }, 10);
    return ws;
  };
  window.WebSocket.prototype = _WS.prototype;
  window.WebSocket.CONNECTING = _WS.CONNECTING;
  window.WebSocket.OPEN = _WS.OPEN;
  window.WebSocket.CLOSING = _WS.CLOSING;
  window.WebSocket.CLOSED = _WS.CLOSED;
  // ---------------------------------------------------------------------
  // Fragment ("#section") links.
  // The <base href="/preview/PORT/"> injected above makes "#section" resolve
  // against /preview/PORT/, which is a DIFFERENT path than the one being
  // viewed: the browser treats it as a full navigation and the visitor is
  // thrown back to the site root instead of jumping inside the page.
  // A fragment link always means "same document", so do it ourselves.
  // ---------------------------------------------------------------------
  function findFragmentTarget(hash){
    var id = hash.slice(1);
    if(!id) return null;
    var el = null;
    try{ el = document.getElementById(id); }catch(e){}
    if(!el){ try{ el = document.getElementsByName(id)[0]; }catch(e){} }
    if(!el){ try{ el = document.querySelector(hash); }catch(e){} }
    return el || null;
  }
  // "#/route", "#!route" and "#?q" belong to hash-routed apps: they are not
  // element ids, so there is nothing to scroll to and nothing to wait for.
  function isRouteFragment(hash){
    var first = hash.charAt(1);
    return first==='/'||first==='!'||first==='?';
  }
  function jumpToFragment(){
    var hash = location.hash;
    if(!hash || hash === '#' || isRouteFragment(hash)){
      window.scrollTo(0,0);
      return true;
    }
    var el = findFragmentTarget(hash);
    if(!el) return false;
    if(el.scrollIntoView) el.scrollIntoView();
    return true;
  }
  // Targets may be rendered after the jump (SPA / JS-built sections), so retry.
  // Only the most recent jump keeps polling.
  var fragmentJump = 0;
  function jumpToFragmentWithRetry(){
    var token = ++fragmentJump;
    var tries = 0;
    (function tick(){
      if(token !== fragmentJump) return;
      if(jumpToFragment() || ++tries > 40) return;   // ~4 s at 100 ms
      setTimeout(tick,100);
    })();
  }
  function restoreFragmentAfterLoad(){
    if(location.hash) jumpToFragmentWithRetry();
  }
  if(document.readyState === 'loading'){
    document.addEventListener("DOMContentLoaded",restoreFragmentAfterLoad);
  }else{
    restoreFragmentAfterLoad();
  }
  window.addEventListener("load",restoreFragmentAfterLoad);
  window.addEventListener("hashchange",function(){ jumpToFragmentWithRetry(); });
  document.addEventListener("click",function(e){
    if(e.defaultPrevented) return;
    if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey) return;
    var a = e.target&&e.target.closest?e.target.closest("a"):null;
    if(!a) return;
    var href = a.getAttribute("href");
    if(!href||href.charAt(0)!=="#") return;
    var t = a.getAttribute("target");
    if(t&&t!=="_self") return;
    e.preventDefault();
    if(href==="#"){
      try{ history.pushState(null,"",location.pathname+location.search); }catch(err){}
      window.scrollTo(0,0);
      return;
    }
    if(location.hash===href){
      jumpToFragmentWithRetry();          // same fragment: no hashchange will fire
      return;
    }
    try{ location.hash = href; }          // same-document navigation, base-independent
    catch(err){ location.href = location.pathname+location.search+href; }
    jumpToFragmentWithRetry();
  },true);
  function rewriteUrl(u){
    if(typeof u!=="string") return u;
    // Rewrite absolute URLs pointing to configured backend ports
    for(var i=0;i<BACKENDS.length;i++){
      var bp=BACKENDS[i];
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
    // Rewrite absolute URLs with iframe hostname
    if(u.indexOf("http")===0){
      try{
        var parsed=new URL(u);
        if(parsed.hostname===location.hostname&&parsed.port===location.port){
          return PREFIX+parsed.pathname.slice(1)+parsed.search+parsed.hash;
        }
      }catch(ex){}
    }
    if(u.startsWith("/")&&!u.startsWith(PREFIX)) return PREFIX+u.slice(1);
    return u;
  }
  // ---------------------------------------------------------------------
  // Root-relative resource URLs ("/assets/x.png").
  // A <base> tag only affects truly relative URLs; anything starting with "/"
  // resolves against the ORIGIN, so inside the preview the browser asks the
  // DSH host for a file that only exists on the dev server (404). The initial
  // HTML is rewritten server-side; this covers everything JS does later.
  // ---------------------------------------------------------------------
  var RESOURCE_ATTRS = ["src","srcset","poster","data-src","data-srcset"];
  function rewriteSrcsetValue(value){
    if(!value) return value;
    var parts = String(value).split(",");
    for(var i=0;i<parts.length;i++){
      var m = /^(\s*)(\S+)([\s\S]*)$/.exec(parts[i]);
      if(m) parts[i] = m[1]+rewriteUrl(m[2])+m[3];
    }
    return parts.join(",");
  }
  function linkWantsResource(el){
    if(!el||el.tagName!=="LINK"||!el.getAttribute) return false;
    var rel = (el.getAttribute("rel")||"").toLowerCase();
    return rel.indexOf("stylesheet")!==-1||rel.indexOf("preload")!==-1||rel.indexOf("icon")!==-1
      ||rel.indexOf("manifest")!==-1||rel.indexOf("prefetch")!==-1;
  }
  function fixResourceAttr(el,name,value){
    if(typeof value!=="string"||!value) return null;
    var next = (name==="srcset"||name==="data-srcset") ? rewriteSrcsetValue(value) : rewriteUrl(value);
    return next===value ? null : next;
  }
  function fixElement(el){
    if(!el||el.nodeType!==1) return;
    for(var i=0;i<RESOURCE_ATTRS.length;i++){
      var name = RESOURCE_ATTRS[i];
      if(el.hasAttribute&&el.hasAttribute(name)){
        var next = fixResourceAttr(el,name,el.getAttribute(name));
        if(next!==null) el.setAttribute(name,next);
      }
    }
    if(linkWantsResource(el)&&el.hasAttribute&&el.hasAttribute("href")){
      var href = el.getAttribute("href"), fixed = rewriteUrl(href);
      if(fixed!==href) el.setAttribute("href",fixed);
    }
  }
  function fixTree(node){
    if(!node) return;
    if(node.nodeType===1){
      fixElement(node);
      var found = node.querySelectorAll ? node.querySelectorAll("[src],[srcset],[poster],[data-src],[data-srcset],link[href]") : [];
      for(var i=0;i<found.length;i++) fixElement(found[i]);
    }else if(node.nodeType===9||node.nodeType===11){
      var kids = node.childNodes||[];
      for(var j=0;j<kids.length;j++) fixTree(kids[j]);
    }
  }
  // Attribute writes are the earliest hook: fix the value before it is stored.
  var _setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name,value){
    var lower = String(name).toLowerCase();
    if(RESOURCE_ATTRS.indexOf(lower)!==-1||(lower==="href"&&linkWantsResource(this))){
      var next = fixResourceAttr(this,lower,String(value));
      if(next!==null) value = next;
    }
    return _setAttribute.call(this,name,value);
  };
  if(window.MutationObserver){
    var _observer = new MutationObserver(function(records){
      for(var i=0;i<records.length;i++){
        var record = records[i];
        if(record.type==="attributes") fixElement(record.target);
        else for(var j=0;j<record.addedNodes.length;j++) fixTree(record.addedNodes[j]);
      }
    });
    _observer.observe(document.documentElement,{
      childList:true,
      subtree:true,
      attributes:true,
      attributeFilter:RESOURCE_ATTRS.concat(["href","rel"]),
    });
  }
  // Setting "element.src = /x" goes through the IDL setter, not setAttribute,
  // and starts the request immediately: wrap those setters so the URL is fixed
  // before the browser sees it.
  var RESOURCE_PROPS = [
    ["HTMLImageElement","src"],["HTMLImageElement","srcset"],
    ["HTMLSourceElement","src"],["HTMLSourceElement","srcset"],
    ["HTMLScriptElement","src"],
    ["HTMLVideoElement","src"],["HTMLVideoElement","poster"],
    ["HTMLAudioElement","src"],
    ["HTMLIFrameElement","src"],
    ["HTMLEmbedElement","src"],
    ["HTMLTrackElement","src"],
    ["HTMLInputElement","src"],
    ["HTMLObjectElement","data"],
    ["HTMLLinkElement","href"],
  ];
  for(var p=0;p<RESOURCE_PROPS.length;p++){
    (function(proto,prop){
      if(!proto) return;
      var desc = Object.getOwnPropertyDescriptor(proto,prop);
      if(!desc||typeof desc.set!=="function"||!desc.configurable) return;
      Object.defineProperty(proto,prop,{
        configurable:true,
        enumerable:desc.enumerable,
        get:desc.get,
        set:function(value){
          var next = null;
          if(prop==="href"){ if(linkWantsResource(this)) next = rewriteUrl(String(value)); }
          else if(prop==="srcset") next = rewriteSrcsetValue(String(value));
          else next = rewriteUrl(String(value));
          desc.set.call(this, next===null ? value : next);
        },
      });
    })(window[RESOURCE_PROPS[p][0]] && window[RESOURCE_PROPS[p][0]].prototype,RESOURCE_PROPS[p][1]);
  }
  document.addEventListener("click",function(e){
    var a=e.target.closest("a");
    if(!a) return;
    var href=a.getAttribute("href");
    if(!href) return;
    if(href.charAt(0)==="#"||href.indexOf(":")!==-1&&href.indexOf("http")===-1) return;
    if(href.indexOf("http")===0){
      try{
        var u=new URL(href);
        if(u.origin===window.location.origin||u.hostname===window.location.hostname){
          href=u.pathname+u.search+u.hash;
        }else{ return; }
      }catch(ex){return;}
    }
    var rewritten=rewriteUrl(href);
    if(rewritten!==href){
      e.preventDefault();
      e.stopPropagation();
      window.location.href=rewritten;
    }
  },true);
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

function prefixRootRelative(url, prefix) {
  if (typeof url !== 'string' || url.charAt(0) !== '/' || url.startsWith('//') || url.startsWith(prefix)) return url;
  return prefix + url.slice(1);
}

function rewriteSrcset(value, prefix) {
  return String(value).split(',').map((candidate) => {
    const match = /^(\s*)(\S+)([\s\S]*)$/.exec(candidate);
    if (!match) return candidate;
    return match[1] + prefixRootRelative(match[2], prefix) + match[3];
  }).join(',');
}

function injectBase(html, port, backendPorts) {
  const prefix = `/preview/${port}/`;
  const bpJson = JSON.stringify(backendPorts || []);
  const script = INTERCEPT_SCRIPT.replace('[__BACKEND_PORTS__]', bpJson).replace(/PORT/g, String(port));
  const baseTag = `<base href="${prefix}">`;

  // Import map: remap all absolute URL prefixes so ES module imports go through the proxy
  const importMap = `<script type="importmap">{"imports":{"/@vite/":"${prefix}@vite/","/@id/":"${prefix}@id/","/@fs/":"${prefix}@fs/","/src/":"${prefix}src/","/node_modules/":"${prefix}node_modules/"}}</script>`;

  // Server-side rewrite: add prefix to src/href on scripts, links, styles
  // Also remove Vite HMR client and Astro dev toolbar (they need WebSocket which can't be proxied)
  const rewritten = html
    // Root-relative resource URLs and srcset candidates: the <base> tag cannot
    // reach them (they resolve against the origin, not the base path).
    .replace(/(<[a-z][^>]*?\b(?:src|poster|data-src)=)(["'])(\/[^"']*)/gi,
      (match, head, quote, url) => head + quote + prefixRootRelative(url, prefix))
    .replace(/(\b(?:srcset|data-srcset)=)(["'])([^"']*)/gi,
      (match, head, quote, value) => head + quote + rewriteSrcset(value, prefix) + quote)
    .replace(/(<link[^>]*?\bhref=)(["'])(\/[^"']*)/gi,
      (match, head, quote, url) => head + quote + prefixRootRelative(url, prefix))
    .replace(/url\(\s*(\/[^)]*)/g, (match, url) => 'url(' + prefixRootRelative(url, prefix))
    // Remove Vite HMR client script (can't connect WebSocket through proxy)
    .replace(/<script type="module" src="[^"]*@vite\/client[^"]*"><\/script>/g, '')
    // Remove Astro dev toolbar entry point (depends on Vite HMR)
    .replace(/<script type="module" src="[^"]*@id\/astro[^"]*"><\/script>/g, '');

  if (rewritten.includes('<head>')) {
    return rewritten.replace('<head>', '<head>\n' + baseTag + '\n' + importMap + '\n' + script);
  }
  if (rewritten.includes('<HEAD>')) {
    return rewritten.replace('<HEAD>', '<HEAD>\n' + baseTag + '\n' + importMap + '\n' + script);
  }
  return baseTag + '\n' + importMap + '\n' + script + '\n' + rewritten;
}

async function proxyFetch(targetUrl, req, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: forwardableHeaders(req),
      body: body && body.length > 0 ? body : undefined,
      redirect: 'manual', // hand redirects (and their Location) back to the app
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return upstream;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/** Headers the browser needs to see, including the ones that carry a session. */
function upstreamHeaders(upstream, isHtml) {
  const headers = {
    'cache-control': 'no-cache',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': '*',
  };
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;
  else if (isHtml) headers['content-type'] = 'text/html; charset=utf-8';
  const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  const location = upstream.headers.get('location');
  if (location) headers['location'] = location;
  const allow = upstream.headers.get('allow');
  if (allow) headers['allow'] = allow;
  return headers;
}

export function apply(ctx) {
  // Register model-visible tool for agent to set preview ports
  const tools = ctx.get('tools');
  if (tools !== undefined) {
    ctx.effect(() => {
      return tools.register({
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
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              port: { type: 'string' },
              backendPorts: { type: 'array', items: { type: 'string' } },
              previewUrl: { type: 'string' },
              error: { type: 'string' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.error
              ? `Error: ${value.error}`
              : `Preview set to port ${value.port}${value.backendPorts && value.backendPorts.length > 0 ? ` (backends: ${value.backendPorts.join(', ')})` : ''}. URL: ${value.previewUrl}`,
          }],
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
    });
  }

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
              'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
              'access-control-allow-headers': '*',
            });
            res.end();
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
            // Forward the method and the body: an app behind the preview must be
            // able to log in, submit forms and use its API, not just GET pages.
            const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
            const body = hasBody ? await readRawBody(req) : undefined;
            const upstream = await proxyFetch(targetUrl, req, body);
            const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
            // Only rewrite pages, never an API response that happens to be HTML.
            const isHtml = contentType.includes('text/html')
              && (req.method === 'GET' || req.method === 'HEAD');
            const headers = upstreamHeaders(upstream, isHtml);
            if (isHtml) {
              const html = await upstream.text();
              const bp = portBackendPorts.get(port) || [];
              const injected = injectBase(html, port, bp);
              res.writeHead(upstream.status, headers);
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

  // WebSocket upgrade proxy for Vite HMR
  ctx.effect(() => {
    try {
      return ctx.webServer.registerUpgrade({
        kind: 'prefix',
        path: '/preview',
        handler: (req, socket, head) => {
          const url = new URL(req.url ?? '', 'http://localhost');
          const parts = url.pathname.replace(/^\/preview\//, '').split('/');
          const port = parts.shift();
          if (!port || !/^\d{1,5}$/.test(port)) {
            socket.destroy();
            return;
          }
          const targetPath = '/' + parts.join('/') + url.search;
          const targetUrl = `http://127.0.0.1:${port}${targetPath}`;
          // Connect to the upstream WebSocket server
          const upstreamReq = http.request(targetUrl, {
            method: 'GET',
            headers: {
              ...req.headers,
              host: `127.0.0.1:${port}`,
            },
          });
          upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
            // Send 101 Switching Protocols to client
            const headers = [];
            headers.push(`HTTP/1.1 101 Switching Protocols`);
            for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
              const key = upstreamRes.rawHeaders[i];
              const val = upstreamRes.rawHeaders[i + 1];
              if (key.toLowerCase() !== 'connection' && key.toLowerCase() !== 'upgrade') {
                headers.push(`${key}: ${val}`);
              }
            }
            headers.push('Connection: Upgrade');
            headers.push('Upgrade: websocket');
            headers.push('');
            headers.push('');
            socket.write(headers.join('\r\n'));
            if (head && head.length) upstreamSocket.write(head);
            upstreamSocket.pipe(socket);
            socket.pipe(upstreamSocket);
            upstreamSocket.on('error', () => socket.destroy());
            socket.on('error', () => upstreamSocket.destroy());
            upstreamSocket.on('close', () => socket.destroy());
            socket.on('close', () => upstreamSocket.destroy());
          });
          upstreamReq.on('error', () => socket.destroy());
          upstreamReq.end();
        },
      });
    } catch (err) {
      console.error('[dsh-preview] WebSocket upgrade registration failed:', err);
      return () => {};
    }
  });
}
