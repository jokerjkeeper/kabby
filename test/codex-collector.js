/**
 * codex-collector 單元測試（合成 fixture，不依賴真實 ~/.codex 資料）。
 * 跑法：node test/codex-collector.js
 */
const assert = require('assert');
const c = require('../src/codex-collector');

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log('  ✓', name);
  pass++;
}

// ── mapUsage：codex token → pricing 形狀 ──
(() => {
  const m = c.mapUsage({ input_tokens: 1000, cached_input_tokens: 600, output_tokens: 200, reasoning_output_tokens: 50 });
  ok('mapUsage: input = input - cached', m.input === 400);
  ok('mapUsage: cacheRead = cached', m.cacheRead === 600);
  ok('mapUsage: output = output + reasoning', m.output === 250);
  ok('mapUsage: 無 cacheCreate', m.cacheCreate5m === 0 && m.cacheCreate1h === 0);
  const z = c.mapUsage({ input_tokens: 100, cached_input_tokens: 300 }); // cached > input 護欄
  ok('mapUsage: input 不為負', z.input === 0);
})();

// ── accumulateLine：累計快照 → 末筆為總量；增量分組進 modelTokens ──
(() => {
  const e = c.freshEntry('sid-1', '/fake/rollout.jsonl');
  const lines = [
    { timestamp: '2026-06-30T01:00:00Z', type: 'session_meta', payload: { id: 'sid-1', cwd: 'D:\\Proj\\X', timestamp: '2026-06-30T01:00:00Z' } },
    { timestamp: '2026-06-30T01:00:01Z', type: 'turn_context', payload: { model: 'gpt-5.4' } },
    { timestamp: '2026-06-30T01:00:02Z', type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: '2026-06-30T01:00:03Z', type: 'event_msg', payload: { type: 'user_message', message: '請幫我重構' } },
    // 第一個 token_count（累計 = 增量）
    { timestamp: '2026-06-30T01:00:04Z', type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100, reasoning_output_tokens: 20 },
      last_token_usage:  { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100, reasoning_output_tokens: 20 },
      model_context_window: 258400 }, rate_limits: { primary: { used_percent: 5 }, plan_type: 'plus' } } },
    // 第二個 token_count（累計成長；增量為差額）
    { timestamp: '2026-06-30T01:00:05Z', type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 3000, cached_input_tokens: 2000, output_tokens: 250, reasoning_output_tokens: 50 },
      last_token_usage:  { input_tokens: 2000, cached_input_tokens: 1400, output_tokens: 150, reasoning_output_tokens: 30 },
      model_context_window: 258400 }, rate_limits: { primary: { used_percent: 12 }, plan_type: 'plus' } } },
  ];
  for (const o of lines) c.accumulateLine(e, JSON.stringify(o), null);

  // session 總量 = 末筆 total_token_usage 映射
  ok('entry.tokens.input = 末筆 input - cached', e.tokens.input === 1000);     // 3000 - 2000
  ok('entry.tokens.cacheRead = 末筆 cached', e.tokens.cacheRead === 2000);
  ok('entry.tokens.output = 末筆 output + reasoning', e.tokens.output === 300); // 250 + 50
  ok('entry.tokens.cacheCreate = 0', e.tokens.cacheCreate === 0);

  // modelTokens 為「增量總和」（兩筆 last 相加）
  const mt = e.modelTokens['gpt-5.4'];
  ok('modelTokens.cacheRead = Σ last cached', mt.cacheRead === 2000);   // 600 + 1400
  ok('modelTokens.output = Σ last (out+reason)', mt.output === 300);    // (100+20)+(150+30)
  ok('modelTokens.input = Σ last (in-cached)', mt.input === 1000);      // (1000-600)+(2000-1400)=400+600

  ok('turns 由 task_started 計', e.turns === 1);
  ok('summary 取真實 user 訊息', e.summary === '請幫我重構');
  ok('lastModel 來自 turn_context', e.lastModel === 'gpt-5.4');
  ok('rateLimits 取末筆', e.rateLimits && e.rateLimits.primary.used_percent === 12);
  ok('contextWindow 記錄', e.contextWindow === 258400);
})();

// ── 注入的 <environment_context> 不汙染 summary ──
(() => {
  const e = c.freshEntry('sid-2', '/fake/2.jsonl');
  c.accumulateLine(e, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '<environment_context>\n<cwd>D:\\X</cwd>\n</environment_context>' } }), null);
  ok('注入 context 不當 summary', e.summary === '');
  c.accumulateLine(e, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '真正的問題' } }), null);
  ok('後續真實訊息才入 summary', e.summary === '真正的問題');
})();

// ── buildView：聚合 + 成本（gpt-5.4 by family/defaults）──
(() => {
  const e = c.freshEntry('sid-3', '/fake/3.jsonl');
  e.cwd = 'D:\\Proj\\X'; e.lastTs = '2026-06-30T02:00:00Z';
  e.tokens = { input: 1000, output: 300, cacheCreate: 0, cacheRead: 2000 };
  e.modelTokens = { 'gpt-5.4': { input: 1000, output: 300, cacheRead: 2000, cacheCreate5m: 0, cacheCreate1h: 0 } };
  e.models = { 'gpt-5.4': 2 };
  e.daily = { '2026-06-30': { turns: 1, models: { 'gpt-5.4': { input: 1000, output: 300, cacheRead: 2000, cacheCreate5m: 0, cacheCreate1h: 0 } } } };
  e.rateLimits = { primary: { used_percent: 50 }, plan_type: 'plus' };
  const index = { updatedAt: 'now', sessions: { 'sid-3': e } };
  const v = c.buildView(index);
  ok('buildView provider=codex', v.provider === 'codex');
  ok('totals.sessions', v.totals.sessions === 1);
  ok('totals.tokens 對齊 entry', v.totals.tokens.input === 1000 && v.totals.tokens.cacheRead === 2000);
  // 成本：gpt-5.4 = in1.25 out10 cacheRead0.125（/1M）
  const expect = (1000 * 1.25 + 300 * 10 + 2000 * 0.125) / 1e6;
  ok('totals.costUsd 正確', Math.abs(v.totals.costUsd - expect) < 1e-9);
  ok('byModel 有 gpt-5.4', v.byModel[0].model === 'gpt-5.4');
  ok('byDay 有當日', v.byDay[0].day === '2026-06-30');
  ok('view.rateLimits 透出', v.rateLimits && v.rateLimits.plan_type === 'plus');
  // cwd 過濾
  ok('cwd 過濾命中', c.buildView(index, { cwd: 'D:\\Proj\\X' }).totals.sessions === 1);
  ok('cwd 過濾未命中', c.buildView(index, { cwd: 'D:\\Other' }).totals.sessions === 0);
})();

console.log(`\n✓ ALL PASS (${pass} assertions)`);
