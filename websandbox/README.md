# 🛡 WebSandbox

> An isolated, VM-like web browser sandbox. Browse any website safely with persistent sessions across reloads, reboots, and devices.

---

## ✨ Features

- 🌐 **Proxy-based sandbox** — all traffic routes through the server, isolating your device
- 💾 **Persistent sessions** — history & bookmarks survive page reloads, tab closes, browser restarts
- 🕓 **Browsing history** — last 200 pages tracked per session
- ☆ **Bookmarks** — save and revisit your favourite pages
- ↩ **Back / Forward navigation** — full nav stack in the sandbox
- 📱 **Responsive** — works on desktop, tablet, and mobile
- ⚡ **Fast** — asset proxying with CSS rewriting, automatic redirect following

---

## 🗂 Project Structure

```
websandbox/
├── web.js          ← Main Express server (CJS)
├── package.json    ← Dependencies & scripts
├── vercel.json     ← Vercel deployment config
├── .gitignore
├── README.md
└── public/
    └── home.html   ← Frontend UI
```

---

## 🚀 Deploy to Vercel

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit: WebSandbox"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/websandbox.git
git push -u origin main
```

### 2. Deploy with Vercel

**Option A — Vercel CLI:**
```bash
npm i -g vercel
vercel
```

**Option B — Vercel Dashboard:**
1. Go to [vercel.com](https://vercel.com) → New Project
2. Import your GitHub repo
3. Framework Preset: **Other**
4. Leave all settings default → **Deploy**

### 3. Done! 🎉

Your sandbox will be live at `https://your-project.vercel.app`

---

## 🖥 Run Locally

```bash
npm install
npm start
# → http://localhost:3000
```

Requires **Node.js v20+** (v24 recommended).

---

## ⚙️ How Sessions Work

| Storage | What's stored | Survives |
|---------|--------------|----------|
| `localStorage` | Session ID, history, bookmarks, last URL | Reload, tab close, browser restart |
| Server (in-memory) | Same data synced | Server restart (Vercel serverless instances) |

> **Note:** On Vercel's serverless infrastructure, in-memory server state may reset between cold starts. However, because the client always syncs from `localStorage` on boot and pushes to the server, your data is always restored from the client side — making sessions fully persistent on the user's device.

---

## 🔒 Sandbox Limitations

- Sites using **Content Security Policy** (CSP) may restrict some resources
- **Login sessions** inside the sandbox are not preserved (cookies are not proxied)
- Some sites detect and block proxy/scraper user agents
- WebSocket connections are not supported through the proxy
- JavaScript that makes cross-origin XHR/fetch calls may fail inside the sandbox

---

## 📦 Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server |
| `node-fetch` | Fetching remote pages |
| `cheerio` | HTML parsing & URL rewriting |
| `uuid` | Generating session IDs |
| `cors` | Cross-origin headers |

---

## 📄 License

MIT — free to use, modify, and deploy.
