/**
 * 敏感詞偵測（監控 B 方案的差異化核心：審計偵測）。
 *
 * 詞庫來源：~/.kabby/sensitive-words.json（user-level，跟 profiles.json 同層，
 * 隨時可手編、不進 git）。格式：
 *   {
 *     "version": 1,
 *     "words":    ["password", "密碼", ...],   // 字面比對（不分大小寫、含子字串）
 *     "patterns": ["sk-[A-Za-z0-9]{20,}"]       // 正規表達式（i 旗標）
 *   }
 *
 * 行為：watcher 採集到的對話文字（user + assistant）逐行比對，命中就記進
 * usage 索引的 entry.sensitiveHits。不擋、只記（審計）；即時攔輸入是另一條
 * D 方案路線（session.js write()），這裡不碰。
 *
 * 注意：詞庫改動只對「之後新採集的行」生效（採集是增量的）；要重審歷史需
 * 重置 offset 全掃，屬未來增強。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// 共用詞庫進 repo config/（git 同步三機）；每機可用 ~/.kabby 覆寫。
const LOCAL_FILE = path.join(os.homedir(), '.kabby', 'sensitive-words.json');
const REPO_FILE = path.join(__dirname, '..', 'config', 'sensitive-words.json');

// 解析順序：本機覆寫 → repo 共用 → 無
function resolveFile() {
  if (fs.existsSync(LOCAL_FILE)) return LOCAL_FILE;
  if (fs.existsSync(REPO_FILE)) return REPO_FILE;
  return null;
}

function load() {
  const file = resolveFile();
  if (!file) return { version: 1, words: [], patterns: [], blockInput: false };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return {
      version: data.version || 1,
      words: Array.isArray(data.words) ? data.words : [],
      patterns: Array.isArray(data.patterns) ? data.patterns : [],
      // D 方案：是否在輸入時即時攔截（命中就不送進 cc）。預設關。
      blockInput: data.blockInput === true,
    };
  } catch (err) {
    console.error('[sensitive] corrupt sensitive-words.json:', err.message);
    return { version: 1, words: [], patterns: [], blockInput: false };
  }
}

/**
 * 建一個 matcher。詞庫為空時回 null（= 功能休眠，採集走零成本路徑）。
 * matcher.scan(text) → 命中的詞陣列（去重）。
 */
function buildMatcher(cfg) {
  cfg = cfg || load();
  const words = (Array.isArray(cfg.words) ? cfg.words : [])
    .filter((w) => typeof w === 'string' && w.trim())
    .map((w) => w.toLowerCase());
  const patterns = [];
  for (const p of Array.isArray(cfg.patterns) ? cfg.patterns : []) {
    if (typeof p !== 'string' || !p.trim()) continue;
    try {
      patterns.push(new RegExp(p, 'i'));
    } catch (err) {
      console.error(`[sensitive] 略過無效 pattern「${p}」:`, err.message);
    }
  }
  if (!words.length && !patterns.length) return null;

  return {
    wordCount: words.length,
    patternCount: patterns.length,
    scan(text) {
      if (!text) return [];
      const hits = new Set();
      const lower = text.toLowerCase();
      for (const w of words) {
        if (lower.includes(w)) hits.add(w);
      }
      for (const re of patterns) {
        const m = text.match(re);
        if (m) hits.add(m[0]);
      }
      return [...hits];
    },
  };
}

module.exports = {
  LOCAL_FILE,
  REPO_FILE,
  resolveFile,
  load,
  buildMatcher,
};
