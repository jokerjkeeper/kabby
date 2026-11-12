/**
 * /api/files（唯讀檔案下載服務）測試。跑法：node test/files.js
 *
 * 1. 用臨時目錄當 KABBY_FILES_ROOT、隨機 port、測試用 AUTH_TOKEN 起一個真的 daemon 子行程
 *    （HOME / USERPROFILE 也指到臨時目錄，不碰本機 ~/.kabby），測 token、代理 header、路徑檢查、
 *    list / stat / sha256 / raw + Range。
 * 2. IP 白名單與「未設定 = 404」用只掛 router 的小 express app 測（不必另起 daemon）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const { createFilesRouter, parseFilesConfig, parseAllowIps, ipAllowed } = require('../src/files');
const { createFilesAudit, localDate } = require('../src/files-audit');

const TOKEN = 'test-files-token';
const DAEMON = path.join(__dirname, '..', 'src', 'daemon.js');

/** 取一個空閒 port */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** 建臨時分享目錄：一般檔、子目錄、點開頭檔案 / 目錄、指向 root 外的 junction */
function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kabby-files-'));
  const root = path.join(base, 'share');
  const outside = path.join(base, 'outside');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const big = crypto.randomBytes(300 * 1024 + 7);
  fs.writeFileSync(path.join(root, 'model.bin'), big);
  fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'hello a');
  fs.writeFileSync(path.join(root, 'sub', 'deep', 'b.txt'), 'hello b');
  fs.writeFileSync(path.join(root, '.gitattributes'), 'secret-ish');
  fs.writeFileSync(path.join(root, '.cache', 'x.txt'), 'cache');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');

  let hasLink = false;
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    hasLink = true;
  } catch (err) {
    console.log(`  (略過 junction 逃逸測試：${err.code})`);
  }
  // 稽核日誌目錄：預先放一個過期檔、一個今天的檔、一個無關檔，驗證啟動時只清過期的
  const logDir = path.join(base, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'files-2000-01-01.jsonl'), '{}\n');
  fs.writeFileSync(path.join(logDir, `files-${localDate(Date.now())}.jsonl`), '');
  fs.writeFileSync(path.join(logDir, 'notes.txt'), 'keep');
  return { base, root, home, big, hasLink, logDir };
}

/** 起 daemon 子行程，等到 listening */
function startDaemon(port, fx) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      AUTH_TOKEN: TOKEN,
      KABBY_FILES_ROOT: fx.root,
      KABBY_FILES_ROOTS: '',   // 擋掉本機 .env 的多根設定，這段測單根模式
      KABBY_FILES_LOG_DIR: fx.logDir,
      KABBY_FILES_LOG_DAYS: '30',
      KABBY_FILES_ALLOW_IPS: '127.0.0.1,::1',
      HOME: fx.home,
      USERPROFILE: fx.home,
    };
    const child = spawn(process.execPath, [DAEMON], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const logs = [];
    const timer = setTimeout(() => reject(new Error('daemon 啟動逾時')), 15000);
    child.stdout.on('data', (d) => {
      if (d.toString().includes('listening')) { clearTimeout(timer); resolve({ child, logs }); }
    });
    child.stderr.on('data', (d) => logs.push(...d.toString().split('\n').filter(Boolean)));
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`daemon 提前結束 code=${code}`)); });
  });
}

/** 在 0 port 起一個只掛 files router 的 express app */
function startMini(opts) {
  return new Promise((resolve) => {
    const app = express();
    app.use('/api/files', createFilesRouter({ ...opts, log: () => {} }));
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function main() {
  const fx = makeFixture();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/api/files`;
  const { child, logs } = await startDaemon(port, fx);
  const auth = { 'X-Kabby-Token': TOKEN };
  const get = (p, headers = {}) => fetch(base + p, { headers: { ...auth, ...headers } });
  const q = encodeURIComponent;
  let passed = 0;
  const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

  try {
    // --- 認證 / 代理 header ---
    assert.strictEqual((await fetch(`${base}/list`)).status, 401);
    ok('無 token → 401');
    assert.strictEqual((await get('/list', { 'X-Forwarded-For': '1.2.3.4' })).status, 403);
    assert.strictEqual((await get('/list', { 'CF-Connecting-IP': '1.2.3.4' })).status, 403);
    ok('帶 x-forwarded-for / cf-connecting-ip → 403');

    // --- 路徑檢查 ---
    const bad = ['../x', '..\\x', 'sub/../../x', 'C:\\Windows\\win.ini', 'C:/Windows/win.ini', '/etc/passwd',
      '\\\\server\\share\\x', '//server/share/x', 'model.bin:stream', 'model.bin::$DATA', 'model.bin\0'];
    for (const p of bad) {
      for (const ep of ['raw', 'stat']) {
        const r = await get(`/${ep}?path=${q(p)}`);
        assert.strictEqual(r.status, 400, `${ep} ${JSON.stringify(p)} 應為 400，得到 ${r.status}`);
        const body = await r.json();
        assert.ok(!JSON.stringify(body).includes(fx.root), '錯誤訊息不可洩漏實際路徑');
      }
    }
    assert.strictEqual((await get(`/list?path=${q('../')}`)).status, 400);
    ok('.. / 絕對路徑 / UNC / ADS / 空字元 → 400，且不洩漏路徑');

    for (const p of ['.gitattributes', '.cache/x.txt', 'sub/.hidden', 'nope.bin']) {
      assert.strictEqual((await get(`/raw?path=${q(p)}`)).status, 404, `raw ${p}`);
      assert.strictEqual((await get(`/stat?path=${q(p)}`)).status, 404, `stat ${p}`);
    }
    ok('點開頭檔案 / 目錄、不存在 → 404');

    if (fx.hasLink) {
      assert.strictEqual((await get(`/raw?path=${q('escape/secret.txt')}`)).status, 400);
      assert.strictEqual((await get(`/list?path=escape`)).status, 400);
      ok('junction / symlink 逃出 root → 400');
    }

    // --- list ---
    let r = await get('/list');
    assert.strictEqual(r.status, 200);
    let body = await r.json();
    assert.strictEqual(body.root, 'share');
    assert.strictEqual(body.path, '');
    assert.deepStrictEqual(body.entries.map((e) => e.path).sort(), ['model.bin', 'sub']);
    const mb = body.entries.find((e) => e.path === 'model.bin');
    assert.strictEqual(mb.size, fx.big.length);
    assert.strictEqual(mb.isDir, false);
    assert.ok(!Number.isNaN(Date.parse(mb.mtime)));
    ok('list 根目錄（不含點開頭、不跟 junction，root 只回名稱）');

    body = await (await get('/list?recursive=1')).json();
    assert.deepStrictEqual(body.entries.map((e) => e.path).sort(),
      ['model.bin', 'sub', 'sub/a.txt', 'sub/deep', 'sub/deep/b.txt']);
    body = await (await get('/list?path=sub')).json();
    assert.strictEqual(body.path, 'sub');
    assert.deepStrictEqual(body.entries.map((e) => e.path).sort(), ['sub/a.txt', 'sub/deep']);
    assert.strictEqual((await get('/list?path=model.bin')).status, 400);
    ok('list recursive / 子目錄 / 對檔案 → 400');

    // --- stat / sha256 ---
    const expectHash = crypto.createHash('sha256').update(fx.big).digest('hex');
    body = await (await get('/stat?path=model.bin')).json();
    assert.deepStrictEqual([body.path, body.size, body.sha256], ['model.bin', fx.big.length, null]);
    const [h1, h2] = await Promise.all([get('/stat?path=model.bin&hash=1'), get('/stat?path=model.bin&hash=1')]);
    assert.strictEqual((await h1.json()).sha256, expectHash);
    assert.strictEqual((await h2.json()).sha256, expectHash);
    body = await (await get('/stat?path=model.bin')).json();
    assert.strictEqual(body.sha256, expectHash, '算過後不帶 hash=1 也應回快取');
    assert.strictEqual((await get('/stat?path=sub')).status, 400);
    assert.strictEqual((await get('/stat')).status, 400);
    ok('stat：無快取回 null、hash=1 正確、並發共用、之後走快取');

    const aPath = path.join(fx.root, 'sub', 'a.txt');
    body = await (await get(`/stat?path=${q('sub\\a.txt')}&hash=1`)).json();
    assert.strictEqual(body.path, 'sub/a.txt');
    fs.writeFileSync(aPath, 'hello a, changed');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(aPath, later, later);
    body = await (await get('/stat?path=sub/a.txt')).json();
    assert.strictEqual(body.sha256, null, '檔案改變後快取應失效');
    ok('檔案變更 → 快取失效；反斜線路徑正規化為 /');

    // --- raw ---
    r = await get('/raw?path=model.bin', { Range: 'bytes=0-99' });
    assert.strictEqual(r.status, 206);
    assert.strictEqual(r.headers.get('content-range'), `bytes 0-99/${fx.big.length}`);
    assert.strictEqual(r.headers.get('content-length'), '100');
    let buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.equals(fx.big.subarray(0, 100)));
    ok('Range 0-99 → 206、長度 100、內容正確');

    r = await get('/raw?path=model.bin', { Range: 'bytes=300000-' });
    assert.strictEqual(r.status, 206);
    buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.equals(fx.big.subarray(300000)));
    ok('續傳 Range bytes=N- → 206、尾段內容正確');

    r = await get('/raw?path=model.bin', { Range: `bytes=${fx.big.length + 10}-` });
    assert.strictEqual(r.status, 416);
    ok('超出範圍 → 416');

    r = await get('/raw?path=model.bin');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('accept-ranges'), 'bytes');
    assert.strictEqual(r.headers.get('content-length'), String(fx.big.length));
    assert.ok(r.headers.get('etag'));
    assert.ok(r.headers.get('last-modified'));
    buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.equals(fx.big));
    ok('完整下載 200 + Accept-Ranges / Content-Length / ETag / Last-Modified');

    // 中途斷線：不應讓 daemon 出錯，後續請求照常
    const ac = new AbortController();
    r = await get('/raw?path=model.bin', {});
    await fetch(`${base}/raw?path=model.bin`, { headers: auth, signal: ac.signal }).then((res) => {
      ac.abort();
      return res.arrayBuffer().catch(() => {});
    }).catch(() => {});
    await r.arrayBuffer();
    assert.strictEqual((await get('/stat?path=model.bin')).status, 200);
    ok('用戶端中途斷線後服務正常');

    // 存取日誌
    await new Promise((res) => setTimeout(res, 200));
    const rawLog = logs.find((l) => l.includes('[files]') && l.includes(' raw ') && l.includes('range=bytes=0-99'));
    assert.ok(rawLog, '應有 raw 存取日誌');
    assert.ok(/status=206 .*bytes=100 .*ok$/.test(rawLog), rawLog);
    assert.ok(logs.some((l) => l.includes('[files]') && l.includes(' hash ')), '應有 hash 存取日誌');
    ok('存取日誌寫 stderr（ip / path / range / status / bytes / ms / 結果）');

    await testAuditWithDaemon({ fx, base, port, get, ok });
  } finally {
    child.kill();
  }

  // --- 小 app：IP 白名單、未設定 ---
  const srvDeny = await startMini({ root: fx.root, allowIps: '10.9.9.9' });
  const srvMapped = await startMini({ root: fx.root, allowIps: '::ffff:127.0.0.1' });
  const srvOff = await startMini({ root: null });
  const srvWild = await startMini({ root: fx.root, allowIps: '127.0.0.*' });
  const srvWildDeny = await startMini({ root: fx.root, allowIps: '10.1.129.*' });
  const srvCidr = await startMini({ root: fx.root, allowIps: '10.0.0.1,127.0.0.0/8' });
  const srvBad = await startMini({ root: fx.root, allowIps: '10.1.129.*x, abc' });
  try {
    const url = (srv, p) => `http://127.0.0.1:${srv.address().port}/api/files${p}`;
    assert.strictEqual((await fetch(url(srvDeny, '/list'))).status, 403);
    ok('IP 不在白名單 → 403');
    const actDeny = await fetch(url(srvDeny, '/activity'));
    assert.strictEqual(actDeny.status, 200);
    assert.strictEqual((await actDeny.json()).enabled, true);
    ok('activity 不套 IP 白名單');
    assert.deepStrictEqual(await (await fetch(url(srvOff, '/activity'))).json(), { enabled: false });
    ok('未啟用時 activity 回 { enabled:false }');
    assert.strictEqual((await fetch(url(srvMapped, '/list'))).status, 200);
    ok('白名單寫 ::ffff: 形式也能比對');
    assert.strictEqual((await fetch(url(srvWild, '/list'))).status, 200);
    assert.strictEqual((await fetch(url(srvWildDeny, '/list'))).status, 403);
    ok('白名單萬用字元 127.0.0.* 放行、10.1.129.* 擋下 127.0.0.1');
    assert.strictEqual((await fetch(url(srvCidr, '/list'))).status, 200);
    ok('白名單 CIDR 127.0.0.0/8 與單一 IP 混寫');
    assert.strictEqual((await fetch(url(srvBad, '/list'))).status, 403);
    assert.deepStrictEqual((await (await fetch(url(srvWild, '/activity'))).json()).config.allowIps, ['127.0.0.*']);
    ok('白名單全部不合法 → 一律拒絕（不會變成不限）；activity 列出規則');
    assert.strictEqual((await fetch(url(srvOff, '/list'))).status, 404);
    assert.strictEqual((await fetch(url(srvOff, '/raw?path=x'))).status, 404);
    ok('KABBY_FILES_ROOT 未設 → 404');
  } finally {
    srvDeny.close(); srvMapped.close(); srvOff.close();
    srvWild.close(); srvWildDeny.close(); srvCidr.close(); srvBad.close();
  }

  testAllowIpsUnit(ok);
  await testMultiRoots(fx, ok);
  await testAuditUnit(fx, ok);

  fs.rmSync(fx.base, { recursive: true, force: true });
  console.log(`\nfiles: ${passed} 項全部通過`);
}

/** 讀今天的 JSONL 稽核檔 */
function readAudit(logDir) {
  const file = path.join(logDir, `files-${localDate(Date.now())}.jsonl`);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return { text, events: text.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

/** 輪詢直到 fn() 回 truthy（最多 ms 毫秒） */
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

/** 稽核 JSONL + activity（在真的 daemon 上跑） */
async function testAuditWithDaemon({ fx, base, port, get, ok }) {
  // 啟動時清過期檔
  assert.ok(!fs.existsSync(path.join(fx.logDir, 'files-2000-01-01.jsonl')), '過期日誌應被清除');
  assert.ok(fs.existsSync(path.join(fx.logDir, 'notes.txt')), '非日誌檔不可刪');
  ok('啟動時清掉超過保留天數的日誌，其他檔不動');

  // 錯誤 token：要記 bad_token，但不可出現 token 值
  assert.strictEqual((await (await get('/stat?path=model.bin&hash=1')).json()).sha256.length, 64);   // 走快取
  const WRONG = 'WRONG-SECRET-xyz789';
  assert.strictEqual((await fetch(`${base}/raw?path=model.bin`, { headers: { 'X-Kabby-Token': WRONG } })).status, 401);
  assert.strictEqual((await fetch(`${base}/list?token=${WRONG}`)).status, 401);
  const { text, events } = await waitFor(() => {
    const a = readAudit(fx.logDir);
    return a.events.filter((e) => e.reason === 'bad_token').length >= 2 && a;
  });
  assert.ok(!text.includes(WRONG), '稽核日誌不可含收到的 token');
  assert.ok(!text.includes(TOKEN), '稽核日誌不可含正確 token');
  const bad = events.find((e) => e.reason === 'bad_token' && e.endpoint === 'raw');
  assert.ok(bad, '應記 raw 的 bad_token');
  assert.deepStrictEqual([bad.status, bad.result, bad.path, bad.method], [401, 'denied', 'model.bin', 'GET']);
  ok('401 記 bad_token（result=denied），日誌不含任何 token 值');

  // 其他被拒原因與正常事件的欄位
  const reasons = new Set(events.map((e) => e.reason));
  for (const r of ['proxy_header', 'invalid_path', 'dotfile', 'not_found']) assert.ok(reasons.has(r), `應有 reason=${r}`);
  assert.ok(events.filter((e) => e.reason === 'invalid_path').every((e) => e.result === 'denied' && e.status === 400));
  const raw = events.find((e) => e.endpoint === 'raw' && e.range === 'bytes=0-99');
  for (const k of ['ts', 'ip', 'method', 'endpoint', 'path', 'range', 'status', 'bytes', 'size', 'ms', 'result']) {
    assert.ok(raw[k] !== undefined, `raw 事件缺欄位 ${k}`);
  }
  assert.deepStrictEqual([raw.ip, raw.path, raw.status, raw.bytes, raw.size, raw.result],
    ['127.0.0.1', 'model.bin', 206, 100, fx.big.length, 'ok']);
  assert.ok(events.some((e) => e.endpoint === 'hash' && e.result === 'ok' && e.size === fx.big.length));
  assert.ok(events.some((e) => e.endpoint === 'hash' && e.result === 'cached'));
  assert.ok(events.some((e) => e.endpoint === 'list' && e.result === 'ok'));
  assert.ok(!events.some((e) => e.endpoint === 'activity'), 'activity 輪詢不寫稽核');
  ok('JSONL 欄位正確：raw / hash(ok, cached) / list，被拒請求帶 reason');

  // activity：下載進行中看得到 active，斷線後移除並記 aborted
  const bigPath = path.join(fx.root, 'big.bin');
  fs.writeFileSync(bigPath, Buffer.alloc(48 * 1024 * 1024, 7));
  let firstChunk = false;
  const req = http.get(`${base}/raw?path=big.bin`, { headers: { 'X-Kabby-Token': TOKEN } }, (res) => {
    res.once('data', () => { firstChunk = true; res.pause(); });
  });
  req.on('error', () => {});
  await waitFor(() => firstChunk);
  const act = await waitFor(async () => {
    const a = await (await get('/activity')).json();
    return a.active.some((d) => d.path === 'big.bin' && d.sent > 0) && a;
  });
  const dl = act.active.find((d) => d.path === 'big.bin');
  assert.ok(dl, 'active 應有進行中的下載');
  assert.deepStrictEqual([dl.ip, dl.total, typeof dl.mibps, typeof dl.id], ['127.0.0.1', 48 * 1024 * 1024, 'number', 'number']);
  assert.ok(dl.sent < dl.total);
  assert.strictEqual(act.enabled, true);
  assert.deepStrictEqual(act.config.roots, ['share']);
  assert.ok(act.stats.denied >= 2 && act.stats.deniedByReason.bad_token >= 2);
  assert.ok(act.stats.bytesSent > 0 && act.stats.bytesByIp['127.0.0.1'] > 0);
  assert.strictEqual(act.log.writable, true);
  assert.ok(Array.isArray(act.hashing) && Array.isArray(act.recent) && act.recent.length > 0);
  ok('activity：下載中看得到 active（sent / total / mibps）、stats、config、recent');

  req.destroy();
  const after = await waitFor(async () => {
    const a = await (await get('/activity')).json();
    return !a.active.some((d) => d.path === 'big.bin') && a;
  });
  assert.ok(after, '斷線後 active 應移除');
  const aborted = await waitFor(() => readAudit(fx.logDir).events.find((e) => e.path === 'big.bin' && e.result === 'aborted'));
  assert.ok(aborted, '斷線應記 aborted');
  assert.ok(aborted.bytes > 0 && aborted.bytes < 48 * 1024 * 1024);
  assert.ok(after.recent.some((e) => e.path === 'big.bin' && e.result === 'aborted'));
  ok('用戶端斷線 → active 移除、JSONL / recent 記 aborted');
  fs.unlinkSync(bigPath);

  // activity 不套代理 header 檢查以外的 IP 白名單（見小 app 測試）；無 token 仍 401
  assert.strictEqual((await fetch(`${base}/activity`)).status, 401);
  ok('activity 仍需 token');
}

/** files-audit 單元測試：被拒限流、過期清除、寫檔失敗不丟例外 */
async function testAuditUnit(fx, ok) {
  const dir = path.join(fx.base, 'audit-unit');
  let clock = Date.parse('2026-11-11T12:00:00');
  const warns = [];
  const audit = createFilesAudit({ logDir: dir, logDays: 30, deniedPerMin: 3, now: () => clock, warn: (l) => warns.push(l) });
  for (let i = 0; i < 5; i++) audit.record({ ip: '10.0.0.9', endpoint: 'list', status: 401, result: 'denied', reason: 'bad_token' });
  audit.record({ ip: '10.0.0.8', endpoint: 'list', status: 401, result: 'denied', reason: 'bad_token' });
  clock += 61 * 1000;
  audit.flushSuppressed();
  await audit.drain();
  const lines = fs.readFileSync(path.join(dir, 'files-2026-11-11.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.strictEqual(lines.filter((e) => e.ip === '10.0.0.9' && e.reason === 'bad_token').length, 3);
  const sup = lines.find((e) => e.reason === 'suppressed');
  assert.deepStrictEqual([sup.ip, sup.suppressed], ['10.0.0.9', 2]);
  assert.strictEqual(lines.filter((e) => e.ip === '10.0.0.8').length, 1);
  assert.strictEqual(audit.snapshot().stats.denied, 6, '統計計數不受限流影響');
  ok('被拒限流：每 IP 每分鐘上限，超過只計數並補 suppressed 摘要');

  for (const d of ['2026-10-11', '2026-10-12', '2026-10-01']) fs.writeFileSync(path.join(dir, `files-${d}.jsonl`), '');
  const removed = await audit.cleanup();
  const left = fs.readdirSync(dir).sort();
  assert.strictEqual(removed, 2);
  assert.deepStrictEqual(left, ['files-2026-10-12.jsonl', 'files-2026-11-11.jsonl']);
  ok('過期清除：只刪超過 30 天的 files-YYYY-MM-DD.jsonl');

  // 日誌目錄不可寫（指到一個檔案）：record 不丟例外，只警告
  const blocker = path.join(fx.base, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const broken = createFilesAudit({ logDir: path.join(blocker, 'sub'), warn: (l) => warns.push(l) });
  broken.record({ ip: '1.1.1.1', endpoint: 'raw', status: 200, result: 'ok', bytes: 10 });
  await broken.drain();
  assert.ok(warns.some((w) => w.includes('寫入失敗')));
  assert.strictEqual(broken.snapshot().log.writable, false);
  assert.strictEqual(broken.snapshot().stats.bytesSent, 10);
  ok('日誌寫入失敗只警告、統計照常');
}

/** KABBY_FILES_ROOTS 多根目錄：設定解析 + 兩個根各自 list / stat / raw + 跨根逃逸 */
/** KABBY_FILES_ALLOW_IPS 解析與比對（純函數） */
function testAllowIpsUnit(ok) {
  const allowed = (spec, ip) => ipAllowed(parseAllowIps(spec), ip);
  assert.strictEqual(allowed('', '1.2.3.4'), true);
  assert.strictEqual(allowed('  ', '1.2.3.4'), true);
  ok('白名單空白 = 不限');

  assert.strictEqual(allowed('10.1.129.*', '10.1.129.0'), true);
  assert.strictEqual(allowed('10.1.129.*', '10.1.129.255'), true);
  assert.strictEqual(allowed('10.1.129.*', '::ffff:10.1.129.88'), true);
  assert.strictEqual(allowed('10.1.129.*', '10.1.130.1'), false);
  assert.strictEqual(allowed('10.1.129.*', '110.1.129.1'), false);
  assert.strictEqual(allowed('10.1.*.*', '10.1.200.3'), true);
  assert.strictEqual(allowed('10.1.*.*', '10.2.0.1'), false);
  ok('萬用字元：10.1.129.* 只放行該 /24、10.1.*.* = /16、IPv4-mapped 也比對');

  assert.strictEqual(allowed('10.1.128.0/23', '10.1.129.77'), true);
  assert.strictEqual(allowed('10.1.128.0/23', '10.1.130.1'), false);
  assert.strictEqual(allowed('10.1.129.5/24', '10.1.129.200'), true, 'base 不在邊界也要套遮罩');
  assert.strictEqual(allowed('10.1.129.16/28', '10.1.129.31'), true);
  assert.strictEqual(allowed('10.1.129.16/28', '10.1.129.32'), false);
  assert.strictEqual(allowed('0.0.0.0/0', '8.8.8.8'), true);
  assert.strictEqual(allowed('192.168.1.20/32', '192.168.1.21'), false);
  assert.strictEqual(allowed('255.255.255.0/24', '255.255.255.9'), true, '高位元 IP 不可變負數');
  ok('CIDR：/23、/28、/0、/32、非邊界 base、高位元位址');

  assert.strictEqual(allowed('10.1.129.20, 192.168.1.*', '192.168.1.9'), true);
  assert.strictEqual(allowed('10.1.129.20, 192.168.1.*', '10.1.129.20'), true);
  assert.strictEqual(allowed('10.1.129.20, 192.168.1.*', '10.1.129.21'), false);
  assert.strictEqual(allowed('::1', '::1'), true);
  assert.strictEqual(allowed('::1', '127.0.0.1'), false);
  ok('單一 IP、萬用字元、IPv6 混寫');

  for (const bad of ['*', '*.1.2.3', '10.*.1.5', '10.1.129.1*', '10.1.129', '10.1.129.256', '10.1.129.0/33',
    '10.1.129.0/', '10.1.129.0/24/1', 'abc', '10.1.129.*/24']) {
    const parsed = parseAllowIps(bad);
    assert.deepStrictEqual(parsed.invalid, [bad], `應判為不合法：${bad}`);
    assert.strictEqual(ipAllowed(parsed, '10.1.129.5'), false, `全部不合法要一律拒絕：${bad}`);
  }
  const mixed = parseAllowIps('bogus, 10.1.129.*');
  assert.deepStrictEqual(mixed.invalid, ['bogus']);
  assert.strictEqual(ipAllowed(mixed, '10.1.129.5'), true);
  ok('不合法項目：單獨 *、中間 *、半段 *、超過 255、/33… 被略過；全不合法 → 全擋');
}

async function testMultiRoots(fx, ok) {
  // fixture：repo（腳本 + .git + 指向 models 的 junction）、models（權重檔）
  const repo = path.join(fx.base, 'repo');
  const models = path.join(fx.base, 'models');
  fs.mkdirSync(path.join(repo, 'executor'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(models, 'hf', 'vae'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'executor', 'pull.py'), 'print("pull")\n');
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[core]');
  const weights = crypto.randomBytes(64 * 1024 + 3);
  fs.writeFileSync(path.join(models, 'hf', 'vae', 'x.safetensors'), weights);
  let hasLink = false;
  try {
    fs.symlinkSync(models, path.join(repo, 'models-link'), process.platform === 'win32' ? 'junction' : 'dir');
    hasLink = true;
  } catch {}

  // --- parseFilesConfig ---
  let cfg = parseFilesConfig({ roots: `repo=${repo};models=${models}` });
  assert.strictEqual(cfg.mode, 'multi');
  assert.deepStrictEqual(cfg.roots.map((r) => r.name), ['repo', 'models']);
  assert.deepStrictEqual([cfg.errors, cfg.warnings], [[], []]);
  cfg = parseFilesConfig({ roots: ` repo = ${repo} ; ; models=${models};` });
  assert.strictEqual(cfg.mode, 'multi', '容許空白與多餘分號');
  const bads = [
    [`repo=${repo};repo=${models}`, '名稱重複'],
    [`Repo=${repo}`, '名稱不合法'],
    [`re po=${repo}`, '名稱不合法'],
    [`repo=${path.join(fx.base, 'nope')}`, '不存在'],
    [`repo=${path.join(repo, 'executor', 'pull.py')}`, '不是目錄'],
    ['repo=relative\\dir', '絕對路徑'],
    [`${repo}`, '格式錯誤'],
  ];
  for (const [value, expectMsg] of bads) {
    cfg = parseFilesConfig({ roots: value });
    assert.strictEqual(cfg.mode, 'off', value);
    assert.ok(cfg.errors.some((e) => e.includes(expectMsg)), `${value} → ${cfg.errors.join(' / ')}`);
  }
  cfg = parseFilesConfig({ root: fx.root, roots: `models=${models}` });
  assert.strictEqual(cfg.mode, 'multi');
  assert.strictEqual(cfg.warnings.length, 1);
  assert.strictEqual(parseFilesConfig({ root: fx.root }).mode, 'single');
  assert.strictEqual(parseFilesConfig({}).mode, 'off');
  ok('KABBY_FILES_ROOTS 解析：合法 / 重複 / 非法名稱 / 不存在 / 非目錄 / 相對路徑 / 兩者都設警告');

  const srv = await startMini({ roots: `repo=${repo};models=${models}` });
  const srvBad = await startMini({ roots: `repo=${repo};repo=${models}` });
  const url = (s, p) => `http://127.0.0.1:${s.address().port}/api/files${p}`;
  const get = (p, headers = {}) => fetch(url(srv, p), { headers });
  const q = encodeURIComponent;
  try {
    // 根清單
    for (const p of ['/list', '/list?path=', '/list?recursive=1']) {
      const body = await (await get(p)).json();
      assert.strictEqual(body.root, null);
      assert.strictEqual(body.path, '');
      assert.deepStrictEqual(body.entries.map((e) => [e.path, e.isDir]), [['repo', true], ['models', true]]);
      assert.ok(!JSON.stringify(body).includes(fx.base), '根清單不可回絕對路徑');
    }
    ok('根清單：只列名稱（recursive 也不遞迴）、不回絕對路徑');

    let body = await (await get('/list?path=repo&recursive=1')).json();
    assert.strictEqual(body.root, 'repo');
    assert.strictEqual(body.path, 'repo');
    assert.deepStrictEqual(body.entries.map((e) => e.path).sort(), ['repo/executor', 'repo/executor/pull.py']);
    body = await (await get(`/list?path=${q('models/hf')}&recursive=1`)).json();
    assert.strictEqual(body.root, 'models');
    assert.deepStrictEqual(body.entries.map((e) => e.path).sort(),
      ['models/hf/vae', 'models/hf/vae/x.safetensors']);
    ok('兩個根各自 list：path 帶名稱前綴、root 回名稱、不列 .git 與 junction');

    body = await (await get(`/stat?path=${q('models\\hf\\vae\\x.safetensors')}&hash=1`)).json();
    assert.strictEqual(body.path, 'models/hf/vae/x.safetensors');
    assert.strictEqual(body.size, weights.length);
    assert.strictEqual(body.sha256, crypto.createHash('sha256').update(weights).digest('hex'));
    body = await (await get('/stat?path=repo/executor/pull.py')).json();
    assert.strictEqual(body.path, 'repo/executor/pull.py');
    assert.strictEqual((await get('/stat?path=repo')).status, 400);
    assert.strictEqual((await get('/stat')).status, 400);
    ok('stat：兩個根各自正確、sha256 正確、對根目錄 / 空路徑 → 400');

    let r = await get('/raw?path=models/hf/vae/x.safetensors', { Range: 'bytes=0-99' });
    assert.strictEqual(r.status, 206);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(weights.subarray(0, 100)));
    r = await get('/raw?path=repo/executor/pull.py');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await r.text(), 'print("pull")\n');
    ok('raw：兩個根各自下載、Range 206');

    for (const p of ['nope/x.bin', 'nope', 'Repo/executor/pull.py']) {
      r = await get(`/raw?path=${q(p)}`);
      assert.strictEqual(r.status, 404, p);
      assert.deepStrictEqual(await r.json(), { error: 'unknown root' });
    }
    assert.strictEqual((await get('/list?path=nope')).status, 404);
    ok('未知名稱 → 404 unknown root');

    assert.strictEqual((await get(`/raw?path=${q('repo/../models/hf/vae/x.safetensors')}`)).status, 400);
    if (hasLink) {
      assert.strictEqual((await get(`/raw?path=${q('repo/models-link/hf/vae/x.safetensors')}`)).status, 400);
      assert.strictEqual((await get(`/list?path=${q('repo/models-link')}`)).status, 400);
    }
    assert.strictEqual((await get('/raw?path=repo/.git/config')).status, 404);
    assert.strictEqual((await get('/raw?path=.git/config')).status, 404);
    ok('從 repo 用 .. 或 junction 跳到 models → 400；點開頭 → 404');

    assert.strictEqual((await fetch(url(srvBad, '/list'))).status, 404);
    ok('ROOTS 不合規 → /api/files 停用（404）');
  } finally {
    srv.close(); srvBad.close();
  }
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
