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
    // 去重游標：一次 API 回應(同 requestId)會被 cc 按 content block 拆成多行寫入,
    // 每行重貼「相同的整包 usage」。記住上一個 requestId,同 request 的後續行只計一次,
    // 避免 token / turns 被 2~3x 灌水（與 ccusage 的 messageId:requestId 去重對齊）。
    // 跨檔重複（resume/compact 複製舊訊息）僅佔 ~0.6%,不在此處理,屬已知餘差。
    lastRequestId: null,
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
    // 敏感詞掃描：每行各自的 content block 不同（thinking / text / tool_use），
    // 必須逐行全掃才完整,因此放在去重判斷「之前」。
    if (matcher) recordHits(entry, matcher, extractText(obj.message.content), 'assistant', ts);

    // 同一 requestId 的後續行（其他 content block）→ usage 已在第一行計過,跳過累加。
    // requestId 缺失（舊版 cc 格式）時不去重,維持逐行計（與既有測試行為一致）。
    const rid = obj.requestId || null;
    if (rid && rid === entry.lastRequestId) return;
    if (rid) entry.lastRequestId = rid;

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

// ──────────────────────────────────────────────────────────────────────────
// 單 session 成本歸因（drill-down）
//
// 目的：回答「這個 session 為什麼貴 / 誰把 token 吃掉的」。
// 做法：讀全檔,把同一 requestId 的多個 content-block 行收斂成「一個回應」,
//       用相對成本單位排序（相對單位用於歸因排序;精確金額由 pricing.js 負責）：
//         input 1× / cacheRead 0.1× / cacheCreate 1.25× / output 5×
//       再從每一行收集 tool_use（工具呼叫散在不同 block 行）與 thinking 標記,
//       最後產生診斷（長 session 稅 / 吞大檔 / 囉嗦）。
// ──────────────────────────────────────────────────────────────────────────
const COST_W = { input: 1, output: 5, cacheCreate: 1.25, cacheRead: 0.1 };

function unitsOf(tk) {
  return tk.input * COST_W.input + tk.output * COST_W.output
    + tk.cacheCreate * COST_W.cacheCreate + tk.cacheRead * COST_W.cacheRead;
}

/** 從 tool_use input 取一段可讀提示（檔名 / 指令 / 樣式…）。 */
function toolHint(input) {
  if (!input || typeof input !== 'object') return '';
  const h = input.file_path || input.command || input.pattern || input.path
    || input.url || input.description || input.prompt || '';
  return String(h).replace(/\s+/g, ' ').slice(0, 60);
}

/** 把一個 session 的全部回應記錄聚成分析結果（純函數,供測試）。 */
function buildAnalysis(sessionId, file, reqs) {
  reqs.sort((a, b) => a.order - b.order);
  // 每輪相對單位(歸因排序) + 真實 $ (pricing.js,含 5m/1h 寫入費率差異)
  const priceTable = pricing.load();
  const rates = {};
  for (const r of reqs) {
    r.units = unitsOf(r.tokens);
    r.costUsd = pricing.cost({ [r.model || '?']: {
      input: r.tokens.input, output: r.tokens.output, cacheRead: r.tokens.cacheRead,
      cacheCreate5m: r.cw5 || 0, cacheCreate1h: r.cw1 || 0,
    } }, priceTable).usd;
    if (r.model && !rates[r.model]) {
      const rr = pricing.rateFor(r.model, priceTable);
      if (rr) rates[r.model] = rr;
    }
  }
  const total = reqs.reduce((s, r) => s + r.units, 0) || 1;
  const costUsd = reqs.reduce((s, r) => s + r.costUsd, 0);
  for (const r of reqs) r.pct = r.units / total;

  const split = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  const rawSplit = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  const toolCounts = {};
  for (const r of reqs) {
    split.input += r.tokens.input * COST_W.input;
    split.output += r.tokens.output * COST_W.output;
    split.cacheCreate += r.tokens.cacheCreate * COST_W.cacheCreate;
    split.cacheRead += r.tokens.cacheRead * COST_W.cacheRead;
    rawSplit.input += r.tokens.input; rawSplit.output += r.tokens.output;
    rawSplit.cacheCreate += r.tokens.cacheCreate; rawSplit.cacheRead += r.tokens.cacheRead;
    for (const t of r.tools) toolCounts[t.name] = (toolCounts[t.name] || 0) + 1;
  }

  const slim = (r) => ({
    order: r.order, ts: r.ts, model: r.model, tokens: r.tokens,
    units: Math.round(r.units), pct: r.pct, costUsd: r.costUsd, tools: r.tools, thinking: r.thinking,
  });
  const topByUnits = [...reqs].sort((a, b) => b.units - a.units).slice(0, 10).map(slim);
  const topByOutput = [...reqs].sort((a, b) => b.tokens.output - a.tokens.output).slice(0, 5).map(slim);
  const topByCacheCreate = [...reqs].sort((a, b) => b.tokens.cacheCreate - a.tokens.cacheCreate).slice(0, 5).map(slim);

  return {
    sessionId, file,
    requests: reqs.length,
    weights: COST_W,
    totalUnits: Math.round(total),
    costUsd,   // 此 session(此檔,已去重)的等值 API 成本
    rates,     // 各 model 的費率表(供前端費率參考)
    split, rawSplit, toolCounts,
    topByUnits, topByOutput, topByCacheCreate,
    // 全輪明細(oldest-first),供 live 逐輪視圖。前端自行 reverse 顯示,並用
    // turns[i-1].tools 算出「本輪 cacheCreate ← 上一輪工具的結果被 ingest」。
    turns: reqs.map(slim),
    findings: diagnose(reqs, split, total, topByUnits),
  };
}

/** 規則式診斷:把常見的「貴法」翻成人話。 */
function diagnose(reqs, split, total, topByUnits) {
  const findings = [];
  if (!reqs.length) return findings;
  const n = reqs.length;
  const topShare = topByUnits.length ? topByUnits[0].pct : 0;
  const crShare = split.cacheRead / total;
  const outShare = split.output / total;

  // 長 session 稅:輪數多 + cacheRead 主導成本 + 沒有單一高峰輪
  if (n >= 25 && crShare >= 0.45 && topShare < 0.10) {
    findings.push({
      type: 'long-session', level: 'warn', title: '長 session 稅',
      detail: `共 ${n} 輪,context 養大後每輪都把整包重讀一次（cacheRead 佔成本 ${(crShare * 100).toFixed(0)}%），沒有單一兇手輪。建議早點 /compact 或拆成多個短 session。`,
    });
  }
  // 吞大檔:某輪 cacheCreate 遠高於中位數
  const cws = reqs.map((r) => r.tokens.cacheCreate).filter((x) => x > 0).sort((a, b) => a - b);
  if (cws.length) {
    const med = cws[Math.floor(cws.length / 2)];
    const top = reqs.reduce((m, r) => (r.tokens.cacheCreate > m.tokens.cacheCreate ? r : m));
    if (med > 0 && top.tokens.cacheCreate >= Math.max(8000, med * 6)) {
      // 歸因:本輪 cacheCreate 是「上一輪工具的結果」被 ingest 進 context,
      // 所以兇手是上一輪(reqs 已按 order 排序,order===index)的工具,而非本輪。
      const prev = reqs[top.order - 1];
      const tool = (prev && prev.tools[0]) || top.tools[0];
      const where = prev ? `第 ${prev.order + 1} 輪` : `第 ${top.order + 1} 輪`;
      findings.push({
        type: 'big-ingest', level: 'warn', title: '某輪吞入大量內容',
        detail: `第 ${top.order + 1} 輪一次寫入 ${top.tokens.cacheCreate.toLocaleString()} cacheCreate token（中位數 ${med.toLocaleString()}）${tool ? `，來源是${where}的 ${tool.name}${tool.hint ? ' ' + tool.hint : ''} 結果` : ''}。常見原因:讀大檔 / 把大段輸出塞進 context。`,
      });
    }
  }
  // 囉嗦:output 佔成本偏高（output 單價最貴 5×）
  if (outShare >= 0.35) {
    const top = reqs.reduce((m, r) => (r.tokens.output > m.tokens.output ? r : m));
    findings.push({
      type: 'verbose', level: 'info', title: '模型輸出偏多',
      detail: `Output 佔成本 ${(outShare * 100).toFixed(0)}%（最貴單輪 ${top.tokens.output.toLocaleString()} token）。output 單價最高（5×），可在 prompt 約束「精簡、勿整段貼代碼」。`,
    });
  }
  if (!findings.length) {
    findings.push({ type: 'ok', level: 'ok', title: '用量分布正常', detail: '沒有明顯的單輪異常或長 session 稅。' });
  }
  return findings;
}

/**
 * 讀某 session 原檔,做成本歸因分析。回傳 buildAnalysis 結果,或 null（找不到檔）。
 * 與 collector 一致:同 requestId 的多行只算一次 usage,但工具/thinking 從每行收集。
 */
function analyzeSession(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const byReq = new Map(); // requestId(或 uuid fallback) -> 回應記錄
    let order = 0;
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      if (!obj || obj.type !== 'assistant' || !obj.message) return;
      const rid = obj.requestId || ('uuid:' + obj.uuid);
      let r = byReq.get(rid);
      if (!r) {
        const u = obj.message.usage || {};
        const cc = u.cache_creation || {};
        let c5 = cc.ephemeral_5m_input_tokens || 0;
        let c1 = cc.ephemeral_1h_input_tokens || 0;
        if (!c5 && !c1) c5 = u.cache_creation_input_tokens || 0; // 無拆分→當 5m
        r = {
          order: order++,
          ts: obj.timestamp || null,
          model: obj.message.model || null,
          tokens: {
            input: u.input_tokens || 0,
            output: u.output_tokens || 0,
            cacheCreate: u.cache_creation_input_tokens || 0,
            cacheRead: u.cache_read_input_tokens || 0,
          },
          cw5: c5, cw1: c1, // 供精確成本(5m/1h 寫入費率不同)
          tools: [],
          thinking: false,
        };
        byReq.set(rid, r);
      }
      // tool_use 與 thinking 散在同一回應的不同 content-block 行 → 逐行收集
      const content = obj.message.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'tool_use') r.tools.push({ name: b.name || '?', hint: toolHint(b.input) });
          else if (b.type === 'thinking') r.thinking = true;
        }
      }
    });
    rl.on('close', () => resolve(buildAnalysis(sessionId, file, [...byReq.values()])));
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
  analyzeSession,
  findSessionFile,
  // 匯出供測試
  scanFile,
  buildView,
  buildAnalysis,
};
