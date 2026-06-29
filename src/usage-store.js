/**
 * 監控採集的「衍生索引」儲存層（B 方案核心）。
 *
 * 設計取捨（2026-06-12 與用戶確認）：
 *   - 存 JSON 不存 SQLite：監控是 pull 式（點按鈕才掃描顯示），非常駐刷新；
 *     SQLite 會產生大顆 binary db、難 diff、難同步。
 *   - 只存「索引 + 聚合」不存全文對話：全文 source of truth 仍在 cc 的 jsonl
 *     原檔（~/.claude/projects/），要看全文時按需從原檔讀，索引檔因此保持小。
 *   - 放 ~/.kabby/（user-level，跟 profiles.json 同層），不進 git：
 *     它是每台機器各自的本地衍生快取，跨機工作流本來就不 sync cc jsonl。
 *
 * 索引結構：
 *   {
 *     version: 1,
 *     updatedAt: ISO,
 *     sessions: {
 *       "<sessionId>": {
 *         sessionId, file, projectDir, cwd,
 *         offset, size, mtimeMs,          // 增量讀取游標（byte offset）
 *         firstTs, lastTs, summary,
 *         turns, userMsgs,
 *         models: { "<model>": <次數> },
 *         tokens: { input, output, cacheCreate, cacheRead },
 *         sensitiveHits: []               // 保留給 D 方案（敏感詞）
 *       }
 *     }
 *   }
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = path.join(os.homedir(), '.kabby');
// 預設 claude 索引檔；其他 provider（codex）傳 fileName 用獨立檔，互不污染。
const DEFAULT_FILE = 'usage-index.json';

const CURRENT_VERSION = 1;

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function storePath(fileName) {
  return path.join(STORE_DIR, fileName || DEFAULT_FILE);
}

function emptyIndex() {
  return { version: CURRENT_VERSION, updatedAt: null, sessions: {} };
}

function load(fileName) {
  ensureDir();
  const file = storePath(fileName);
  if (!fs.existsSync(file)) return emptyIndex();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data.sessions !== 'object' || data.sessions === null) {
      return emptyIndex();
    }
    if (typeof data.version !== 'number') data.version = CURRENT_VERSION;
    return data;
  } catch (err) {
    console.error(`[usage-store] corrupt ${fileName || DEFAULT_FILE}:`, err.message);
    return emptyIndex();
  }
}

function save(data, fileName) {
  ensureDir();
  const file = storePath(fileName);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = {
  STORE_FILE: storePath(DEFAULT_FILE),
  DEFAULT_FILE,
  storePath,
  CURRENT_VERSION,
  emptyIndex,
  load,
  save,
};
