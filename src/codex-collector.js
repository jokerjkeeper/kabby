/**
 * Codex rollout 增量採集器（監控 Phase D — codex provider）。
 *
 * 對齊 cc-collector 的對外介面（scanAll/scanProject/view/rebuildAll/sensitiveHits/
 * readConversation/analyzeSession/findSessionFile），但解析的是 codex 的 rollout 格式
 * （~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl），索引獨立存 ~/.kabby/usage-index-codex.json。
 *
 * 與 cc 的根本差異（2026-06-30 實測）：
 *   - token 不是逐行 message.usage 相加，而是 event_msg/token_count 事件的「累計快照」：
 *       info.total_token_usage = 累計到此刻的總量（session 總量取「末筆」）
 *       info.last_token_usage  = 此事件增量（per-day / per-turn / live 用增量分組）
 *     欄位：{ input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }
 *     映射到既有 pricing 形狀：input = input - cached（未快取）、cacheRead = cached、
 *     output = output + reasoning、cacheCreate = 0。
 *   - model 來自 turn_context.model（如 "gpt-5.4"），需跨增量讀保留（entry.lastModel）。
 *   - rate_limits / model_context_window 是 codex 專屬，存末筆供前端面板用。
 *   - 對話文字走 event_msg/{user_message,agent_message}（不含注入的 <environment_context>）。
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const store = require('./usage-store');
const sensitive = require('./sensitive');
const pricing = require('./pricing');
const {
  SESSIONS_DIR,
  listSessionFiles,
  isInjectedContext,
} = require('./codex-history');
const { normalizeCwd, stripTags, stripTagsKeepLines, shorten } = require('./cc-history');

const STORE_FILE = 'usage-index-codex.json';
const NEWLINE = 0x0a;
const MAX_HITS_PER_SESSION = 200;

function freshEntry(sessionId, file) {
  return {
    sessionId,
    file,
    cwd: null,
    offset: 0,
    size: 0,
    mtimeMs: 0,
    firstTs: null,
    lastTs: null,
    lastModel: null,        // 跨增量讀保留當前 turn_context.model
    summary: '',
    turns: 0,               // task_started 數（≈ user turn）
    userMsgs: 0,
    models: {},             // { model: turn 次數 }
    tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, // 末筆累計快照映射
    totalTokenUsage: null,  // 末筆 total_token_usage 原始
    modelTokens: {},        // 增量分組（供成本）
    daily: {},              // { day: { turns, models:{model:tok} } }
    sensitiveHits: [],
    rateLimits: null,       // 末筆 rate_limits（codex 專屬）
    contextWindow: null,
  };
}

function newTok() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0 };
}
function addTok(t, m) {
  t.input += m.input; t.output += m.output; t.cacheRead += m.cacheRead;
  // codex 無 cacheCreate
}

/** codex token usage（total 或 last）→ 既有 pricing 形狀。 */
function mapUsage(u) {
  u = u || {};
  const input = Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0));
  return {
    input,
    output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0),
    cacheRead: u.cached_input_tokens || 0,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
  };
}
/** total_token_usage → entry.tokens 形狀 {input,output,cacheCreate,cacheRead}。 */
function mapTotals(u) {
  const m = mapUsage(u);
  return { input: m.input, output: m.output, cacheCreate: 0, cacheRead: m.cacheRead };
}

/** event_msg 文字（user_message / agent_message） */
function eventText(payload) {
  if (!payload) return '';
  if (typeof payload.message === 'string') return payload.message;
  if (Array.isArray(payload.message)) {
    return payload.message.map((p) => (p && p.text) || '').join(' ');
  }
  return '';
}

function recordHits(entry, matcher, text, role, ts) {
  if (!matcher || !text) return;
  const hits = matcher.scan(text);
  if (!hits.length) return;
  const snippet = shorten(stripTags(text), 120);
  for (const word of hits) {
    if (entry.sensitiveHits.length >= MAX_HITS_PER_SESSION) break;
    entry.sensitiveHits.push({ ts: ts || null, role, word, snippet });
  }
}

/** 把一行 codex rollout jsonl 累加進 entry。 */
function accumulateLine(entry, line, matcher) {
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj || typeof obj !== 'object') return;

  const ts = obj.timestamp;
  if (ts) {
    if (!entry.firstTs || ts < entry.firstTs) entry.firstTs = ts;
    if (!entry.lastTs || ts > entry.lastTs) entry.lastTs = ts;
  }
  const p = obj.payload || {};

  if (obj.type === 'session_meta') {
    if (p.cwd && !entry.cwd) entry.cwd = p.cwd;
    if (p.timestamp && !entry.firstTs) entry.firstTs = p.timestamp;
    return;
  }
  if (obj.type === 'turn_context') {
    if (p.model) entry.lastModel = p.model;
    return;
  }
  if (obj.type !== 'event_msg') return;

  const day = ts ? String(ts).slice(0, 10) : 'unknown';

  if (p.type === 'task_started') {
    entry.turns += 1;
    const d = entry.daily[day] || (entry.daily[day] = { turns: 0, models: {} });
    d.turns += 1;
    return;
  }
  if (p.type === 'user_message') {
    const text = eventText(p);
    if (text && !isInjectedContext(text)) {
      if (!entry.summary) entry.summary = shorten(stripTags(text), 120);
      entry.userMsgs += 1;
      if (matcher) recordHits(entry, matcher, text, 'user', ts);
    }
    return;
  }
  if (p.type === 'agent_message') {
    if (matcher) recordHits(entry, matcher, eventText(p), 'assistant', ts);
    return;
  }
  if (p.type === 'token_count') {
    const info = p.info || {};
    // 累計快照 → session 總量（覆寫）
    if (info.total_token_usage) {
      entry.totalTokenUsage = info.total_token_usage;
      entry.tokens = mapTotals(info.total_token_usage);
    }
    if (info.model_context_window) entry.contextWindow = info.model_context_window;
    if (p.rate_limits) entry.rateLimits = p.rate_limits;
    // 增量分組 → modelTokens / daily（供 byModel/byDay 成本）
    const model = entry.lastModel || 'codex';
    const delta = mapUsage(info.last_token_usage);
    entry.models[model] = (entry.models[model] || 0) + 1;
    addTok(entry.modelTokens[model] || (entry.modelTokens[model] = newTok()), delta);
    const d = entry.daily[day] || (entry.daily[day] = { turns: 0, models: {} });
    addTok(d.models[model] || (d.models[model] = newTok()), delta);
  }
}

/** 增量掃描單一 rollout 檔。sessionId 由 session_meta.id 決定（呼叫端先讀）。 */
function scanFile(full, sessionId, index) {
  const stat = fs.statSync(full);
  const matcher = sensitive.buildMatcher();
  let entry = index.sessions[sessionId];

  if (!entry || entry.file !== full || stat.size < (entry.offset || 0)) {
    entry = freshEntry(sessionId, full);
  } else if (stat.size === entry.size && stat.mtimeMs === entry.mtimeMs) {
    return entry;
  }

  const fromOffset = entry.offset || 0;
  const len = stat.size - fromOffset;
  if (len > 0) {
    const fd = fs.openSync(full, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, fromOffset);
      const lastNL = buf.lastIndexOf(NEWLINE);
      if (lastNL >= 0) {
        const text = buf.subarray(0, lastNL + 1).toString('utf8');
        for (const line of text.split('\n')) {
          if (line.trim()) accumulateLine(entry, line, matcher);
        }
        entry.offset = fromOffset + lastNL + 1;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  entry.size = stat.size;
  entry.mtimeMs = stat.mtimeMs;
  index.sessions[sessionId] = entry;
  return entry;
}

/** 讀某 rollout 檔首行 session_meta，取 sessionId。掃描入口用。 */
function sessionIdOf(file) {
  try {
    const first = fs.readFileSync(file, 'utf8').split(/\r?\n/, 1)[0];
    if (!first) return null;
    const obj = JSON.parse(first);
    if (obj && obj.type === 'session_meta' && obj.payload && obj.payload.id) return obj.payload.id;
  } catch {}
  return null;
}

function scanAllFiles(index) {
  const files = listSessionFiles(SESSIONS_DIR);
  for (const file of files) {
    const sessionId = sessionIdOf(file);
    if (!sessionId) continue;
    try { scanFile(file, sessionId, index); }
    catch (err) { console.error(`[codex-collector] skip ${path.basename(file)}:`, err.message); }
  }
}

// ── buildView（聚合，對齊 cc-collector 的對外結構 + codex 專屬 rateLimits） ──
function sumInto(b, tk) {
  b.input += tk.input || 0; b.output += tk.output || 0; b.cacheRead += tk.cacheRead || 0;
  b.cacheCreate += (tk.cacheCreate5m || 0) + (tk.cacheCreate1h || 0);
}

function buildView(index, filter) {
  let entries = Object.values(index.sessions);
  if (filter && filter.cwd) {
    const want = normalizeCwd(filter.cwd);
    entries = entries.filter((e) => e.cwd && normalizeCwd(e.cwd) === want);
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
  let latestRateLimits = null, latestRateTs = '';

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

    for (const [model, mt] of Object.entries(e.modelTokens || {})) {
      const b = byModelMap[model] || (byModelMap[model] =
        { model, turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0 });
      sumInto(b, mt);
      b.turns += e.models[model] || 0;
      b.costUsd += pricing.cost({ [model]: mt }, priceTable).usd;
    }
    for (const [day, d] of Object.entries(e.daily || {})) {
      const b = byDayMap[day] || (byDayMap[day] =
        { day, turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0 });
      b.turns += d.turns || 0;
      for (const mt of Object.values(d.models || {})) sumInto(b, mt);
      b.costUsd += pricing.cost(d.models, priceTable).usd;
    }
    // 帳號級 rate_limits：取最近活動 session 的末筆
    if (e.rateLimits && String(e.lastTs || '') >= latestRateTs) {
      latestRateLimits = e.rateLimits; latestRateTs = String(e.lastTs || '');
    }
  }
  const byModel = Object.values(byModelMap).sort((a, b) => b.costUsd - a.costUsd);
  const byDay = Object.values(byDayMap).sort((a, b) => String(a.day).localeCompare(String(b.day)));

  return {
    provider: 'codex',
    updatedAt: index.updatedAt,
    totals,
    byModel,
    byDay,
    rateLimits: latestRateLimits,   // codex 專屬
    sessions: entries.map((e) => ({
      sessionId: e.sessionId,
      cwd: e.cwd,
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
      contextWindow: e.contextWindow || null,
    })),
  };
}

function sensitiveHits(filter) {
  const index = store.load(STORE_FILE);
  let entries = Object.values(index.sessions);
  if (filter && filter.cwd) {
    const want = normalizeCwd(filter.cwd);
    entries = entries.filter((e) => e.cwd && normalizeCwd(e.cwd) === want);
  }
  const out = [];
  for (const e of entries) {
    for (const h of e.sensitiveHits || []) {
      out.push({ sessionId: e.sessionId, cwd: e.cwd, ...h });
    }
  }
  out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return { count: out.length, hits: out };
}

function scanAll() {
  const index = store.load(STORE_FILE);
  if (fs.existsSync(SESSIONS_DIR)) scanAllFiles(index);
  index.updatedAt = new Date().toISOString();
  store.save(index, STORE_FILE);
  return buildView(index);
}

function view(filter) {
  return buildView(store.load(STORE_FILE), filter);
}

function rebuildAll() {
  store.save(store.emptyIndex(), STORE_FILE);
  return scanAll();
}

/** codex 沒有 encodeCwd 單層目錄，scanProject 等同 scanAll 後按 cwd 過濾。 */
function scanProject(cwd) {
  const index = store.load(STORE_FILE);
  if (fs.existsSync(SESSIONS_DIR)) scanAllFiles(index);
  index.updatedAt = new Date().toISOString();
  store.save(index, STORE_FILE);
  return buildView(index, { cwd });
}

function findSessionFile(sessionId) {
  const index = store.load(STORE_FILE);
  const e = index.sessions[sessionId];
  if (e && e.file && fs.existsSync(e.file)) return e.file;
  for (const file of listSessionFiles(SESSIONS_DIR)) {
    if (sessionIdOf(file) === sessionId) return file;
  }
  return null;
}

/** 按需讀完整對話（turns:[{ts,role,text,model}]）。 */
function readConversation(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const turns = [];
    let model = null;
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let obj; try { obj = JSON.parse(line); } catch { return; }
      if (!obj) return;
      const p = obj.payload || {};
      if (obj.type === 'turn_context' && p.model) { model = p.model; return; }
      // 工具呼叫是獨立的 response_item（非 event_msg）→ 掛到「上一則 assistant 輪」（下決策的那輪）；
      // 若前面還沒有 assistant 輪則自建一個純工具輪。
      if (obj.type === 'response_item') {
        let tool = null;
        if (p.type === 'function_call') tool = { name: p.name || 'tool', hint: toolHintFromArgs(p.arguments) };
        else if (p.type === 'custom_tool_call') tool = { name: p.name || 'tool', hint: toolHintFromArgs(p.input) };
        else if (p.type === 'web_search_call') tool = { name: 'web_search', hint: '' };
        if (tool) {
          const last = turns[turns.length - 1];
          if (last && last.role === 'assistant') last.tools.push(tool);
          else turns.push({ ts: obj.timestamp || null, role: 'assistant', text: '', model, tools: [tool] });
        }
        return;
      }
      if (obj.type !== 'event_msg') return;
      if (p.type === 'user_message') {
        const text = stripTagsKeepLines(eventText(p));
        if (text && !isInjectedContext(text)) turns.push({ ts: obj.timestamp || null, role: 'user', text });
      } else if (p.type === 'agent_message') {
        const text = stripTagsKeepLines(eventText(p));
        if (text) turns.push({ ts: obj.timestamp || null, role: 'assistant', text, model, tools: [] });
      }
    });
    rl.on('close', () => resolve({ sessionId, file, turns }));
    rl.on('error', reject);
  });
}

// ── 單 session 成本歸因（live 面板）：以 task_started..task_complete 切 turn ──
const COST_W = { input: 1, output: 5, cacheCreate: 1.25, cacheRead: 0.1 };
function unitsOf(tk) {
  return tk.input * COST_W.input + tk.output * COST_W.output
    + tk.cacheCreate * COST_W.cacheCreate + tk.cacheRead * COST_W.cacheRead;
}
function toolHintFromArgs(raw) {
  if (!raw) return '';
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const h = a.command || a.file_path || a.path || a.pattern || a.query || a.url || '';
    return String(Array.isArray(h) ? h.join(' ') : h).replace(/\s+/g, ' ').slice(0, 60);
  } catch {
    return String(raw).replace(/\s+/g, ' ').slice(0, 60);
  }
}

function buildAnalysis(sessionId, file, turns) {
  const priceTable = pricing.load();
  const rates = {};
  for (const r of turns) {
    r.units = unitsOf(r.tokens);
    r.costUsd = pricing.cost({ [r.model || '?']: {
      input: r.tokens.input, output: r.tokens.output, cacheRead: r.tokens.cacheRead,
      cacheCreate5m: 0, cacheCreate1h: 0,
    } }, priceTable).usd;
    if (r.model && !rates[r.model]) {
      const rr = pricing.rateFor(r.model, priceTable);
      if (rr) rates[r.model] = rr;
    }
  }
  const total = turns.reduce((s, r) => s + r.units, 0) || 1;
  const costUsd = turns.reduce((s, r) => s + r.costUsd, 0);
  for (const r of turns) r.pct = r.units / total;

  const split = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  const toolCounts = {};
  for (const r of turns) {
    split.input += r.tokens.input * COST_W.input;
    split.output += r.tokens.output * COST_W.output;
    split.cacheRead += r.tokens.cacheRead * COST_W.cacheRead;
    for (const t of r.tools) toolCounts[t.name] = (toolCounts[t.name] || 0) + 1;
  }
  const slim = (r) => ({
    order: r.order, ts: r.ts, model: r.model, tokens: r.tokens,
    units: Math.round(r.units), pct: r.pct, costUsd: r.costUsd, tools: r.tools, thinking: r.thinking,
  });
  const topByUnits = [...turns].sort((a, b) => b.units - a.units).slice(0, 10).map(slim);
  const topByOutput = [...turns].sort((a, b) => b.tokens.output - a.tokens.output).slice(0, 5).map(slim);

  return {
    sessionId, file, provider: 'codex',
    requests: turns.length,
    weights: COST_W,
    totalUnits: Math.round(total),
    costUsd, rates, split, toolCounts,
    topByUnits, topByOutput, topByCacheCreate: [],
    turns: turns.map(slim),
    findings: diagnose(turns, split, total),
  };
}

function diagnose(turns, split, total) {
  const findings = [];
  if (!turns.length) {
    findings.push({ type: 'empty', level: 'info', title: '尚無逐輪資料', detail: '這個 codex session 還沒有可分析的 token_count。' });
    return findings;
  }
  const outShare = split.output / total;
  if (outShare >= 0.5) {
    findings.push({ type: 'verbose', level: 'info', title: '輸出/推理偏多',
      detail: `output(含 reasoning) 佔成本 ${(outShare * 100).toFixed(0)}%。codex reasoning token 算進 output 計費。` });
  }
  if (!findings.length) {
    findings.push({ type: 'ok', level: 'ok', title: '用量分布正常', detail: '沒有明顯的單輪異常。' });
  }
  return findings;
}

function analyzeSession(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const turns = [];
    let cur = null, order = 0, model = null;
    const closeTurn = () => { if (cur) { turns.push(cur); cur = null; } };
    const ensureTurn = (ts) => {
      if (!cur) cur = { order: order++, ts, model, tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, tools: [], thinking: false };
      return cur;
    };
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let obj; try { obj = JSON.parse(line); } catch { return; }
      if (!obj) return;
      const p = obj.payload || {};
      if (obj.type === 'turn_context') { if (p.model) model = p.model; if (cur) cur.model = model; return; }
      if (obj.type === 'response_item') {
        if (p.type === 'function_call') ensureTurn(obj.timestamp).tools.push({ name: p.name || 'tool', hint: toolHintFromArgs(p.arguments) });
        else if (p.type === 'custom_tool_call') ensureTurn(obj.timestamp).tools.push({ name: p.name || 'tool', hint: toolHintFromArgs(p.input) });
        else if (p.type === 'web_search_call') ensureTurn(obj.timestamp).tools.push({ name: 'web_search', hint: '' });
        else if (p.type === 'reasoning') ensureTurn(obj.timestamp).thinking = true;
        return;
      }
      if (obj.type !== 'event_msg') return;
      if (p.type === 'task_started') { closeTurn(); ensureTurn(obj.timestamp); }
      else if (p.type === 'task_complete' || p.type === 'turn_aborted') closeTurn();
      else if (p.type === 'token_count') {
        const r = ensureTurn(obj.timestamp);
        const m = mapUsage((p.info || {}).last_token_usage);
        r.tokens.input += m.input; r.tokens.output += m.output; r.tokens.cacheRead += m.cacheRead;
        if (!r.model) r.model = model;
      }
    });
    rl.on('close', () => { closeTurn(); resolve(buildAnalysis(sessionId, file, turns)); });
    rl.on('error', reject);
  });
}

module.exports = {
  STORE_FILE,
  scanAll,
  scanProject,
  rebuildAll,
  view,
  sensitiveHits,
  readConversation,
  analyzeSession,
  findSessionFile,
  // 測試用
  scanFile,
  buildView,
  buildAnalysis,
  accumulateLine,
  freshEntry,
  mapUsage,
};
