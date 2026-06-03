'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  WebSandbox v3 — Full-featured proxy sandbox
//  Fixes: redirect leaks, Cloudflare bypass attempts, cookie persistence,
//         history navigation, sidebar, and cross-device support
// ═══════════════════════════════════════════════════════════════════════════

const express   = require('express');
const fetch     = require('node-fetch');
const https     = require('https');
const http      = require('http');
const cheerio   = require('cheerio');
const { v4: uuidv4 } = require('uuid');
const cors      = require('cors');
const path      = require('path');
const urlModule = require('url');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── IN-MEMORY STORES ───────────────────────────────────────────────────────
const sessions    = new Map();   // sessionId → session object
const cookieJars  = new Map();   // sessionId → Map<domain, Map<name, cookieObj>>

// ─── MIDDLEWARE ─────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── SESSION HELPERS ────────────────────────────────────────────────────────
function getSession(id) {
  if (!id) id = uuidv4();
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      created:      Date.now(),
      history:      [],
      bookmarks:    [],
      currentUrl:   '',
      currentTitle: '',
    });
  }
  return sessions.get(id);
}

function addHistory(session, { url, title, favicon }) {
  if (!url) return;
  const last = session.history[session.history.length - 1];
  if (last && last.url === url) { last.title = title || last.title; return; }
  session.history.push({ url, title: title || url, favicon: favicon || '', visitedAt: Date.now() });
  if (session.history.length > 300) session.history = session.history.slice(-300);
}

// ─── COOKIE ENGINE ──────────────────────────────────────────────────────────
function getDomainKey(hostname) {
  // Normalize: strip www., keep TLD+1
  return hostname.replace(/^www\./, '').toLowerCase();
}

function getJar(sessionId) {
  if (!cookieJars.has(sessionId)) cookieJars.set(sessionId, new Map());
  return cookieJars.get(sessionId);
}

function parseCookieHeader(raw) {
  // Returns { name, value, domain, path, expires, httpOnly, secure, sameSite }
  const parts  = raw.split(';').map(s => s.trim());
  const [name, ...valParts] = parts[0].split('=');
  const value  = valParts.join('=');
  const meta   = {};
  for (let i = 1; i < parts.length; i++) {
    const [k, v] = parts[i].split('=');
    meta[k.trim().toLowerCase()] = (v || '').trim();
  }
  return {
    name:     name.trim(),
    value,
    domain:   meta.domain   || '',
    path:     meta.path     || '/',
    expires:  meta.expires  ? new Date(meta.expires).getTime() : (meta['max-age'] ? Date.now() + parseInt(meta['max-age']) * 1000 : Infinity),
    httpOnly: 'httponly' in meta,
    secure:   'secure'   in meta,
    sameSite: meta.samesite || '',
  };
}

function storeCookies(sessionId, hostname, setCookieList) {
  if (!sessionId || !setCookieList || !setCookieList.length) return;
  const jar     = getJar(sessionId);
  const domain  = getDomainKey(hostname);
  if (!jar.has(domain)) jar.set(domain, new Map());
  const domJar  = jar.get(domain);
  for (const raw of setCookieList) {
    try {
      const c = parseCookieHeader(raw);
      if (!c.name) continue;
      if (c.expires !== Infinity && c.expires < Date.now()) {
        domJar.delete(c.name); // expired → delete
      } else {
        domJar.set(c.name, c);
      }
    } catch {}
  }
}

function buildCookieHeader(sessionId, hostname) {
  if (!sessionId) return '';
  const jar    = getJar(sessionId);
  const domain = getDomainKey(hostname);
  const now    = Date.now();
  const parts  = [];

  // Collect cookies matching this domain or parent domains
  jar.forEach((domJar, key) => {
    if (domain === key || domain.endsWith('.' + key) || key.endsWith('.' + domain.replace(/^\./, ''))) {
      domJar.forEach(c => {
        if (c.expires !== Infinity && c.expires < now) return;
        parts.push(`${c.name}=${c.value}`);
      });
    }
  });

  return parts.join('; ');
}

// ─── URL HELPERS ─────────────────────────────────────────────────────────────
function resolveUrl(base, rel) {
  if (!rel) return base;
  if (/^https?:\/\//i.test(rel)) return rel;
  if (rel.startsWith('//')) {
    try { return new URL(base).protocol + rel; } catch { return 'https:' + rel; }
  }
  try { return new URL(rel, base).href; } catch { return rel; }
}

function mkProxyUrl(abs, sid) {
  return `/proxy?url=${encodeURIComponent(abs)}&sid=${encodeURIComponent(sid || '')}`;
}

function mkAssetUrl(abs) {
  return `/asset?url=${encodeURIComponent(abs)}`;
}

function isNavigable(url) {
  return /^https?:\/\//i.test(url);
}

// ─── CSS REWRITER ────────────────────────────────────────────────────────────
function rewriteCss(css, baseUrl) {
  // url() references
  css = css.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (m, q, u) => {
    if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('#')) return m;
    const abs = resolveUrl(baseUrl, u);
    return isNavigable(abs) ? `url('${mkAssetUrl(abs)}')` : m;
  });
  // @import url or @import "..."
  css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
    const abs = resolveUrl(baseUrl, u);
    return isNavigable(abs) ? `@import '${mkAssetUrl(abs)}'` : m;
  });
  css = css.replace(/@import\s+url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (m, q, u) => {
    const abs = resolveUrl(baseUrl, u);
    return isNavigable(abs) ? `@import url('${mkAssetUrl(abs)}')` : m;
  });
  return css;
}

// ─── HTML REWRITER ────────────────────────────────────────────────────────────
function rewriteHtml(rawHtml, pageUrl, sid) {
  const $ = cheerio.load(rawHtml, { decodeEntities: false });

  // 1. Remove all CSP, X-Frame-Options meta tags
  $('meta[http-equiv]').each((_, el) => {
    const v = ($(el).attr('http-equiv') || '').toLowerCase();
    if (v === 'content-security-policy' || v === 'x-frame-options' || v === 'x-xss-protection') {
      $(el).remove();
    }
  });

  // 2. Remove/rewrite <base>
  let baseUrl = pageUrl;
  $('base').each((_, el) => {
    const h = $(el).attr('href');
    if (h) try { baseUrl = resolveUrl(pageUrl, h); } catch {}
    $(el).remove();
  });

  // 3. <a href> — ALWAYS rewrite, remove target/_blank, keep in sandbox
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href || /^(javascript:|mailto:|tel:|#)/.test(href)) return;
    const abs = resolveUrl(baseUrl, href);
    if (isNavigable(abs)) {
      $(el).attr('href', mkProxyUrl(abs, sid));
    }
    // CRITICAL: remove ALL target attributes to prevent escaping sandbox
    $(el).removeAttr('target');
    $(el).attr('data-sandbox-href', abs);
  });

  // 4. <link> — stylesheets, icons, preload, etc.
  $('link[href]').each((_, el) => {
    const rel  = ($(el).attr('rel') || '').toLowerCase();
    const href = $(el).attr('href') || '';
    if (!href || href.startsWith('data:')) return;
    const abs = resolveUrl(baseUrl, href);
    if (!isNavigable(abs)) return;
    if (rel.includes('stylesheet') || rel.includes('preload') || rel.includes('prefetch') || rel.includes('icon') || rel.includes('canonical')) {
      $(el).attr('href', mkAssetUrl(abs));
    } else {
      $(el).attr('href', mkProxyUrl(abs, sid));
    }
  });

  // 5. <script src>
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    const abs = resolveUrl(baseUrl, src);
    if (isNavigable(abs)) $(el).attr('src', mkAssetUrl(abs));
  });

  // 6. Media elements: img, source, video, audio, track, input[type=image]
  $('img[src], source[src], video[src], audio[src], track[src], input[type=image][src]').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
      const abs = resolveUrl(baseUrl, src);
      if (isNavigable(abs)) $(el).attr('src', mkAssetUrl(abs));
    }
    const srcset = $(el).attr('srcset') || '';
    if (srcset) {
      const rw = srcset.split(',').map(part => {
        const [s, ...rest] = part.trim().split(/\s+/);
        if (!s) return part;
        const abs = resolveUrl(baseUrl, s);
        return [isNavigable(abs) ? mkAssetUrl(abs) : s, ...rest].join(' ');
      }).join(', ');
      $(el).attr('srcset', rw);
    }
    const poster = $(el).attr('poster') || '';
    if (poster && !poster.startsWith('data:')) {
      const abs = resolveUrl(baseUrl, poster);
      if (isNavigable(abs)) $(el).attr('poster', mkAssetUrl(abs));
    }
    const lazySrc = $(el).attr('data-src') || '';
    if (lazySrc && !lazySrc.startsWith('data:') && !lazySrc.startsWith('blob:')) {
      const abs = resolveUrl(baseUrl, lazySrc);
      if (isNavigable(abs)) $(el).attr('data-src', mkAssetUrl(abs));
    }
  });

  // 7. Nested <iframe> — proxy them too
  $('iframe[src]').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!src || src.startsWith('data:') || src.startsWith('javascript:') || src.startsWith('about:')) return;
    const abs = resolveUrl(baseUrl, src);
    if (isNavigable(abs)) {
      $(el).attr('src', mkProxyUrl(abs, sid));
      $(el).removeAttr('sandbox'); // don't restrict nested iframes
    }
  });

  // 8. <form> — handle GET and POST
  $('form').each((_, el) => {
    const action = $(el).attr('action') || '';
    const method = ($(el).attr('method') || 'GET').toUpperCase();
    const abs    = action ? resolveUrl(baseUrl, action) : baseUrl;
    $(el).removeAttr('target'); // never escape sandbox via form submit
    if (isNavigable(abs)) {
      if (method === 'POST') {
        $(el).attr('action', `/form-post?target=${encodeURIComponent(abs)}&sid=${encodeURIComponent(sid || '')}`);
      } else {
        // For GET, append to proxy URL via hidden input
        $(el).attr('action', '/form-get');
        $(el).attr('method', 'GET');
        // Add hidden input for base target
        $(el).append(`<input type="hidden" name="_proxy_target" value="${abs}" />`);
        $(el).append(`<input type="hidden" name="sid" value="${sid || ''}" />`);
      }
    }
  });

  // 9. Inline style url()
  $('[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    if (style.includes('url(')) {
      $(el).attr('style', rewriteCss(style, baseUrl));
    }
  });

  // 10. <style> blocks
  $('style').each((_, el) => {
    const css = $(el).html() || '';
    if (css) $(el).html(rewriteCss(css, baseUrl));
  });

  // 11. Background image attributes
  $('[background]').each((_, el) => {
    const bg = $(el).attr('background') || '';
    if (bg && isNavigable(resolveUrl(baseUrl, bg))) {
      $(el).attr('background', mkAssetUrl(resolveUrl(baseUrl, bg)));
    }
  });

  // 12. Inject interceptor script as FIRST thing in <head>
  const interceptor = buildInterceptor(baseUrl, sid);
  if ($('head').length) {
    $('head').prepend(interceptor);
  } else if ($('html').length) {
    $('html').prepend(`<head>${interceptor}</head>`);
  } else {
    $.root().prepend(`<head>${interceptor}</head>`);
  }

  return $.html();
}

// ─── INTERCEPTOR INJECTED INTO EVERY PAGE ───────────────────────────────────
function buildInterceptor(baseUrl, sid) {
  return `<script data-sandbox="interceptor">
(function(){
var _BASE = ${JSON.stringify(baseUrl)};
var _SID  = ${JSON.stringify(sid || '')};

function toAbs(u){
  if(!u) return u;
  if(/^https?:\/\//i.test(u)) return u;
  if(u.startsWith('//')) return location.protocol+u;
  try{ return new URL(u,_BASE).href; }catch(e){ return u; }
}
function proxyNav(abs){
  return '/proxy?url='+encodeURIComponent(abs)+'&sid='+encodeURIComponent(_SID);
}
function proxyAsset(abs){
  return '/asset?url='+encodeURIComponent(abs);
}

// ── Block ALL window.open to prevent escaping ──────────────────────────
window.open = function(u,t,f){
  if(u && u!=='about:blank' && !/^javascript:/.test(u)){
    var abs=toAbs(u);
    if(/^https?:\/\//.test(abs)){
      window.top.postMessage({type:'navigate',url:abs},'*');
      return {closed:false,focus:function(){},document:{write:function(){},close:function(){}}};
    }
  }
  return null;
};

// ── Intercept ALL anchor clicks (including dynamic ones) ───────────────
document.addEventListener('click',function(e){
  var node=e.target;
  for(var i=0;i<8;i++){
    if(!node||node===document) break;
    if(node.tagName==='A') break;
    node=node.parentElement;
  }
  if(!node||node.tagName!=='A') return;
  var href=node.getAttribute('href');
  if(!href||/^(javascript:|#|mailto:|tel:)/.test(href)) return;
  var abs=toAbs(href);
  if(!/^https?:\/\//.test(abs)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  window.top.postMessage({type:'navigate',url:abs},'*');
},true);

// ── Block form targets ─────────────────────────────────────────────────
document.addEventListener('submit',function(e){
  var f=e.target;
  if(f&&f.tagName==='FORM'){
    f.removeAttribute('target');
    var action=f.getAttribute('action')||location.href;
    // Already rewritten server-side; just ensure no _blank
  }
},true);

// ── history API ────────────────────────────────────────────────────────
(function(){
var wrap=function(orig){
  return function(state,title,url){
    try{ orig.call(history,state,title,url); }catch(e){}
    if(url){
      var abs=toAbs(String(url));
      if(/^https?:\/\//.test(abs)){
        window.top.postMessage({type:'softNav',url:abs},'*');
      }
    }
  };
};
try{
  history.pushState=wrap(history.pushState);
  history.replaceState=wrap(history.replaceState);
}catch(e){}
})();

// ── Intercept fetch() ──────────────────────────────────────────────────
(function(){
var _f=window.fetch;
if(!_f) return;
window.fetch=function(input,init){
  try{
    var url=(input instanceof Request)?input.url:String(input);
    if(/^https?:\/\//i.test(url)){
      var p=proxyAsset(url);
      input=(input instanceof Request)?new Request(p,input):p;
    }
  }catch(e){}
  return _f.call(window,input,init);
};
})();

// ── Intercept XMLHttpRequest ───────────────────────────────────────────
(function(){
var _open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u,a,us,pw){
  try{
    if(/^https?:\/\//i.test(u)) u=proxyAsset(u);
  }catch(e){}
  return _open.call(this,m,u,a!==false,us,pw);
};
})();

// ── MutationObserver: rewrite dynamic <a> ─────────────────────────────
(function(){
var done=function(node){
  if(!node||node.nodeType!==1) return;
  var nodes=node.tagName==='A'?[node]:Array.from(node.querySelectorAll('a[href]'));
  nodes.forEach(function(a){
    var h=a.getAttribute('href');
    if(!h||/^(javascript:|#|mailto:|tel:|\/proxy\?|\/asset\?)/.test(h)) return;
    var abs=toAbs(h);
    if(!/^https?:\/\//.test(abs)) return;
    a.setAttribute('href',proxyNav(abs));
    a.removeAttribute('target');
    a.removeAttribute('rel');
  });
  var forms=node.tagName==='FORM'?[node]:Array.from(node.querySelectorAll('form'));
  forms.forEach(function(f){ f.removeAttribute('target'); });
};
try{
  var mo=new MutationObserver(function(muts){
    muts.forEach(function(m){
      m.addedNodes.forEach(done);
    });
  });
  mo.observe(document.documentElement||document.body||document,{childList:true,subtree:true});
}catch(e){}
})();

// ── Report page loaded ─────────────────────────────────────────────────
function reportLoaded(){
  if(window.top===window) return;
  window.top.postMessage({
    type:'pageLoaded',
    url:_BASE,
    title:document.title||_BASE
  },'*');
}
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',reportLoaded);
} else {
  reportLoaded();
}
window.addEventListener('load',reportLoaded);

})();
</script>`;
}

// ─── MULTI-STRATEGY FETCH ────────────────────────────────────────────────────
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_MOBILE  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_CURL    = 'curl/8.4.0';
const UA_BOT     = 'Googlebot/2.1 (+http://www.google.com/bot.html)';

function buildHeaders(parsedUrl, sessionId, ua, extra) {
  const cookies = buildCookieHeader(sessionId, parsedUrl.hostname);
  return Object.assign({
    'User-Agent':      ua,
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
    'Sec-Ch-Ua':       '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile':'?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest':  'document',
    'Sec-Fetch-Mode':  'navigate',
    'Sec-Fetch-Site':  'none',
    'Sec-Fetch-User':  '?1',
    'Upgrade-Insecure-Requests': '1',
    ...(cookies ? { 'Cookie': cookies } : {}),
    ...(extra || {}),
  }, extra || {});
}

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const httpAgent  = new http.Agent({ keepAlive: true });

async function tryFetch(url, headers, timeout, method, body) {
  const parsed = new URL(url);
  const agent  = parsed.protocol === 'https:' ? httpsAgent : httpAgent;
  const ctrl   = new AbortController();
  const tid    = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: method || 'GET',
      headers,
      body:   body || undefined,
      redirect: 'follow',
      signal: ctrl.signal,
      agent,
    });
    clearTimeout(tid);
    return res;
  } catch(e) {
    clearTimeout(tid);
    throw e;
  }
}

async function smartFetch(targetUrl, sessionId, method, body, extraHeaders) {
  let parsed;
  try { parsed = new URL(targetUrl); } catch { throw new Error('Invalid URL: ' + targetUrl); }

  // Strategy 1: Desktop Chrome
  try {
    const h   = buildHeaders(parsed, sessionId, UA_DESKTOP, extraHeaders);
    const res = await tryFetch(targetUrl, h, 20000, method, body);
    saveCookiesFromResponse(res, sessionId, parsed.hostname);
    return res;
  } catch(e1) {
    if (e1.name === 'AbortError') throw new Error('Timed out');
  }

  // Strategy 2: Mobile UA
  try {
    const h   = buildHeaders(parsed, sessionId, UA_MOBILE, extraHeaders);
    const res = await tryFetch(targetUrl, h, 15000, method, body);
    saveCookiesFromResponse(res, sessionId, parsed.hostname);
    return res;
  } catch(e2) {
    if (e2.name === 'AbortError') throw new Error('Timed out');
  }

  // Strategy 3: Minimal curl-like headers (bypasses some Cloudflare "bot" detection)
  try {
    const minimal = {
      'User-Agent': UA_CURL,
      'Accept': '*/*',
      'Accept-Encoding': 'identity',
    };
    const res = await tryFetch(targetUrl, minimal, 15000, method, body);
    saveCookiesFromResponse(res, sessionId, parsed.hostname);
    return res;
  } catch(e3) {
    if (e3.name === 'AbortError') throw new Error('Timed out');
  }

  // Strategy 4: Googlebot
  try {
    const h   = { 'User-Agent': UA_BOT, 'Accept': 'text/html', 'Accept-Encoding': 'identity' };
    const res = await tryFetch(targetUrl, h, 15000, method, body);
    saveCookiesFromResponse(res, sessionId, parsed.hostname);
    return res;
  } catch(e4) {
    throw new Error('All fetch strategies failed. Site may block all proxies.');
  }
}

function saveCookiesFromResponse(res, sessionId, hostname) {
  if (!sessionId || !res || !res.headers) return;
  try {
    // node-fetch exposes raw headers via .raw()
    const raw = res.headers.raw ? res.headers.raw()['set-cookie'] : null;
    if (raw && raw.length) storeCookies(sessionId, hostname, raw);
  } catch {}
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Home
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// ─── MAIN HTML PROXY ─────────────────────────────────────────────────────────
app.get('/proxy', handleProxy);

async function handleProxy(req, res) {
  const targetUrl = req.query.url || '';
  const sid       = req.query.sid || req.query.sessionId || '';

  if (!targetUrl) {
    return res.status(400).send(errorHtml('No URL provided', '', sid));
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).send(errorHtml('Only HTTP/HTTPS supported', targetUrl, sid));
    }
  } catch {
    return res.status(400).send(errorHtml('Invalid URL: ' + targetUrl, targetUrl, sid));
  }

  try {
    const response = await smartFetch(targetUrl, sid);
    const ct       = response.headers.get('content-type') || '';
    const finalUrl = response.url || targetUrl;

    // Non-HTML → redirect to asset proxy
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
      return res.redirect(302, `/asset?url=${encodeURIComponent(targetUrl)}`);
    }

    let html = '';
    try { html = await response.text(); } catch { html = ''; }

    // Extract title + favicon before rewriting
    const $m       = cheerio.load(html, { decodeEntities: false });
    const title    = $m('title').first().text().trim() || parsed.hostname;
    let   favicon  = '';
    const favEl    = $m('link[rel*="icon"]').first();
    if (favEl.length) {
      try { favicon = resolveUrl(finalUrl, favEl.attr('href') || ''); } catch {}
    }
    if (!favicon) favicon = `${parsed.protocol}//${parsed.host}/favicon.ico`;

    // Rewrite HTML
    const rewritten = rewriteHtml(html, finalUrl, sid);

    // Update session
    if (sid) {
      const session = getSession(sid);
      addHistory(session, { url: finalUrl, title, favicon });
      session.currentUrl   = finalUrl;
      session.currentTitle = title;
    }

    // Strip all server-sent security headers
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Content-Type-Options');
    res.removeHeader('Cross-Origin-Embedder-Policy');
    res.removeHeader('Cross-Origin-Opener-Policy');
    res.removeHeader('Cross-Origin-Resource-Policy');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Sandbox-Url', encodeURIComponent(finalUrl));
    res.send(rewritten);

  } catch (err) {
    res.status(502).send(errorHtml(err.message || 'Failed to fetch page', targetUrl, sid));
  }
}

// ─── GET FORM HANDLER ────────────────────────────────────────────────────────
app.get('/form-get', (req, res) => {
  const { _proxy_target, sid, ...rest } = req.query;
  if (!_proxy_target) return res.redirect('/');
  try {
    const base = new URL(_proxy_target);
    const qs   = new URLSearchParams(rest).toString();
    const full = `${base.origin}${base.pathname}${qs ? '?' + qs : ''}`;
    return res.redirect(302, `/proxy?url=${encodeURIComponent(full)}&sid=${encodeURIComponent(sid || '')}`);
  } catch {
    return res.redirect('/');
  }
});

// ─── POST FORM HANDLER ────────────────────────────────────────────────────────
app.post('/form-post', async (req, res) => {
  const target = req.query.target || '';
  const sid    = req.query.sid || '';

  if (!target) return res.status(400).send(errorHtml('Missing target', '', sid));

  try {
    const parsed = new URL(target);
    const body   = new URLSearchParams(req.body).toString();
    const response = await smartFetch(target, sid, 'POST', body, {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(body)),
      'Origin': `${parsed.protocol}//${parsed.host}`,
      'Referer': target,
    });

    const ct       = response.headers.get('content-type') || '';
    const finalUrl = response.url || target;

    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
      return res.redirect(302, `/asset?url=${encodeURIComponent(target)}`);
    }

    let html = '';
    try { html = await response.text(); } catch { html = ''; }

    const rewritten = rewriteHtml(html, finalUrl, sid);
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (sid) {
      const session = getSession(sid);
      const $m = cheerio.load(html, { decodeEntities: false });
      const title = $m('title').first().text().trim() || new URL(finalUrl).hostname;
      addHistory(session, { url: finalUrl, title });
      session.currentUrl = finalUrl;
      session.currentTitle = title;
    }

    res.send(rewritten);
  } catch (err) {
    res.status(502).send(errorHtml('Form submission failed: ' + err.message, target, sid));
  }
});

// ─── ASSET PROXY ─────────────────────────────────────────────────────────────
app.get('/asset', handleAsset);

async function handleAsset(req, res) {
  const assetRaw = req.query.url || '';
  if (!assetRaw) return res.status(400).send('Missing url');

  let parsed;
  try {
    parsed = new URL(assetRaw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).send('Invalid protocol');
  } catch {
    return res.status(400).send('Invalid URL');
  }

  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 15000);
    const agent = parsed.protocol === 'https:' ? httpsAgent : httpAgent;

    const res2 = await fetch(assetRaw, {
      signal:  ctrl.signal,
      redirect:'follow',
      agent,
      headers: {
        'User-Agent':      UA_DESKTOP,
        'Accept':          '*/*',
        'Accept-Encoding': 'identity',
        'Referer':         `${parsed.protocol}//${parsed.host}/`,
        'Origin':          `${parsed.protocol}//${parsed.host}`,
      },
    });
    clearTimeout(tid);

    const ct = res2.headers.get('content-type') || 'application/octet-stream';

    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');

    if (ct.includes('text/css')) {
      let css = '';
      try { css = await res2.text(); } catch {}
      return res.send(rewriteCss(css, res2.url || assetRaw));
    }

    // Pipe everything else
    res2.body.pipe(res);
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).send('Asset timeout');

    // Fallback: try HTTP if HTTPS failed
    if (assetRaw.startsWith('https://')) {
      try {
        const fallback = assetRaw.replace('https://', 'http://');
        const res3 = await fetch(fallback, {
          headers: { 'User-Agent': UA_DESKTOP, 'Accept': '*/*', 'Accept-Encoding': 'identity' },
          redirect: 'follow',
        });
        const ct3 = res3.headers.get('content-type') || 'application/octet-stream';
        res.setHeader('Content-Type', ct3);
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (ct3.includes('text/css')) {
          let css = await res3.text();
          return res.send(rewriteCss(css, res3.url || fallback));
        }
        return res3.body.pipe(res);
      } catch {}
    }

    res.status(502).send('Asset failed: ' + err.message);
  }
}

// ─── SESSION API ─────────────────────────────────────────────────────────────
app.post('/api/session', (req, res) => {
  const id = req.body.sessionId || uuidv4();
  res.json({ success: true, sessionId: id, session: getSession(id) });
});

app.get('/api/session/:id', (req, res) => {
  res.json({ success: true, session: getSession(req.params.id) });
});

app.post('/api/session/:id/save', (req, res) => {
  const s = getSession(req.params.id);
  const { history, bookmarks, currentUrl, currentTitle } = req.body;
  if (Array.isArray(history))    s.history      = history;
  if (Array.isArray(bookmarks))  s.bookmarks    = bookmarks;
  if (currentUrl   != null)      s.currentUrl   = currentUrl;
  if (currentTitle != null)      s.currentTitle = currentTitle;
  res.json({ success: true });
});

app.post('/api/session/:id/bookmark', (req, res) => {
  const s = getSession(req.params.id);
  const { url: u, title, favicon } = req.body;
  if (u && !s.bookmarks.find(b => b.url === u)) {
    s.bookmarks.push({ url: u, title: title || u, favicon: favicon || '', addedAt: Date.now() });
  }
  res.json({ success: true, bookmarks: s.bookmarks });
});

app.delete('/api/session/:id/bookmark', (req, res) => {
  const s = getSession(req.params.id);
  s.bookmarks = s.bookmarks.filter(b => b.url !== req.body.url);
  res.json({ success: true, bookmarks: s.bookmarks });
});

app.delete('/api/session/:id/history', (req, res) => {
  getSession(req.params.id).history = [];
  res.json({ success: true });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, sessions: sessions.size, uptime: Math.round(process.uptime()) });
});

// ─── ERROR PAGE ───────────────────────────────────────────────────────────────
function errorHtml(msg, url, sid) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<script>
(function(){
  function send(){
    if(window.top!==window) window.top.postMessage({type:'proxyError',message:${JSON.stringify(String(msg))},url:${JSON.stringify(String(url||''))}},'*');
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',send);
  else send();
})();
</script>
</head>
<body style="margin:0;background:#0a0a0f;color:#e8e8f0;font-family:monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;padding:32px;text-align:center">
<div style="font-size:64px;font-weight:900;color:#ff6b6b;letter-spacing:-3px">ERR</div>
<div style="font-size:14px;color:#9090c0;max-width:480px;line-height:1.7">${String(msg).replace(/</g,'&lt;')}</div>
<div style="font-size:11px;color:#3a3a5a;word-break:break-all;max-width:480px">${String(url||'').replace(/</g,'&lt;')}</div>
<div style="display:flex;gap:12px;margin-top:8px">
  <button onclick="window.top.postMessage({type:'retryNav',url:${JSON.stringify(String(url||''))}},'*')" style="padding:10px 24px;background:#7c5cfc;border:none;border-radius:8px;color:#fff;cursor:pointer;font-size:13px;font-weight:700">Retry</button>
  <button onclick="window.top.postMessage({type:'goHome'},'*')" style="padding:10px 24px;background:#1e1e2e;border:1px solid #2a2a3e;border-radius:8px;color:#e8e8f0;cursor:pointer;font-size:13px">Home</button>
</div>
<div style="margin-top:16px;font-size:11px;color:#3a3a5a;max-width:480px;line-height:1.6">
  💡 Some sites (Cloudflare-protected, login-required) may not work fully in a proxy sandbox. Try clicking Retry.
</div>
</body></html>`;
}

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`WebSandbox v3 → http://localhost:${PORT}`));
module.exports = app;
