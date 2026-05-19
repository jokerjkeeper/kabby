/**
 * Phase 1 smoke test：
 *   1. POST /api/sessions 建一個 session（用 cmd.exe 代替 cc，純測 PTY/WS pipeline）
 *   2. 開兩個 WS 連上
 *   3. WS-A 發 "echo HELLO\r"
 *   4. 驗 WS-A 和 WS-B 都收到含 "HELLO" 的 output
 *   5. DELETE session
 */
const WebSocket = require('ws');

const BASE = 'http://localhost:3700';
const IS_WINDOWS = process.platform === 'win32';

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function del(path) {
  const r = await fetch(BASE + path, { method: 'DELETE' });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function attach(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:3700/ws/${id}`);
    const received = [];
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'output') received.push(msg.data);
      } catch {}
    });
    ws.on('open', () => resolve({ ws, received }));
    ws.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const fails = [];
  let sessionId;
  try {
    // 1. health
    const h = await fetch(BASE + '/api/health').then((r) => r.json());
    console.log('health:', h);

    // 2. create session
    const created = await post('/api/sessions', {
      name: `smoke-${Date.now()}`,
      cwd: process.cwd(),
      cmd: IS_WINDOWS ? 'cmd.exe' : 'bash',
      args: IS_WINDOWS ? [] : ['-i'],
      cols: 80,
      rows: 24,
    });
    console.log('create:', created.status, created.body && created.body.name);
    if (created.status !== 201) throw new Error('create failed');
    sessionId = created.body.id;

    // wait for prompt to appear in scrollback
    await sleep(500);

    // 3. attach 2 WS clients
    const a = await attach(sessionId);
    const b = await attach(sessionId);
    console.log('attached: A and B');
    await sleep(200);

    // 4. send input from A
    const marker = 'KABBY_SMOKE_OK_' + Math.random().toString(36).slice(2, 8);
    a.ws.send(JSON.stringify({ type: 'input', data: `echo ${marker}\r` }));

    // 5. wait & check both received marker
    await sleep(800);
    const aGot = a.received.join('').includes(marker);
    const bGot = b.received.join('').includes(marker);
    console.log(`A got marker: ${aGot}`);
    console.log(`B got marker: ${bGot}`);
    if (!aGot) fails.push('A did not receive marker');
    if (!bGot) fails.push('B did not receive marker (fan-out broken)');

    // 6. list sessions, should see clientCount === 2
    const list = await fetch(BASE + '/api/sessions').then((r) => r.json());
    const me = list.find((s) => s.id === sessionId);
    console.log('clientCount:', me && me.clientCount);
    if (!me || me.clientCount !== 2) fails.push(`clientCount expected 2, got ${me && me.clientCount}`);

    // 7. scrollback replay test: attach a 3rd client, should immediately receive past output
    const c = await attach(sessionId);
    await sleep(300);
    const cGot = c.received.join('').includes(marker);
    console.log(`C (late join) got marker via scrollback: ${cGot}`);
    if (!cGot) fails.push('C did not receive marker via scrollback replay');

    a.ws.close();
    b.ws.close();
    c.ws.close();
    await sleep(200);
  } catch (err) {
    fails.push('exception: ' + err.message);
  } finally {
    if (sessionId) {
      const d = await del('/api/sessions/' + sessionId);
      console.log('delete:', d.status);
    }
  }

  if (fails.length) {
    console.log('\nFAIL:');
    fails.forEach((f) => console.log('  -', f));
    process.exit(1);
  } else {
    console.log('\nPASS — Phase 1 smoke test 全部通過');
    process.exit(0);
  }
})();
