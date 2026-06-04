# 🛡 WebSandbox v4

> Proxy-based isolated browser sandbox. Browse websites inside an iframe with full session persistence via localStorage. Supports Vercel, Railway, Fly.io, Render, VPS, Docker — any Node.js host.

---

## 🔧 What's Fixed in v4

| Problem | Fix |
|---------|-----|
| History lost on reload | 100% localStorage — server is stateless |
| Cookies lost between requests | Cookie jar in localStorage, sent back to server per-request |
| History items not clickable | Fixed event listeners (no onclick strings) |
| Sidebar breaking iframe | Sidebar uses CSS only, never touches iframe |
| XHR/fetch blocked by CORS | `/c` CORS proxy endpoint — all XHR/fetch inside sandboxed pages routes through it |
| Links opening outside sandbox | target removed server-side + client interceptor + MutationObserver |
| window.open escaping | Fully overridden in injected script |
| Vercel state loss (cold start) | Server stateless; all state in client localStorage |
| User-Agent detected as bot | 4 rotating browser profiles (Chrome Win, Chrome Mac, Firefox, Safari) |
| Asset CSS/images broken | Full CSS rewriter: url(), @import, srcset, data-src, poster |
| POST forms not working | `/fp` endpoint with full body forwarding |
| GET forms not working | `/fg` endpoint with query string reconstruction |
| SPA soft navigation | history.pushState/replaceState intercepted |

---

## ⚠️ Technical Limitations (Cannot Be Fixed Without Puppeteer)

| Issue | Reason |
|-------|--------|
| Cloudflare JS Challenge | Requires real browser JS execution |
| Google/Facebook OAuth login | OAuth redirects to accounts.google.com which is hard to proxy |
| Sites checking residential IP | Vercel/Railway IPs are datacenter IPs — blocked by many major sites |
| WebSocket real-time apps | WS not proxied |
| Service Workers | Cannot register in proxied context |

**If you need to bypass Cloudflare:** Self-host on a residential IP (home server + ngrok/Cloudflare Tunnel) or use a residential proxy service.

---

## 🗂 File Structure

```
websandbox/
├── web.js              ← Express server (Node.js CJS)
├── package.json
├── vercel.json         ← Vercel config
├── .gitignore
├── README.md
└── public/
    └── home.html       ← Full frontend (all state in localStorage)
```

---

## 🚀 Deploy Options

### Option 1 — Vercel (Free, Serverless)

```bash
git init && git add . && git commit -m "WebSandbox v4"
git remote add origin https://github.com/YOU/websandbox.git
git push -u origin main

npx vercel --prod
```
Or import at vercel.com → Framework: **Other** → Deploy.

> ⚠️ Vercel serverless = no persistent in-memory state. This is fine because v4 is fully stateless — all data in client localStorage.

---

### Option 2 — Railway (Free tier, persistent server)

1. Push to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add variable: `PORT=3000`
4. Deploy — Railway auto-detects Node.js via `package.json`

Railway gives you a persistent server with a static IP — better for sites that block Vercel IPs.

---

### Option 3 — Render (Free tier)

1. Push to GitHub
2. Go to [render.com](https://render.com) → New Web Service → Connect GitHub
3. Build Command: `npm install`
4. Start Command: `node web.js`
5. Deploy

---

### Option 4 — Fly.io

```bash
npm install -g flyctl
flyctl auth login
flyctl launch      # auto-detects Node.js
flyctl deploy
```

---

### Option 5 — VPS (Ubuntu/Debian) — Best for Cloudflare bypass

```bash
# On your server:
git clone https://github.com/YOU/websandbox.git
cd websandbox
npm install

# Install PM2 for process management
npm install -g pm2
pm2 start web.js --name websandbox
pm2 startup && pm2 save

# Optional: Nginx reverse proxy
# /etc/nginx/sites-available/websandbox
server {
    listen 80;
    server_name yourdomain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

### Option 6 — Docker

```dockerfile
# Dockerfile (create this file)
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "web.js"]
```

```bash
docker build -t websandbox .
docker run -p 3000:3000 websandbox
```

---

### Option 7 — Local (Development)

```bash
npm install
npm start
# → http://localhost:3000
```

---

## 🍪 How Cookies Work in v4

1. You visit `https://example.com` via proxy
2. Server fetches the page, captures `Set-Cookie` headers
3. Server sends cookies back to client in `X-Wsb-Cookies` response header
4. Client stores cookies in `localStorage.wsb4_cookies` keyed by domain
5. Next request to `example.com`: client sends stored cookies as `?ck=...` query param
6. Server uses those cookies in the upstream request → site sees you as logged in

---

## 🔁 How Persistence Works

Everything is stored in `localStorage` (never lost on server restart):

| Key | Content |
|-----|---------|
| `wsb4_sid` | Session ID |
| `wsb4_hist` | Browsing history (up to 500 entries) |
| `wsb4_bkms` | Bookmarks |
| `wsb4_nav` | Back/forward navigation stack |
| `wsb4_cururl` | Last visited URL |
| `wsb4_cookies` | Per-domain cookies |

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+L` | Focus URL bar |
| `Ctrl+D` | Bookmark page |
| `Ctrl+B` | Toggle sidebar |
| `Alt+←` | Go back |
| `Alt+→` | Go forward |

---

## 📡 API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /p?u=URL&s=SID&ck=COOKIES` | Main HTML proxy |
| `GET /a?u=URL` | Asset proxy (CSS/JS/images) |
| `ALL /c?u=URL&s=SID` | CORS proxy for XHR/fetch |
| `POST /fp?t=URL&s=SID` | POST form handler |
| `GET /fg?_pt=URL&_ps=SID&...` | GET form handler |
| `POST /api/session` | Get/create session ID |
| `GET /api/ping` | Health check |

---

MIT License
