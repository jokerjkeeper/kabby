/* kabby 聊天室 — 訪客頁
 * 流程：key + 暱稱 → POST /api/rooms/join 換 ticket → WS /ws/:sessionId?ticket=
 * 同一條 WS 收終端輸出（output/termsize/exit）與聊天室訊息（chat/room-*）。
 * ticket 存 sessionStorage：刷新頁面自動重連；房間關閉或 daemon 重啟則失效回到入房表單。
 */
(() => {
  const STORAGE_KEY = 'kabby-room-guest';
  const MAX_RECONNECT = 5;

  let joinInfo = null;      // { ticket, roomId, roomName, sessionId, sessionName, allowWrite, nickname }
  let ws = null;
  let term = null;
  let allowWrite = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let closedByServer = false;

  // ── DOM ──
  const overlay = document.getElementById('overlay');
  const joinBox = document.getElementById('join-box');
  const roomNameEl = document.getElementById('room-name');
  const sessionNameEl = document.getElementById('session-name');
  const permBadge = document.getElementById('perm-badge');
  const meNickEl = document.getElementById('me-nick');
  const connDot = document.getElementById('conn-dot');
  const chatMsgsEl = document.getElementById('chat-msgs');
  const chatInputEl = document.getElementById('chat-input');
  const guestListEl = document.getElementById('guest-list');
  const guestCountEl = document.getElementById('guest-count');

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }

  function showToast(text, kind) {
    const host = document.getElementById('toast-host');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = text;
    host.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 4000);
  }

  // ── 入房表單（note = 頂部提示，例如「房間已關閉」）──
  function showJoinForm(note) {
    overlay.classList.remove('hidden');
    joinBox.innerHTML = `
      <h2>進入 kabby 聊天室</h2>
      <div class="sub">輸入房主給你的 key 與你的暱稱</div>
      ${note ? `<div class="closed-note" style="margin-bottom:10px">${escapeHtml(note)}</div>` : ''}
      <label for="join-key">聊天室 key</label>
      <input id="join-key" type="text" autocomplete="off" spellcheck="false" />
      <label for="join-nick">暱稱</label>
      <input id="join-nick" type="text" maxlength="24" autocomplete="off" />
      <div class="error" id="join-error"></div>
      <div class="actions"><button class="btn" id="join-submit">進入</button></div>
    `;
    const keyEl = document.getElementById('join-key');
    const nickEl = document.getElementById('join-nick');
    const params = new URLSearchParams(location.search);
    if (params.get('key')) keyEl.value = params.get('key');
    const submit = () => submitJoin(keyEl, nickEl, document.getElementById('join-error'));
    document.getElementById('join-submit').addEventListener('click', submit);
    [keyEl, nickEl].forEach((el) =>
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));
    (keyEl.value ? nickEl : keyEl).focus();
  }

  async function submitJoin(keyEl, nickEl, errEl) {
    const key = keyEl.value.trim();
    const nickname = nickEl.value.trim();
    if (!key) { errEl.textContent = '請輸入 key'; return; }
    if (!nickname) { errEl.textContent = '請輸入暱稱'; return; }
    errEl.textContent = '';
    try {
      const res = await fetch('/api/rooms/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, nickname }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
      joinInfo = json;
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(json)); } catch {}
      enterRoom();
    } catch (err) {
      errEl.textContent = err.message;
    }
  }

  function leaveRoom() {
    closedByServer = true;   // 別觸發自動重連
    try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
    if (ws) { try { ws.close(); } catch {} ws = null; }
    location.href = location.pathname; // 清 query 回到入房表單
  }

  // ── 進房：建終端 + 連 WS ──
  function enterRoom() {
    overlay.classList.add('hidden');
    closedByServer = false;
    reconnectAttempts = 0;
    roomNameEl.textContent = joinInfo.roomName || '聊天室';
    sessionNameEl.textContent = joinInfo.sessionName ? `· ${joinInfo.sessionName}` : '';
    meNickEl.textContent = joinInfo.nickname;
    setAllowWrite(!!joinInfo.allowWrite, true);
    if (!term) {
      term = new Terminal({
        cursorBlink: false,
        fontSize: 14,
        fontFamily: "'Cascadia Code', Consolas, monospace",
        theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#aeafad' },
        scrollback: 5000,
        allowProposedApi: true,
      });
      term.open(document.getElementById('term-side'));
      term.onData((data) => {
        if (!allowWrite) return;   // 前端輔助；伺服器端也會擋
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
      });
    } else {
      term.reset();
    }
    connect();
  }

  function setAllowWrite(v, silent) {
    allowWrite = !!v;
    permBadge.className = 'perm-badge ' + (allowWrite ? 'rw' : 'ro');
    permBadge.textContent = allowWrite ? '可輸入' : '唯讀';
    permBadge.title = allowWrite
      ? '房主已開放你在終端輸入（點終端直接打字）'
      : '唯讀模式：只能看終端與聊天，不能輸入指令';
    if (!silent) showToast(allowWrite ? '房主開放了終端輸入' : '已切換為唯讀模式', allowWrite ? '' : 'warn');
  }

  function connect() {
    if (ws) { try { ws.close(); } catch {} }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/${encodeURIComponent(joinInfo.sessionId)}?ticket=${encodeURIComponent(joinInfo.ticket)}`;
    ws = new WebSocket(url);

    ws.onopen = () => { connDot.classList.remove('off'); connDot.classList.add('on'); };
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleMessage(msg);
    };
    ws.onclose = () => {
      connDot.classList.remove('on');
      connDot.classList.add('off');
      if (closedByServer) return;
      // 非預期斷線（daemon 重啟 / 網路閃斷）→ 3 秒後重連；連續失敗 → 回入房表單
      reconnectAttempts += 1;
      if (reconnectAttempts > MAX_RECONNECT) {
        try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
        showJoinForm('連線中斷且無法重連（房間可能已關閉或伺服器重啟），請重新入房。');
        return;
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => { if (term) term.reset(); connect(); }, 3000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'output':
        reconnectAttempts = 0;
        if (term) term.write(msg.data);
        break;
      case 'termsize':
        // 跟隨 PTY 尺寸（訪客不能 resize，只能遷就）；超出視窗由容器捲動
        if (term && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          try { term.resize(msg.cols, msg.rows); } catch {}
        }
        break;
      case 'room-init':
        reconnectAttempts = 0;
        if (msg.room) {
          roomNameEl.textContent = msg.room.name || '聊天室';
          sessionNameEl.textContent = msg.room.sessionName ? `· ${msg.room.sessionName}` : '';
          setAllowWrite(!!msg.room.allowWrite, true);
        }
        chatMsgsEl.innerHTML = '';
        for (const m of msg.chatLog || []) appendChat(m);
        renderGuests(msg.guests || []);
        break;
      case 'chat':
        appendChat(msg);
        break;
      case 'room-presence':
        renderGuests(msg.guests || []);
        break;
      case 'room-config':
        setAllowWrite(!!msg.allowWrite);
        break;
      case 'room-closed':
        closedByServer = true;
        try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
        showJoinForm(msg.reason === 'session-exit'
          ? '綁定的 session 已結束，聊天室已關閉。'
          : '房主已關閉聊天室。');
        break;
      case 'exit':
        if (term) term.write(`\r\n\x1b[33m[session exited code=${msg.code}]\x1b[0m\r\n`);
        break;
      case 'blocked':
        showToast('⚠ 輸入含敏感詞「' + (msg.words || []).join('、') + '」，已被攔截', 'warn');
        break;
    }
  }

  // ── 聊天 ──
  function appendChat(m) {
    const el = document.createElement('div');
    if (m.from === 'system') {
      el.className = 'msg system';
      el.textContent = m.text;
    } else {
      const mine = m.from === 'guest' && joinInfo && m.nickname === joinInfo.nickname;
      el.className = 'msg ' + (m.from === 'host' ? 'host' : 'guest') + (mine ? ' me' : '');
      const ts = m.ts ? new Date(m.ts).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
      el.innerHTML = `<span class="who">${escapeHtml(m.from === 'host' ? '房主' : m.nickname || '訪客')}</span>`
        + `${escapeHtml(m.text)}<span class="ts">${ts}</span>`;
    }
    chatMsgsEl.appendChild(el);
    chatMsgsEl.scrollTop = chatMsgsEl.scrollHeight;
  }

  function sendChat() {
    const text = chatInputEl.value.trim();
    if (!text) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('未連線，訊息未送出', 'warn'); return; }
    ws.send(JSON.stringify({ type: 'chat', text }));
    chatInputEl.value = '';
  }

  function renderGuests(guests) {
    guestCountEl.textContent = guests.length ? `${guests.filter((g) => g.online).length}/${guests.length} 在線` : '';
    guestListEl.innerHTML = guests.map((g) =>
      `<span class="guest-chip ${g.online ? 'online' : 'offline'}"><span class="dot">●</span>${escapeHtml(g.nickname)}</span>`
    ).join('');
  }

  // ── 綁事件 + boot ──
  document.getElementById('chat-send').addEventListener('click', sendChat);
  chatInputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  document.getElementById('leave-btn').addEventListener('click', leaveRoom);

  (function boot() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null'); } catch {}
    if (saved && saved.ticket) {
      joinInfo = saved;      // 刷新頁面 → 用舊 ticket 直接重連
      enterRoom();
    } else {
      showJoinForm();        // 統一用動態表單（含 ?key= 預填）
    }
  })();
})();
