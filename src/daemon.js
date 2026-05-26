const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const registry = require('./registry');
const profileStore = require('./profile-store');
const ccHistory = require('./cc-history');

// 載入專案根目錄的 .env（Node 20.12+ 內建 loadEnvFile，零依賴）；檔案不存在或舊版 node 則略過
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch {}
}

const PORT = parseInt(process.env.PORT || '3700', 10);
const HOST = process.env.HOST || '127.0.0.1';
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;
const VIEWER_PATH = process.env.KABBY_VIEWER_PATH || null;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ALLOWED_ORIGINS = (process.env.KABBY_ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// token 取自：X-Kabby-Token header / Authorization: Bearer <token> / ?token= query
// AUTH_TOKEN 未設則不鎖（本機開發）
function tokenOk(req) {
  if (!AUTH_TOKEN) return true;
  let t = req.get('x-kabby-token') || req.query.token;
  if (!t) {
    const auth = req.get('authorization');
    if (auth) t = auth.replace(/^Bearer\s+/i, '').trim();
  }
  return t === AUTH_TOKEN;
}

const app = express();
app.use(cors({
  origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true,   // 未設白名單 = 放行全部（本機開發）
  allowedHeaders: ['Content-Type', 'X-Kabby-Token', 'Authorization'],
  credentials: false,
}));
app.use(express.json({ limit: '1mb' }));

// 開放：liveness + 讓前端判斷是否需要登入（不需 token）
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    authRequired: !!AUTH_TOKEN,
    sessions: registry.list().length,
    profiles: profileStore.list().length,
    viewerConfigured: !!(VIEWER_PATH && fs.existsSync(VIEWER_PATH)),
  });
});

// 其餘 /api/* 一律要 token（health 已在上面先處理，不受影響）
app.use('/api', (req, res, next) => {
  if (tokenOk(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
});

// ──────────────────────────────────────────────────────────────────────────
// Profiles
// ──────────────────────────────────────────────────────────────────────────
app.get('/api/profiles', (req, res) => {
  const busy = registry.busyCcSessionIds();
  const profiles = profileStore.list().map((p) => ({
    ...p,
    lastSessionBusy: p.lastSessionId ? busy.has(p.lastSessionId) : false,
  }));
  res.json(profiles);
});

app.post('/api/profiles', (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    if (body.cwd) body.cwd = ccHistory.normalizeCwd(body.cwd);
    const profile = profileStore.create(body);
    res.status(201).json(profile);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/profiles/:id', (req, res) => {
  const body = { ...(req.body || {}) };
  if (body.cwd) body.cwd = ccHistory.normalizeCwd(body.cwd);
  const updated = profileStore.update(req.params.id, body);
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json(updated);
});

app.delete('/api/profiles/:id', (req, res) => {
  const ok = profileStore.destroy(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.get('/api/profiles/:id/history', async (req, res) => {
  const profile = profileStore.get(req.params.id);
  if (!profile) return res.status(404).json({ error: 'profile not found' });
  try {
    const history = await ccHistory.listHistory(profile.cwd);
    const busy = registry.busyCcSessionIds();
    res.json(history.map((h) => ({ ...h, busy: busy.has(h.sessionId) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/profiles/:id/history-dir', (req, res) => {
  const profile = profileStore.get(req.params.id);
  if (!profile) return res.status(404).json({ error: 'profile not found' });
  const dir = ccHistory.projectDir(profile.cwd);
  res.json({ dir, exists: fs.existsSync(dir) });
});

app.post('/api/profiles/:id/launch', (req, res) => {
  const profile = profileStore.get(req.params.id);
  if (!profile) return res.status(404).json({ error: 'profile not found' });
  const { resume, sessionName } = req.body || {};

  // 衝突檢查：要 resume 的 cc session id 是否已被 running PTY 佔用
  if (resume) {
    const busy = registry.busyCcSessionIds();
    if (busy.has(resume)) {
      return res.status(409).json({
        error: `cc session ${resume} 已被另一個 kabby session 掛載中，不能同時雙開驅動。`,
      });
    }
  }

  // 組裝 args
  const baseArgs = Array.isArray(profile.args) ? [...profile.args] : ['--dangerously-skip-permissions'];
  if (resume) baseArgs.push('--resume', resume);

  // 名稱：使用者指定 > profile name + 時間戳尾巴
  const name = sessionName || `${profile.name}-${Date.now().toString(36).slice(-4)}`;

  try {
    const session = registry.create({
      name,
      cwd: profile.cwd,
      cmd: profile.cmd || undefined,
      args: baseArgs,
      profileId: profile.id,
    });
    // 紀錄 lastUsedAt / lastSessionId（resume 才有意義）
    profileStore.update(profile.id, {
      lastUsedAt: new Date().toISOString(),
      lastSessionId: resume || profile.lastSessionId || null,
    });
    res.status(201).json(session.toJSON());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Viewer launching
// ──────────────────────────────────────────────────────────────────────────
app.post('/api/viewer/open', (req, res) => {
  if (!VIEWER_PATH) {
    return res.status(503).json({ error: 'viewer 未設定（請設定 env KABBY_VIEWER_PATH）' });
  }
  if (!fs.existsSync(VIEWER_PATH)) {
    return res.status(503).json({ error: `viewer 檔案不存在：${VIEWER_PATH}` });
  }
  try {
    const child = spawn(VIEWER_PATH, [], { detached: true, stdio: 'ignore' });
    child.unref();
    res.json({ ok: true, path: VIEWER_PATH });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/viewer/open-folder', (req, res) => {
  const { path: target } = req.body || {};
  if (!target || typeof target !== 'string') {
    return res.status(400).json({ error: 'path is required' });
  }
  if (!fs.existsSync(target)) {
    return res.status(404).json({ error: `path not found: ${target}` });
  }
  try {
    const opener = process.platform === 'win32' ? 'explorer.exe'
      : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(opener, [target], { detached: true, stdio: 'ignore' });
    child.unref();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions', (req, res) => {
  res.json(registry.list());
});

app.post('/api/sessions', (req, res) => {
  const { name, cwd, cmd, args, cols, rows } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const session = registry.create({ name, cwd, cmd, args, cols, rows });
    res.status(201).json(session.toJSON());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/sessions/:id', (req, res) => {
  const session = registry.get(req.params.id) || registry.getByName(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  res.json(session.toJSON());
});

app.delete('/api/sessions/:id', (req, res) => {
  const ok = registry.destroy(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.post('/api/sessions/:id/input', (req, res) => {
  const session = registry.get(req.params.id) || registry.getByName(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  const { data } = req.body || {};
  if (typeof data !== 'string') return res.status(400).json({ error: 'data must be string' });
  const ok = session.write(data);
  res.json({ ok });
});

// Static UI — mount after /api/* so API routes win
app.use(express.static(PUBLIC_DIR));

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const match = url.pathname.match(/^\/ws\/([^/]+)$/);
  if (!match) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  if (AUTH_TOKEN && url.searchParams.get('token') !== AUTH_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const id = decodeURIComponent(match[1]);
  const session = registry.get(id) || registry.getByName(id);
  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleConnection(ws, session);
  });
});

function handleConnection(ws, session) {
  console.log(`[ws] attach session=${session.name} (${session.id.slice(0,8)}) clients=${session.clients.size + 1}`);
  session.attach(ws);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      session.write(msg.data);
    } else if (msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
      session.resize(msg.cols, msg.rows);
    }
  });

  ws.on('close', () => {
    session.detach(ws);
    console.log(`[ws] detach session=${session.name} clients=${session.clients.size}`);
  });

  ws.on('error', (err) => {
    console.error('[ws] error:', err.message);
  });
}

httpServer.listen(PORT, HOST, () => {
  console.log(`kabby daemon listening on http://${HOST}:${PORT}`);
  console.log(AUTH_TOKEN ? '[auth] AUTH_TOKEN enabled — /api + WS 需要 token' : '[auth] AUTH_TOKEN 未設 — 不鎖（僅適合本機）');
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
function shutdown() {
  console.log('\n[kabby] shutting down...');
  for (const s of registry.list()) {
    const session = registry.get(s.id);
    if (session) session.kill();
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}
