/**
 * cc-collector 測試（不需 daemon 在跑）：
 *   A. 增量正確性（temp 檔）：逐行累加、重掃不重複計、半行不誤吞、offset 前進
 *   B. 整合 sanity：對真實 kabby cwd 跑 scanProject，印聚合給人眼確認
 *
 * 跑法：node test/usage-collector.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanFile, buildView } = require('../src/cc-collector');
const sensitive = require('../src/sensitive');
const pricing = require('../src/pricing');

function asstLine(ts, model, usage) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    cwd: 'D:\\Git\\demo',
    sessionId: 'sess-A',
    message: { model, role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage },
  });
}
function userLine(ts, text) {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    cwd: 'D:\\Git\\demo',
    sessionId: 'sess-A',
    message: { role: 'user', content: text },
  });
}

function run() {
  // ── A. 增量正確性 ──────────────────────────────────────────────
  const tmp = path.join(os.tmpdir(), `kabby-collector-${process.pid}.jsonl`);
  const u = (i, o, cc, cr) => ({
    input_tokens: i, output_tokens: o,
    cache_creation_input_tokens: cc, cache_read_input_tokens: cr,
  });

  // 第一批：1 user + 2 assistant（一個 turn 多行 assistant 的情境）
  fs.writeFileSync(tmp, [
    userLine('2026-06-12T00:00:00Z', 'hello there'),
    asstLine('2026-06-12T00:00:01Z', 'claude-opus-4-8', u(10, 20, 100, 200)),
    asstLine('2026-06-12T00:00:02Z', 'claude-opus-4-8', u(5, 8, 0, 300)),
    '',
  ].join('\n'), 'utf8');

  const index = { version: 1, updatedAt: null, sessions: {} };
  let e = scanFile(tmp, 'sess-A', 'D--Git-demo', index);

  assert.strictEqual(e.turns, 2, 'turns 應為 2（兩行 assistant）');
  assert.strictEqual(e.userMsgs, 1, 'userMsgs 應為 1');
  assert.strictEqual(e.tokens.input, 15, 'input 累加 10+5');
  assert.strictEqual(e.tokens.output, 28, 'output 累加 20+8');
  assert.strictEqual(e.tokens.cacheCreate, 100, 'cacheCreate 累加');
  assert.strictEqual(e.tokens.cacheRead, 500, 'cacheRead 累加 200+300');
  assert.strictEqual(e.models['claude-opus-4-8'], 2, 'model 計數');
  assert.strictEqual(e.modelTokens['claude-opus-4-8'].input, 15, 'modelTokens input 累加');
  assert.strictEqual(e.modelTokens['claude-opus-4-8'].output, 28, 'modelTokens output 累加');
  assert.strictEqual(e.modelTokens['claude-opus-4-8'].cacheCreate5m, 100, 'modelTokens cacheCreate5m（無拆分→當5m）');
  assert.strictEqual(e.summary, 'hello there', 'summary 取第一則 user');
  assert.strictEqual(e.firstTs, '2026-06-12T00:00:00Z');
  assert.strictEqual(e.lastTs, '2026-06-12T00:00:02Z');
  const offsetAfter1 = e.offset;
  assert.strictEqual(offsetAfter1, fs.statSync(tmp).size, 'offset 應到 EOF（最後是換行）');

  // 重掃（檔案沒變）→ 不應重複計
  e = scanFile(tmp, 'sess-A', 'D--Git-demo', index);
  assert.strictEqual(e.turns, 2, '重掃不重複計 turns');
  assert.strictEqual(e.tokens.input, 15, '重掃不重複計 tokens');

  // 追加「半行」（沒有換行）→ 不應被吞、offset 不前進
  fs.appendFileSync(tmp, asstLine('2026-06-12T00:00:03Z', 'claude-opus-4-8', u(1, 1, 0, 0)), 'utf8');
  e = scanFile(tmp, 'sess-A', 'D--Git-demo', index);
  assert.strictEqual(e.turns, 2, '半行不計入');
  assert.strictEqual(e.offset, offsetAfter1, '半行時 offset 不前進');

  // 補上換行 + 再一行 → 之前那半行現在成完整行，應 +1（不是 +2，不重複）
  fs.appendFileSync(tmp, '\n', 'utf8');
  e = scanFile(tmp, 'sess-A', 'D--Git-demo', index);
  assert.strictEqual(e.turns, 3, '補換行後該行計入（增量 +1）');
  assert.strictEqual(e.tokens.input, 16, 'tokens 增量 +1');

  // 檔案被截斷（size 變小）→ 從頭重建，不應算出負數或錯位
  fs.writeFileSync(tmp, userLine('2026-06-12T01:00:00Z', 'reset') + '\n', 'utf8');
  e = scanFile(tmp, 'sess-A', 'D--Git-demo', index);
  assert.strictEqual(e.turns, 0, '截斷後重建 turns 歸零');
  assert.strictEqual(e.tokens.input, 0, '截斷後重建 tokens 歸零');
  assert.strictEqual(e.summary, 'reset', '截斷後重抓 summary');

  fs.unlinkSync(tmp);
  console.log('✓ A. 增量正確性全部通過（累加 / 重掃不重複 / 半行安全 / 截斷重建）');

  // buildView 過濾 + 聚合
  const idx2 = {
    version: 1, updatedAt: 'X',
    sessions: {
      a: { sessionId: 'a', projectDir: 'D--Git-demo', cwd: 'D:\\Git\\demo', summary: '', firstTs: '1', lastTs: '3', turns: 2, userMsgs: 1, models: {}, tokens: { input: 10, output: 5, cacheCreate: 0, cacheRead: 0 }, size: 2048 },
      b: { sessionId: 'b', projectDir: 'D--Git-other', cwd: 'D:\\Git\\other', summary: '', firstTs: '2', lastTs: '5', turns: 1, userMsgs: 1, models: {}, tokens: { input: 3, output: 2, cacheCreate: 0, cacheRead: 0 }, size: 1024 },
    },
  };
  const all = buildView(idx2);
  assert.strictEqual(all.totals.sessions, 2);
  assert.strictEqual(all.totals.tokens.input, 13, '全域 input 聚合');
  assert.strictEqual(all.sessions[0].sessionId, 'b', 'lastTs 新的排前面');
  const filtered = buildView(idx2, { cwd: 'D:\\Git\\demo' });
  assert.strictEqual(filtered.totals.sessions, 1, 'cwd 過濾只剩一個 project');
  assert.strictEqual(filtered.sessions[0].sizeKb, 2, 'sizeKb = round(2048/1024)');
  console.log('✓ buildView 聚合 / 排序 / cwd 過濾通過');

  // ── C. 敏感詞偵測 ──────────────────────────────────────────────
  // matcher：字面詞（不分大小寫）+ regex pattern；詞庫為空回 null
  assert.strictEqual(sensitive.buildMatcher({ words: [], patterns: [] }), null, '空詞庫應回 null');
  const m = sensitive.buildMatcher({ words: ['password', '密碼'], patterns: ['sk-[a-z0-9]{6,}'] });
  assert.deepStrictEqual(m.scan('my PASSWORD is 123'), ['password'], '字面命中、不分大小寫');
  assert.deepStrictEqual(m.scan('我的密碼很長'), ['密碼'], '中文字面命中');
  assert.deepStrictEqual(m.scan('key sk-abc123 here'), ['sk-abc123'], 'regex pattern 命中');
  assert.deepStrictEqual(m.scan('nothing here'), [], '無命中回空陣列');

  // accumulateLine 帶 matcher → 命中記進 entry.sensitiveHits
  const tmp2 = path.join(os.tmpdir(), `kabby-collector-sw-${process.pid}.jsonl`);
  fs.writeFileSync(tmp2, [
    userLine('2026-06-12T02:00:00Z', 'my password is hunter2'),
    asstLine('2026-06-12T02:00:01Z', 'claude-opus-4-8', u(1, 1, 0, 0)),
    '',
  ].join('\n'), 'utf8');
  const idx3 = { version: 1, updatedAt: null, sessions: {} };
  const e3 = scanFile(tmp2, 'sess-SW', 'D--Git-demo', idx3, m);
  assert.strictEqual(e3.sensitiveHits.length, 1, '命中 1 筆敏感詞');
  assert.strictEqual(e3.sensitiveHits[0].word, 'password');
  assert.strictEqual(e3.sensitiveHits[0].role, 'user');
  assert.ok(e3.sensitiveHits[0].snippet.includes('hunter2'), 'snippet 帶上下文');
  // 沒帶 matcher → 不偵測（零成本路徑）
  const idx4 = { version: 1, updatedAt: null, sessions: {} };
  const e4 = scanFile(tmp2, 'sess-SW', 'D--Git-demo', idx4);
  assert.strictEqual((e4.sensitiveHits || []).length, 0, '無 matcher 不偵測');
  fs.unlinkSync(tmp2);
  // buildView 聚合 hit 數
  const view3 = buildView(idx3);
  assert.strictEqual(view3.totals.sensitiveHits, 1, 'totals.sensitiveHits 聚合');
  assert.strictEqual(view3.sessions[0].sensitiveHitCount, 1, 'session.sensitiveHitCount');
  console.log('✓ C. 敏感詞偵測通過（字面/中文/regex/不分大小寫 + 記錄 + 聚合 + 零成本路徑）');

  // ── D. 定價 / 成本換算 ─────────────────────────────────────────
  // opus 預設：in 5 / out 25 / cacheWrite5m 6.25 / cacheWrite1h 10 / cacheRead 0.5（每 1M）
  const r = pricing.rateFor('claude-opus-4-8', pricing.load());
  assert.strictEqual(r.input, 5);
  assert.strictEqual(r.output, 25);
  assert.strictEqual(r.cacheWrite5m, 6.25, '5m = 1.25× input');
  assert.strictEqual(r.cacheWrite1h, 10, '1h = 2× input');
  assert.strictEqual(r.cacheRead, 0.5, 'read = 0.1× input');
  // 1M 各類 token → 預期 5+25+0.5+6.25+10 = 46.75
  const c1 = pricing.cost({ 'claude-opus-4-8': { input: 1e6, output: 1e6, cacheRead: 1e6, cacheCreate5m: 1e6, cacheCreate1h: 1e6 } });
  assert.ok(Math.abs(c1.usd - 46.75) < 1e-9, `opus 全類 1M = $46.75，得 ${c1.usd}`);
  assert.strictEqual(c1.unknownModels.length, 0);
  // 混 model：sonnet 1M output = $15
  const c2 = pricing.cost({ 'claude-sonnet-4-6': { output: 1e6 } });
  assert.ok(Math.abs(c2.usd - 15) < 1e-9, `sonnet 1M output = $15，得 ${c2.usd}`);
  // 家族 fallback：未知 opus 變體照 opus 算
  const c3 = pricing.cost({ 'claude-opus-4-9-future': { input: 1e6 } });
  assert.ok(Math.abs(c3.usd - 5) < 1e-9, '未知 opus 變體 fallback 到 opus 費率');
  // 完全不認得 → 列入 unknownModels、不算成本
  const c4 = pricing.cost({ 'gpt-9': { input: 1e6 } });
  assert.strictEqual(c4.usd, 0);
  assert.deepStrictEqual(c4.unknownModels, ['gpt-9']);
  // buildView 帶出 costUsd
  const idxP = { version: 1, updatedAt: 'X', sessions: {
    a: { sessionId: 'a', projectDir: 'D--x', cwd: 'D:\\x', summary: '', firstTs: '1', lastTs: '2', turns: 1, userMsgs: 0, models: { 'claude-opus-4-8': 1 }, tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, modelTokens: { 'claude-opus-4-8': { output: 1e6 } }, size: 0 },
  } };
  const vP = buildView(idxP);
  assert.ok(Math.abs(vP.totals.costUsd - 25) < 1e-9, 'totals.costUsd 聚合 opus 1M output = $25');
  assert.ok(Math.abs(vP.sessions[0].costUsd - 25) < 1e-9, 'session.costUsd');
  console.log('✓ D. 定價/成本換算通過（費率推導 / 混 model / 家族 fallback / 未知 model / buildView 聚合）');

  // ── B. 整合 sanity（真實 kabby cwd）─────────────────────────────
  const { scanProject } = require('../src/cc-collector');
  const view = scanProject(process.cwd());
  console.log(`\n── 整合：scanProject(${process.cwd()}) ──`);
  console.log(`sessions=${view.totals.sessions}  turns=${view.totals.turns}`);
  console.log(`tokens  in=${view.totals.tokens.input}  out=${view.totals.tokens.output}  ` +
    `cacheCreate=${view.totals.tokens.cacheCreate}  cacheRead=${view.totals.tokens.cacheRead}`);
  for (const s of view.sessions.slice(0, 5)) {
    const models = Object.keys(s.models).join(',') || '-';
    console.log(`  ${s.sessionId.slice(0, 8)}  turns=${String(s.turns).padStart(4)}  ` +
      `in=${String(s.tokens.input).padStart(6)} out=${String(s.tokens.output).padStart(6)}  ` +
      `[${models}]  ${(s.summary || '').slice(0, 40)}`);
  }

  console.log('\n✓ ALL PASS');
}

run();
