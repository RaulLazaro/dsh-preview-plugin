import http from 'http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-preview';
export const inject = ['webServer'];

let globalPort = null;
let globalBackendPorts = [];
// Per-session preview config, keyed by session id and written in insertion
// order: one Map gives eviction the LRU order to walk, the cap the size to
// measure, and the purge the exact entries a closing session owns.
const sessionStates = new Map();
// The session whose preview tab last polled its config (GET ?sessionId=): the
// session on screen, which eviction must never touch.
let activeSessionId = null;
const portBackendPorts = new Map(); // frontend port → backend ports

// What is being previewed is state the user set on purpose, so it outlives the
// process: the host half is re-imported on every DSH restart.
const STATE_FILE = path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'preview-plugin.json',
);

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      setGlobalPortConfig(
        raw.port === null || raw.port === undefined ? null : String(raw.port),
        Array.isArray(raw.backendPorts) ? raw.backendPorts.map(String) : [],
      );
    }
  } catch {
    // First run, or a file we cannot read: defaults are fine.
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ port: globalPort, backendPorts: globalBackendPorts }, null, 2));
  } catch (err) {
    console.error('[dsh-preview] could not persist the preview state:', err);
  }
}

// ---------------------------------------------------------------------------
// Session state: purge, cap and frontend-port mapping ownership
//
// The per-session maps used to grow forever: nothing reacted to a session
// closing, so a long-lived box collected entries (and port mappings) for
// sessions that no longer existed. Two mechanisms keep them bounded:
//
//   1. `session/disposed` — DSH emits it once when a session leaves the store,
//      with the session as its argument — drops everything the session
//      contributed (registered in apply()).
//   2. A hard cap with LRU eviction catches sessions whose disposal never
//      arrives (`DSH_PREVIEW_MAX_SESSIONS`, default 64).
//
// Either path must leave `portBackendPorts` (frontend port → backend ports,
// read by the proxy) consistent: an entry survives only while something still
// justifies it — the global config for its own port, or a live session that
// points at the port.
// ---------------------------------------------------------------------------

/**
 * Re-derive a frontend port's mapping from the state that still exists.
 *
 * The global config is authoritative for its own port; otherwise the most
 * recently written session that still points at the port owns the entry (the
 * Map is written in insertion order, so the last match is the newest write);
 * when nothing does, the entry is dropped instead of leaking.
 */
function releasePortMapping(port) {
  if (!port) return;
  if (port === globalPort) {
    portBackendPorts.set(port, globalBackendPorts);
    return;
  }
  let owner = null;
  for (const entry of sessionStates.values()) {
    if (entry.port === port) owner = entry;
  }
  if (owner) portBackendPorts.set(port, owner.backendPorts);
  else portBackendPorts.delete(port);
}

/** Apply the global config and release the port mapping it replaced. */
function setGlobalPortConfig(port, backendPorts) {
  const previous = globalPort;
  globalPort = port;
  globalBackendPorts = backendPorts;
  if (port) portBackendPorts.set(port, backendPorts);
  if (previous && previous !== port) releasePortMapping(previous);
}

/** Forget one session: its entry and every port mapping only it justified. */
function forgetSession(sessionId) {
  if (activeSessionId === sessionId) activeSessionId = null;
  const entry = sessionStates.get(sessionId);
  if (entry === undefined) return;
  sessionStates.delete(sessionId);
  releasePortMapping(entry.port);
}

/**
 * Safety net for sessions whose `session/disposed` never arrives: keep at most
 * `maxTrackedSessions()` entries, dropping the least recently written first
 * and never the session the preview tab is showing. A single pass over a
 * snapshot keeps it bounded: `cap >= 1` leaves at least one evictable entry
 * whenever the cap is exceeded.
 */
function evictOverflow() {
  const cap = maxTrackedSessions();
  if (sessionStates.size <= cap) return;
  for (const sessionId of [...sessionStates.keys()]) {
    if (sessionStates.size <= cap) return;
    if (sessionId === activeSessionId) continue;
    forgetSession(sessionId);
  }
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Validation and limits
//
// The proxy's only target is 127.0.0.1, so the port is the entire attack
// surface of the URL: it must be a real TCP port. Bodies are buffered before
// they are forwarded and answers are read chunk by chunk, so both ends need a
// hard bound instead of "as much as the other side feels like sending".
// ---------------------------------------------------------------------------

/** 127.0.0.1:<port> only ever makes sense for a real TCP port (1–65535). */
function isValidPort(value) {
  return typeof value === 'string'
    && /^\d{1,5}$/.test(value)
    && Number(value) >= 1
    && Number(value) <= 65535;
}

/** Milliseconds allowed to pass without upstream activity (first byte or chunk). */
function upstreamTimeoutMs() {
  const raw = Number(process.env.DSH_PREVIEW_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 15_000;
}

/** Cap for a proxied request body; override for tests with DSH_PREVIEW_MAX_BODY_BYTES. */
function maxRequestBodyBytes() {
  const raw = Number(process.env.DSH_PREVIEW_MAX_BODY_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8 * 1024 * 1024;
}

/**
 * Hard cap on tracked sessions; override with DSH_PREVIEW_MAX_SESSIONS.
 *
 * At least one session must always fit (the active one), so an unusable value
 * — zero, negative, garbage — falls back to the default instead of disabling
 * storage or pinching it shut.
 */
function maxTrackedSessions() {
  const raw = Number(process.env.DSH_PREVIEW_MAX_SESSIONS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 64;
}

/** The port config is a small JSON document, nothing more. */
const MAX_API_BODY_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {
  constructor(limit) {
    super(`request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
    this.limit = limit;
  }
}

/**
 * The proxy answers a too-large body with 413 and closes the connection: the
 * rest of the upload is discarded instead of buffered.
 */
function sendTooLarge(res, req, err) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (req) req.resume();
  res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify({ error: err.message }));
}

async function readRawBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError(limit);
  const chunks = [];
  let size = 0;
  // A manual iteration, never `for await`: breaking out of `for await` destroys
  // the request stream, and a destroyed socket cannot carry the 413 reply.
  const iterator = req[Symbol.asyncIterator]();
  for (;;) {
    const step = await iterator.next();
    if (step.done) break;
    const chunk = Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value);
    size += chunk.length;
    if (size > limit) throw new BodyTooLargeError(limit);
    chunks.push(chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

async function readBody(req, limit) {
  const raw = await readRawBody(req, limit);
  return raw === undefined ? '' : raw.toString('utf8');
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

/**
 * The preview is same-origin by design — the iframe lives on the DSH origin —
 * so no other web site may read local dev-server responses through this proxy.
 * A wildcard `access-control-allow-origin` would let any page the user visits
 * enumerate every loopback port behind DSH and read what those ports serve,
 * because the browser hands the response body straight to that page.
 *
 * Only the origin the request actually carries is echoed back, and only when it
 * is the DSH origin itself (`Origin` matched against `Host`). Requests without
 * an `Origin` header (plain navigations, curl) never needed CORS.
 */
function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return null;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return null;
  }
  const host = req.headers.host;
  return typeof host === 'string' && host !== '' && originHost === host ? origin : null;
}

/** Release an upstream response whose body is never going to be read. */
function discardBody(upstream) {
  try {
    const body = upstream.body;
    if (body && !body.locked) Promise.resolve(body.cancel()).catch(() => {});
  } catch {
    // Nothing left to release.
  }
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
  var RESOURCE_ATTRS = ["src","srcset","poster","data-src","data-srcset","action"];
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
      var found = node.querySelectorAll ? node.querySelectorAll("[src],[srcset],[poster],[data-src],[data-srcset],[action],link[href]") : [];
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
  // ---------------------------------------------------------------------
  // Navigation that does not go through a click or a fetch.
  // An app that pushes "/laptops" into history (or calls location.assign /
  // window.open) would leave the preview prefix and land on the DSH origin,
  // where nothing answers. (Assigning location.href cannot be intercepted:
  // it is a LegacyUnforgeable own property of the location object.)
  // ---------------------------------------------------------------------
  function rewriteNavigation(u){
    if(typeof u!=="string"||!u) return u;
    if(u.charAt(0)==="#") return u;              // same-document fragment
    return rewriteUrl(u);
  }
  try{
    if(window.history){
      var _pushState=window.history.pushState,_replaceState=window.history.replaceState;
      window.history.pushState=function(state,title,url){
        return _pushState.call(this,state,title,url===undefined||url===null?url:rewriteNavigation(String(url)));
      };
      window.history.replaceState=function(state,title,url){
        return _replaceState.call(this,state,title,url===undefined||url===null?url:rewriteNavigation(String(url)));
      };
    }
  }catch(e){}
  try{
    var _assign=location.assign,_replace=location.replace;
    location.assign=function(u){ return _assign.call(location,rewriteNavigation(String(u))); };
    location.replace=function(u){ return _replace.call(location,rewriteNavigation(String(u))); };
  }catch(e){}
  try{
    var _open=window.open;
    window.open=function(u){
      return _open.call(window,typeof u==="string"?rewriteNavigation(u):u);
    };
  }catch(e){}
  // A form with a root-relative action would submit outside the prefix.
  document.addEventListener("submit",function(e){
    var form=e.target;
    if(!form||!form.getAttribute) return;
    var action=form.getAttribute("action");
    if(!action) return;
    var rewritten=rewriteUrl(action);
    if(rewritten===action) return;
    e.preventDefault();
    form.setAttribute("action",rewritten);
    try{ HTMLFormElement.prototype.submit.call(form); }catch(err){ form.submit(); }
  },true);
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
    if(rewritten===href) return;
    var target=a.getAttribute("target");
    if(target&&target!=="_self"){
      // Let the browser open it, but keep the URL inside the preview.
      a.setAttribute("href",rewritten);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    window.location.href=rewritten;
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
    .replace(/(<[a-z][^>]*?\b(?:src|poster|data-src|action)=)(["'])(\/[^"']*)/gi,
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

/**
 * One upstream request. The abort signal belongs to the caller: the whole
 * exchange (headers, fallback lookup and body) is bounded by a single timer,
 * refreshed on every chunk, so a silent upstream cannot hold a preview forever.
 */
async function proxyFetch(targetUrl, req, body, signal) {
  return fetch(targetUrl, {
    method: req.method,
    headers: forwardableHeaders(req),
    body: body && body.length > 0 ? body : undefined,
    redirect: 'manual', // hand redirects (and their Location) back to the app
    signal,
  });
}

/** Buffer an upstream body, refreshing the caller's stall timer per chunk. */
async function readText(upstream, touch) {
  if (!upstream.body) return '';
  const reader = upstream.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    touch();
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  // `Response.text()` decodes UTF-8 and drops a byte-order mark; match it so
  // the markup we inject lands where it always did.
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/**
 * "This deep link does not exist on the server" — a client-side route. Only a
 * top-level HTML navigation qualifies: assets, API calls and XHR keep the
 * upstream's real 404, and so does every path the dev server does serve.
 */
function wantsIndexFallback(req, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const accept = req.headers.accept;
  if (typeof accept !== 'string' || !accept.toLowerCase().includes('text/html')) return false;
  if (pathname === '/' || pathname === '') return false;
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return !/\.[a-z0-9]{2,12}$/i.test(lastSegment);
}

/**
 * Headers the browser needs to see, including the ones that carry a session.
 * CORS is same-origin only — see allowedOrigin().
 */
function upstreamHeaders(upstream, isHtml, req) {
  const headers = { 'cache-control': 'no-cache', vary: 'origin' };
  const origin = allowedOrigin(req);
  if (origin !== null) headers['access-control-allow-origin'] = origin;
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
  loadState();

  // Per-session preview state dies with its session: DSH emits
  // `session/disposed` once when a session leaves the store, handing the
  // session to the listener (session.id is the identifier the API keys
  // entries by). This is the purge path; evictOverflow() is the safety net
  // for sessions whose disposal never arrives.
  ctx.on('session/disposed', (session) => {
    forgetSession(session && session.id);
  });

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
          if (!isValidPort(String(port))) {
            return { error: 'Invalid port number (expected 1-65535)' };
          }
          // Store in plugin state
          const val = String(port);
          const bp = backendPorts.map(p => String(p)).filter(isValidPort);
          setGlobalPortConfig(val, bp);
          saveState();
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
            // A GET with a sessionId is the preview tab of that session
            // polling its config: that session is the one on screen, the one
            // eviction must keep. Reads never create or reorder entries.
            if (sessionId) activeSessionId = sessionId;
            const state = sessionId ? sessionStates.get(sessionId) : undefined;
            const port = state ? (state.port ?? globalPort) : globalPort;
            const bp = state ? state.backendPorts : globalBackendPorts;
            return json(res, 200, { port: port || null, backendPorts: bp });
          }

          if (req.method === 'POST') {
            let raw;
            try {
              raw = await readBody(req, MAX_API_BODY_BYTES);
            } catch (err) {
              if (err instanceof BodyTooLargeError) {
                sendTooLarge(res, req, err);
                return;
              }
              return json(res, 400, { error: 'invalid body' });
            }
            try {
              const { port, backendPorts } = JSON.parse(raw);
              // Out-of-range or malformed ports are dropped rather than stored:
              // they would only come back as a broken preview later.
              const requested = (port === null || port === undefined) ? null : String(port);
              const val = requested !== null && isValidPort(requested) ? requested : null;
              const bp = Array.isArray(backendPorts)
                ? backendPorts.map(p => String(p)).filter(isValidPort)
                : [];
              if (sessionId) {
                const previous = sessionStates.get(sessionId);
                // Write the new state first, then release what the session no
                // longer points at: releasePortMapping() derives ownership
                // from the entries themselves. The delete/set pair also moves
                // the entry to the recent end — that insertion order is the
                // LRU order eviction walks.
                sessionStates.delete(sessionId);
                sessionStates.set(sessionId, { port: val, backendPorts: bp });
                if (val) portBackendPorts.set(val, bp);
                if (previous && previous.port && previous.port !== val) releasePortMapping(previous.port);
                evictOverflow();
              } else {
                setGlobalPortConfig(val, bp);
                saveState();
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
          // CORS preflight. The preview is same-origin, so only the DSH origin
          // itself gets an answer — see allowedOrigin().
          if (req.method === 'OPTIONS') {
            const origin = allowedOrigin(req);
            if (origin === null) {
              json(res, 403, { error: 'cross-origin requests to the preview proxy are not allowed' });
              return;
            }
            res.writeHead(204, {
              'access-control-allow-origin': origin,
              'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
              'access-control-allow-headers': String(req.headers['access-control-request-headers'] || '*'),
              'vary': 'origin',
            });
            res.end();
            return;
          }

          const url = new URL(req.url ?? '', 'http://localhost');
          const parts = url.pathname.replace(/^\/preview\//, '').split('/');
          const port = parts.shift();

          if (!isValidPort(port)) {
            json(res, 400, { error: 'invalid port in /preview/:port/* (expected 1-65535)' });
            return;
          }

          const upstreamPath = '/' + parts.join('/');
          const targetUrl = `http://127.0.0.1:${port}${upstreamPath}${url.search}`;

          // One timer governs the whole exchange: time to first byte, then —
          // refreshed by touch() — the silence allowed between body chunks.
          const timeoutMs = upstreamTimeoutMs();
          const controller = new AbortController();
          let timer = setTimeout(() => controller.abort(), timeoutMs);
          const touch = () => {
            clearTimeout(timer);
            timer = setTimeout(() => controller.abort(), timeoutMs);
          };

          try {
            // Forward the method and the body: an app behind the preview must be
            // able to log in, submit forms and use its API, not just GET pages.
            const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
            const body = hasBody ? await readRawBody(req, maxRequestBodyBytes()) : undefined;
            let upstream = await proxyFetch(targetUrl, req, body, controller.signal);
            touch();

            // SPA fallback: a deep link the dev server answers with 404 is a
            // client-side route, so serve the app shell and let the router boot.
            // Anything else — assets, API calls, paths the dev server does
            // serve — keeps the upstream's own answer.
            if (upstream.status === 404 && wantsIndexFallback(req, upstreamPath)) {
              try {
                const shell = await proxyFetch(`http://127.0.0.1:${port}/`, req, undefined, controller.signal);
                touch();
                const shellType = shell.headers.get('content-type') ?? '';
                if (shell.status === 200 && shellType.includes('text/html')) {
                  discardBody(upstream);
                  upstream = shell;
                } else {
                  discardBody(shell);
                }
              } catch {
                // The shell did not answer either: keep the real 404.
              }
            }

            const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
            // Only rewrite pages, never an API response that happens to be HTML.
            const isHtml = contentType.includes('text/html')
              && (req.method === 'GET' || req.method === 'HEAD');
            const headers = upstreamHeaders(upstream, isHtml, req);
            if (isHtml) {
              const html = await readText(upstream, touch);
              const bp = portBackendPorts.get(port) || [];
              const injected = injectBase(html, port, bp);
              res.writeHead(upstream.status, headers);
              res.end(injected);
            } else {
              res.writeHead(upstream.status, headers);
              if (upstream.body) {
                const reader = upstream.body.getReader();
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  touch();
                  res.write(value);
                }
              }
              res.end();
            }
          } catch (err) {
            // Once the first byte is out, a failure can only be shown by
            // tearing the response down: emitting a status line now would
            // throw ERR_HTTP_HEADERS_SENT on top of the original error.
            if (res.headersSent) {
              res.destroy();
              return;
            }
            if (err instanceof BodyTooLargeError) {
              sendTooLarge(res, req, err);
              return;
            }
            const msg = err?.name === 'AbortError'
              ? `upstream timeout after ${timeoutMs} ms`
              : `fetch failed: ${err?.message ?? err}`;
            json(res, 502, { error: msg });
          } finally {
            clearTimeout(timer);
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
          if (!isValidPort(port)) {
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
