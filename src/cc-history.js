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
    try {
      const meta = await readFirstUserMessage(full);
      summary = meta.summary;
      firstUserAt = meta.timestamp;
    } catch {}
    out.push({
      sessionId,
      file: full,
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
};
