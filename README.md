# 🛡 WebSandbox v3

> Full-featured proxy-based web sandbox. Browse any site in an isolated environment. Sessions persist across reloads, browser restarts, and devices via localStorage + server sync.

---

## ✅ What's Fixed in v3

| Issue | Fix |
|-------|-----|
| Links opening outside sandbox | `target=_blank` stripped from ALL anchors server-side + client-side interceptor |
| `window.open()` escaping sandbox | Overridden in injected script, redirects into proxy |
| History items not navigating | Fixed event delegation — `navigate(url)` called correctly |
| Sidebar toggle breaking iframe | Sidebar uses CSS width transition only, iframe unaffected |
| Cloudflare / bot detection | 4-strategy fetch: Chrome UA → Mobile UA → Minimal/curl → Googlebot |
| Sites blocking proxy | Multiple fallback strategies + SSL cert bypass |
| Redirects going outside sandbox | `follow-redirects` with full cookie passthrough |
| CSS/fonts/images broken | CSS rewriter for url(), @import, inline styles, srcset |
| Login not working | Per-session cookie jar with domain matching |
| POST forms not working | `/form-post` endpoint with full body forwarding |
| GET forms not working | `/form-get` endpoint reconstructs URL with query params |
| Session lost on reload | localStorage + server sync on every page load |

---

## 🗂 File Structure

```
websandbox/
├── web.js              ← Express backend (Node.js CJS)
├── package.json        ← Dependencies
├── vercel.json         ← Vercel deploy config
├── .gitignore
├── README.md
└── public/
    └── home.html       ← Full frontend UI
```

---

## 🚀 Deploy to Vercel

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "WebSandbox v3"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/websandbox.git
git push -u origin main
```

### Step 2 — Import on Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your GitHub repo
3. Framework Preset: **Other**
4. Root Directory: *(leave blank)*
5. Click **Deploy**

### Step 3 — Done! 🎉

Your sandbox runs at `https://YOUR_PROJECT.vercel.app`

---

## 💻 Run Locally

```bash
npm install
npm start
# → http://localhost:3000
```

Requires Node.js v20+ (v24 recommended).

---

## 🍪 How Sessions & Cookies Work

- Each browser gets a unique session ID stored in `localStorage`
- The server maintains a **per-session cookie jar** (domain-aware)
- Cookies set by proxied sites are stored and sent back on subsequent requests
- This enables **login flows** on many sites
- State (history, bookmarks, current URL) saved to localStorage every 8s + on visibility change

---

## 🛡 Fetch Strategy (Multi-fallback)

When loading a page, the proxy tries 4 strategies in order:

1. **Desktop Chrome** — `Mozilla/5.0 Windows Chrome/124` with full Sec-Fetch headers
2. **Mobile Safari** — iPhone UA (bypasses some desktop-only blocks)
3. **Minimal curl** — bare-bones headers (bypasses some anti-bot checks)
4. **Googlebot** — search crawler UA (many sites allow Googlebot)

---

## ⚠️ Known Limitations

| Limitation | Reason |
|-----------|--------|
| Cloudflare JS challenge | Requires real browser JS execution; not possible in server proxy |
| Google/Facebook login | OAuth redirect chains are complex to proxy |
| WebSocket apps | WS connections not proxied (real-time features won't work) |
| Service Workers | Cannot be registered in proxied context |
| CAPTCHA | Human verification requires real browser |
| Some SPAs | Client-side routing may partially break |

---

## 📦 Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server |
| `node-fetch` | Fetch remote pages |
| `cheerio` | HTML rewriting |
| `uuid` | Session ID generation |
| `cors` | CORS headers |
| `tough-cookie` | Cookie parsing (reference) |
| `follow-redirects` | Enhanced redirect following |

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+L` | Focus URL bar |
| `Ctrl+D` | Bookmark current page |

---

MIT License
