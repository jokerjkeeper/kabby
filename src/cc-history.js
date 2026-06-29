/**
 * 讀 cc 的對話歷史（~/.claude/projects/<encoded-cwd>/<uuid>.jsonl）
 *
 * 編碼規則（從 cc 觀察 + 用戶驗證）：
 *   D:\Git\kabby           →  D--Git-kabby
 *   D:\Projects\RS\my-app   →  D--Projects-RS-my-app   ← 底線也會被換
 *   D:\Git\claude-code-2.1.88 →  D--Git-claude-code-2-1-88   ← 點號也會被換
 *   規則：每個非英數字元一律換成 '-'，連續不合併。
 *
 * normalize 步驟（避免使用者填法導致對不上 cc 內部規範化的路徑）：
 *   1. trim
 *   2. 去尾巴的 \ 或 /
 *   3. Windows: drive letter 統一大寫
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const IS_WINDOWS = process.platform === 'win32';

function normalizeCwd(cwd) {
  let s = String(cwd || '').trim();
  s = s.replace(/[\\/]+$/, '');                       // 去尾 slash
  if (IS_WINDOWS) {
    s = s.replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ':');  // d: → D:
  }
  return s;
}

function encodeCwd(cwd) {
  return normalizeCwd(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

function projectDir(cwd) {
  return path.join(PROJECTS_DIR, encodeCwd(cwd));
}

async function listHistory(cwd) {
  const dir = projectDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
    const full = path.join(dir, ent.name);
    const stat = fs.statSync(full);
    const sessionId = ent.name.replace(/\.jsonl$/, '');
    let summary = '';
    let firstUserAt = null;
    let title = null;
    try {
      const meta = await readFirstUserMessage(full);
      summary = meta.summary;
      firstUserAt = meta.timestamp;
    } catch {}
    try {
      title = await readCustomTitle(full, stat.size);   // cc `/rename` 的名字（若有）
    } catch {}
    out.push({
      sessionId,
      file: full,
      title: title || null,               // /rename 設的自訂名；null = 沒 rename 過
      summary: summary || '(empty)',
      firstUserAt,
      mtime: stat.mtimeMs,
      size: stat.size,
    });
  }
  // 最近活動排最前
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * 讀 jsonl 直到拿到第一個 type === 'user' 的訊息。
 * 用 stream 避免大檔一次載入。
 */
function readFirstUserMessage(filePath) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    let resolved = false;
    let lineCount = 0;
    rl.on('line', (line) => {
      lineCount++;
      if (lineCount > 50) {       // 太多行還沒找到 user 訊息就放棄
        if (!resolved) {
          resolved = true;
          rl.close();
          resolve({ summary: '', timestamp: null });
        }
        return;
      }
      if (resolved) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      if (obj && obj.type === 'user' && obj.message) {
        const content = obj.message.content;
        const text = extractText(content);
        resolved = true;
        rl.close();
        resolve({ summary: shorten(stripTags(text), 120), timestamp: obj.timestamp || null });
      }
    });
    rl.on('close', () => { if (!resolved) resolve({ summary: '', timestamp: null }); });
    rl.on('error', reject);
  });
}

// cc 的 `/rename` 會往 jsonl 追加一行 {"type":"custom-title","customTitle":"..."}。
// rename 通常在對話後段才下，這行落在檔尾，所以只讀檔尾 TAIL_BYTES，不整檔掃（大檔也是固定成本）。
// 取最後一個 custom-title（多次 rename 用最新）。
const TAIL_BYTES = 64 * 1024;

function readCustomTitle(filePath, fileSize) {
  return new Promise((resolve) => {
    const start = Math.max(0, (fileSize || 0) - TAIL_BYTES);
    const stream = fs.createReadStream(filePath, { encoding: 'utf8', start });
    const rl = readline.createInterface({ input: stream });
    let title = null;
    let skipFirst = start > 0;   // 非從頭讀時，第一行可能是被截斷的半行，跳過
    rl.on('line', (line) => {
      if (skipFirst) { skipFirst = false; return; }
      if (line.indexOf('"custom-title"') === -1) return;   // 便宜的預過濾，避免每行都 JSON.parse
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      if (obj && obj.type === 'custom-title' && obj.customTitle) {
        title = String(obj.customTitle);
      }
    });
    rl.on('close', () => resolve(title));
    rl.on('error', () => resolve(null));
  });
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return part.text || '';
        return '';
      })
      .join(' ');
  }
  return '';
}

function stripTags(s) {
  // 把 <command-name>...</command-name>, <ide_opened_file>...</ide_opened_file> 之類包裹標籤去掉
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function shorten(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

module.exports = {
  PROJECTS_DIR,
  normalizeCwd,
  encodeCwd,
  projectDir,
  listHistory,
  // 供 cc-collector 複用的文字解析 helper
  extractText,
  stripTags,
  shorten,
};
