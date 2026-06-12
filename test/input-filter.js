/**
 * input-filter（D 方案輸入攔截）測試。跑法：node test/input-filter.js
 */
const assert = require('assert');
const { createInputFilter } = require('../src/input-filter');

// 假 matcher：命中 password / secret / 密碼
const matcher = {
  scan(t) {
    const hits = [];
    if (/password/i.test(t)) hits.push('password');
    if (/secret/i.test(t)) hits.push('secret');
    if (t.includes('密碼')) hits.push('密碼');
    return hits;
  },
};

function feedAll(f, chunks) {
  let forward = '';
  const blocked = [];
  for (const c of chunks) {
    const r = f.feed(c, matcher);
    forward += r.forward;
    blocked.push(...r.blockedWords);
  }
  return { forward, blocked };
}

function run() {
  // matcher null → 原樣放行
  let f = createInputFilter();
  assert.deepStrictEqual(f.feed('anything\r', null), { forward: 'anything\r', blockedWords: [] }, 'null matcher 放行');

  // 乾淨行：全轉發 + Enter 放行 + buf 清空
  f = createInputFilter();
  let r = feedAll(f, ['h', 'e', 'l', 'l', 'o', '\r']);
  assert.strictEqual(r.forward, 'hello\r', '乾淨行 forward 含 Enter');
  assert.strictEqual(r.blocked.length, 0);
  assert.strictEqual(f.peek().buf, '', 'Enter 後 buf 清空');

  // 命中：攔下 Enter（forward 不含 \r），blocked 有詞，buf 保留
  f = createInputFilter();
  r = feedAll(f, ['p', 'a', 's', 's', 'w', 'o', 'r', 'd', '\r']);
  assert.strictEqual(r.forward, 'password', 'forward 是打的字（cc 已 echo），但不含被攔的 Enter');
  assert.deepStrictEqual(r.blocked, ['password'], '回報命中詞');
  assert.strictEqual(f.peek().buf, 'password', '攔截後 buf 保留（供改後重送再檢查）');
  // 直接再按 Enter（沒改）→ 再次攔截（防繞過）
  r = feedAll(f, ['\r']);
  assert.deepStrictEqual(r.blocked, ['password'], '未改重送仍攔截');

  // 退格能改掉敏感詞 → 改乾淨後放行
  f = createInputFilter();
  feedAll(f, ['s', 'e', 'c', 'r', 'e', 't', '\r']); // 先被攔
  r = feedAll(f, ['\x7f', '\x7f', '\x7f', '\x7f', '\x7f', '\x7f']); // 退 6 格清掉 secret
  assert.strictEqual(f.peek().buf, '', '退格清空 buf');
  r = feedAll(f, ['o', 'k', '\r']);
  assert.strictEqual(r.blocked.length, 0, '改乾淨後放行');
  assert.strictEqual(r.forward.endsWith('\r'), true, '放行含 Enter');

  // Ctrl+U 清行
  f = createInputFilter();
  r = feedAll(f, ['s', 'e', 'c', 'r', 'e', 't', '\x15', 'o', 'k', '\r']);
  assert.strictEqual(r.blocked.length, 0, 'Ctrl+U 清掉敏感詞後放行');

  // 方向鍵不污染 buf（arrow = \x1b[D），原樣轉發
  f = createInputFilter();
  r = feedAll(f, ['o', 'k', '\x1b[D', '\r']);
  assert.strictEqual(r.blocked.length, 0);
  assert.ok(r.forward.includes('\x1b[D'), 'arrow 序列原樣轉發給 cc');

  // 中文敏感詞
  f = createInputFilter();
  r = feedAll(f, ['我', '的', '密', '碼', '\r']);
  assert.deepStrictEqual(r.blocked, ['密碼'], '中文命中');

  // bracketed paste：paste 內容進 buf、不當提交；真正 Enter 才檢查
  f = createInputFilter();
  r = feedAll(f, ['\x1b[200~my secret data\x1b[201~', '\r']);
  assert.deepStrictEqual(r.blocked, ['secret'], 'paste 內容也被檢查');
  assert.ok(r.forward.includes('\x1b[200~'), 'paste 標記原樣轉發');

  // 一次 write 含整行+Enter
  f = createInputFilter();
  r = f.feed('password\r', matcher);
  assert.strictEqual(r.forward, 'password', '單次 write：forward 去掉 Enter');
  assert.deepStrictEqual(r.blockedWords, ['password']);

  console.log('✓ input-filter 全部通過（放行/攔截/退格/Ctrl+U/方向鍵/中文/paste/單次write）');
  console.log('✓ ALL PASS');
}

run();
