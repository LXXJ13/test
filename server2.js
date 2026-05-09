const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = 3000;
const VIDEOS_DIR = path.join(__dirname, "videos");

// ══════════════════════════════════════════════════════════════
//  🔐 SECURITY CONFIG — ضع كلمة السر هنا
// ══════════════════════════════════════════════════════════════
const SECRET_TOKEN   = process.env.SECRET_TOKEN   || "sjdhf34Da2";   // ← رمز الرفع (index.html)
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || "@school3"; // ← كلمة سر اللوحة
// ══════════════════════════════════════════════════════════════

// ── Device‑based upload limit (2 per phone, 24h window) ──────────────────
const deviceCounts = new Map();
const UPLOAD_LIMIT_PER_DEVICE = 2;        // maximum uploads per phone
const UPLOAD_WINDOW_MS       = 86400000;  // 24 hours

function isDeviceLimited(clientId) {
  const now = Date.now();
  let entry = deviceCounts.get(clientId);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + UPLOAD_WINDOW_MS };
    deviceCounts.set(clientId, entry);
  }
  entry.count++;
  return entry.count > UPLOAD_LIMIT_PER_DEVICE;
}

// ── Cookie-based Dashboard Auth (works through ngrok) ─────────────────────
const SESSION_COOKIE = 'vs_session';

function getSessionCookie(req) {
  const raw = req.headers['cookie'] || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

function isAuthed(req) {
  return getSessionCookie(req) === DASHBOARD_PASS;
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang='ar' dir='rtl'>
<head>
<meta charset='UTF-8'>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>VidStream — تسجيل الدخول</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#07070f;font-family:Tajawal,Tahoma,sans-serif;color:#eeeef8}
.card{background:#0f0f1c;border:1px solid #1a1a2e;border-radius:18px;
  padding:40px 36px;width:320px;display:flex;flex-direction:column;gap:20px;
  box-shadow:0 20px 60px rgba(0,0,0,.6)}
h1{font-size:20px;font-weight:700;text-align:center;letter-spacing:2px;color:#ff3c5f}
input{width:100%;padding:13px 16px;border-radius:12px;border:1.5px solid #22223a;
  background:#141426;color:#eeeef8;font-size:16px;outline:none;text-align:center;
  transition:border-color .2s;font-family:inherit}
input:focus{border-color:#ff3c5f}
button{width:100%;padding:14px;border:none;border-radius:12px;cursor:pointer;
  background:linear-gradient(135deg,#ff3c5f,#c0283f);color:#fff;
  font-size:16px;font-weight:700;font-family:inherit}
.err{color:#f87171;font-size:13px;text-align:center}
</style>
</head>
<body>
<div class='card'>
  <h1>🎬 VidStream</h1>
  <form method='POST' action='/login' style='display:flex;flex-direction:column;gap:12px'>
    <input type='password' name='pass' placeholder='كلمة السر' autofocus autocomplete='current-password'>
    ERRSLOT
    <button type='submit'>دخول ←</button>
  </form>
</div>
</body>
</html>`;

function serveLogin(res, showError) {
  const html = LOGIN_HTML.replace('ERRSLOT', showError ? '<div class=err>❌ كلمة السر غير صحيحة</div>' : '');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

function checkDashboardAuth(req, res) {
  if (isAuthed(req)) return true;
  serveLogin(res, false);
  return false;
}

// ── Auto-delete videos older than 2 hours ─────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  videos = videos.filter(v => {
    if (v.timestamp < cutoff) {
      fs.unlink(path.join(VIDEOS_DIR, v.filename), () => {});
      return false;
    }
    return true;
  });
  saveVideos();
}, 10 * 60 * 1000);

if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR);

const META_FILE = path.join(__dirname, "videos_meta.json");

// ── Load saved videos from disk on startup ─────────────────────────────────
function loadVideos() {
  try {
    if (fs.existsSync(META_FILE)) {
      const saved = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
      // Only keep videos whose files still exist on disk
      return saved.filter(v => fs.existsSync(path.join(VIDEOS_DIR, v.filename)));
    }
  } catch (e) {
    console.error("Failed to load saved videos:", e.message);
  }
  return [];
}

function saveVideos() {
  try {
    fs.writeFileSync(META_FILE, JSON.stringify(videos), "utf8");
  } catch (e) {
    console.error("Failed to save videos metadata:", e.message);
  }
}

let videos = loadVideos();
console.log(`📂 Loaded ${videos.length} saved video(s) from disk`);
let dashboardClients = new Map(); // ws -> {id, alive}
let playerClients = new Map();    // ws -> {id, alive}
let clientIdCounter = 0;

// ── Static file cache ──────────────────────────────────────────────────────
const staticCache = new Map();
function loadStatic(name) {
  if (!staticCache.has(name)) {
    const p = path.join(__dirname, name);
    if (fs.existsSync(p)) staticCache.set(name, fs.readFileSync(p));
  }
  return staticCache.get(name);
}

// ── CORS headers ───────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Sender-Name, X-Mime-Type",
};

// ── HTTP Server ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // POST /login — dashboard password form
  if (req.method === "POST" && url.pathname === "/login") {
    let body = "";
    req.on("data", c => { body += c.toString(); if (body.length > 500) body = body.slice(0,500); });
    req.on("end", () => {
      const match = body.match(/pass=([^&]*)/);
      const submitted = match ? decodeURIComponent(match[1].replace(/[+]/g, " ")) : "";
      if (submitted === DASHBOARD_PASS) {
        res.writeHead(302, {
          "Location": "/",
          "Set-Cookie": `${SESSION_COOKIE}=${DASHBOARD_PASS}; Path=/; HttpOnly; SameSite=Strict`,
        });
        res.end();
      } else {
        serveLogin(res, true);
      }
    });
    return;
  }

  // POST /upload
  if (req.method === "POST" && url.pathname === "/upload") {

    // 1. استخراج الاسم من الرابط وفك تشفيره لدعم العربية
    const rawSender = url.searchParams.get("name") || req.headers["x-sender-name"] || "مجهول";
    let sender = "مجهول";
    try {
      sender = decodeURIComponent(rawSender).slice(0, 40);
    } catch (e) {
      sender = rawSender.slice(0, 40);
    }
    // Strip HTML-injectable characters
    sender = sender.replace(/[<>"'&]/g, "").trim() || "مجهول";

    // ── Device‑based upload limit ──────────────────────────────────────
    const clientId = (url.searchParams.get("clientid") || req.headers["x-client-id"] || "").trim();

    if (!clientId) {
      res.writeHead(400);
      res.end("معرّف الجهاز مفقود");
      return;
    }

    if (isDeviceLimited(clientId)) {
      res.writeHead(429);
      res.end("لقد تجاوزت الحد المسموح (مقطعين فقط) — شكراً لمشاركتك!");
      return;
    }
    // ── End device limit ───────────────────────────────────────────────

    // 2. تحديد نوع الملف وامتداده
    const mimeType = req.headers["x-mime-type"] || "video/webm";
    const ext = mimeType.includes("mp4") ? "mp4" : "webm";
    const filename = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
    const filepath = path.join(VIDEOS_DIR, filename);
    
    // 3. إعداد بث الكتابة (Write Stream)
    const writeStream = fs.createWriteStream(filepath);
    let size = 0;
    let aborted = false;
    // Limit upload size to 500MB
    req.on("data", chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > 500 * 1024 * 1024) {
        aborted = true;
        writeStream.destroy();
        fs.unlink(filepath, () => {});
        res.writeHead(413); res.end("File too large");
        return;
      }
      // Backpressure: pause if buffer full
      if (!writeStream.write(chunk)) req.pause();
    });

    writeStream.on("drain", () => req.resume());

    req.on("end", () => {
      if (aborted) return;
      writeStream.end(() => {
        const meta = {
          id: filename, sender, mimeType, filename, size,
          timestamp: Date.now(), url: `/video/${filename}`
        };
        videos.unshift(meta);
        if (videos.length > 300) videos = videos.slice(0, 300);  // increased to 300
        saveVideos();
        console.log(`📹 [${sender}] — ${(size / 1024).toFixed(1)} KB`);
        broadcastJSON(dashboardClients, { type: "new_video", video: meta });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: filename }));
      });
    });

    req.on("error", () => { writeStream.destroy(); res.writeHead(500); res.end(); });
    writeStream.on("error", () => { res.writeHead(500); res.end(); });
    return;
  }

  // GET /videos
  if (req.method === "GET" && url.pathname === "/videos") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(videos));
    return;
  }

  // GET /video/:file (range support)
  if (req.method === "GET" && url.pathname.startsWith("/video/")) {
    const filename = path.basename(url.pathname);
    // Prevent path traversal
    if (filename.includes("..") || filename.includes("/")) { res.writeHead(400); res.end(); return; }
    const filepath = path.join(VIDEOS_DIR, filename);
    if (!fs.existsSync(filepath)) { res.writeHead(404); res.end(); return; }
    const stat = fs.statSync(filepath);
    const mime = filename.endsWith(".mp4") ? "video/mp4" : "video/webm";

    // Cache-Control for video assets
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Accept-Ranges", "bytes");

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 1024 * 1024, stat.size - 1);
      if (start >= stat.size || end >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end(); return;
      }
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": end - start + 1,
        "Content-Type": mime,
      });
      fs.createReadStream(filepath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Length": stat.size, "Content-Type": mime });
      fs.createReadStream(filepath, { highWaterMark: 64 * 1024 }).pipe(res);
    }
    return;
  }

  // GET /health
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      dashboards: dashboardClients.size,
      players: playerClients.size,
      videos: videos.length,
      uptime: process.uptime()
    }));
    return;
  }

  // Serve HTML files (cached)
  const htmlMap = { "/": "dashboard.html", "/dashboard.html": "dashboard.html", "/player.html": "player.html" };
  if (htmlMap[url.pathname]) {
    // Dashboard requires auth; player.html is public (it only plays, no data)
    if (url.pathname !== "/player.html" && !checkDashboardAuth(req, res)) return;
    const content = loadStatic(htmlMap[url.pathname]);
    if (!content) { res.writeHead(404); res.end("File not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(content);
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// ── WebSocket Server ───────────────────────────────────────────────────────
const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024,        // 64KB max WS message (play messages with metadata can exceed 10KB)
  perMessageDeflate: {           // compress WS messages
    zlibDeflateOptions: { level: 1 },
    threshold: 1024,
  }
});

wss.on("connection", (ws, req) => {
  const params = new URL(req.url, "http://x").searchParams;
  const role   = params.get("role");
  const token  = params.get("token");

  // Token check disabled

  const id = ++clientIdCounter;
  const clientInfo = { id, alive: true };

  if (role === "player") {
    playerClients.set(ws, clientInfo);
    console.log(`🖥️  Player #${id} connected  (total: ${playerClients.size})`);
    ws.on("close", () => { playerClients.delete(ws); console.log(`🖥️  Player #${id} left`); });
  } else {
    dashboardClients.set(ws, clientInfo);
    console.log(`📊 Dashboard #${id} connected (total: ${dashboardClients.size})`);
    // Send current video list to new dashboard
    safeSend(ws, JSON.stringify({ type: "video_list", videos }));
    ws.on("close", () => { dashboardClients.delete(ws); });
  }

  ws.on("pong", () => {
    const info = dashboardClients.get(ws) || playerClients.get(ws);
    if (info) info.alive = true;
  });

  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "play" && msg.video?.filename) {
        console.log(`▶️  Broadcasting to ${playerClients.size} player(s): ${msg.video.filename}`);
        broadcastJSON(playerClients, { type: "play", video: msg.video });
      }
    } catch (_) {}
  });

  ws.on("error", () => {
    dashboardClients.delete(ws);
    playerClients.delete(ws);
  });
});

// ── Heartbeat: drop dead connections (critical for 300+ users) ─────────────
setInterval(() => {
  const check = (map) => {
    map.forEach((info, ws) => {
      if (!info.alive) { map.delete(ws); ws.terminate(); return; }
      info.alive = false;
      ws.ping();
    });
  };
  check(dashboardClients);
  check(playerClients);
}, 25000);

// ── Helpers ────────────────────────────────────────────────────────────────
function safeSend(ws, payload) {
  if (ws.readyState === 1) {
    try { ws.send(payload); } catch (_) {}
  }
}

function broadcastJSON(clients, data) {
  const payload = JSON.stringify(data);
  clients.forEach((_, ws) => safeSend(ws, payload));
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  server.close(() => process.exit(0));
});

// ── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   🎬  VidStream — Port ${PORT}               ║
╠══════════════════════════════════════════╣
║  Dashboard → http://localhost:${PORT}/       ║
║  Player    → http://localhost:${PORT}/player.html ║
║  Health    → http://localhost:${PORT}/health  ║
╠══════════════════════════════════════════╣
║  Optimized for 300+ concurrent users     ║
║  1. Run: ngrok http ${PORT}                ║
║  2. Share ngrok URL with recorders       ║
╚══════════════════════════════════════════╝
`);
});