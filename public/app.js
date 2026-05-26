/* kabby Web UI — SPA (Phase 2.5 with profiles) */
(() => {
  const API = '';
  const WS_BASE = `ws://${location.host}/ws/`;
  document.getElementById('daemon-url').textContent = location.origin;

  // ──────────────────────────────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────────────────────────────
  // ── Tab / pane tree 模型 ──
  //   Leaf  = { kind:'leaf', paneId, el, sessionId, info, term, fit, ws, connected }  // sessionId=null → 空 pane
  //   Split = { kind:'split', dir:'row'|'col', children:[Node,Node], ratio, el }       // row=左右並排 / col=上下疊
  //   Tab   = { id, root:Node, el }                                                    // el 只在 active 時顯示
  const tabs = [];                 // 有序，對應 tab bar
  let activeTabId = null;
  let focusedPaneId = null;        // active tab 內有鍵盤焦點的 leaf
  let pendingFillPaneId = null;    // 剛 split 出、等待填 session 的空 leaf
  const leaves = new Map();        // paneId → Leaf（含空 leaf）
  let paneSeq = 0, tabSeq = 0;
  const MAX_PANES_PER_TAB = 4;
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
  const splitHBtn = document.getElementById('split-h-btn');
  const splitVBtn = document.getElementById('split-v-btn');
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
          <button class="btn danger tiny" data-action="delete">刪除</button>
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
      body.querySelector('[data-action="delete"]').addEventListener('click', (e) => { e.stopPropagation(); deleteProfile(p.id, p.name); });

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
      openSession(json.id, json);
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

  async function deleteProfile(id, name) {
    if (!confirm(`確定刪除項目「${name}」？\n（只刪除 kabby profile 配置，不會動到 cc 的對話歷史 jsonl，也不影響運行中的 session）`)) return;
    try {
      const res = await fetch(API + '/api/profiles/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || ('HTTP ' + res.status));
      }
      expandedProfiles.delete(id);
      historyCache.delete(id);
      await refreshProfiles();
    } catch (err) {
      alert('刪除失敗：' + err.message);
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
    const attached = new Set([...leaves.values()].filter((l) => l.sessionId).map((l) => l.sessionId));
    const focusedLeaf = leaves.get(focusedPaneId);
    const focusedSid = focusedLeaf ? focusedLeaf.sessionId : null;
    sessionListEl.innerHTML = '';
    for (const s of sessions) {
      const isFocused = s.id === focusedSid;
      const isAttached = attached.has(s.id);
      const div = document.createElement('div');
      div.className = 'session-item'
        + (isFocused ? ' active' : '')
        + (isAttached && !isFocused ? ' attached' : '')
        + (s.alive ? '' : ' dead');
      div.dataset.id = s.id;
      div.innerHTML = `
        <button class="session-kill" title="殺掉這個 session（PTY 結束，免先連回去；掛載中徽章會解除）">✕</button>
        <div class="session-name">
          <span>${escapeHtml(s.name)}</span>
          <span class="badge">${s.clientCount} clt</span>
          ${isAttached ? '<span class="badge" title="已在某個 pane 開啟">開啟中</span>' : ''}
          ${s.ccSessionId ? '<span class="badge" title="cc session id">resumed</span>' : ''}
        </div>
        <div class="session-meta">${escapeHtml(shorten(s.cwd, 36))}</div>
      `;
      div.addEventListener('click', () => openSession(s.id, s));
      div.querySelector('.session-kill').addEventListener('click', (e) => {
        e.stopPropagation();
        killSession(s.id, s.name);
      });
      sessionListEl.appendChild(div);
    }
  }

  async function refreshSessions() {
    const sessions = await fetchSessions();
    renderSessions(sessions);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    for (const leaf of [...leaves.values()]) {
      if (!leaf.sessionId) continue;
      const s = byId.get(leaf.sessionId);
      if (s) leaf.info = s;
      else removeLeaf(leaf.paneId);     // server 上消失（PTY 已結束）→ 收掉 pane
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
  // Tab / pane tree — 樹結構工具
  // ──────────────────────────────────────────────────────────────────────
  function activeTab() { return tabs.find((t) => t.id === activeTabId) || null; }
  function tabById(id) { return tabs.find((t) => t.id === id) || null; }
  function leavesOf(node, out = []) {
    if (!node) return out;
    if (node.kind === 'leaf') out.push(node);
    else { leavesOf(node.children[0], out); leavesOf(node.children[1], out); }
    return out;
  }
  function tabOfLeaf(paneId) {
    for (const t of tabs) if (leavesOf(t.root).some((l) => l.paneId === paneId)) return t;
    return null;
  }
  function sessionToLeaf(sessionId) {
    for (const leaf of leaves.values()) if (leaf.sessionId === sessionId) return leaf;
    return null;
  }
  // 把樹裡的 target 節點換成 replacement（target 可為 leaf 或 split）
  function replaceNode(tab, target, replacement) {
    if (tab.root === target) { tab.root = replacement; return; }
    const walk = (node) => {
      if (node.kind !== 'split') return false;
      for (let i = 0; i < 2; i++) {
        if (node.children[i] === target) { node.children[i] = replacement; return true; }
        if (walk(node.children[i])) return true;
      }
      return false;
    };
    walk(tab.root);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Tab bar 渲染
  // ──────────────────────────────────────────────────────────────────────
  function renderTabs() {
    tabListEl.innerHTML = '';
    if (tabs.length === 0) {
      tabEmptyEl.style.display = '';
      return;
    }
    tabEmptyEl.style.display = 'none';
    for (const tab of tabs) {
      const ls = leavesOf(tab.root);
      const focused = ls.find((l) => l.paneId === focusedPaneId) || ls[0];
      const info = (focused && focused.info) || {};
      const anyConnected = ls.some((l) => l.connected);
      const el = document.createElement('div');
      el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
      el.dataset.tabId = tab.id;
      el.title = info.cwd || info.name || tab.id;
      const name = info.name || (focused && focused.sessionId ? focused.sessionId.slice(0, 8) : '空 pane');
      const paneBadge = ls.length > 1 ? `<span class="badge" title="${ls.length} 個 pane">${ls.length}◫</span>` : '';
      el.innerHTML = `
        <span class="tab-dot ${anyConnected ? 'connected' : 'disconnected'}"></span>
        <span class="tab-name">${escapeHtml(name)}</span>
        ${paneBadge}
        <button class="tab-close" title="關閉 tab（全部 pane detach，PTY 不殺）">×</button>
      `;
      el.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); closeTab(tab.id); }   // 中鍵 = 關 tab
      });
      el.addEventListener('click', (e) => {
        if (e.target.closest('.tab-close')) return;
        setActiveTab(tab.id);
      });
      el.querySelector('.tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      });
      tabListEl.appendChild(el);
    }
  }

  function switchTabByOffset(offset) {
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    if (idx < 0) { setActiveTab(tabs[0].id); return; }
    const next = tabs[(idx + offset + tabs.length) % tabs.length];
    setActiveTab(next.id);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Leaf（pane）建立 / 終端 / WS
  // ──────────────────────────────────────────────────────────────────────
  function createLeaf(sessionId, info) {
    const paneId = 'p' + (++paneSeq);
    const el = document.createElement('div');
    el.className = 'term-pane';
    el.dataset.paneId = paneId;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'pane-close';
    closeBtn.title = '關閉這個 pane（PTY 保留，可從 sidebar 重新 attach）';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeLeaf(paneId, false); });
    el.appendChild(closeBtn);
    el.addEventListener('mousedown', () => focusLeaf(paneId));

    const leaf = { kind: 'leaf', paneId, el, sessionId: sessionId || null, info: info || null,
                   term: null, fit: null, ws: null, connected: false, _ph: null };
    leaves.set(paneId, leaf);
    if (sessionId) wireLeafTerminal(leaf);
    else showEmptyPlaceholder(leaf);
    return leaf;
  }

  function showEmptyPlaceholder(leaf) {
    const ph = document.createElement('div');
    ph.className = 'pane-empty';
    ph.innerHTML = '<div class="hint-strong">空 pane</div><div>點左側 Projects「新對話」或 Running 的 session<br>填入這裡（不會開新 tab）</div>';
    leaf.el.appendChild(ph);
    leaf._ph = ph;
  }
  function removeEmptyPlaceholder(leaf) {
    if (leaf._ph) { leaf._ph.remove(); leaf._ph = null; }
  }

  // 建立 xterm + 連 WS（空 pane 被填入時也走這裡）
  function wireLeafTerminal(leaf) {
    removeEmptyPlaceholder(leaf);
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#aeafad' },
      scrollback: 5000,
      allowProposedApi: true,
    });
    // 這些組合鍵保留給 kabby（切 tab / split / 關 pane），xterm 不處理
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        if (['ArrowLeft', 'ArrowRight', 'KeyD', 'KeyE', 'KeyW'].includes(e.code)) return false;
      }
      return true;
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(leaf.el);
    leaf.term = term;
    leaf.fit = fit;
    term.onData((data) => {
      if (leaf.ws && leaf.ws.readyState === WebSocket.OPEN) {
        leaf.ws.send(JSON.stringify({ type: 'input', data }));
      }
    });
    // 監看 pane 實際尺寸變化（split / 拖 gutter / 切 tab / window resize）自動 refit
    const ro = new ResizeObserver(() => scheduleLeafFit(leaf));
    ro.observe(leaf.el);
    leaf.ro = ro;
    scheduleLeafFit(leaf);
    connect(leaf);
  }

  // 依 pane 當前尺寸 refit；rAF 去抖、隱藏中（0 尺寸）跳過
  function scheduleLeafFit(leaf) {
    if (leaf._fitRaf) return;
    leaf._fitRaf = requestAnimationFrame(() => {
      leaf._fitRaf = null;
      if (!leaf.term || !leaf.fit) return;
      if (leaf.el.clientWidth <= 0 || leaf.el.clientHeight <= 0) return;
      try { leaf.fit.fit(); } catch {}
      try { leaf.term.refresh(0, leaf.term.rows - 1); } catch {}
      sendResize(leaf);
    });
  }

  function connect(leaf) {
    const ws = new WebSocket(WS_BASE + encodeURIComponent(leaf.sessionId));
    leaf.ws = ws;
    ws.onopen = () => {
      leaf.connected = true;
      if (focusedPaneId === leaf.paneId) updateStatusbar(leaf);
      renderTabs();
      sendResize(leaf);
    };
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'output') { if (leaf.term) leaf.term.write(msg.data); }
      else if (msg.type === 'exit') {
        if (leaf.term) leaf.term.write(`\r\n\x1b[33m[session exited code=${msg.code}]\x1b[0m\r\n`);
        leaf.connected = false;
        if (focusedPaneId === leaf.paneId) updateStatusbar(leaf);
        renderTabs();
      }
    };
    ws.onclose = () => {
      leaf.connected = false;
      if (focusedPaneId === leaf.paneId) updateStatusbar(leaf);
      renderTabs();
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  function sendResize(leaf) {
    if (!leaf.term || !leaf.ws || leaf.ws.readyState !== WebSocket.OPEN) return;
    leaf.ws.send(JSON.stringify({ type: 'resize', cols: leaf.term.cols, rows: leaf.term.rows }));
  }

  // ──────────────────────────────────────────────────────────────────────
  // Tab / pane lifecycle
  // ──────────────────────────────────────────────────────────────────────
  function createTab(sessionId, info) {
    const id = 't' + (++tabSeq);
    const el = document.createElement('div');
    el.className = 'tab-content';
    el.dataset.tabId = id;
    wrap.appendChild(el);
    const leaf = createLeaf(sessionId, info);
    const tab = { id, root: leaf, el };
    tabs.push(tab);
    renderTabContent(tab);
    setActiveTab(id);
    return tab;
  }

  function applyFlex(childEl, grow) { childEl.style.flex = grow + ' 1 0'; }

  // 遞迴把 tree 畫成 DOM；leaf 重用既有 .el（內含 live xterm）
  function buildNode(node) {
    if (node.kind === 'leaf') {
      // 清掉上次 split 留下的 inline flex：root leaf 回退 CSS 預設(flex:1 1 0)撐滿；
      // 若是 split 子節點，父層 buildNode 會在之後用 applyFlex 覆蓋。
      node.el.style.flex = '';
      return node.el;
    }
    const sp = document.createElement('div');
    sp.className = 'split ' + node.dir;
    node.el = sp;
    const a = buildNode(node.children[0]);
    const b = buildNode(node.children[1]);
    const r = node.ratio == null ? 0.5 : node.ratio;
    applyFlex(a, r);
    applyFlex(b, 1 - r);
    const gutter = document.createElement('div');
    gutter.className = 'gutter';
    attachGutterDrag(gutter, node, sp);
    sp.appendChild(a);
    sp.appendChild(gutter);
    sp.appendChild(b);
    return sp;
  }

  function renderTabContent(tab) {
    tab.el.innerHTML = '';                 // 移出 leaf .el（仍被 leaves/tree 參照，xterm 不毀）
    tab.el.appendChild(buildNode(tab.root));
    if (tab.id === activeTabId) fitTab(tab);
  }

  function attachGutterDrag(gutter, splitNode, splitEl) {
    gutter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const horizontal = splitNode.dir === 'row';
      const rect = splitEl.getBoundingClientRect();
      const total = horizontal ? rect.width : rect.height;
      if (total <= 0) return;
      const startPos = horizontal ? e.clientX : e.clientY;
      const startRatio = splitNode.ratio == null ? 0.5 : splitNode.ratio;
      const aEl = splitEl.children[0];
      const bEl = splitEl.children[2];
      document.body.style.userSelect = 'none';
      document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
      const onMove = (ev) => {
        const delta = (horizontal ? ev.clientX : ev.clientY) - startPos;
        let r = startRatio + delta / total;
        r = Math.max(0.1, Math.min(0.9, r));
        splitNode.ratio = r;
        applyFlex(aEl, r);
        applyFlex(bEl, 1 - r);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        const t = activeTab();
        if (t) fitTab(t);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    // 雙擊 gutter = 還原 50/50（卡住時的逃生口）
    gutter.addEventListener('dblclick', (e) => {
      e.preventDefault();
      splitNode.ratio = 0.5;
      applyFlex(splitEl.children[0], 0.5);
      applyFlex(splitEl.children[2], 0.5);
      const t = activeTab();
      if (t) fitTab(t);
    });
  }

  function fitTab(tab) {
    for (const leaf of leavesOf(tab.root)) scheduleLeafFit(leaf);
  }

  function setActiveTab(id) {
    activeTabId = id;
    placeholder.classList.add('hidden');
    for (const t of tabs) t.el.classList.toggle('active', t.id === id);
    const tab = tabById(id);
    if (!tab) { renderTabs(); return; }
    const ls = leavesOf(tab.root);
    const keep = ls.find((l) => l.paneId === focusedPaneId);
    focusLeaf((keep || ls[0]).paneId);
    fitTab(tab);
  }

  function focusLeaf(paneId) {
    focusedPaneId = paneId;
    const leaf = leaves.get(paneId);
    const tab = activeTab();
    if (tab) for (const l of leavesOf(tab.root)) l.el.classList.toggle('focused', l.paneId === paneId);
    if (leaf && leaf.term) { try { leaf.term.focus(); } catch {} }
    updateStatusbar(leaf || null);
    renderTabs();
  }

  // 左右(row) / 上下(col) 分割焦點 pane
  function splitFocused(dir) {
    const tab = activeTab();
    if (!tab) return;
    const leaf = leaves.get(focusedPaneId);
    if (!leaf) return;
    if (leavesOf(tab.root).length >= MAX_PANES_PER_TAB) { flashStatus(`每個 tab 最多 ${MAX_PANES_PER_TAB} 個 pane`); return; }
    const empty = createLeaf(null, null);
    const split = { kind: 'split', dir, children: [leaf, empty], ratio: 0.5, el: null };
    replaceNode(tab, leaf, split);
    renderTabContent(tab);
    pendingFillPaneId = empty.paneId;
    focusLeaf(empty.paneId);
  }

  // 把 session 填進空 pane
  function fillPane(paneId, sessionId, info) {
    const leaf = leaves.get(paneId);
    if (!leaf) return;
    leaf.sessionId = sessionId;
    leaf.info = info;
    wireLeafTerminal(leaf);
    if (pendingFillPaneId === paneId) pendingFillPaneId = null;
    const tab = tabOfLeaf(paneId);
    if (tab && tab.id === activeTabId) fitTab(tab);
    focusLeaf(paneId);
    refreshSessions();
  }

  // sidebar 點 session/profile 的統一入口：填空 pane vs 開新 tab
  function openSession(sessionId, info) {
    const existing = sessionToLeaf(sessionId);
    if (existing) {                             // 已開啟 → 聚焦既有 pane（不重複 attach）
      const t = tabOfLeaf(existing.paneId);
      if (t) setActiveTab(t.id);
      focusLeaf(existing.paneId);
      return;
    }
    const pendTab = pendingFillPaneId ? tabOfLeaf(pendingFillPaneId) : null;
    if (pendTab && pendTab.id === activeTabId) {
      fillPane(pendingFillPaneId, sessionId, info);
    } else {
      createTab(sessionId, info);
    }
  }

  // 釋放單一 leaf 資源（不動樹、不發網路）
  function disposeLeaf(leaf) {
    try { leaf.ro && leaf.ro.disconnect(); } catch {}
    try { leaf.ws && leaf.ws.close(); } catch {}
    try { leaf.term && leaf.term.dispose(); } catch {}
    leaves.delete(leaf.paneId);
    if (pendingFillPaneId === leaf.paneId) pendingFillPaneId = null;
  }

  // 從樹移除 leaf（塌縮兄弟）；若是 tab 唯一 pane → 移除整個 tab。回傳 sessionId。純本地，不發網路
  function removeLeaf(paneId) {
    const leaf = leaves.get(paneId);
    if (!leaf) return null;
    const tab = tabOfLeaf(paneId);
    const sid = leaf.sessionId;
    if (tab && tab.root === leaf) {
      removeTab(tab.id);
      return sid;
    }
    disposeLeaf(leaf);
    if (tab) {
      // 找 parent split，用兄弟取代它
      const findParent = (node) => {
        if (node.kind !== 'split') return null;
        if (node.children[0] === leaf || node.children[1] === leaf) return node;
        return findParent(node.children[0]) || findParent(node.children[1]);
      };
      const parent = findParent(tab.root);
      if (parent) {
        const sibling = parent.children[0] === leaf ? parent.children[1] : parent.children[0];
        replaceNode(tab, parent, sibling);
        renderTabContent(tab);
      }
      const ls = leavesOf(tab.root);
      if (focusedPaneId === paneId && ls.length) focusLeaf(ls[0].paneId);
      else renderTabs();
    }
    return sid;
  }

  function removeTab(tabId) {
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    const tab = tabs[idx];
    for (const leaf of leavesOf(tab.root)) disposeLeaf(leaf);
    tab.el.remove();
    tabs.splice(idx, 1);
    if (activeTabId === tabId) {
      activeTabId = null;
      focusedPaneId = null;
      if (tabs.length) setActiveTab(tabs[Math.min(idx, tabs.length - 1)].id);
      else { placeholder.classList.remove('hidden'); updateStatusbar(null); renderTabs(); }
    } else {
      renderTabs();
    }
  }

  // pane × / Ctrl+Shift+W / 殺 session
  function closeLeaf(paneId, alsoDeleteServer) {
    const sid = removeLeaf(paneId);
    if (alsoDeleteServer && sid) {
      fetch(API + '/api/sessions/' + encodeURIComponent(sid), { method: 'DELETE' })
        .catch(() => {})
        .finally(() => { historyCache.clear(); refreshAll(); });
    } else {
      refreshSessions();
    }
  }

  // tab × / 中鍵：detach 整個 tab 全部 pane，PTY 全保留
  function closeTab(tabId) {
    removeTab(tabId);
    refreshSessions();
  }

  // sidebar Running 的「殺」按鈕：殺掉任意 session（免先連回去）。若正在某 pane 開著 → 連 pane 一起收
  function killSession(id, name) {
    if (!confirm(`確定殺掉 session「${name || id}」？\nPTY 會結束，所有 attach 的 client（含其他視窗 / wepages iframe）都會斷開。\n殺掉後該 cc 對話的「掛載中」會解除、可重新接續。`)) return;
    const leaf = sessionToLeaf(id);
    if (leaf) { closeLeaf(leaf.paneId, true); return; }   // 在 pane 內 → closeLeaf 會 DELETE + 收 pane
    fetch(API + '/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' })
      .catch(() => {})
      .finally(() => { historyCache.clear(); refreshAll(); });
  }

  function updateStatusbar(leaf) {
    if (!leaf || !leaf.sessionId) {
      statusText.textContent = leaf ? '空 pane — 點 sidebar 填入 session' : '未選擇 session';
      statusText.style.color = '#888';
      metaEl.textContent = '';
      killBtn.style.display = 'none';
      redrawBtn.style.display = 'none';
      splitHBtn.style.display = leaf ? '' : 'none';
      splitVBtn.style.display = leaf ? '' : 'none';
      return;
    }
    const s = leaf.info || {};
    statusText.textContent = leaf.connected ? `${s.name} · connected` : `${s.name} · disconnected`;
    statusText.style.color = leaf.connected ? '#4caf50' : '#f44336';
    const ccTail = s.ccSessionId ? ` · cc:${s.ccSessionId.slice(0, 8)}` : '';
    metaEl.textContent = `${shorten(s.cwd || '', 50)} · ${s.cols || '?'}x${s.rows || '?'}${ccTail}`;
    killBtn.style.display = '';
    redrawBtn.style.display = '';
    splitHBtn.style.display = '';
    splitVBtn.style.display = '';
  }

  let flashTimer = null;
  function flashStatus(msg) {
    statusText.textContent = msg;
    statusText.style.color = '#d7ba7d';
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => updateStatusbar(leaves.get(focusedPaneId) || null), 1800);
  }

  function redrawFocused() {
    const leaf = leaves.get(focusedPaneId);
    if (!leaf || !leaf.ws || leaf.ws.readyState !== WebSocket.OPEN) return;
    // \x0c = Form Feed = Ctrl+L，cc 收到會重繪 TUI / 清屏
    leaf.ws.send(JSON.stringify({ type: 'input', data: '\x0c' }));
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
      openSession(json.id, json);
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
    const id = pm.editingId;
    const name = pm.name.value.trim() || id;
    pmClose();
    await deleteProfile(id, name);
  }

  document.getElementById('new-profile-btn').addEventListener('click', () => openProfileModal(null));
  document.getElementById('pm-cancel').addEventListener('click', pmClose);
  pm.submit.addEventListener('click', pmSubmit);
  pm.del.addEventListener('click', pmDelete);

  // ──────────────────────────────────────────────────────────────────────
  // Misc bindings
  // ──────────────────────────────────────────────────────────────────────
  killBtn.addEventListener('click', () => {
    const leaf = leaves.get(focusedPaneId);
    if (!leaf || !leaf.sessionId) return;
    if (!confirm('確定要殺掉這個 session？PTY 會結束，所有 attach 的 client（含其他視窗、wepages iframe）都會斷開。\n\n（只想關掉 pane 的話按 pane 右上的 × 即可，PTY 會保留）')) return;
    closeLeaf(focusedPaneId, true);
  });
  redrawBtn.addEventListener('click', redrawFocused);
  splitHBtn.addEventListener('click', () => splitFocused('row'));
  splitVBtn.addEventListener('click', () => splitFocused('col'));

  // Help modal
  const openHelp = () => { helpModal.classList.add('visible'); };
  const closeHelp = () => { helpModal.classList.remove('visible'); };
  document.getElementById('help-btn').addEventListener('click', openHelp);
  document.getElementById('help-close').addEventListener('click', closeHelp);
  document.getElementById('help-redraw').addEventListener('click', () => { redrawFocused(); closeHelp(); });

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

  // Tab / pane 快捷鍵 — 用 capture 確保 xterm 不先吃掉
  //   Ctrl+Shift+←/→ 切 tab；Ctrl+Shift+D 左右切；Ctrl+Shift+E 上下切；Ctrl+Shift+W 關 pane
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.shiftKey) || e.altKey || e.metaKey) return;
    if (e.code === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation();
      switchTabByOffset(+1);
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault(); e.stopPropagation();
      switchTabByOffset(-1);
    } else if (e.code === 'KeyD') {
      e.preventDefault(); e.stopPropagation();
      splitFocused('row');
    } else if (e.code === 'KeyE') {
      e.preventDefault(); e.stopPropagation();
      splitFocused('col');
    } else if (e.code === 'KeyW') {
      e.preventDefault(); e.stopPropagation();
      if (focusedPaneId) closeLeaf(focusedPaneId, false);
    }
  }, true);

  window.addEventListener('resize', () => {
    const t = activeTab();
    if (t) fitTab(t);
  });

  // 週期刷新運行中 session 的 metadata；profile 不需高頻
  setInterval(refreshSessions, 3000);
  setInterval(refreshProfiles, 10_000);

  // Boot
  refreshAll();
})();
