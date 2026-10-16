/**
 * 對話視圖 chat items 測試（不需 daemon）：
 *   - user 文字 / assistant text / tool_use / tool_result 展平成時間序 items
 *   - meta、sidechain、slash 指令輸出不出現
 *   - 長字串截斷
 *   - 增量：append 新行只解析新增部分；半行不誤吞；檔案變小整份重解析
 *
 * 跑法：node test/cc-chat-items.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chatItemsFromLine, readChatItemsFromFile } = require('../src/cc-collector');

const line = (obj) => JSON.stringify(obj) + '\n';
const user = (content, extra = {}) => ({ type: 'user', timestamp: 't', message: { role: 'user', content }, ...extra });
const asst = (content, extra = {}) => ({ type: 'assistant', timestamp: 't', requestId: 'r1', message: { role: 'assistant', model: 'm', content }, ...extra });

function run() {
  // ── 單行轉換 ──
  assert.deepStrictEqual(chatItemsFromLine(user('hello')).map((i) => [i.kind, i.text]), [['user', 'hello']]);
  assert.strictEqual(chatItemsFromLine(user('x', { isMeta: true })).length, 0, 'isMeta 要略過');
  assert.strictEqual(chatItemsFromLine(user('x', { isSidechain: true })).length, 0, 'sidechain 要略過');
  assert.strictEqual(chatItemsFromLine(user('<local-command-stdout>ok</local-command-stdout>')).length, 0, 'slash 指令輸出要略過');
  assert.deepStrictEqual(
    chatItemsFromLine(user('<command-name>/clear</command-name>')).map((i) => i.text), ['/clear'], 'slash 指令本身保留（去標籤）');

  const a = chatItemsFromLine(asst([
    { type: 'thinking', thinking: 'secret' },
    { type: 'text', text: '先讀檔' },
    { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.js' } },
  ]));
  assert.deepStrictEqual(a.map((i) => i.kind), ['assistant', 'tool'], 'thinking 不輸出，順序保留');
  assert.strictEqual(a[1].id, 'tu1');
  assert.strictEqual(a[1].input.file_path, 'a.js');

  const r = chatItemsFromLine(user([
    { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'line1' }, { type: 'image' }], is_error: false },
  ]));
  assert.deepStrictEqual(r.map((i) => [i.kind, i.toolUseId, i.content]), [['result', 'tu1', 'line1\n[圖片]']]);
  const err = chatItemsFromLine(user([{ type: 'tool_result', tool_use_id: 'tu2', content: 'boom', is_error: true }]));
  assert.strictEqual(err[0].isError, true);

  // 截斷
  const big = 'x'.repeat(10000);
  const w = chatItemsFromLine(asst([{ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: 'f', content: big } }]));
  assert.ok(w[0].input.content.length < 5000, 'tool input 長字串要截斷');
  assert.ok(w[0].input.content.includes('已截斷'));
  const rb = chatItemsFromLine(user([{ type: 'tool_result', tool_use_id: 'w', content: big }]));
  assert.ok(rb[0].content.length < 5000, 'tool_result 要截斷');

  // ── 增量讀檔 ──
  const tmp = path.join(os.tmpdir(), `kabby-chat-${process.pid}.jsonl`);
  fs.writeFileSync(tmp, line(user('q1')) + line(asst([{ type: 'text', text: 'a1' }])));
  let res = readChatItemsFromFile(tmp);
  assert.deepStrictEqual(res.items.map((i) => i.text), ['q1', 'a1']);

  // 半行：不應被吞，也不應產生 item
  const half = line(asst([{ type: 'text', text: 'a2' }]));
  fs.appendFileSync(tmp, half.slice(0, 10));
  res = readChatItemsFromFile(tmp);
  assert.strictEqual(res.items.length, 2, '半行不產生 item');
  fs.appendFileSync(tmp, half.slice(10));
  res = readChatItemsFromFile(tmp);
  assert.deepStrictEqual(res.items.map((i) => i.text), ['q1', 'a1', 'a2'], '補完半行後才出現');

  // 不重複累加
  res = readChatItemsFromFile(tmp);
  assert.strictEqual(res.items.length, 3, '無新資料時不重複');

  // 檔案變小 → 整份重解析
  fs.writeFileSync(tmp, line(user('new')));
  res = readChatItemsFromFile(tmp);
  assert.deepStrictEqual(res.items.map((i) => i.text), ['new'], '檔案重寫要重解析');

  fs.unlinkSync(tmp);
  console.log('cc-chat-items: all PASS');
}

run();
