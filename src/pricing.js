/**
 * Model 定價 → token 成本換算（監控成本估算）。
 *
 * 定價來源：claude-api skill（cached 2026-06-04），USD per 1M tokens。
 *   cache write 5m = 1.25× input、cache write 1h = 2× input、cache read = 0.1× input。
 * 用戶可在 ~/.kabby/model-prices.json 覆寫（跟其他 ~/.kabby 設定同層、不進 git）：
 *   { "version": 1, "perMillion": { "claude-opus-4-8": { "input": 5, "output": 25 }, ... } }
 * 只填 input/output 即可，cache 三種費率自動由 input 推導；要精確也可填
 * cacheWrite5m / cacheWrite1h / cacheRead 覆寫。
 *
 * 注意：成本是「估算」——cc 訂閱制實際是吃到飽月費，這裡換算的是「若走 API 計價」
 * 的等值成本，供用量對比/內部分攤參考，不是真實帳單。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// 共用定價進 repo config/（git 同步三機）；每機可用 ~/.kabby 覆寫。
const LOCAL_FILE = path.join(os.homedir(), '.kabby', 'model-prices.json');
const REPO_FILE = path.join(__dirname, '..', 'config', 'model-prices.json');
function resolveFile() {
  if (fs.existsSync(LOCAL_FILE)) return LOCAL_FILE;
  if (fs.existsSync(REPO_FILE)) return REPO_FILE;
  return null;
}

// 內建預設（USD / 1M tokens）
const DEFAULTS = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

// 未知 model id 時，用名稱含的家族字樣退而求其次
const FAMILY = [
  ['fable', { input: 10, output: 50 }],
  ['opus', { input: 5, output: 25 }],
  ['sonnet', { input: 3, output: 15 }],
  ['haiku', { input: 1, output: 5 }],
];

function load() {
  let over = {};
  const file = resolveFile();
  if (file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && data.perMillion && typeof data.perMillion === 'object') over = data.perMillion;
    } catch (err) {
      console.error('[pricing] corrupt model-prices.json:', err.message);
    }
  }
  return { ...DEFAULTS, ...over };
}

// 把 {input,output,...} 補全成五種費率
function normalize(r) {
  const input = r.input || 0;
  const output = r.output || 0;
  return {
    input,
    output,
    cacheWrite5m: r.cacheWrite5m != null ? r.cacheWrite5m : input * 1.25,
    cacheWrite1h: r.cacheWrite1h != null ? r.cacheWrite1h : input * 2,
    cacheRead: r.cacheRead != null ? r.cacheRead : input * 0.1,
  };
}

function rateFor(model, table) {
  if (!model) return null;
  if (table[model]) return normalize(table[model]);
  for (const [needle, r] of FAMILY) {
    if (model.includes(needle)) return normalize(r);
  }
  return null; // 真的不認得 → 不估成本
}

/**
 * 由 per-model token 明細算成本。
 * modelTokens: { "<model>": { input, output, cacheRead, cacheCreate5m, cacheCreate1h } }
 * 回傳 { usd, unknownModels: [...] }。
 */
function cost(modelTokens, table) {
  table = table || load();
  let usd = 0;
  const unknown = [];
  for (const [model, t] of Object.entries(modelTokens || {})) {
    const r = rateFor(model, table);
    if (!r) {
      unknown.push(model);
      continue;
    }
    usd += ((t.input || 0) * r.input
      + (t.output || 0) * r.output
      + (t.cacheRead || 0) * r.cacheRead
      + (t.cacheCreate5m || 0) * r.cacheWrite5m
      + (t.cacheCreate1h || 0) * r.cacheWrite1h) / 1e6;
  }
  return { usd, unknownModels: unknown };
}

module.exports = {
  LOCAL_FILE,
  REPO_FILE,
  resolveFile,
  DEFAULTS,
  load,
  rateFor,
  cost,
};
