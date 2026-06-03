'use strict';

const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory session store (persists for server lifetime)
// On Vercel, sessions survive between requests on same instance
const sessions = new Map();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── HELPERS ───────────────────────────────────────────────────────────────

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      created: Date.now(),
      history: [],
      bookmarks: [],
      currentUrl: '',
      currentTitle: '',
    });
  }
  return sessions.get(sessionId);
}

function addToHistory(session, entry) {
  // Avoid duplicate consecutive entries
  const last = session.history[session.history.length - 1];
  if (last && last.url === entry.url) return;
  session.history.push({
    url: entry.url,
    title: entry.title || entry.url,
    favicon: entry.favicon || '',
    visitedAt: Date.now(),
  });
  // Keep last 200 entries
  if (session.history.length > 200) {
    session.history = session.history.slice(-200);
  }
}

function resolveUrl(base, relative) {
  try {
    return new url.URL(relative, base).href;
  } catch {
    return relative;
  }
}

function rewriteAssets(html, baseUrl, proxyBase) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // Rewrite all href, src, action to go through proxy
  $('[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('javascript:') || href.startsWith('#') || href.startsWith('data:') || href.startsWith('mailto:')) return;
    try {
      const abs = resolveUrl(baseUrl, href);
      if (abs.startsWith('http')) {
        $(el).attr('href', `${proxyBase}?url=${encodeURIComponent(abs)}`);
      }
    } catch {}
  });

  $('[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (!src || src.startsWith('data:') || src.startsWith('javascript:') || src.startsWith('blob:')) return;
    try {
      const abs = resolveUrl(baseUrl, src);
      if (abs.startsWith('http')) {
        $(el).attr('src', `/api/asset?url=${encodeURIComponent(abs)}`);
      }
    } catch {}
  });

  $('[srcset]').each((_, el) => {
    const srcset = $(el).attr('srcset');
    if (!srcset) return;
    const rewritten = srcset.split(',').map(part => {
      const [s, ...rest] = part.trim().split(/\s+/);
      try {
        const abs = resolveUrl(baseUrl, s);
        return [`/api/asset?url=${encodeURIComponent(abs)}`, ...rest].join(' ');
      } catch {
        return part;
      }
    }).join(', ');
    $(el).attr('srcset', rewritten);
  });

  $('form').each((_, el) => {
    const action = $(el).attr('action');
    if (action && !action.startsWith('javascript:')) {
      try {
        const abs = resolveUrl(baseUrl, action);
        if (abs.startsWith('http')) {
          $(el).attr('action', `${proxyBase}?url=${encodeURIComponent(abs)}`);
        }
      } catch {}
    }
    // Convert POST forms to GET for proxy compatibility
    $(el).attr('method', 'GET');
  });

  // Fix inline styles with url()
  $('[style]').each((_, el) => {
    let style = $(el).attr('style');
    if (style && style.includes('url(')) {
      style = style.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, u) => {
        if (u.startsWith('data:')) return match;
        try {
          const abs = resolveUrl(baseUrl, u);
          return `url('/api/asset?url=${encodeURIComponent(abs)}')`;
        } catch {
          return match;
        }
      });
      $(el).attr('style', style);
    }
  });

  // Rewrite CSS @import and url() in <style> tags
  $('style').each((_, el) => {
    let css = $(el).html();
    if (!css) return;
    css = css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, u) => {
      if (u.startsWith('data:')) return match;
      try {
        const abs = resolveUrl(baseUrl, u);
        return `url('/api/asset?url=${encodeURIComponent(abs)}')`;
      } catch {
        return match;
      }
    });
    $(el).html(css);
  });

  return $.html();
}

// ─── ROUTES ────────────────────────────────────────────────────────────────

// Serve home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// Session API
app.post('/api/session', (req, res) => {
  const { sessionId } = req.body;
  const id = sessionId || uuidv4();
  const session = getSession(id);
  res.json({ success: true, sessionId: id, session });
});

app.get('/api/session/:id', (req, res) => {
  const session = getSession(req.params.id);
  res.json({ success: true, session });
});

// Save session state (called from client)
app.post('/api/session/:id/save', (req, res) => {
  const { history, bookmarks, currentUrl, currentTitle } = req.body;
  const session = getSession(req.params.id);
  if (history !== undefined) session.history = history;
  if (bookmarks !== undefined) session.bookmarks = bookmarks;
  if (currentUrl !== undefined) session.currentUrl = currentUrl;
  if (currentTitle !== undefined) session.currentTitle = currentTitle;
  res.json({ success: true });
});

// Add bookmark
app.post('/api/session/:id/bookmark', (req, res) => {
  const { url: bookmarkUrl, title, favicon } = req.body;
  const session = getSession(req.params.id);
  const exists = session.bookmarks.find(b => b.url === bookmarkUrl);
  if (!exists) {
    session.bookmarks.push({ url: bookmarkUrl, title: title || bookmarkUrl, favicon: favicon || '', addedAt: Date.now() });
  }
  res.json({ success: true, bookmarks: session.bookmarks });
});

app.delete('/api/session/:id/bookmark', (req, res) => {
  const { url: bookmarkUrl } = req.body;
  const session = getSession(req.params.id);
  session.bookmarks = session.bookmarks.filter(b => b.url !== bookmarkUrl);
  res.json({ success: true, bookmarks: session.bookmarks });
});

// Clear history
app.delete('/api/session/:id/history', (req, res) => {
  const session = getSession(req.params.id);
  session.history = [];
  res.json({ success: true });
});

// Main proxy endpoint
app.get('/api/proxy', async (req, res) => {
  const { url: targetUrl, sessionId } = req.query;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: 'Only HTTP/HTTPS URLs are supported' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'identity',
        'DNT': '1',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') || '';

    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      // Non-HTML: redirect to asset proxy
      return res.redirect(`/api/asset?url=${encodeURIComponent(targetUrl)}`);
    }

    const textBody = await response.text();
    const finalUrl = response.url || targetUrl;

    // Extract title and favicon
    const $meta = cheerio.load(textBody);
    const pageTitle = $meta('title').first().text().trim() || parsedUrl.hostname;
    let favicon = '';
    const faviconEl = $meta('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').first();
    if (faviconEl.length) {
      favicon = resolveUrl(finalUrl, faviconEl.attr('href') || '');
    } else {
      favicon = `${parsedUrl.protocol}//${parsedUrl.host}/favicon.ico`;
    }

    // Rewrite HTML
    const proxyBase = '/api/proxy';
    const rewritten = rewriteAssets(textBody, finalUrl, proxyBase);

    // Update session history
    if (sessionId) {
      const session = getSession(sessionId);
      addToHistory(session, { url: targetUrl, title: pageTitle, favicon });
      session.currentUrl = targetUrl;
      session.currentTitle = pageTitle;
    }

    // Inject sandbox UI overlay script
    const sandboxScript = `
<script>
(function() {
  window.__SANDBOX_URL__ = ${JSON.stringify(targetUrl)};
  window.__SANDBOX_TITLE__ = ${JSON.stringify(pageTitle)};
  window.__SANDBOX_FAVICON__ = ${JSON.stringify(favicon)};

  // Intercept all navigation
  const _pushState = history.pushState.bind(history);
  const _replaceState = history.replaceState.bind(history);
  history.pushState = function(state, title, u) {
    try { _pushState(state, title, u); } catch(e) {}
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'navigate', url: u }, '*');
    }
  };
  history.replaceState = function(state, title, u) {
    try { _replaceState(state, title, u); } catch(e) {}
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'navigate', url: u }, '*');
    }
  };

  // Intercept link clicks
  document.addEventListener('click', function(e) {
    const a = e.target.closest('a');
    if (a && a.href && !a.href.startsWith('javascript:') && !a.href.startsWith('#') && !a.href.startsWith('/api/proxy')) {
      // Already rewritten by server, pass through
    }
  }, true);

  // Report page load to parent
  window.addEventListener('load', function() {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({
        type: 'pageLoaded',
        url: window.__SANDBOX_URL__,
        title: document.title || window.__SANDBOX_TITLE__,
        favicon: window.__SANDBOX_FAVICON__
      }, '*');
    }
  });
})();
</script>`;

    const finalHtml = rewritten.replace('</head>', `${sandboxScript}</head>`).replace('<html', '<html sandbox-active="true"');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Page-Title', encodeURIComponent(pageTitle));
    res.send(finalHtml);

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Request timed out', url: targetUrl });
    }
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch page', message: err.message, url: targetUrl });
  }
});

// Asset proxy (CSS, images, fonts, JS)
app.get('/api/asset', async (req, res) => {
  const { url: assetUrl } = req.query;
  if (!assetUrl) return res.status(400).send('Missing url');

  try {
    const parsed = new URL(assetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).send('Invalid protocol');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(assetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WebSandbox/1.0)',
        'Accept': '*/*',
        'Referer': `${parsed.protocol}//${parsed.host}/`,
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // For CSS files, rewrite urls
    if (contentType.includes('text/css')) {
      let css = await response.text();
      const baseUrl = response.url || assetUrl;
      css = css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, u) => {
        if (u.startsWith('data:')) return match;
        try {
          const abs = new URL(u, baseUrl).href;
          return `url('/api/asset?url=${encodeURIComponent(abs)}')`;
        } catch {
          return match;
        }
      });
      return res.send(css);
    }

    response.body.pipe(res);

  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).send('Timeout');
    res.status(502).send('Asset fetch failed');
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size, uptime: process.uptime() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Web Sandbox running on http://localhost:${PORT}`);
});

module.exports = app;
