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
const history = require('./history');
const ccCollector = require('./cc-collector');
const codexCollector = require('./codex-collector');
const codexHistory = require('./codex-history');
const { createWatcher } = require('./usage-watcher');
const providers = require('./providers');

// 監控 provider 路由：?provider=codex → codex 採集器，其餘（含未帶）→ claude。
function collectorFor(provider) {
  return providers.normalizeProvider(provider) === 'codex' ? codexCollector : ccCollector;
}

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

app.get('/api/providers', (req, res) => {
  res.json(providers.listProviders());
});

// ──────────────────────────────────────────────────────────────────────────
// Profiles
// ──────────────────────────────────────────────────────────────────────────
app.get('/api/profiles', async (req, res) => {
  const profiles = await Promise.all(profileStore.list().map(async (p) => {
    const provider = providers.getProvider(p.provider);
    const busy = registry.busyResumeSessionIds(provider.id);
    let lastSessionId = p.lastSessionId || null;
    if (provider.historySupported && provider.resumeSupported && !lastSessionId) {
      try {
        const items = await history.listHistory(provider.id, p.cwd);
        lastSessionId = items[0] ? items[0].sessionId : null;
      } catch {}
    }
    return {
      ...p,
      provider: provider.id,
      providerLabel: provider.label,
      historySupported: provider.historySupported,
      resumeSupported: provider.resumeSupported,
      viewerSupported: provider.viewerSupported,
      lastSessionId,
      lastSessionBusy: provider.resumeSupported && lastSessionId ? busy.has(lastSessionId) : false,
    };
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
  const provider = providers.getProvider(profile.provider);
  if (!provider.historySupported) return res.json([]);
  try {
    const items = await history.listHistory(provider.id, profile.cwd);
    const busy = registry.busyResumeSessionIds(provider.id);
    res.json(items.map((h) => ({ ...h, busy: busy.has(h.sessionId) })));

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/profiles/:id/history-dir', (req, res) => {
  const profile = profileStore.get(req.params.id);
  if (!profile) return res.status(404).json({ error: 'profile not found' });
  const provider = providers.getProvider(profile.provider);
  if (!provider.historySupported) {
    return res.json({ dir: null, exists: false, unsupported: true, provider: provider.id });
  }
  const dir = history.projectDir(provider.id, profile.cwd);
  res.json({ dir, exists: fs.existsSync(dir), provider: provider.id });
});

app.post('/api/profiles/:id/launch', (req, res) => {
  const profile = profileStore.get(req.params.id);
  if (!profile) return res.status(404).json({ error: 'profile not found' });
  const provider = providers.getProvider(profile.provider);
  const { resume, sessionName } = req.body || {};

  if (resume && !provider.resumeSupported) {
    return res.status(400).json({ error: `${provider.label} 尚未支援 history resume` });
  }

  // 衝突檢查：要 resume 的歷史 session id 是否已被 running PTY 佔用
  if (resume) {
    const busy = registry.busyResumeSessionIds(provider.id);
    if (busy.has(resume)) {
      return res.status(409).json({
        error: `${provider.label} history session ${resume} 已被另一個 kabby session 掛載中，不能同時雙開驅動。`,
      });
    }
  }

  // 組裝 args
  let baseArgs = Array.isArray(profile.args) ? [...profile.args] : providers.defaultArgs(provider.id);
  if (resume) baseArgs = providers.appendResumeArgs(provider.id, baseArgs, resume);

  // 名稱：使用者指定 > profile name + 時間戳尾巴
  const name = sessionName || `${profile.name}-${Date.now().toString(36).slice(-4)}`;

  try {
    const session = registry.create({
      name,
      cwd: profile.cwd,
      cmd: profile.cmd || undefined,
      args: baseArgs,
      profileId: profile.id,
      provider: provider.id,
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
  const { name, cwd, cmd, args, cols, rows, provider } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const session = registry.create({ name, cwd, cmd, args, cols, rows, provider });
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
  const r = session.write(data);
  res.json({ ok: r.ok, blocked: r.blocked });
});

// ──────────────────────────────────────────────────────────────────────────
// Usage 監控（B 方案：cc JSONL 增量採集，pull 式：請求時掃描 + 回聚合）
// 索引存 ~/.kabby/usage-index.json（衍生快取，不進 git）。詳見 cc-collector.js。
// ──────────────────────────────────────────────────────────────────────────

// GET /api/usage                 → 只讀索引（背景 watcher 已維護），回聚合
// GET /api/usage?cwd=D:\Git\xxx  → 同上但只回該 project
// GET /api/usage?refresh=1       → 強制立刻增量掃一次再回（手動刷新）
// GET /api/usage?rebuild=1       → 砍索引從頭全掃（套用新敏感詞庫到既有歷史，較重）
app.get('/api/usage', (req, res) => {
  try {
    const collector = collectorFor(req.query.provider);
    const cwd = req.query.cwd ? ccHistory.normalizeCwd(req.query.cwd) : null;
    const filter = cwd ? { cwd } : undefined;
    let view;
    if (req.query.rebuild === '1') {
      view = collector.rebuildAll();
      if (cwd) view = collector.view(filter);
    } else if (req.query.refresh === '1') {
      view = cwd ? collector.scanProject(cwd) : collector.scanAll();
    } else {
      view = collector.view(filter);
    }
    res.json(view);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/usage/sensitive          → 所有 session 的敏感詞命中（攤平、時間新→舊）
// GET /api/usage/sensitive?cwd=...   → 只回該 project；?provider=codex → codex
app.get('/api/usage/sensitive', (req, res) => {
  try {
    const collector = collectorFor(req.query.provider);
    const cwd = req.query.cwd ? ccHistory.normalizeCwd(req.query.cwd) : null;
    res.json(collector.sensitiveHits(cwd ? { cwd } : undefined));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/usage/:sessionId/conversation → 按需從原檔讀完整對話（不存索引）
app.get('/api/usage/:sessionId/conversation', async (req, res) => {
  try {
    const convo = await collectorFor(req.query.provider).readConversation(req.params.sessionId);
    if (!convo) return res.status(404).json({ error: 'session jsonl not found' });
    res.json(convo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/usage/:sessionId/analysis → 單 session 成本歸因（誰貴/為何貴/診斷）
app.get('/api/usage/:sessionId/analysis', async (req, res) => {
  try {
    const a = await collectorFor(req.query.provider).analyzeSession(req.params.sessionId);
    if (!a) return res.status(404).json({ error: 'session jsonl not found' });
    res.json(a);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Static UI — mount after /api/* so API routes win
app.use(express.static(PUBLIC_DIR));

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// 監控頁即時推送：watcher 每次掃描後廣播聚合 view 給這些 client。
// 帶 provider 讓前端依目前選的 provider 過濾（claude view 無 provider 欄 → 補 'claude'）。
const usageClients = new Set();
function broadcastUsage(view) {
  if (!usageClients.size) return;
  const msg = JSON.stringify({ type: 'usage', provider: view.provider || 'claude', ...view });
  for (const ws of usageClients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// 兩個 provider 各一個背景 watcher（claude → ~/.claude/projects、codex → ~/.codex/sessions）
const ccWatcher = createWatcher({ watchDir: ccHistory.PROJECTS_DIR, collector: ccCollector, label: 'claude' });
const codexWatcher = createWatcher({ watchDir: codexHistory.SESSIONS_DIR, collector: codexCollector, label: 'codex' });
ccWatcher.setOnScan(broadcastUsage);
codexWatcher.setOnScan(broadcastUsage);

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 監控即時串流（與 per-session 終端 WS 區隔）
  if (url.pathname === '/api/usage/stream') {
    if (AUTH_TOKEN && url.searchParams.get('token') !== AUTH_TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      usageClients.add(ws);
      ws.on('close', () => usageClients.delete(ws));
      ws.on('error', () => usageClients.delete(ws));
    });
    return;
  }

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
  // 背景採集：監看 cc / codex JSONL，檔案一變就增量入庫（B 方案常駐採集）
  ccWatcher.start();
  codexWatcher.start();
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
function shutdown() {
  console.log('\n[kabby] shutting down...');
  ccWatcher.stop();
  codexWatcher.stop();
  for (const s of registry.list()) {
    const session = registry.get(s.id);
    if (session) session.kill();
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}
