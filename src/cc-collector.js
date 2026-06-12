/**
 * cc JSONL 增量採集器（監控 B 方案核心）。
 *
 * 做什麼：掃描 cc 的對話歷史檔（~/.claude/projects/**​/*.jsonl），逐行累加
 * 每個 session 的 token 用量（message.usage）、turn 數、model 分布、起訖時間，
 * 把「聚合索引」寫進 ~/.kabby/usage-index.json（見 usage-store.js）。
 *
 * 增量原理：jsonl 是 append-only，每個 session 索引記一個 byte offset，
 * 每次掃描只讀「上次 offset 之後的新位元組」，所以即使幾百個檔案也很快，
 * 解掉 CCHV「每次重掃量大會慢」的痛點。
 *
 * 資料結構已用實際 cc jsonl 驗證（2026-06-12）：
 *   assistant 行：{ type:'assistant', timestamp, cwd, sessionId,
 *                   message:{ model, usage:{ input_tokens, output_tokens,
 *                   cache_creation_input_tokens, cache_read_input_tokens } } }
 *   一個 user turn 可能對應多行 assistant（tool-use 迭代）→ token 逐行累加。
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const store = require('./usage-store');
const sensitive = require('./sensitive');
const pricing = require('./pricing');
const {
  PROJECTS_DIR,
  encodeCwd,
  extractText,
  stripTags,
  shorten,
} = require('./cc-history');

const NEWLINE = 0x0a;
const MAX_HITS_PER_SESSION = 200; // 索引大小護欄

function freshEntry(sessionId, file, projectDirName) {
  return {
    sessionId,
    file,
    projectDir: projectDirName,
    cwd: null,
    offset: 0,
    size: 0,
    mtimeMs: 0,
    firstTs: null,
    lastTs: null,
    summary: '',
    turns: 0,
    userMsgs: 0,
    models: {},
    tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    // per-model token 明細（含 5m/1h cache 拆分），供精確成本換算
    modelTokens: {},
    // 按日 × model token 明細（供趨勢圖 / 按日成本）：{ "YYYY-MM-DD": { turns, models:{model:tok} } }
    daily: {},
    sensitiveHits: [],
  };
}

function newTok() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0 };
}
function addTok(t, din, dout, dread, c5, c1) {
  t.input += din; t.output += dout; t.cacheRead += dread;
  t.cacheCreate5m += c5; t.cacheCreate1h += c1;
}

/** 命中敏感詞 → 記進 entry.sensitiveHits（有上限護欄）。 */
function recordHits(entry, matcher, text, role, ts) {
  if (!matcher || !text) return;
  const hits = matcher.scan(text);
  if (!hits.length) return;
  if (!entry.sensitiveHits) entry.sensitiveHits = [];
  const snippet = shorten(stripTags(text), 120);
  for (const word of hits) {
    if (entry.sensitiveHits.length >= MAX_HITS_PER_SESSION) break;
    entry.sensitiveHits.push({ ts: ts || null, role, word, snippet });
  }
}

/**
 * 把一行 jsonl 累加進 session 聚合 entry。解析失敗的行直接略過（不中斷）。
 * matcher 為 null 時跳過敏感詞偵測（零成本路徑）。
 */
function accumulateLine(entry, line, matcher) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return; // 半行 / 壞行容忍
  }
  if (!obj || typeof obj !== 'object') return;

  const ts = obj.timestamp;
  if (ts) {
    if (!entry.firstTs || ts < entry.firstTs) entry.firstTs = ts;
    if (!entry.lastTs || ts > entry.lastTs) entry.lastTs = ts;
  }
  if (obj.cwd && !entry.cwd) entry.cwd = obj.cwd;

  if (obj.type === 'assistant' && obj.message) {
    const u = obj.message.usage || {};
    const din = u.input_tokens || 0;
    const dout = u.output_tokens || 0;
    const dread = u.cache_read_input_tokens || 0;
    const cc = u.cache_creation || {};
    let c5 = cc.ephemeral_5m_input_tokens || 0;
    let c1 = cc.ephemeral_1h_input_tokens || 0;
    if (!c5 && !c1) c5 = u.cache_creation_input_tokens || 0; // 無拆分 → 當 5m
    entry.tokens.input += din;
    entry.tokens.output += dout;
    entry.tokens.cacheCreate += u.cache_creation_input_tokens || 0;
    entry.tokens.cacheRead += dread;
    entry.turns += 1;
    const m = obj.message.model;
    if (m) {
      entry.models[m] = (entry.models[m] || 0) + 1;
      if (!entry.modelTokens) entry.modelTokens = {};
      addTok(entry.modelTokens[m] || (entry.modelTokens[m] = newTok()), din, dout, dread, c5, c1);
      const day = ts ? String(ts).slice(0, 10) : 'unknown';
      if (!entry.daily) entry.daily = {};
      const d = entry.daily[day] || (entry.daily[day] = { turns: 0, models: {} });
      d.turns += 1;
      addTok(d.models[m] || (d.models[m] = newTok()), din, dout, dread, c5, c1);
    }
    if (matcher) recordHits(entry, matcher, extractText(obj.message.content), 'assistant', ts);
  } else if (obj.type === 'user' && obj.message) {
    entry.userMsgs += 1;
    const t = stripTags(extractText(obj.message.content));
    if (!entry.summary && t) entry.summary = shorten(t, 120);
    if (matcher) recordHits(entry, matcher, extractText(obj.message.content), 'user', ts);
  }
}

/**
 * 增量掃描單一 jsonl 檔，就地更新 index.sessions[sessionId]。
 * 回傳該 session entry。
 */
function scanFile(full, sessionId, projectDirName, index, matcher) {
  const stat = fs.statSync(full);
  let entry = index.sessions[sessionId];

  // 全新 / 換檔 / 被截斷（size 變小）→ 從頭重建，避免游標錯位
  if (!entry || entry.file !== full || stat.size < (entry.offset || 0)) {
    entry = freshEntry(sessionId, full, projectDirName);
  } else if (stat.size === entry.size && stat.mtimeMs === entry.mtimeMs) {
    return entry; // 無變化，跳過
  }

  const fromOffset = entry.offset || 0;
  const len = stat.size - fromOffset;

  if (len > 0) {
    const fd = fs.openSync(full, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, fromOffset);
      // 只吃到「最後一個換行」為止，留下半行不解析、游標也不前進到半行
      const lastNL = buf.lastIndexOf(NEWLINE);
      if (lastNL >= 0) {
        const text = buf.subarray(0, lastNL + 1).toString('utf8');
        for (const line of text.split('\n')) {
          if (line.trim()) accumulateLine(entry, line, matcher);
        }
        entry.offset = fromOffset + lastNL + 1;
      }
      // lastNL < 0：整段都是半行（檔案寫到一半）→ offset 不動，下次再讀
    } finally {
      fs.closeSync(fd);
    }
  }

  entry.size = stat.size;
  entry.mtimeMs = stat.mtimeMs;
  index.sessions[sessionId] = entry;
  return entry;
}

/** 掃一個 project 目錄底下所有 *.jsonl。 */
function scanDir(dir, projectDirName, index, matcher) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
    const sessionId = ent.name.replace(/\.jsonl$/, '');
    try {
      scanFile(path.join(dir, ent.name), sessionId, projectDirName, index, matcher);
    } catch (err) {
      console.error(`[cc-collector] skip ${ent.name}:`, err.message);
    }
  }
}

/** 把索引轉成對外視圖（聚合 + 排序 + 不洩漏內部游標）。 */
function buildView(index, filter) {
  let entries = Object.values(index.sessions);
  if (filter && filter.cwd) {
    const enc = encodeCwd(filter.cwd);
    entries = entries.filter((e) => e.projectDir === enc);
  }
  entries.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));

  const priceTable = pricing.load();
  const totals = {
    sessions: entries.length,
    turns: 0,
    tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    sensitiveHits: 0,
    costUsd: 0,
  };
  const perSessionCost = new Map();
  const byModelMap = {};
  const byDayMap = {};
  const sumInto = (b, tk) => {
    b.input += tk.input || 0; b.output += tk.output || 0; b.cacheRead += tk.cacheRead || 0;
    b.cacheCreate += (tk.cacheCreate5m || 0) + (tk.cacheCreate1h || 0);
  };
  for (const e of entries) {
    totals.turns += e.turns;
    totals.tokens.input += e.tokens.input;
    totals.tokens.output += e.tokens.output;
    totals.tokens.cacheCreate += e.tokens.cacheCreate;
    totals.tokens.cacheRead += e.tokens.cacheRead;
    totals.sensitiveHits += (e.sensitiveHits || []).length;
    const c = pricing.cost(e.modelTokens, priceTable).usd;
    perSessionCost.set(e.sessionId, c);
    totals.costUsd += c;

    // 按 model 聚合
    for (const [model, mt] of Object.entries(e.modelTokens || {})) {
      const b = byModelMap[model] || (byModelMap[model] =
        { model, turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0 });
      sumInto(b, mt);
      b.turns += e.models[model] || 0;
      b.costUsd += pricing.cost({ [model]: mt }, priceTable).usd;
    }
    // 按日聚合（per-day × model → 可算每日成本）
    for (const [day, d] of Object.entries(e.daily || {})) {
      const b = byDayMap[day] || (byDayMap[day] =
        { day, turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0 });
      b.turns += d.turns || 0;
      for (const mt of Object.values(d.models || {})) sumInto(b, mt);
      b.costUsd += pricing.cost(d.models, priceTable).usd;
    }
  }
  const byModel = Object.values(byModelMap).sort((a, b) => b.costUsd - a.costUsd);
  const byDay = Object.values(byDayMap).sort((a, b) => String(a.day).localeCompare(String(b.day)));

  return {
    updatedAt: index.updatedAt,
    totals,
    byModel,
    byDay,
    sessions: entries.map((e) => ({
      sessionId: e.sessionId,
      cwd: e.cwd,
      projectDir: e.projectDir,
      summary: e.summary,
      firstTs: e.firstTs,
      lastTs: e.lastTs,
      turns: e.turns,
      userMsgs: e.userMsgs,
      models: e.models,
      tokens: e.tokens,
      sizeKb: Math.round((e.size || 0) / 1024),
      sensitiveHitCount: (e.sensitiveHits || []).length,
      costUsd: perSessionCost.get(e.sessionId) || 0,
    })),
  };
}

/**
 * 把所有 session 的敏感詞命中攤平、按時間新→舊排序，供監控查詢。
 * filter.cwd 可選。回傳 { count, hits:[{ sessionId, cwd, projectDir, ts, role, word, snippet }] }。
 */
function sensitiveHits(filter) {
  const index = store.load();
  let entries = Object.values(index.sessions);
  if (filter && filter.cwd) {
    const enc = encodeCwd(filter.cwd);
    entries = entries.filter((e) => e.projectDir === enc);
  }
  const out = [];
  for (const e of entries) {
    for (const h of e.sensitiveHits || []) {
      out.push({ sessionId: e.sessionId, cwd: e.cwd, projectDir: e.projectDir, ...h });
    }
  }
  out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return { count: out.length, hits: out };
}

/** 掃全部 project（全主機所有 cc session）。回傳聚合視圖。 */
function scanAll() {
  const index = store.load();
  const matcher = sensitive.buildMatcher();
  if (fs.existsSync(PROJECTS_DIR)) {
    let dirs;
    try {
      dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    } catch {
      dirs = [];
    }
    for (const d of dirs) {
      if (d.isDirectory()) scanDir(path.join(PROJECTS_DIR, d.name), d.name, index, matcher);
    }
  }
  index.updatedAt = new Date().toISOString();
  store.save(index);
  return buildView(index);
}

/**
 * 只讀索引、不掃描，回傳聚合視圖（背景 watcher 已維護索引，查詢端點走這個最快）。
 * filter.cwd 可選，過濾單一 project。
 */
function view(filter) {
  return buildView(store.load(), filter);
}

/**
 * 砍掉索引從頭全掃（offset 歸零）。用途：套用新敏感詞庫到「既有歷史」
 * ——採集是增量的，平時只掃新行；要重審舊對話必須整個 rebuild。較重，手動觸發。
 */
function rebuildAll() {
  store.save(store.emptyIndex());
  return scanAll();
}

/** 只掃單一 cwd 對應的 project。回傳該 project 的聚合視圖。 */
function scanProject(cwd) {
  const index = store.load();
  const matcher = sensitive.buildMatcher();
  const projectDirName = encodeCwd(cwd);
  const dir = path.join(PROJECTS_DIR, projectDirName);
  if (fs.existsSync(dir)) scanDir(dir, projectDirName, index, matcher);
  index.updatedAt = new Date().toISOString();
  store.save(index);
  return buildView(index, { cwd });
}

/** 從索引（或退而求其次掃 PROJECTS_DIR）找出某 session 的 jsonl 原檔路徑。 */
function findSessionFile(sessionId) {
  const index = store.load();
  const e = index.sessions[sessionId];
  if (e && e.file && fs.existsSync(e.file)) return e.file;
  if (fs.existsSync(PROJECTS_DIR)) {
    let dirs;
    try {
      dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    } catch {
      dirs = [];
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const f = path.join(PROJECTS_DIR, d.name, sessionId + '.jsonl');
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
}

/**
 * 按需從原檔讀某 session 的完整對話（不存進索引，符合「全文按需讀」設計）。
 * 回傳 { sessionId, file, turns:[{ ts, role, text, model, tokens }] } 或 null。
 */
function readConversation(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const turns = [];
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      if (!obj || !obj.message) return;
      if (obj.type === 'user') {
        const text = stripTags(extractText(obj.message.content));
        if (text) turns.push({ ts: obj.timestamp || null, role: 'user', text });
      } else if (obj.type === 'assistant') {
        const text = stripTags(extractText(obj.message.content));
        const u = obj.message.usage || {};
        turns.push({
          ts: obj.timestamp || null,
          role: 'assistant',
          text,
          model: obj.message.model || null,
          tokens: {
            input: u.input_tokens || 0,
            output: u.output_tokens || 0,
            cacheCreate: u.cache_creation_input_tokens || 0,
            cacheRead: u.cache_read_input_tokens || 0,
          },
        });
      }
    });
    rl.on('close', () => resolve({ sessionId, file, turns }));
    rl.on('error', reject);
  });
}

module.exports = {
  scanAll,
  scanProject,
  rebuildAll,
  view,
  sensitiveHits,
  readConversation,
  findSessionFile,
  // 匯出供測試
  scanFile,
  buildView,
};
