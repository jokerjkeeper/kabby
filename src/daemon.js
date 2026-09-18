const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const registry = require('./registry');
const roomRegistry = require('./room-registry');
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

// 訪客入房（不需 AUTH_TOKEN — 訪客只有房間 key）。放在 token middleware 之前。
// 防爆破：同 IP 連續猜錯 key 超過上限 → 暫時拒絕。
const joinFails = new Map(); // ip → { count, resetAt }
const JOIN_FAIL_LIMIT = 10;
const JOIN_FAIL_WINDOW_MS = 5 * 60 * 1000;
app.post('/api/rooms/join', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || '?';
  const now = Date.now();
  const rec = joinFails.get(ip);
  if (rec && rec.resetAt > now && rec.count >= JOIN_FAIL_LIMIT) {
    return res.status(429).json({ error: '嘗試次數過多，請稍後再試' });
  }
  // 邀請碼（分享連結）或明文密碼（手動輸入）；相容舊欄位 key
  const invite = (req.body && req.body.invite) || '';
  const pw = (req.body && (req.body.password || req.body.key)) || '';
  if (!invite && !pw) return res.status(400).json({ error: '密碼必填' });
  const nick = (typeof (req.body && req.body.nickname) === 'string' ? req.body.nickname.trim() : '').slice(0, 24);
  if (!nick) return res.status(400).json({ error: '暱稱必填' });

  const joined = invite
    ? roomRegistry.joinByInvite(String(invite).trim(), nick)
    : roomRegistry.join(String(pw).trim(), nick);
  if (!joined) {
    const cur = rec && rec.resetAt > now ? rec : { count: 0, resetAt: now + JOIN_FAIL_WINDOW_MS };
    cur.count += 1;
    joinFails.set(ip, cur);
    return res.status(404).json({ error: '密碼不正確或房間不存在' });
  }
  joinFails.delete(ip);
  const { room, ticket, role } = joined;
  res.json({
    ticket,
    roomId: room.id,
    roomName: room.name,
    sessionId: room.sessionId,
    sessionName: room.sessionName,
    role,
    allowWrite: roomRegistry.effectiveWrite(role, room.frozen),
    nickname: nick,
  });
});

// 把一個運行中的 kabby session 對應到它的 cc/codex 對話存檔並讀出 turns（房主 + 訪客共用）。
// 定位規則：resume 的直接用該 id；否則取該 cwd 下「PTY 啟動後仍有更新」的最新一份
//（cc 啟動即建檔、活躍中 mtime 持續前進）。定位結果快取在 session.ccSessionId 上——
// 這條會被前端每 8 秒輪詢，不要每次都重掃整個歷史目錄。回傳只含 turns（不外露本機路徑）。
async function readSessionConversation(session) {
  const provider = providers.getProvider(session.provider);
  if (!provider.historySupported) return { turns: [], unsupported: true, provider: provider.id };
  let ccSessionId = session.resumeSessionId || session.ccSessionId;
  if (!ccSessionId) {
    const items = await history.listHistory(provider.id, session.cwd);
    const started = new Date(session.createdAt).getTime();
    const hit = items.find((h) => h.mtime >= started);
    ccSessionId = hit ? hit.sessionId : null;
    if (ccSessionId) session.ccSessionId = ccSessionId;
  }
  if (!ccSessionId) return { turns: [], notFound: true };
  const convo = await collectorFor(provider.id).readConversation(ccSessionId);
  if (!convo) {
    session.ccSessionId = null;   // 檔案不見了（罕見）→ 下次重新定位
    return { turns: [], notFound: true };
  }
  return { turns: convo.turns || [] };
}

// 訪客看綁定 session 的「乾淨版對話記錄」（ticket 認證，在 token middleware 之前）。
app.get('/api/rooms/guest/conversation', async (req, res) => {
  const resolved = roomRegistry.resolveTicket(req.query.ticket || '');
  if (!resolved) return res.status(401).json({ error: 'ticket 無效或房間已關閉' });
  const session = registry.get(resolved.room.sessionId);
  if (!session) return res.status(404).json({ error: 'session 已結束' });
  try {
    res.json(await readSessionConversation(session));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 其餘 /api/* 一律要 token（health / rooms/join / rooms/guest/* 已在上面先處理，不受影響）
app.use('/api', (req, res, next) => {
  if (tokenOk(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
});

app.get('/api/providers', (req, res) => {
  res.json(providers.listProviders());
});

// 房主看「當前 kabby session」的乾淨版對話記錄（token 認證；不必開房）。
// 傳 kabby session id，走跟訪客端同一套解析（readSessionConversation）。
app.get('/api/sessions/:id/conversation', async (req, res) => {
  const session = registry.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session 不存在或已結束' });
  try {
    res.json(await readSessionConversation(session));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  const { resume, sessionName, cols, rows } = req.body || {};

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
      cols,
      rows,
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

// ──────────────────────────────────────────────────────────────────────────
// Rooms（聊天室）— 房主管理端（需 AUTH_TOKEN）；訪客入口是上面的 /api/rooms/join
// ──────────────────────────────────────────────────────────────────────────
app.get('/api/rooms', (req, res) => {
  res.json(roomRegistry.list());
});

app.post('/api/rooms', (req, res) => {
  const { name, masterPass, collabPass, guestPass, sessionId, frozen } = req.body || {};
  const session = registry.get(sessionId) || registry.getByName(sessionId);
  if (!session || !session.alive) {
    return res.status(400).json({ error: '綁定的 session 不存在或已結束' });
  }
  try {
    const room = roomRegistry.create({
      name: name || `${session.name} 聊天室`,
      masterPass,
      collabPass,
      guestPass,
      sessionId: session.id,
      sessionName: session.name,
      frozen,
    });
    // session 結束（exit / 被殺）→ 連帶關房、通知所有成員
    session.on('exit', () => roomRegistry.closeForSession(session.id, 'session-exit'));
    res.status(201).json(room.toJSON());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/rooms/:id', (req, res) => {
  const room = roomRegistry.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'not found' });
  const { frozen } = req.body || {};
  if (typeof frozen === 'boolean' && frozen !== room.frozen) {
    setRoomFrozen(room, frozen);
  }
  res.json(room.toJSON());
});

app.delete('/api/rooms/:id', (req, res) => {
  const ok = roomRegistry.destroy(req.params.id, 'host-closed');
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
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

  // 房主聊天面板 WS（chat-only，不串終端）：/ws/room/:roomId，需 token
  const roomMatch = url.pathname.match(/^\/ws\/room\/([^/]+)$/);
  if (roomMatch) {
    if (AUTH_TOKEN && url.searchParams.get('token') !== AUTH_TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const room = roomRegistry.get(decodeURIComponent(roomMatch[1]));
    if (!room || room.closed) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleRoomHostConnection(ws, room));
    return;
  }

  const match = url.pathname.match(/^\/ws\/([^/]+)$/);
  if (!match) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
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
  // 認證：房主 token（完整權限）或訪客 ticket（僅限該房綁定的 session、受房間權限管制）
  const isHost = !AUTH_TOKEN || url.searchParams.get('token') === AUTH_TOKEN;
  let guestCtx = null;
  const ticket = url.searchParams.get('ticket');
  if (ticket) {
    const resolved = roomRegistry.resolveTicket(ticket);
    if (resolved && resolved.room.sessionId === session.id) guestCtx = resolved;
  }
  if (!isHost && !guestCtx) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleConnection(ws, session, guestCtx);
  });
});

// 房間聊天訊息：入 log + 廣播給房內所有成員。支援文字與貼圖（data URL，前端已壓縮）
const CHAT_IMG_MAX_CHARS = 2 * 1024 * 1024; // base64 字串長度上限（≈1.5MB 二進位）
function roomChat(room, { from, nickname, text, image }) {
  const cleanText = typeof text === 'string' ? text.slice(0, 2000).trim() : '';
  let cleanImage = null;
  if (typeof image === 'string'
      && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image)
      && image.length <= CHAT_IMG_MAX_CHARS) {
    cleanImage = image;
  }
  if (!cleanText && !cleanImage) return;
  const entry = room.addChat({
    from,
    nickname: nickname || '',
    text: cleanText,
    image: cleanImage,
    ts: new Date().toISOString(),
  });
  room.broadcast({ type: 'chat', ...entry });
}

function roomSystemMsg(room, text) {
  roomChat(room, { from: 'system', nickname: '', text });
}

// 切換全房凍結：更新狀態並依角色把「有效寫入權」推給每個在線訪客
// （master 不受凍結影響、collab 凍結時變唯讀、guest 恆唯讀）。房主面板收到 frozen 狀態。
function setRoomFrozen(room, frozen) {
  room.frozen = !!frozen;
  for (const g of room.guests.values()) {
    if (g.ws && g.ws.readyState === g.ws.OPEN) {
      g.ws.send(JSON.stringify({
        type: 'room-config',
        allowWrite: roomRegistry.effectiveWrite(g.role, room.frozen),
        frozen: room.frozen,
      }));
    }
  }
  for (const ws of room.hostSockets) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'room-config', frozen: room.frozen }));
  }
  roomSystemMsg(room, room.frozen ? '房主已凍結全房輸入（協作者暫為唯讀）' : '房主已解除凍結');
}

// 遠端房主（master ticket）房內全權：凍結 / 踢人 / 關房。ctx = { room, guest, ticket }
function handleRoomAdmin(ctx, msg) {
  const { room, ticket } = ctx;
  const action = msg && msg.action;
  if (action === 'freeze' || action === 'unfreeze') {
    const want = action === 'freeze';
    if (want !== room.frozen) setRoomFrozen(room, want);
  } else if (action === 'kick' && typeof msg.ticket === 'string' && msg.ticket !== ticket) {
    const target = room.guests.get(msg.ticket);
    if (target) {
      const nick = target.nickname;
      roomRegistry.kick(room, msg.ticket);
      if (!room.closed) {
        room.broadcast({ type: 'room-presence', guests: room.presence() });
        roomSystemMsg(room, `${nick} 已被房主移出聊天室`);
      }
    }
  } else if (action === 'close') {
    roomRegistry.destroy(room.id, 'host-closed');
  }
}

// 房主聊天面板 WS：只收發聊天，不碰終端
function handleRoomHostConnection(ws, room) {
  room.hostSockets.add(ws);
  ws.send(JSON.stringify({ type: 'room-init', room: room.toJSON(), chatLog: room.chatLog }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'chat') roomChat(room, { from: 'host', nickname: '房主', text: msg.text, image: msg.image });
  });
  ws.on('close', () => room.hostSockets.delete(ws));
  ws.on('error', () => room.hostSockets.delete(ws));
}

// 終端 WS。guestCtx 有值 = 訪客連線：input 受房間 allowWrite 管制、resize 一律忽略、可收發聊天
function handleConnection(ws, session, guestCtx) {
  const who = guestCtx ? `guest:${guestCtx.guest.nickname}` : 'host';
  console.log(`[ws] attach session=${session.name} (${session.id.slice(0,8)}) ${who} clients=${session.clients.size + 1}`);
  session.attach(ws);

  if (guestCtx) {
    const { room, guest } = guestCtx;
    // 同 ticket 重複連線（多分頁）→ 踢掉舊的，保留最新
    if (guest.ws && guest.ws !== ws) { try { guest.ws.close(); } catch {} }
    guest.ws = ws;
    ws.send(JSON.stringify({
      type: 'room-init',
      room: {
        id: room.id,
        name: room.name,
        sessionName: room.sessionName,
        frozen: room.frozen,
        allowWrite: roomRegistry.effectiveWrite(guest.role, room.frozen),
      },
      role: guest.role,
      nickname: guest.nickname,
      chatLog: room.chatLog,
      guests: room.presence(),
    }));
    room.broadcast({ type: 'room-presence', guests: room.presence() });
    roomSystemMsg(room, `${guest.nickname} 加入了聊天室`);
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      // 訪客輸入：依角色與凍結狀態放行（伺服器端強制，前端只是輔助 UI）
      // master 一律可寫、collab 非凍結才可寫、guest 恆唯讀；本機房主(無 guestCtx)不受限
      if (guestCtx && !roomRegistry.effectiveWrite(guestCtx.guest.role, guestCtx.room.frozen)) return;
      session.write(msg.data);
    } else if (msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
      if (guestCtx) return;   // 訪客（含遠端房主）不許 resize（會弄亂本機房主畫面）
      session.resize(msg.cols, msg.rows);
    } else if (msg.type === 'chat' && guestCtx) {
      roomChat(guestCtx.room, { from: 'guest', nickname: guestCtx.guest.nickname, text: msg.text, image: msg.image });
    } else if (msg.type === 'room-admin' && guestCtx && guestCtx.guest.role === 'master') {
      // 遠端房主房內全權：凍結 / 踢人 / 關房
      handleRoomAdmin(guestCtx, msg);
    }
  });

  ws.on('close', () => {
    session.detach(ws);
    if (guestCtx) {
      const { room, guest } = guestCtx;
      if (guest.ws === ws) guest.ws = null;
      if (!room.closed) {
        room.broadcast({ type: 'room-presence', guests: room.presence() });
        roomSystemMsg(room, `${guest.nickname} 離開了聊天室`);
      }
    }
    console.log(`[ws] detach session=${session.name} ${who} clients=${session.clients.size}`);
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
