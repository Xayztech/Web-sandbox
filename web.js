'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  WebSandbox v4 — Production-grade proxy
//  Architecture fixes vs v3:
//  1. Server is STATELESS — all session/history stored in client localStorage
//  2. CORS proxy endpoint for XHR/fetch from within sandboxed pages
//  3. Ultra-realistic browser headers (rotating fingerprints)
//  4. Proper Set-Cookie round-trip via response headers to client
//  5. Full redirect chain following with Location rewriting
//  6. Multi-platform deploy support (Vercel, Railway, Fly, VPS, Docker)
// ══════════════════════════════════════════════════════════════════════════════

const express   = require('express');
const fetch     = require('node-fetch');
const https     = require('https');
const http      = require('http');
const cheerio   = require('cheerio');
const { v4: uuidv4 } = require('uuid');
const cors      = require('cors');
const path      = require('path');
const urlMod    = require('url');
const crypto    = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── AGENTS ────────────────────────────────────────────────────────────────────
const agentHttps = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 64,
  timeout: 30000,
});
const agentHttp = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  timeout: 30000,
});

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'], allowedHeaders: '*' }));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── BROWSER PROFILES ──────────────────────────────────────────────────────────
// Rotate between realistic browser fingerprints to avoid datacenter detection
const PROFILES = [
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ch_ua: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    ch_platform: '"Windows"',
    ch_mobile: '?0',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    accept_lang: 'en-US,en;q=0.9',
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ch_ua: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    ch_platform: '"macOS"',
    ch_mobile: '?0',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    accept_lang: 'en-US,en;q=0.9',
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    ch_ua: null,
    ch_platform: null,
    ch_mobile: null,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    accept_lang: 'en-US,en;q=0.5',
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
    ch_ua: null,
    ch_platform: null,
    ch_mobile: null,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    accept_lang: 'en-US,en;q=0.9',
  },
];

function pickProfile(url) {
  // Deterministic per-domain so same site always gets same UA (avoids bot detection from UA switching)
  try {
    const h = new URL(url).hostname;
    const idx = Math.abs(h.split('').reduce((a,c) => a + c.charCodeAt(0), 0)) % PROFILES.length;
    return PROFILES[idx];
  } catch {
    return PROFILES[0];
  }
}

function buildHeaders(targetUrl, cookieStr, extraHeaders) {
  const p = pickProfile(targetUrl);
  let parsed;
  try { parsed = new URL(targetUrl); } catch { parsed = { host: '', protocol: 'https:', origin: '' }; }

  const h = {
    'Accept':                    p.accept,
    'Accept-Language':           p.accept_lang,
    'Accept-Encoding':           'gzip, deflate, br',
    'User-Agent':                p.ua,
    'Cache-Control':             'max-age=0',
    'Sec-Fetch-Dest':            'document',
    'Sec-Fetch-Mode':            'navigate',
    'Sec-Fetch-Site':            'none',
    'Sec-Fetch-User':            '?1',
    'Upgrade-Insecure-Requests': '1',
    'Connection':                'keep-alive',
  };

  if (p.ch_ua) {
    h['Sec-Ch-Ua']           = p.ch_ua;
    h['Sec-Ch-Ua-Mobile']    = p.ch_mobile;
    h['Sec-Ch-Ua-Platform']  = p.ch_platform;
  }

  if (cookieStr) h['Cookie'] = cookieStr;
  if (parsed.host) h['Host'] = parsed.host;

  return Object.assign(h, extraHeaders || {});
}

// ── URL HELPERS ───────────────────────────────────────────────────────────────
function absUrl(base, rel) {
  if (!rel) return base;
  if (/^https?:\/\//i.test(rel)) return rel;
  if (rel.startsWith('//')) {
    try { return new URL(base).protocol + rel; } catch { return 'https:' + rel; }
  }
  if (rel.startsWith('?') || rel.startsWith('#')) {
    try { const u = new URL(base); return u.origin + u.pathname + rel; } catch {}
  }
  try { return new URL(rel, base).href; } catch { return rel; }
}

const isHttp = u => /^https?:\/\//i.test(u);

function pUrl(abs, sid) {
  return `/p?u=${encodeURIComponent(abs)}&s=${encodeURIComponent(sid || '')}`;
}
function aUrl(abs) {
  return `/a?u=${encodeURIComponent(abs)}`;
}
function cUrl(abs, sid) {
  return `/c?u=${encodeURIComponent(abs)}&s=${encodeURIComponent(sid || '')}`;
}

// ── CSS REWRITER ──────────────────────────────────────────────────────────────
function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (m, q, u) => {
      if (!u || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('#')) return m;
      const a = absUrl(base, u);
      return isHttp(a) ? `url('${aUrl(a)}')` : m;
    })
    .replace(/@import\s+url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (m, q, u) => {
      const a = absUrl(base, u);
      return isHttp(a) ? `@import url('${aUrl(a)}')` : m;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
      const a = absUrl(base, u);
      return isHttp(a) ? `@import '${aUrl(a)}'` : m;
    });
}

// ── HTML REWRITER ─────────────────────────────────────────────────────────────
function rewriteHtml(rawHtml, pageUrl, sid) {
  const $ = cheerio.load(rawHtml, { decodeEntities: false });

  // 1) Strip ALL security headers that block framing
  $('meta[http-equiv]').each((_, el) => {
    const v = ($(el).attr('http-equiv') || '').toLowerCase();
    if (['content-security-policy','x-frame-options','x-xss-protection',
         'cross-origin-embedder-policy','cross-origin-opener-policy'].includes(v)) {
      $(el).remove();
    }
  });

  // 2) Handle <base> tag
  let base = pageUrl;
  $('base').each((_, el) => {
    const h = $(el).attr('href');
    if (h) try { base = absUrl(pageUrl, h); } catch {}
    $(el).remove();
  });

  // 3) <a href> — rewrite + strip target
  $('a[href]').each((_, el) => {
    const h = $(el).attr('href') || '';
    if (!h || /^(javascript:|mailto:|tel:|#)/.test(h)) {
      $(el).removeAttr('target'); return;
    }
    const a = absUrl(base, h);
    if (isHttp(a)) $(el).attr('href', pUrl(a, sid));
    $(el).removeAttr('target');
    $(el).removeAttr('ping');
  });

  // 4) <link>
  $('link[href]').each((_, el) => {
    const rel  = ($(el).attr('rel') || '').toLowerCase();
    const href = $(el).attr('href') || '';
    if (!href || href.startsWith('data:')) return;
    const a = absUrl(base, href);
    if (!isHttp(a)) return;
    if (rel.includes('stylesheet') || rel.includes('preload') || rel.includes('prefetch') || rel.includes('icon')) {
      $(el).attr('href', aUrl(a));
    } else {
      $(el).attr('href', pUrl(a, sid));
    }
  });

  // 5) <script src>
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    const a = absUrl(base, src);
    if (isHttp(a)) $(el).attr('src', aUrl(a));
  });

  // 6) All media: img, source, video, audio, input[type=image], picture
  $('img, source, video, audio, track').each((_, el) => {
    ['src','data-src','data-lazy-src','data-original'].forEach(attr => {
      const v = $(el).attr(attr) || '';
      if (v && !v.startsWith('data:') && !v.startsWith('blob:')) {
        const a = absUrl(base, v);
        if (isHttp(a)) $(el).attr(attr, aUrl(a));
      }
    });
    const srcset = $(el).attr('srcset') || '';
    if (srcset) {
      $(el).attr('srcset', srcset.split(',').map(part => {
        const [s, ...rest] = part.trim().split(/\s+/);
        if (!s) return part;
        const a = absUrl(base, s);
        return [isHttp(a) ? aUrl(a) : s, ...rest].join(' ');
      }).join(', '));
    }
    const poster = $(el).attr('poster') || '';
    if (poster && !poster.startsWith('data:')) {
      const a = absUrl(base, poster);
      if (isHttp(a)) $(el).attr('poster', aUrl(a));
    }
  });

  // 7) <iframe src>
  $('iframe, frame').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!src || src.startsWith('data:') || src.startsWith('javascript:') || src.startsWith('about:')) return;
    const a = absUrl(base, src);
    if (isHttp(a)) {
      $(el).attr('src', pUrl(a, sid));
      $(el).removeAttr('sandbox');
      $(el).attr('allow', 'scripts; forms; same-origin; popups');
    }
  });

  // 8) <form>
  $('form').each((_, el) => {
    const action = $(el).attr('action') || '';
    const method = ($(el).attr('method') || 'GET').toUpperCase();
    $(el).removeAttr('target');
    if (!action || /^(javascript:|#)/.test(action)) return;
    const a = absUrl(base, action);
    if (!isHttp(a)) return;
    if (method === 'POST') {
      $(el).attr('action', `/fp?t=${encodeURIComponent(a)}&s=${encodeURIComponent(sid || '')}`);
    } else {
      $(el).attr('action', '/fg');
      $(el).attr('method', 'GET');
      $(el).append(`<input type="hidden" name="_pt" value="${a.replace(/"/g,'&quot;')}" />`);
      $(el).append(`<input type="hidden" name="_ps" value="${(sid||'').replace(/"/g,'&quot;')}" />`);
    }
  });

  // 9) Inline style
  $('[style]').each((_, el) => {
    const s = $(el).attr('style') || '';
    if (s.includes('url(')) $(el).attr('style', rewriteCss(s, base));
  });

  // 10) <style> blocks
  $('style').each((_, el) => {
    const c = $(el).html() || '';
    if (c) $(el).html(rewriteCss(c, base));
  });

  // 11) background attribute
  $('[background]').each((_, el) => {
    const bg = $(el).attr('background') || '';
    if (bg) { const a = absUrl(base, bg); if (isHttp(a)) $(el).attr('background', aUrl(a)); }
  });

  // 12) Open Graph / meta tags with URLs
  $('meta[content]').each((_, el) => {
    const prop = ($(el).attr('property') || $(el).attr('name') || '').toLowerCase();
    if (prop.includes('url') || prop.includes('image')) {
      const c = $(el).attr('content') || '';
      if (isHttp(c)) $(el).attr('content', aUrl(c));
    }
  });

  // 13) Inject interceptor + CORS proxy fix as first script in head
  const interceptor = makeInterceptor(base, sid);
  if ($('head').length) $('head').prepend(interceptor);
  else if ($('html').length) $('html').prepend(`<head>${interceptor}</head>`);
  else $.root().prepend(interceptor);

  return $.html();
}

// ── CLIENT-SIDE INTERCEPTOR ───────────────────────────────────────────────────
function makeInterceptor(base, sid) {
  return `<script data-wsb="1">
(function(W,D,H){
'use strict';
var BASE=${JSON.stringify(base)};
var SID=${JSON.stringify(sid||'')};
var PX='/p';
var AX='/a';
var CX='/c';

function abs(u){
  if(!u) return u;
  if(/^https?:\\/\\//i.test(u)) return u;
  if(u.startsWith('//')) return location.protocol+u;
  if(u.startsWith('?')||u.startsWith('#')){
    try{var pu=new URL(BASE);return pu.origin+pu.pathname+u;}catch(e){}
  }
  try{return new URL(u,BASE).href;}catch(e){return u;}
}
function px(u){return PX+'?u='+encodeURIComponent(u)+'&s='+encodeURIComponent(SID);}
function ax(u){return AX+'?u='+encodeURIComponent(u);}
function cx(u){return CX+'?u='+encodeURIComponent(u)+'&s='+encodeURIComponent(SID);}

// ── window.open → stays in sandbox ──────────────────────────────────────────
W.open=function(u,t,f){
  if(u&&u!=='about:blank'&&!/^javascript:/.test(u)){
    var a=abs(u);
    if(/^https?:\\/\\//.test(a)){
      try{W.top.postMessage({type:'wsb_nav',url:a},'*');}catch(e){}
      return {closed:false,focus:function(){},location:{href:a}};
    }
  }
  return null;
};

// ── Block ALL target=_blank via click capture ────────────────────────────────
D.addEventListener('click',function(e){
  var n=e.target,depth=0;
  while(n&&n!==D&&depth++<10){
    if(n.tagName==='A') break;
    n=n.parentElement;
  }
  if(!n||n.tagName!=='A') return;
  var h=n.getAttribute('href')||'';
  if(!h||/^(javascript:|#|mailto:|tel:)/.test(h)) return;
  var a=abs(h);
  if(!/^https?:\\/\\//.test(a)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  // If already proxied, extract real URL
  if(a.includes('/p?u=')||a.includes('/p%3Fu%3D')){
    try{a=decodeURIComponent(a.split('u=')[1].split('&')[0]);}catch(ex){}
  }
  try{W.top.postMessage({type:'wsb_nav',url:a},'*');}catch(ex){}
},true);

// ── Intercept location.href assignments ──────────────────────────────────────
try{
  var _loc=W.location;
  Object.defineProperty(W,'location',{
    get:function(){return _loc;},
    set:function(v){
      var a=abs(String(v));
      if(/^https?:\\/\\//.test(a)){
        try{W.top.postMessage({type:'wsb_nav',url:a},'*');}catch(e){}
      } else {_loc.href=v;}
    }
  });
}catch(e){}

// ── history.pushState / replaceState ─────────────────────────────────────────
(function(){
  function wrap(orig){
    return function(st,ti,u){
      try{orig.call(H,st,ti,u);}catch(e){}
      if(u){
        var a=abs(String(u));
        if(/^https?:\\/\\//.test(a))
          try{W.top.postMessage({type:'wsb_softNav',url:a},'*');}catch(e){}
      }
    };
  }
  try{H.pushState=wrap(H.pushState);H.replaceState=wrap(H.replaceState);}catch(e){}
})();

// ── XMLHttpRequest → route through CORS proxy ────────────────────────────────
(function(){
  var _XHR=W.XMLHttpRequest;
  function SandboxXHR(){
    this._xhr=new _XHR();
    this._url='';
    this._method='GET';
    var self=this;
    ['onload','onerror','onabort','onprogress','onreadystatechange','ontimeout'].forEach(function(ev){
      Object.defineProperty(self,ev,{
        get:function(){return self._xhr[ev];},
        set:function(v){self._xhr[ev]=v;}
      });
    });
    ['readyState','status','statusText','responseText','response','responseXML','responseURL','responseType','timeout'].forEach(function(prop){
      Object.defineProperty(self,prop,{get:function(){try{return self._xhr[prop];}catch(e){return null;}}});
    });
    ['withCredentials'].forEach(function(prop){
      Object.defineProperty(self,prop,{
        get:function(){return self._xhr[prop];},
        set:function(v){self._xhr[prop]=v;}
      });
    });
  }
  SandboxXHR.prototype.open=function(method,url,async,user,pass){
    this._method=method;
    this._url=url;
    var target=url;
    if(/^https?:\\/\\//i.test(url)){
      target=cx(url);
    } else if(url.startsWith('//')){ 
      target=cx(location.protocol+url);
    }
    return this._xhr.open(method,target,async!==false,user,pass);
  };
  SandboxXHR.prototype.send=function(body){return this._xhr.send(body);};
  SandboxXHR.prototype.setRequestHeader=function(n,v){try{this._xhr.setRequestHeader(n,v);}catch(e){}};
  SandboxXHR.prototype.getResponseHeader=function(n){return this._xhr.getResponseHeader(n);};
  SandboxXHR.prototype.getAllResponseHeaders=function(){return this._xhr.getAllResponseHeaders();};
  SandboxXHR.prototype.abort=function(){return this._xhr.abort();};
  SandboxXHR.UNSENT=0;SandboxXHR.OPENED=1;SandboxXHR.HEADERS_RECEIVED=2;SandboxXHR.LOADING=3;SandboxXHR.DONE=4;
  try{W.XMLHttpRequest=SandboxXHR;}catch(e){}
})();

// ── fetch() → route through CORS proxy ───────────────────────────────────────
(function(){
  var _fetch=W.fetch;
  if(!_fetch) return;
  W.fetch=function(input,init){
    try{
      var url=(input instanceof Request)?input.url:String(input);
      if(/^https?:\\/\\//i.test(url)){
        var proxied=cx(url);
        if(input instanceof Request){
          input=new Request(proxied,{
            method:input.method,
            headers:input.headers,
            body:['GET','HEAD'].includes(input.method.toUpperCase())?undefined:input.body,
            mode:'cors',credentials:'omit',
          });
        } else {
          input=proxied;
          if(init){init=Object.assign({},init,{mode:'cors',credentials:'omit'});}
        }
      }
    }catch(e){}
    return _fetch.call(W,input,init);
  };
})();

// ── MutationObserver: fix dynamically-added elements ─────────────────────────
(function(){
  function fixNode(node){
    if(!node||node.nodeType!==1) return;
    // Fix anchors
    var anchors=node.tagName==='A'?[node]:Array.from(node.querySelectorAll('a[href]'));
    anchors.forEach(function(a){
      var h=a.getAttribute('href');
      if(!h||/^(javascript:|#|mailto:|tel:|data:)/.test(h)) return;
      if(h.includes('/p?u=')||h.includes('/p%3F')) return; // already proxied
      var au=abs(h);
      if(!/^https?:\\/\\//.test(au)) return;
      a.setAttribute('href',px(au));
      a.removeAttribute('target');
      a.removeAttribute('ping');
    });
    // Fix forms
    var forms=node.tagName==='FORM'?[node]:Array.from(node.querySelectorAll('form'));
    forms.forEach(function(f){f.removeAttribute('target');});
    // Fix images
    var imgs=node.tagName==='IMG'?[node]:Array.from(node.querySelectorAll('img[src]'));
    imgs.forEach(function(img){
      var s=img.getAttribute('src');
      if(s&&/^https?:\\/\\//.test(s)&&!s.startsWith('/a?')){
        img.setAttribute('src',ax(s));
      }
    });
  }
  try{
    var mo=new MutationObserver(function(muts){
      muts.forEach(function(m){m.addedNodes.forEach(fixNode);});
    });
    mo.observe(D.documentElement||D.body||D,{childList:true,subtree:true});
  }catch(e){}
})();

// ── Report page loaded to parent ──────────────────────────────────────────────
function report(){
  if(W.top===W) return;
  try{
    W.top.postMessage({
      type:'wsb_loaded',
      url:BASE,
      title:D.title||BASE,
      favicon:(function(){
        var l=D.querySelector('link[rel*="icon"]');
        return l?abs(l.getAttribute('href')||''):'';
      })()
    },'*');
  }catch(e){}
}
if(D.readyState==='loading') D.addEventListener('DOMContentLoaded',report);
else report();
W.addEventListener('load',report);

})(window,document,history);
</script>`;
}

// ── FETCH ENGINE ──────────────────────────────────────────────────────────────
async function doFetch(url, opts) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }

  const agent = parsed.protocol === 'https:' ? agentHttps : agentHttp;
  const ctrl  = new AbortController();
  const tid   = setTimeout(() => ctrl.abort(), opts.timeout || 25000);

  try {
    const res = await fetch(url, {
      method:   opts.method   || 'GET',
      headers:  opts.headers  || {},
      body:     opts.body     || undefined,
      redirect: opts.redirect || 'follow',
      signal:   ctrl.signal,
      agent,
    });
    clearTimeout(tid);
    return res;
  } catch(e) {
    clearTimeout(tid);
    throw e;
  }
}

// Multi-strategy fetch: tries different profiles, falls back gracefully
async function smartFetch(url, cookieStr, extraHeaders, method, body) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL: ' + url); }

  const strategies = [
    // Strategy 1: Full Chrome desktop
    () => ({
      headers: buildHeaders(url, cookieStr, Object.assign({
        'Referer': parsed.origin + '/',
      }, extraHeaders)),
    }),
    // Strategy 2: Mac Chrome (different fingerprint)
    () => ({
      headers: buildHeaders(url + '_mac', cookieStr, Object.assign({
        'Referer': parsed.origin + '/',
      }, extraHeaders)),
    }),
    // Strategy 3: Firefox
    () => ({
      headers: buildHeaders(url + '_ff', cookieStr, extraHeaders),
    }),
    // Strategy 4: Minimal (no sec-ch-ua, no sec-fetch)
    () => ({
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
      }, cookieStr ? { 'Cookie': cookieStr } : {}, extraHeaders || {}),
    }),
    // Strategy 5: Curl-like
    () => ({
      headers: {
        'User-Agent': 'curl/8.6.0',
        'Accept': '*/*',
        'Connection': 'keep-alive',
      },
    }),
  ];

  let lastErr;
  for (const mkOpts of strategies) {
    try {
      const opts = mkOpts();
      const res  = await doFetch(url, {
        method: method || 'GET',
        headers: opts.headers,
        body,
        timeout: 22000,
      });
      return res;
    } catch(e) {
      lastErr = e;
      if (e.name === 'AbortError') break; // timeout, no point retrying
      // Continue to next strategy
    }
  }
  throw lastErr || new Error('All strategies failed');
}

// ── EXTRACT COOKIES FROM RESPONSE ─────────────────────────────────────────────
// We pass cookies back to client via a JSON endpoint so they can store them in localStorage
function extractSetCookies(res) {
  try {
    const raw = res.headers.raw ? res.headers.raw()['set-cookie'] : null;
    return raw || [];
  } catch { return []; }
}

// ── STRIP SECURITY RESPONSE HEADERS ───────────────────────────────────────────
function stripSecHeaders(res) {
  res.removeHeader('X-Frame-Options');
  res.removeHeader('Content-Security-Policy');
  res.removeHeader('Cross-Origin-Embedder-Policy');
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Resource-Policy');
  res.removeHeader('X-Content-Type-Options');
  res.removeHeader('Permissions-Policy');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

// ── ERROR PAGE ────────────────────────────────────────────────────────────────
function errPage(msg, url, details) {
  const safeMsg = String(msg || 'Unknown error').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const safeUrl = String(url || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const safeDet = String(details || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<script>
(function(){
  function s(){
    if(window.top!==window){
      window.top.postMessage({type:'wsb_error',message:${JSON.stringify(String(msg||''))},url:${JSON.stringify(String(url||''))}},'*');
    }
  }
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',s):s();
})();
</script>
</head>
<body style="margin:0;background:#07070f;color:#dde1f0;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:14px;padding:32px;text-align:center">
<div style="font-size:68px;font-weight:900;color:#ff5555;letter-spacing:-4px;line-height:1">ERR</div>
<div style="font-size:14px;color:#8888aa;max-width:500px;line-height:1.75">${safeMsg}</div>
${safeDet ? `<div style="font-size:11px;color:#444466;max-width:500px;word-break:break-all;margin-top:-6px">${safeDet}</div>` : ''}
<div style="font-size:10px;color:#333355;word-break:break-all;max-width:500px">${safeUrl}</div>
<div style="display:flex;gap:10px;margin-top:6px">
  <button onclick="top.postMessage({type:'wsb_retry',url:${JSON.stringify(String(url||''))}},'*')" style="padding:9px 22px;background:#6c47ff;border:none;border-radius:8px;color:#fff;cursor:pointer;font-weight:700">↺ Retry</button>
  <button onclick="top.postMessage({type:'wsb_home'},'*')" style="padding:9px 22px;background:#1a1a2e;border:1px solid #2a2a4e;border-radius:8px;color:#dde1f0;cursor:pointer;font-weight:600">⌂ Home</button>
</div>
<div style="margin-top:12px;font-size:11px;color:#2a2a44;max-width:460px;line-height:1.7">
  ⚠️ Some sites (Cloudflare, Google, banking) detect and block datacenter IPs used by cloud hosting. This is a network-level restriction that no proxy can bypass without a residential IP.
</div>
</body></html>`;
}

// ════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════════════════════

// Home
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));

// Favicon (avoid 404 noise)
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/favicon.png', (req, res) => res.status(204).end());

// ── /p — MAIN HTML PROXY ──────────────────────────────────────────────────────
app.get('/p', async (req, res) => {
  const targetUrl = req.query.u || req.query.url || '';
  const sid       = req.query.s || req.query.sid || '';
  // Also accept cookies passed from client (stored in localStorage)
  const clientCookies = req.query.ck ? decodeURIComponent(req.query.ck) : '';

  if (!targetUrl) return res.status(400).send(errPage('No URL provided', ''));

  let parsed;
  try {
    parsed = new URL(targetUrl);
    if (!['http:','https:'].includes(parsed.protocol))
      return res.status(400).send(errPage('Only HTTP/HTTPS supported', targetUrl));
  } catch {
    return res.status(400).send(errPage('Invalid URL', targetUrl));
  }

  try {
    const upstream = await smartFetch(targetUrl, clientCookies);
    const ct       = upstream.headers.get('content-type') || '';
    const finalUrl = upstream.url || targetUrl;

    // Forward set-cookie headers to client (as data, not actual cookies)
    const setCookies = extractSetCookies(upstream);

    // Non-HTML
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
      return res.redirect(302, `/a?u=${encodeURIComponent(targetUrl)}`);
    }

    let html = '';
    try { html = await upstream.text(); } catch {}

    // Extract metadata
    const $m    = cheerio.load(html, { decodeEntities: false });
    const title = $m('title').first().text().trim() || parsed.hostname;
    let favicon = '';
    try {
      const fl = $m('link[rel*="icon"]').first();
      if (fl.length) favicon = absUrl(finalUrl, fl.attr('href') || '');
    } catch {}
    if (!favicon) favicon = `${parsed.protocol}//${parsed.host}/favicon.ico`;

    const rewritten = rewriteHtml(html, finalUrl, sid);

    stripSecHeaders(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Pass cookies to client via custom header (client reads and stores in localStorage)
    if (setCookies.length) {
      res.setHeader('X-Wsb-Cookies', JSON.stringify(setCookies));
    }
    res.setHeader('X-Wsb-Url',   encodeURIComponent(finalUrl));
    res.setHeader('X-Wsb-Title', encodeURIComponent(title));
    res.setHeader('X-Wsb-Favicon', encodeURIComponent(favicon));
    res.send(rewritten);

  } catch(e) {
    const msg = e.name === 'AbortError'
      ? 'Request timed out (25s). Site may be very slow or unreachable.'
      : `Failed to fetch: ${e.message}`;
    res.status(502).send(errPage(msg, targetUrl,
      'Tip: Cloudflare-protected sites and Google block datacenter IPs. Try a different site or self-host on a residential VPS.'));
  }
});

// ── /a — ASSET PROXY (JS, CSS, Images, Fonts) ────────────────────────────────
app.get('/a', async (req, res) => {
  const assetUrl = req.query.u || req.query.url || '';
  if (!assetUrl) return res.status(400).send('Missing url');

  let parsed;
  try {
    parsed = new URL(assetUrl);
    if (!['http:','https:'].includes(parsed.protocol)) return res.status(400).send('Invalid protocol');
  } catch { return res.status(400).send('Invalid URL'); }

  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 15000);

  try {
    const p = pickProfile(assetUrl);
    const agent = parsed.protocol === 'https:' ? agentHttps : agentHttp;
    const upstream = await fetch(assetUrl, {
      signal:   ctrl.signal,
      redirect: 'follow',
      agent,
      headers: {
        'User-Agent':      p.ua,
        'Accept':          '*/*',
        'Accept-Encoding': 'identity',
        'Referer':         parsed.origin + '/',
        'Origin':          parsed.origin,
        ...(p.ch_ua ? { 'Sec-Ch-Ua': p.ch_ua, 'Sec-Ch-Ua-Mobile': p.ch_mobile, 'Sec-Ch-Ua-Platform': p.ch_platform } : {}),
      },
    });
    clearTimeout(tid);

    const ct = upstream.headers.get('content-type') || 'application/octet-stream';

    stripSecHeaders(res);
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Vary', 'Accept-Encoding');

    if (ct.includes('text/css')) {
      let css = '';
      try { css = await upstream.text(); } catch {}
      return res.send(rewriteCss(css, upstream.url || assetUrl));
    }

    upstream.body.pipe(res);

  } catch(e) {
    clearTimeout(tid);
    if (e.name === 'AbortError') return res.status(504).send('timeout');
    // Fallback: try HTTP version
    if (assetUrl.startsWith('https://')) {
      try {
        const fallback = await fetch(assetUrl.replace('https://', 'http://'), {
          headers: { 'User-Agent': PROFILES[0].ua, 'Accept': '*/*', 'Accept-Encoding': 'identity' },
          redirect: 'follow',
          agent: agentHttp,
        });
        const ct = fallback.headers.get('content-type') || 'application/octet-stream';
        res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (ct.includes('text/css')) {
          let css = ''; try { css = await fallback.text(); } catch {}
          return res.send(rewriteCss(css, fallback.url || assetUrl));
        }
        return fallback.body.pipe(res);
      } catch {}
    }
    res.status(502).send('asset failed');
  }
});

// ── /c — CORS PROXY (XHR/fetch from within proxied pages) ───────────────────
// This is the critical fix: when JS inside proxied pages calls fetch()/XHR to
// their own API endpoints, those requests come here instead of being blocked by browser CORS
app.all('/c', async (req, res) => {
  const targetUrl = req.query.u || req.query.url || '';
  const sid       = req.query.s || req.query.sid || '';
  if (!targetUrl) return res.status(400).json({ error: 'Missing url' });

  let parsed;
  try {
    parsed = new URL(targetUrl);
    if (!['http:','https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'Invalid protocol' });
  } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const method = req.method || 'GET';
  const ctrl   = new AbortController();
  const tid    = setTimeout(() => ctrl.abort(), 20000);

  try {
    const p = pickProfile(targetUrl);
    const agent = parsed.protocol === 'https:' ? agentHttps : agentHttp;

    // Build request headers (forward most from client but fix host/origin)
    const fwdHeaders = {
      'User-Agent':    p.ua,
      'Accept':        req.headers['accept']         || '*/*',
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',
      'Content-Type':  req.headers['content-type']   || undefined,
      'Origin':        parsed.origin,
      'Referer':       parsed.origin + '/',
    };
    // Remove undefined
    Object.keys(fwdHeaders).forEach(k => { if (!fwdHeaders[k]) delete fwdHeaders[k]; });

    let body;
    if (!['GET','HEAD'].includes(method.toUpperCase())) {
      if (Buffer.isBuffer(req.body)) body = req.body;
      else if (typeof req.body === 'string') body = req.body;
      else if (req.body && typeof req.body === 'object') body = JSON.stringify(req.body);
    }

    const upstream = await fetch(targetUrl, {
      method,
      headers: fwdHeaders,
      body,
      redirect: 'follow',
      signal:   ctrl.signal,
      agent,
    });
    clearTimeout(tid);

    const ct = upstream.headers.get('content-type') || 'application/octet-stream';

    stripSecHeaders(res);
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'no-cache');

    // Forward set-cookie
    const setCookies = extractSetCookies(upstream);
    if (setCookies.length) res.setHeader('X-Wsb-Cookies', JSON.stringify(setCookies));

    upstream.body.pipe(res);

  } catch(e) {
    clearTimeout(tid);
    res.status(502).json({ error: e.message || 'CORS proxy failed' });
  }
});

// ── /fp — POST FORM HANDLER ───────────────────────────────────────────────────
app.post('/fp', express.urlencoded({ extended: true, limit: '10mb' }), async (req, res) => {
  const target = req.query.t || req.query.target || '';
  const sid    = req.query.s || req.query.sid    || '';
  if (!target) return res.status(400).send(errPage('Missing target', ''));

  let parsed;
  try { parsed = new URL(target); } catch { return res.status(400).send(errPage('Invalid URL', target)); }

  try {
    const body = new URLSearchParams(req.body).toString();
    const upstream = await smartFetch(target, '', {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(body)),
      'Origin':         parsed.origin,
      'Referer':        parsed.origin + '/',
    }, 'POST', body);

    const ct       = upstream.headers.get('content-type') || '';
    const finalUrl = upstream.url || target;
    const setCookies = extractSetCookies(upstream);

    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
      return res.redirect(302, `/a?u=${encodeURIComponent(target)}`);
    }

    let html = ''; try { html = await upstream.text(); } catch {}
    const rewritten = rewriteHtml(html, finalUrl, sid);
    stripSecHeaders(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (setCookies.length) res.setHeader('X-Wsb-Cookies', JSON.stringify(setCookies));
    res.setHeader('X-Wsb-Url', encodeURIComponent(finalUrl));
    res.send(rewritten);
  } catch(e) {
    res.status(502).send(errPage('Form POST failed: ' + e.message, target));
  }
});

// ── /fg — GET FORM HANDLER ────────────────────────────────────────────────────
app.get('/fg', (req, res) => {
  const { _pt: target, _ps: sid, ...rest } = req.query;
  if (!target) return res.redirect('/');
  try {
    const u    = new URL(target);
    const qs   = new URLSearchParams(rest).toString();
    const full = `${u.origin}${u.pathname}${qs ? '?' + qs : ''}`;
    return res.redirect(302, `/p?u=${encodeURIComponent(full)}&s=${encodeURIComponent(sid||'')}`);
  } catch { return res.redirect('/'); }
});

// ── /api/session — Minimal session API (stateless, client is source of truth) ─
app.post('/api/session', (req, res) => {
  // Server just echoes back a session ID; all real state is in localStorage
  const id = req.body.sessionId || uuidv4();
  res.json({ success: true, sessionId: id, session: { id, history: [], bookmarks: [] } });
});

// ── /api/ping — Health check ──────────────────────────────────────────────────
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, version: '4.0.0', ts: Date.now() });
});

// ── 404 catch ─────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).send('Not found'));

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`WebSandbox v4 → http://0.0.0.0:${PORT}`);
  console.log(`Platform: ${process.env.VERCEL ? 'Vercel' : process.env.RAILWAY_ENVIRONMENT ? 'Railway' : process.env.FLY_APP_NAME ? 'Fly.io' : 'Self-hosted'}`);
});

module.exports = app;
