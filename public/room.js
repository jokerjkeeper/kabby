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
  let role = 'guest';       // 由 join / room-init 帶回：master | collab | guest
  let roomFrozen = false;   // 房間層級凍結狀態（房主控制；跟本地「看自己畫面」的 frozen 不同）
  let pendingInvite = null; // 分享連結帶的邀請碼（?invite=）；有它就不需手動輸密碼
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let closedByServer = false;
  // 畫面跟隨控制：frozen=true 時進來的輸出先暫存，不寫進終端（訪客慢慢看）
  let frozen = false;
  let pendingOutput = [];
  let pendingBytes = 0;
  let pendingOverflow = false;
  const PENDING_MAX = 2 * 1024 * 1024;   // 暫存上限；爆掉就整屏重來（reset + 尾段）

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
  const roleBadge = document.getElementById('role-badge');
  const masterFreezeBtn = document.getElementById('master-freeze-btn');
  const masterCloseBtn = document.getElementById('master-close-btn');
  const ROLE_LABEL = { master: '房主', collab: '協作', guest: '訪客' };

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

  // ── 貼圖：壓縮成 data URL 直接走 WS（伺服器端存記憶體，只留最近 20 張）──
  const CHAT_IMG_MAX = 2 * 1024 * 1024;
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  async function prepareChatImage(file) {
    if (!file || !/^image\//.test(file.type)) return null;
    const raw = await fileToDataUrl(file);
    if (file.type === 'image/gif') return raw.length <= CHAT_IMG_MAX ? raw : null;
    if (raw.length <= 300_000) return raw;
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = raw; });
    const MAX_DIM = 1600;
    const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    let out = canvas.toDataURL('image/jpeg', 0.85);
    if (out.length > CHAT_IMG_MAX) out = canvas.toDataURL('image/jpeg', 0.6);
    return out.length <= CHAT_IMG_MAX ? out : null;
  }

  const lightbox = document.getElementById('img-lightbox');
  function openLightbox(src) {
    lightbox.querySelector('img').src = src;
    lightbox.classList.add('visible');
  }
  lightbox.addEventListener('click', () => {
    lightbox.classList.remove('visible');
    lightbox.querySelector('img').src = '';
  });

  // ── @mention：文字上色 + 被 tag 提示 + 輸入補齊 ──
  function renderChatText(text, selfName) {
    return escapeHtml(text).replace(/@([^\s@]{1,24})/g, (m0, name) =>
      `<span class="mention${name === selfName ? ' me' : ''}">@${name}</span>`);
  }
  function isMentioned(text, selfName) {
    return typeof text === 'string' && selfName && text.includes('@' + selfName);
  }

  let knownGuests = [];   // 最近一次 presence 名單（mention 候選用）
  function mentionCandidates() {
    const self = joinInfo ? joinInfo.nickname : null;
    const names = knownGuests.map((g) => g.nickname).filter((n) => n !== self);
    names.unshift('房主');
    return names;
  }

  function setupMention(inputEl, popEl, getCandidates) {
    let items = [];
    let active = 0;
    let atStart = -1;

    function close() { popEl.classList.remove('visible'); items = []; atStart = -1; }
    function render() {
      popEl.innerHTML = items.map((n, i) =>
        `<div class="mi${i === active ? ' active' : ''}" data-i="${i}">@${escapeHtml(n)}</div>`).join('');
      popEl.classList.add('visible');
    }
    function pick(i) {
      const name = items[i];
      if (name == null) { close(); return; }
      const v = inputEl.value;
      const caret = inputEl.selectionStart;
      inputEl.value = v.slice(0, atStart) + '@' + name + ' ' + v.slice(caret);
      const pos = atStart + name.length + 2;
      inputEl.setSelectionRange(pos, pos);
      inputEl.focus();
      close();
    }
    function update() {
      const caret = inputEl.selectionStart;
      const before = inputEl.value.slice(0, caret);
      const at = before.lastIndexOf('@');
      if (at < 0 || (at > 0 && !/\s/.test(before[at - 1])) || /\s/.test(before.slice(at + 1))) { close(); return; }
      const prefix = before.slice(at + 1).toLowerCase();
      items = getCandidates().filter((n) => n.toLowerCase().startsWith(prefix));
      if (!items.length) { close(); return; }
      atStart = at;
      active = 0;
      render();
    }
    inputEl.addEventListener('input', update);
    inputEl.addEventListener('click', update);
    inputEl.addEventListener('keydown', (e) => {
      if (!popEl.classList.contains('visible')) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); pick(active); }
      else if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });
    inputEl.addEventListener('blur', () => setTimeout(close, 150));
    popEl.addEventListener('mousedown', (e) => {
      const mi = e.target.closest('.mi');
      if (mi) { e.preventDefault(); pick(parseInt(mi.dataset.i, 10)); }
    });
    return { isOpen: () => popEl.classList.contains('visible') };
  }

  // ── 入房表單（note = 頂部提示，例如「房間已關閉」）──
  function showJoinForm(note) {
    overlay.classList.remove('hidden');
    joinBox.innerHTML = `
      <h2>進入 kabby 聊天室</h2>
      <div class="sub">輸入房主給你的密碼與你的暱稱（密碼決定你的角色：房主／協作／訪客）</div>
      ${note ? `<div class="closed-note" style="margin-bottom:10px">${escapeHtml(note)}</div>` : ''}
      <label for="join-key">密碼</label>
      <input id="join-key" type="text" autocomplete="off" spellcheck="false" />
      <label for="join-nick">暱稱</label>
      <input id="join-nick" type="text" maxlength="24" autocomplete="off" />
      <div class="error" id="join-error"></div>
      <div class="actions"><button class="btn" id="join-submit">進入</button></div>
    `;
    const keyEl = document.getElementById('join-key');
    const nickEl = document.getElementById('join-nick');
    const params = new URLSearchParams(location.search);
    pendingInvite = params.get('invite') || null;
    const pref = params.get('pw') || params.get('key'); // pw / key（相容舊連結，明文）
    if (pendingInvite) {
      // 邀請連結：不需手動輸密碼，藏掉密碼欄，只問暱稱
      keyEl.style.display = 'none';
      const lbl = joinBox.querySelector('label[for="join-key"]');
      if (lbl) lbl.style.display = 'none';
      const sub = joinBox.querySelector('.sub');
      if (sub) sub.textContent = '你透過邀請連結進房，輸入暱稱即可。';
    } else if (pref) {
      keyEl.value = pref;
    }
    const submit = () => submitJoin(keyEl, nickEl, document.getElementById('join-error'));
    document.getElementById('join-submit').addEventListener('click', submit);
    [keyEl, nickEl].forEach((el) =>
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));
    (keyEl.value ? nickEl : keyEl).focus();
  }

  async function submitJoin(keyEl, nickEl, errEl) {
    const password = keyEl.value.trim();
    const nickname = nickEl.value.trim();
    if (!pendingInvite && !password) { errEl.textContent = '請輸入密碼'; return; }
    if (!nickname) { errEl.textContent = '請輸入暱稱'; return; }
    errEl.textContent = '';
    try {
      const body = pendingInvite ? { invite: pendingInvite, nickname } : { password, nickname };
      const res = await fetch('/api/rooms/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
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
    applyRole(joinInfo.role || 'guest');
    setAllowWrite(!!joinInfo.allowWrite, true);
    if (!term) {
      term = new Terminal({
        cursorBlink: false,
        fontSize: 14,
        fontFamily: "'Cascadia Code', Consolas, monospace",
        lineHeight: 1.25,
        theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#aeafad' },
        scrollback: 5000,
        allowProposedApi: true,
      });
      const termSide = document.getElementById('term-side');
      term.open(termSide);
      term.onData((data) => {
        if (!allowWrite) return;   // 前端輔助；伺服器端也會擋
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
      });
      // 滾輪 = 純本地捲動（capture 搶在 xterm 前面）。
      // 不攔的話 xterm 會把滾輪轉成方向鍵/滑鼠事件送給 cc → cc 捲動重繪 → 所有人畫面一起動。
      // 這裡讓訪客的滾輪只捲自己的 scrollback，永不影響共享畫面。
      termSide.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const lines = e.deltaMode === 1 ? Math.round(e.deltaY) : Math.round(e.deltaY / 33) || Math.sign(e.deltaY);
        term.scrollLines(lines);
        updateScrollIndicator();
      }, { passive: false, capture: true });
      term.onScroll(() => updateScrollIndicator());
    } else {
      term.reset();
    }
    setFrozen(false, true);
    connect();
  }

  // ── 畫面跟隨控制 ──
  const pauseBtn = document.getElementById('pause-btn');
  const frozenHint = document.getElementById('frozen-hint');
  const scrollLatestBtn = document.getElementById('scroll-latest');

  function atBottom() {
    if (!term) return true;
    const buf = term.buffer.active;
    return buf.viewportY >= buf.baseY;
  }
  function updateScrollIndicator() {
    scrollLatestBtn.classList.toggle('visible', frozen || !atBottom());
  }
  function setFrozen(v, silent) {
    frozen = !!v;
    pauseBtn.classList.toggle('paused', frozen);
    pauseBtn.textContent = frozen ? '▶ 回房主畫面' : '⏸ 看自己畫面';
    frozenHint.classList.toggle('visible', frozen);
    if (!frozen) {
      // 恢復：補上暫存的輸出；爆過量就重置終端只寫尾段（避免卡死）
      if (pendingOverflow && term) term.reset();
      if (pendingOutput.length && term) term.write(pendingOutput.join(''));
      pendingOutput = [];
      pendingBytes = 0;
      pendingOverflow = false;
      if (term) term.scrollToBottom();
      if (!silent) showToast('已切回房主畫面（即時跟隨）');
    } else if (!silent) {
      showToast('已切到自己畫面：定格不動，房主的新輸出暫存中', 'warn');
    }
    updateScrollIndicator();
  }
  pauseBtn.addEventListener('click', () => setFrozen(!frozen));
  scrollLatestBtn.addEventListener('click', () => {
    if (frozen) setFrozen(false);
    else if (term) { term.scrollToBottom(); updateScrollIndicator(); }
  });

  // ── 乾淨版對話記錄（邏輯集中在共用的 convo-view.js）──
  const convoView = window.createConvoView({
    elements: {
      panel: document.getElementById('convo-panel'),
      body: document.getElementById('convo-body'),
      status: document.getElementById('convo-status'),
      search: document.getElementById('convo-search'),
      toolsToggle: document.getElementById('convo-tools-toggle'),
      readerToggle: document.getElementById('convo-reader-toggle'),
      closeBtn: document.getElementById('convo-close'),
      refreshBtn: document.getElementById('convo-refresh'),
      exportMdBtn: document.getElementById('convo-export-md'),
      exportHtmlBtn: document.getElementById('convo-export-html'),
      triggerBtn: document.getElementById('convo-btn'),
    },
    onToast: showToast,
    fetchTurns: async () => {
      if (!joinInfo) throw new Error('尚未入房');
      const res = await fetch('/api/rooms/guest/conversation?ticket=' + encodeURIComponent(joinInfo.ticket));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    },
  });
  document.getElementById('convo-btn').addEventListener('click', () => convoView.toggle());

  // 依角色更新 UI：角色徽章、房主工具列顯示、訪客名單踢人鈕
  function applyRole(r) {
    role = r || 'guest';
    if (roleBadge) {
      roleBadge.textContent = ROLE_LABEL[role] || role;
      roleBadge.className = 'perm-badge ' + (role === 'master' ? 'rw' : 'ro');
    }
    const isMaster = role === 'master';
    if (masterFreezeBtn) masterFreezeBtn.style.display = isMaster ? '' : 'none';
    if (masterCloseBtn) masterCloseBtn.style.display = isMaster ? '' : 'none';
    updateFreezeBtn();
    renderGuests(knownGuests || []);   // 重繪以顯示/隱藏踢人鈕
  }

  function updateFreezeBtn() {
    if (masterFreezeBtn) masterFreezeBtn.textContent = roomFrozen ? '🔥 解除凍結' : '🧊 凍結';
  }

  // 房主管理指令（凍結/踢人/關房）走終端 WS，伺服器只受理 master ticket
  function sendRoomAdmin(action, extra) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(Object.assign({ type: 'room-admin', action }, extra || {})));
    }
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
      reconnectTimer = setTimeout(() => {
        if (term) term.reset();
        setFrozen(false, true);   // 重連 replay 全量畫面，凍結狀態沒意義
        connect();
      }, 3000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'output':
        reconnectAttempts = 0;
        if (frozen) {
          // 凍結中：暫存輸出不上屏。超過上限就標記 overflow，恢復時 reset 只寫尾段
          pendingOutput.push(msg.data);
          pendingBytes += msg.data.length;
          while (pendingBytes > PENDING_MAX && pendingOutput.length > 1) {
            pendingBytes -= pendingOutput.shift().length;
            pendingOverflow = true;
          }
        } else if (term) {
          term.write(msg.data);
          updateScrollIndicator();
        }
        break;
      case 'termsize':
        // 跟隨 PTY 尺寸（訪客不能 resize，只能遷就）；超出視窗由容器捲動
        if (term && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          try { term.resize(msg.cols, msg.rows); } catch {}
        }
        break;
      case 'room-init':
        reconnectAttempts = 0;
        if (msg.role) applyRole(msg.role);
        if (msg.room) {
          roomNameEl.textContent = msg.room.name || '聊天室';
          sessionNameEl.textContent = msg.room.sessionName ? `· ${msg.room.sessionName}` : '';
          roomFrozen = !!msg.room.frozen;
          updateFreezeBtn();
          setAllowWrite(!!msg.room.allowWrite, true);
        }
        chatMsgsEl.innerHTML = '';
        for (const m of msg.chatLog || []) appendChat(m, true);
        renderGuests(msg.guests || []);
        break;
      case 'chat':
        appendChat(msg);
        break;
      case 'room-presence':
        renderGuests(msg.guests || []);
        break;
      case 'room-config':
        if (typeof msg.frozen === 'boolean') { roomFrozen = msg.frozen; updateFreezeBtn(); }
        if (typeof msg.allowWrite === 'boolean') setAllowWrite(msg.allowWrite);
        break;
      case 'room-closed':
        closedByServer = true;
        convoView.close();
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
  function appendChat(m, isReplay) {
    const el = document.createElement('div');
    if (m.from === 'system') {
      el.className = 'msg system';
      el.textContent = m.text;
    } else {
      const selfName = joinInfo ? joinInfo.nickname : null;
      const mine = m.from === 'guest' && m.nickname === selfName;
      const mentioned = !mine && isMentioned(m.text, selfName);
      el.className = 'msg ' + (m.from === 'host' ? 'host' : 'guest') + (mine ? ' me' : '') + (mentioned ? ' mentioned' : '');
      const ts = m.ts ? new Date(m.ts).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
      let body = m.text ? renderChatText(m.text, selfName) : '';
      if (m.image) body += `<img class="chat-img" src="${m.image}" alt="貼圖" />`;
      else if (m.imageExpired) body += '<span class="img-expired">[圖片已釋放（僅保留最近 20 張）]</span>';
      el.innerHTML = `<span class="who">${escapeHtml(m.from === 'host' ? '房主' : m.nickname || '訪客')}</span>`
        + `${body}<span class="ts">${ts}</span>`;
      const img = el.querySelector('.chat-img');
      if (img) img.addEventListener('click', () => openLightbox(m.image));
      if (mentioned && !isReplay) showToast(`💬 ${m.from === 'host' ? '房主' : m.nickname} tag 了你`, 'warn');
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

  async function sendImage(file) {
    if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('未連線，圖片未送出', 'warn'); return; }
    let dataUrl = null;
    try { dataUrl = await prepareChatImage(file); } catch {}
    if (!dataUrl) { showToast('圖片讀取失敗或壓縮後仍超過大小上限', 'warn'); return; }
    ws.send(JSON.stringify({ type: 'chat', image: dataUrl }));
  }

  function renderGuests(guests) {
    knownGuests = guests;   // mention 候選同步更新
    guestCountEl.textContent = guests.length ? `${guests.filter((g) => g.online).length}/${guests.length} 在線` : '';
    const myTicket = joinInfo && joinInfo.ticket;
    guestListEl.innerHTML = guests.map((g) => {
      const roleTag = g.role && g.role !== 'guest'
        ? `<span style="opacity:.55;font-size:9px"> ${ROLE_LABEL[g.role] || g.role}</span>` : '';
      const kick = (role === 'master' && g.ticket && g.ticket !== myTicket)
        ? `<button data-kick="${escapeHtml(g.ticket)}" title="移出此人" style="margin-left:4px;border:0;background:transparent;color:#e06c6c;cursor:pointer;font-size:12px;line-height:1">×</button>` : '';
      return `<span class="guest-chip ${g.online ? 'online' : 'offline'}"><span class="dot">●</span>${escapeHtml(g.nickname)}${roleTag}${kick}</span>`;
    }).join('');
    if (role === 'master') {
      guestListEl.querySelectorAll('[data-kick]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (confirm('把這位成員移出聊天室？')) sendRoomAdmin('kick', { ticket: btn.dataset.kick });
        });
      });
    }
  }

  // ── 綁事件 + boot ──
  document.getElementById('chat-send').addEventListener('click', sendChat);

  // @mention 補齊（開著時 Enter 是選字，不送出）
  const mention = setupMention(chatInputEl, document.getElementById('mention-pop'), mentionCandidates);
  chatInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !mention.isOpen()) sendChat();
  });

  // 貼圖：🖼 按鈕選檔 / 輸入框 Ctrl+V 貼截圖
  const chatFileEl = document.getElementById('chat-file');
  document.getElementById('chat-img').addEventListener('click', () => chatFileEl.click());
  chatFileEl.addEventListener('change', () => {
    if (chatFileEl.files[0]) sendImage(chatFileEl.files[0]);
    chatFileEl.value = '';
  });
  chatInputEl.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) { e.preventDefault(); sendImage(item.getAsFile()); }
  });

  // 聊天欄寬度拖曳（左緣把手），存 localStorage
  (function initChatResize() {
    const handle = document.getElementById('chat-resize');
    const root = document.documentElement;
    try {
      const saved = parseInt(localStorage.getItem('kabby-room-chat-w') || '', 10);
      if (saved >= 220 && saved <= 640) root.style.setProperty('--chat-w', saved + 'px');
    } catch {}
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      const onMove = (ev) => {
        const w = Math.max(220, Math.min(640, window.innerWidth - ev.clientX));
        root.style.setProperty('--chat-w', w + 'px');
      };
      const onUp = (ev) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        handle.classList.remove('dragging');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        const w = Math.max(220, Math.min(640, window.innerWidth - ev.clientX));
        try { localStorage.setItem('kabby-room-chat-w', String(w)); } catch {}
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  })();

  document.getElementById('leave-btn').addEventListener('click', leaveRoom);
  if (masterFreezeBtn) masterFreezeBtn.addEventListener('click', () => sendRoomAdmin(roomFrozen ? 'unfreeze' : 'freeze'));
  if (masterCloseBtn) masterCloseBtn.addEventListener('click', () => {
    if (confirm('關閉整個聊天室？所有人會被斷開。（綁定的 session 不受影響）')) sendRoomAdmin('close');
  });

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
