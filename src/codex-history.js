const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { normalizeCwd, shorten } = require('./cc-history');

const CODEX_DIR = path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const SESSION_INDEX_FILE = path.join(CODEX_DIR, 'session_index.jsonl');

function projectDir() {
  return SESSIONS_DIR;
}

function listSessionFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out;
}

function loadSessionIndex() {
  const map = new Map();
  if (!fs.existsSync(SESSION_INDEX_FILE)) return map;
  const lines = fs.readFileSync(SESSION_INDEX_FILE, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || !obj.id) continue;
    const prev = map.get(obj.id);
    if (!prev || String(obj.updated_at || '') >= String(prev.updated_at || '')) {
      map.set(obj.id, obj);
    }
  }
  return map;
}

function readSessionMeta(filePath) {
  try {
    const first = fs.readFileSync(filePath, 'utf8').split(/\r?\n/, 1)[0];
    if (!first) return null;
    const obj = JSON.parse(first);
    if (obj && obj.type === 'session_meta' && obj.payload) return obj.payload;
  } catch {}
  return null;
}

function readFirstUserMessage(filePath) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    let resolved = false;
    let lineCount = 0;
    // 提早收工必須 destroy 底層 stream：rl.close() 不會關 fd（見 cc-history 同處註解）
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      rl.close();
      stream.destroy();
      resolve(result);
    };
    rl.on('line', (line) => {
      if (resolved) return;
      lineCount++;
      if (lineCount > 80) {
        finish('');
        return;
      }
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      const msg = extractUserMessage(obj);
      if (!msg) return;
      finish(shorten(msg.replace(/\s+/g, ' ').trim(), 120));
    });
    rl.on('close', () => { if (!resolved) { resolved = true; resolve(''); } });
    rl.on('error', (err) => { stream.destroy(); reject(err); });
  });
}

// Codex 會把環境/權限/使用者規則以 XML 包裹當成第一條 user 訊息注入，
// 這些不是真正的對話內容，做 summary 時要跳過。
const INJECTED_CONTEXT_RE = /^\s*<(environment_context|permissions[ _]instructions|permissions|user_instructions|system_context|tool_instructions)\b/i;

function isInjectedContext(text) {
  return INJECTED_CONTEXT_RE.test(text || '');
}

function extractUserMessage(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (obj.type === 'event_msg' && obj.payload && obj.payload.type === 'user_message') {
    const msg = String(obj.payload.message || '');
    return isInjectedContext(msg) ? '' : msg;
  }
  if (obj.type === 'response_item' && obj.payload && obj.payload.type === 'message' && obj.payload.role === 'user') {
    const content = Array.isArray(obj.payload.content) ? obj.payload.content : [];
    const text = content
      .map((part) => (part && typeof part === 'object' ? (part.text || '') : ''))
      .join(' ');
    return isInjectedContext(text) ? '' : text;
  }
  return '';
}

async function listHistory(cwd) {
  const want = normalizeCwd(cwd);
  const sessionIndex = loadSessionIndex();
  const files = listSessionFiles(SESSIONS_DIR);
  const out = [];
  for (const file of files) {
    const meta = readSessionMeta(file);
    if (!meta || !meta.id) continue;
    if (normalizeCwd(meta.cwd) !== want) continue;
    if (meta.thread_source && meta.thread_source !== 'user') continue;
    const stat = fs.statSync(file);
    const indexMeta = sessionIndex.get(meta.id);
    const summary = await readFirstUserMessage(file);
    out.push({
      sessionId: meta.id,
      file,
      summary: summary || (indexMeta && indexMeta.thread_name) || '(empty)',
      firstUserAt: meta.timestamp || null,
      mtime: stat.mtimeMs,
      size: stat.size,
      updatedAt: (indexMeta && indexMeta.updated_at) || meta.timestamp || null,
      threadName: indexMeta ? indexMeta.thread_name || null : null,
    });
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || (b.mtime - a.mtime));
  return out;
}

module.exports = {
  CODEX_DIR,
  SESSIONS_DIR,
  SESSION_INDEX_FILE,
  projectDir,
  listHistory,
  // 供 codex-collector 複用
  listSessionFiles,
  readSessionMeta,
  isInjectedContext,
  extractUserMessage,
};
