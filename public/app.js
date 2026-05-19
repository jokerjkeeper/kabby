/* kabby Web UI — SPA (Phase 2.5 with profiles) */
(() => {
  const API = '';
  const WS_BASE = `ws://${location.host}/ws/`;
  document.getElementById('daemon-url').textContent = location.origin;

  // ──────────────────────────────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────────────────────────────
  /** @type {Map<string, {info:object, term:any, fit:any, ws:WebSocket|null, pane:HTMLElement, connected:boolean}>} */
  const panes = new Map();
  let activeId = null;
  let viewerConfigured = false;
  const expandedProfiles = new Set();      // 哪些 profile 卡片是展開的
  const historyCache = new Map();          // profileId → history array

  // ──────────────────────────────────────────────────────────────────────
  // DOM refs
  // ──────────────────────────────────────────────────────────────────────
  const profileListEl = document.getElementById('profile-list');
  const sessionListEl = document.getElementById('session-list');
  const wrap = document.getElementById('term-wrap');
  const placeholder = document.getElementById('placeholder');
  const statusText = document.getElementById('status-text');
  const metaEl = document.getElementById('meta');
  const killBtn = document.getElementById('kill-btn');
  const redrawBtn = document.getElementById('redraw-btn');
  const openViewerBtn = document.getElementById('open-viewer-btn');
  const tabListEl = document.getElementById('tab-list');
  const tabEmptyEl = document.getElementById('tab-empty');
  const helpModal = document.getElementById('help-modal');

  // ──────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }
  function shorten(s, n) {
    if (!s) return '';
    return s.length <= n ? s : '…' + s.slice(s.length - n + 1);
  }
  function timeAgo(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return '剛剛';
    if (ms < 3_600_000) return Math.floor(ms / 60_000) + ' 分鐘前';
    if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + ' 小時前';
    return Math.floor(ms / 86_400_000) + ' 天前';
  }
  function parseArgsRaw(raw) {
    if (raw === ' ') return [];
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    return trimmed.split(/\s+/);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Profiles
  // ──────────────────────────────────────────────────────────────────────
  async function fetchProfiles() {
    try { return await fetch(API + '/api/profiles').then((r) => r.json()); }
    catch { return []; }
  }

  async function fetchHistory(profileId) {
    try {
      const data = await fetch(API + '/api/profiles/' + encodeURIComponent(profileId) + '/history').then((r) => r.json());
      historyCache.set(profileId, data);
      return data;
    } catch {
      return [];
    }
  }

  function renderProfiles(profiles) {
    if (!profiles.length) {
      profileListEl.innerHTML = '<div class="empty-hint">尚無項目。點右上「+ 項目」建立。</div>';
      return;
    }
    profileListEl.innerHTML = '';
    for (const p of profiles) {
      const card = document.createElement('div');
      card.className = 'profile-card' + (expandedProfiles.has(p.id) ? ' expanded' : '');
      card.dataset.id = p.id;

      const head = document.createElement('div');
      head.className = 'profile-head';
      head.innerHTML = `
        <div class="profile-name">
          <span>${escapeHtml(p.name)}</span>
          ${p.lastSessionBusy ? '<span class="badge warn">last 掛載中</span>' : ''}
        </div>
        <div class="profile-meta">${escapeHtml(shorten(p.cwd, 38))}</div>
        <div class="profile-meta">最近：${escapeHtml(timeAgo(p.lastUsedAt))}</div>
      `;
      head.addEventListener('click', () => toggleProfile(p.id));
      card.appendChild(head);

      const body = document.createElement('div');
      body.className = 'profile-body';
      body.innerHTML = `
        <div class="profile-actions">
          <button class="btn primary tiny" data-action="new-chat">新對話</button>
          <button class="btn tiny" data-action="resume-last" ${p.lastSessionId && !p.lastSessionBusy ? '' : 'disabled'}>接續上次</button>
          <button class="btn tiny" data-action="edit">編輯</button>
          <button class="btn tiny" data-action="open-folder">歷史目錄</button>
        </div>
        <div class="history-list" data-history-list>
          <div class="empty">點開項目自動讀取歷史…</div>
        </div>
      `;
      card.appendChild(body);

      body.querySelector('[data-action="new-chat"]').addEventListener('click', (e) => { e.stopPropagation(); launchProfile(p.id); });
      body.querySelector('[data-action="resume-last"]').addEventListener('click', (e) => { e.stopPropagation(); if (p.lastSessionId) launchProfile(p.id, p.lastSessionId); });
      body.querySelector('[data-action="edit"]').addEventListener('click', (e) => { e.stopPropagation(); openProfileModal(p); });
      body.querySelector('[data-action="open-folder"]').addEventListener('click', (e) => { e.stopPropagation(); openHistoryFolder(p.id); });

      profileListEl.appendChild(card);

      // 若已展開，載入歷史列表
      if (expandedProfiles.has(p.id)) {
        renderHistoryList(p.id, body.querySelector('[data-history-list]'));
      }
    }
  }

  async function toggleProfile(id) {
    if (expandedProfiles.has(id)) {
      expandedProfiles.delete(id);
    } else {
      expandedProfiles.add(id);
      await fetchHistory(id);     // 預先抓
    }
    await refreshProfiles();
  }

  async function renderHistoryList(profileId, container) {
    let history = historyCache.get(profileId);
    if (!history) history = await fetchHistory(profileId);
    if (!history.length) {
      container.innerHTML = '<div class="empty">此目錄無 cc 對話歷史。</div>';
      return;
    }
    container.innerHTML = '';
    for (const h of history) {
      const item = document.createElement('div');
      item.className = 'history-item' + (h.busy ? ' busy' : '');
      item.innerHTML = `
        <div class="summary">${escapeHtml(h.summary || '(無摘要)')}</div>
        <div class="meta">
          <span>${escapeHtml(timeAgo(new Date(h.mtime).toISOString()))}</span>
          <span>·</span>
          <span>${escapeHtml(h.sessionId.slice(0, 8))}</span>
        </div>
      `;
      if (!h.busy) {
        item.title = '點擊接續這個 cc session';
        item.addEventListener('click', () => launchProfile(profileId, h.sessionId));
      } else {
        item.title = '此 cc session 已被另一個 kabby session 掛載中';
      }
      container.appendChild(item);
    }
  }

  async function launchProfile(profileId, resume) {
    try {
      const res = await fetch(API + '/api/profiles/' + encodeURIComponent(profileId) + '/launch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(resume ? { resume } : {}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
      // 新 PTY 上線 → busy set 變了，清 history cache 讓展開的歷史列表反映
      historyCache.clear();
      await Promise.all([refreshProfiles(), refreshSessions()]);
      activate(json.id, json);
    } catch (err) {
      alert('啟動失敗：' + err.message);
    }
  }

  async function openHistoryFolder(profileId) {
    try {
      const info = await fetch(API + '/api/profiles/' + encodeURIComponent(profileId) + '/history-dir').then((r) => r.json());
      if (!info.exists) {
        alert('該 cwd 在 cc 還沒有對話歷史目錄。\n預期位置：' + info.dir);
        return;
      }
      await fetch(API + '/api/viewer/open-folder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: info.dir }),
      });
    } catch (err) {
      alert('開啟失敗：' + err.message);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Sessions (running)
  // ──────────────────────────────────────────────────────────────────────
  async function fetchSessions() {
    try { return await fetch(API + '/api/sessions').then((r) => r.json()); }
    catch { return []; }
  }

  function renderSessions(sessions) {
    if (!sessions.length) {
      sessionListEl.innerHTML = '<div class="empty-hint">尚無運行中 session。</div>';
      return;
    }
    sessionListEl.innerHTML = '';
    for (const s of sessions) {
      const div = document.createElement('div');
      div.className = 'session-item' + (s.id === activeId ? ' active' : '') + (s.alive ? '' : ' dead');
      div.dataset.id = s.id;
      div.innerHTML = `
        <div class="session-name">
          <span>${escapeHtml(s.name)}</span>
          <span class="badge">${s.clientCount} clt</span>
          ${s.ccSessionId ? '<span class="badge" title="cc session id">resumed</span>' : ''}
        </div>
        <div class="session-meta">${escapeHtml(shorten(s.cwd, 36))}</div>
      `;
      div.addEventListener('click', () => activate(s.id, s));
      sessionListEl.appendChild(div);
    }
  }

  async function refreshSessions() {
    const sessions = await fetchSessions();
    renderSessions(sessions);
    for (const s of sessions) {
      const p = panes.get(s.id);
      if (p) p.info = s;
    }
    for (const id of [...panes.keys()]) {
      if (!sessions.find((s) => s.id === id)) closePane(id, false);
    }
  }

  async function refreshProfiles() {
    const profiles = await fetchProfiles();
    renderProfiles(profiles);
  }

  async function refreshAll() {
    await Promise.all([refreshProfiles(), refreshSessions(), refreshHealth()]);
  }

  async function refreshHealth() {
    try {
      const h = await fetch(API + '/api/health').then((r) => r.json());
      viewerConfigured = !!h.viewerConfigured;
      openViewerBtn.disabled = !viewerConfigured;
      openViewerBtn.title = viewerConfigured
        ? '開啟 cc history viewer'
        : '尚未設定 viewer：請設環境變數 KABBY_VIEWER_PATH 指向 claude-code-history-viewer.exe';
    } catch {}
  }

  // ──────────────────────────────────────────────────────────────────────
  // Tabs
  // ──────────────────────────────────────────────────────────────────────
  function renderTabs() {
    tabListEl.innerHTML = '';
    if (panes.size === 0) {
      tabEmptyEl.style.display = '';
      return;
    }
    tabEmptyEl.style.display = 'none';
    for (const [id, pane] of panes) {
      const info = pane.info || {};
      const tab = document.createElement('div');
      tab.className = 'tab' + (id === activeId ? ' active' : '');
      tab.dataset.id = id;
      tab.title = info.cwd || info.name || id;
      tab.innerHTML = `
        <span class="tab-dot ${pane.connected ? 'connected' : 'disconnected'}"></span>
        <span class="tab-name">${escapeHtml(info.name || id.slice(0, 8))}</span>
        <button class="tab-close" title="關閉 tab（保留 session，PTY 不殺）">×</button>
      `;
      tab.addEventListener('mousedown', (e) => {
        // 中鍵 = 關 tab
        if (e.button === 1) { e.preventDefault(); detachTab(id); }
      });
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.tab-close')) return;     // close 自己處理
        activate(id, info);
      });
      tab.querySelector('.tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        detachTab(id);
      });
      tabListEl.appendChild(tab);
    }
  }

  function detachTab(id) {
    // 只關 tab：斷 WS、移除 pane DOM，PTY 保留。sidebar 仍會列著該 session。
    closePane(id, false);
  }

  function switchTabByOffset(offset) {
    const ids = [...panes.keys()];
    if (ids.length < 2) return;
    const idx = ids.indexOf(activeId);
    if (idx < 0) {
      activate(ids[0], panes.get(ids[0]).info);
      return;
    }
    const next = ids[(idx + offset + ids.length) % ids.length];
    activate(next, panes.get(next).info);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Pane management
  // ──────────────────────────────────────────────────────────────────────
  function activate(id, info) {
    activeId = id;
    placeholder.classList.add('hidden');
    let p = panes.get(id);
    if (!p) {
      p = createPane(id, info);
      panes.set(id, p);
    } else if (info) {
      p.info = info;
    }
    for (const [pid, pane] of panes) {
      pane.pane.classList.toggle('visible', pid === id);
    }
    updateStatusbar(p);
    renderTabs();
    requestAnimationFrame(() => {
      try { p.fit.fit(); } catch {}
      sendResize(p);
    });
    refreshSessions();
  }

  function createPane(id, info) {
    const div = document.createElement('div');
    div.className = 'term-pane';
    wrap.appendChild(div);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#aeafad' },
      scrollback: 5000,
      allowProposedApi: true,
    });
    // Ctrl+Shift+←/→ 給 kabby 切 tab 用，xterm 不處理
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') return false;
      }
      return true;
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(div);
    try { fit.fit(); } catch {}

    const pane = { info, term, fit, ws: null, pane: div, connected: false };
    term.onData((data) => {
      if (pane.ws && pane.ws.readyState === WebSocket.OPEN) {
        pane.ws.send(JSON.stringify({ type: 'input', data }));
      }
    });
    connect(id, pane);
    return pane;
  }

  function connect(id, pane) {
    const ws = new WebSocket(WS_BASE + encodeURIComponent(id));
    pane.ws = ws;
    ws.onopen = () => {
      pane.connected = true;
      if (activeId === id) updateStatusbar(pane);
      renderTabs();
      sendResize(pane);
    };
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'output') pane.term.write(msg.data);
      else if (msg.type === 'exit') {
        pane.term.write(`\r\n\x1b[33m[session exited code=${msg.code}]\x1b[0m\r\n`);
        pane.connected = false;
        if (activeId === id) updateStatusbar(pane);
        renderTabs();
      }
    };
    ws.onclose = () => {
      pane.connected = false;
      if (activeId === id) updateStatusbar(pane);
      renderTabs();
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  function sendResize(pane) {
    if (!pane.ws || pane.ws.readyState !== WebSocket.OPEN) return;
    pane.ws.send(JSON.stringify({ type: 'resize', cols: pane.term.cols, rows: pane.term.rows }));
  }

  function closePane(id, alsoDeleteServer) {
    const p = panes.get(id);
    if (!p) return;
    try { p.ws && p.ws.close(); } catch {}
    try { p.term.dispose(); } catch {}
    p.pane.remove();
    panes.delete(id);
    if (activeId === id) {
      activeId = null;
      // 若還有其他 tab，自動切到下一個；否則回 placeholder
      const remaining = [...panes.keys()];
      if (remaining.length) {
        const nextId = remaining[0];
        activate(nextId, panes.get(nextId).info);
      } else {
        placeholder.classList.remove('hidden');
        updateStatusbar(null);
      }
    }
    renderTabs();
    if (alsoDeleteServer) {
      fetch(API + '/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' })
        .catch(() => {})
        .finally(() => {
          // 殺 session 後 busy 狀態變了 — 清 history cache，讓已展開的歷史列表重抓 busy flag
          historyCache.clear();
          refreshAll();
        });
    } else {
      refreshSessions();
    }
  }

  function updateStatusbar(pane) {
    if (!pane) {
      statusText.textContent = '未選擇 session';
      metaEl.textContent = '';
      killBtn.style.display = 'none';
      redrawBtn.style.display = 'none';
      return;
    }
    const s = pane.info;
    statusText.textContent = pane.connected
      ? `${s.name} · connected`
      : `${s.name} · disconnected`;
    statusText.style.color = pane.connected ? '#4caf50' : '#f44336';
    const ccTail = s.ccSessionId ? ` · cc:${s.ccSessionId.slice(0, 8)}` : '';
    metaEl.textContent = `${shorten(s.cwd, 50)} · ${s.cols}x${s.rows}${ccTail}`;
    killBtn.style.display = '';
    redrawBtn.style.display = '';
  }

  function redrawActive() {
    if (!activeId) return;
    const pane = panes.get(activeId);
    if (!pane || !pane.ws || pane.ws.readyState !== WebSocket.OPEN) return;
    // \x0c = Form Feed = Ctrl+L，cc 收到會重繪 TUI / 清屏
    pane.ws.send(JSON.stringify({ type: 'input', data: '\x0c' }));
  }

  // ──────────────────────────────────────────────────────────────────────
  // Session modal (temporary / ad-hoc)
  // ──────────────────────────────────────────────────────────────────────
  const sm = {
    modal: document.getElementById('session-modal'),
    name: document.getElementById('sm-name'),
    cwd: document.getElementById('sm-cwd'),
    cmd: document.getElementById('sm-cmd'),
    args: document.getElementById('sm-args'),
    err: document.getElementById('sm-error'),
    submit: document.getElementById('sm-submit'),
    chips: document.getElementById('sm-arg-chips'),
  };
  function smOpen() {
    sm.err.textContent = '';
    smSyncChips();
    sm.modal.classList.add('visible');
    setTimeout(() => sm.name.focus(), 50);
  }
  function smClose() { sm.modal.classList.remove('visible'); }
  function smReset() { sm.name.value = sm.cwd.value = sm.cmd.value = sm.args.value = ''; smSyncChips(); }
  function smTokens() { return sm.args.value.trim() ? sm.args.value.trim().split(/\s+/) : []; }
  function smSyncChips() {
    const set = new Set(smTokens());
    for (const c of sm.chips.querySelectorAll('.chip')) c.classList.toggle('active', set.has(c.dataset.flag));
  }
  sm.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    const flag = chip.dataset.flag; const t = smTokens(); const i = t.indexOf(flag);
    if (i === -1) t.push(flag); else t.splice(i, 1);
    sm.args.value = t.join(' '); smSyncChips();
  });
  sm.args.addEventListener('input', smSyncChips);

  async function smSubmit() {
    const name = sm.name.value.trim();
    if (!name) { sm.err.textContent = '請輸入名稱'; return; }
    const body = { name };
    if (sm.cwd.value.trim()) body.cwd = sm.cwd.value.trim();
    if (sm.cmd.value.trim()) body.cmd = sm.cmd.value.trim();
    const args = parseArgsRaw(sm.args.value);
    if (args !== undefined) body.args = args;
    sm.submit.disabled = true; sm.err.textContent = '';
    try {
      const res = await fetch(API + '/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
      smReset(); smClose();
      await refreshSessions();
      activate(json.id, json);
    } catch (err) { sm.err.textContent = err.message; }
    finally { sm.submit.disabled = false; }
  }

  document.getElementById('new-session-btn').addEventListener('click', smOpen);
  document.getElementById('sm-cancel').addEventListener('click', () => { smReset(); smClose(); });
  sm.submit.addEventListener('click', smSubmit);

  // ──────────────────────────────────────────────────────────────────────
  // Profile modal (create / edit)
  // ──────────────────────────────────────────────────────────────────────
  const pm = {
    modal: document.getElementById('profile-modal'),
    title: document.getElementById('pm-title'),
    name: document.getElementById('pm-name'),
    cwd: document.getElementById('pm-cwd'),
    cmd: document.getElementById('pm-cmd'),
    args: document.getElementById('pm-args'),
    err: document.getElementById('pm-error'),
    submit: document.getElementById('pm-submit'),
    del: document.getElementById('pm-delete'),
    chips: document.getElementById('pm-arg-chips'),
    editingId: null,
  };
  function openProfileModal(profile) {
    pm.err.textContent = '';
    if (profile) {
      pm.editingId = profile.id;
      pm.title.textContent = '編輯項目：' + profile.name;
      pm.name.value = profile.name;
      pm.cwd.value = profile.cwd;
      pm.cmd.value = profile.cmd || '';
      pm.args.value = (profile.args || []).join(' ');
      pm.del.style.display = '';
    } else {
      pm.editingId = null;
      pm.title.textContent = '新建項目';
      pm.name.value = pm.cwd.value = pm.cmd.value = pm.args.value = '';
      pm.del.style.display = 'none';
    }
    pmSyncChips();
    pm.modal.classList.add('visible');
    setTimeout(() => pm.name.focus(), 50);
  }
  function pmClose() { pm.modal.classList.remove('visible'); }
  function pmTokens() { return pm.args.value.trim() ? pm.args.value.trim().split(/\s+/) : []; }
  function pmSyncChips() {
    const set = new Set(pmTokens());
    for (const c of pm.chips.querySelectorAll('.chip')) c.classList.toggle('active', set.has(c.dataset.flag));
  }
  pm.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    const flag = chip.dataset.flag; const t = pmTokens(); const i = t.indexOf(flag);
    if (i === -1) t.push(flag); else t.splice(i, 1);
    pm.args.value = t.join(' '); pmSyncChips();
  });
  pm.args.addEventListener('input', pmSyncChips);

  async function pmSubmit() {
    const name = pm.name.value.trim();
    const cwd = pm.cwd.value.trim();
    if (!name) { pm.err.textContent = '請輸入項目名稱'; return; }
    if (!cwd) { pm.err.textContent = '請輸入工作目錄'; return; }
    const body = { name, cwd };
    if (pm.cmd.value.trim()) body.cmd = pm.cmd.value.trim();
    const args = parseArgsRaw(pm.args.value);
    if (args !== undefined) body.args = args;
    pm.submit.disabled = true; pm.err.textContent = '';
    try {
      const url = pm.editingId
        ? API + '/api/profiles/' + encodeURIComponent(pm.editingId)
        : API + '/api/profiles';
      const method = pm.editingId ? 'PUT' : 'POST';
      const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
      pmClose();
      historyCache.delete(json.id || pm.editingId);  // cwd 可能變了
      await refreshProfiles();
    } catch (err) { pm.err.textContent = err.message; }
    finally { pm.submit.disabled = false; }
  }

  async function pmDelete() {
    if (!pm.editingId) return;
    if (!confirm('確定刪除這個項目？\n（只刪除 kabby profile，不會動到 cc 的對話歷史 jsonl）')) return;
    try {
      const res = await fetch(API + '/api/profiles/' + encodeURIComponent(pm.editingId), { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || ('HTTP ' + res.status));
      }
      expandedProfiles.delete(pm.editingId);
      historyCache.delete(pm.editingId);
      pmClose();
      await refreshProfiles();
    } catch (err) {
      pm.err.textContent = err.message;
    }
  }

  document.getElementById('new-profile-btn').addEventListener('click', () => openProfileModal(null));
  document.getElementById('pm-cancel').addEventListener('click', pmClose);
  pm.submit.addEventListener('click', pmSubmit);
  pm.del.addEventListener('click', pmDelete);

  // ──────────────────────────────────────────────────────────────────────
  // Misc bindings
  // ──────────────────────────────────────────────────────────────────────
  killBtn.addEventListener('click', () => {
    if (!activeId) return;
    if (!confirm('確定要殺掉這個 session？PTY 會結束，所有 attach 的 client（含其他視窗、wepages iframe）都會斷開。\n\n（只想關掉 tab 的話按上方 tab 的 × 即可，PTY 會保留）')) return;
    closePane(activeId, true);
  });
  redrawBtn.addEventListener('click', redrawActive);

  // Help modal
  const openHelp = () => { helpModal.classList.add('visible'); };
  const closeHelp = () => { helpModal.classList.remove('visible'); };
  document.getElementById('help-btn').addEventListener('click', openHelp);
  document.getElementById('help-close').addEventListener('click', closeHelp);
  document.getElementById('help-redraw').addEventListener('click', () => { redrawActive(); closeHelp(); });

  openViewerBtn.addEventListener('click', async () => {
    try {
      const res = await fetch(API + '/api/viewer/open', { method: 'POST' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || ('HTTP ' + res.status));
      }
    } catch (err) {
      alert('開啟 viewer 失敗：' + err.message);
    }
  });

  // Modal 鍵盤 (ESC / Enter) — modal 開啟時優先處理
  document.addEventListener('keydown', (e) => {
    const inModal = sm.modal.classList.contains('visible') || pm.modal.classList.contains('visible') || helpModal.classList.contains('visible');
    if (!inModal) return;
    if (e.key === 'Escape') {
      if (sm.modal.classList.contains('visible')) smClose();
      if (pm.modal.classList.contains('visible')) pmClose();
      if (helpModal.classList.contains('visible')) closeHelp();
    } else if (e.key === 'Enter') {
      if (sm.modal.classList.contains('visible')) smSubmit();
      else if (pm.modal.classList.contains('visible')) pmSubmit();
    }
  });

  // F1 開幫助；? 也可（但要在 xterm 沒 focus 時才生效，避免吃掉 cc 自己的 ? 提示鍵）
  document.addEventListener('keydown', (e) => {
    if (e.code === 'F1') {
      e.preventDefault();
      if (helpModal.classList.contains('visible')) closeHelp(); else openHelp();
    }
    // ? 只在 xterm 沒 focus 時生效（避免 cc 內 ? 鍵被吞）
    if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const target = e.target;
      const inXterm = target && target.closest && target.closest('.xterm');
      const inInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      if (!inXterm && !inInput) {
        e.preventDefault();
        if (!helpModal.classList.contains('visible')) openHelp();
      }
    }
  });

  // Tab 切換快捷鍵 (Ctrl+Shift+←/→) — 用 capture 確保 xterm 不先吃掉
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.shiftKey) || e.altKey || e.metaKey) return;
    if (e.code === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation();
      switchTabByOffset(+1);
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault(); e.stopPropagation();
      switchTabByOffset(-1);
    }
  }, true);

  window.addEventListener('resize', () => {
    for (const pane of panes.values()) {
      try { pane.fit.fit(); } catch {}
      sendResize(pane);
    }
  });

  // 週期刷新運行中 session 的 metadata；profile 不需高頻
  setInterval(refreshSessions, 3000);
  setInterval(refreshProfiles, 10_000);

  // Boot
  refreshAll();
})();
