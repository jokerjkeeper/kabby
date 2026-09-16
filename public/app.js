/* kabby Web UI — SPA (Phase 2.5 with profiles) */
(() => {
  const API = '';

  // ──────────────────────────────────────────────────────────────────────
  // 終端字型與初始 PTY 尺寸估算
  //
  // 為什麼要估：PTY 若以 daemon 預設寬度（220 欄）啟動，cc 會先用 220 欄畫好 TUI
  // 邊框並硬換行寫進 scrollback；等 pane 掛好、fit() 算出真實欄數（例如 100）再
  // resize 時，那些 220 欄的長行會被 xterm 重新折行，畫面右緣就出現「斷層」。
  // 建 session 時就把接近真實的 cols/rows 帶上去，第一幀起寬度就是對的。
  //
  // 這裡是估算值（±1 欄），掛上 xterm 後 fit() 仍會送一次精確 resize。差 1 欄的
  // 重繪發生在 scrollback 幾乎是空的開場，肉眼無感；真正會炸版面的是 220→100。
  // ──────────────────────────────────────────────────────────────────────
  const TERM_FONT_SIZE = 14;
  const TERM_FONT_FAMILY = "'Cascadia Code', Consolas, monospace";
  const TERM_LINE_HEIGHT = 1.25;
  const TERM_SCROLLBAR_W = 15;   // xterm viewport scrollbar，FitAddon 也會扣掉
  const PANE_CHROME = 9;         // .term-pane 的 padding 8 + border 1

  let cellMetrics = null;

  // 用與 xterm 相同的字型量一個 cell 的 px 尺寸（量 'W' 的 line-height:normal 高度，
  // 再自行乘上 lineHeight，對齊 xterm CharSizeService 的算法）
  function measureCell() {
    if (cellMetrics) return cellMetrics;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;top:-9999px;left:-9999px;visibility:hidden;'
      + 'white-space:pre;line-height:normal;font-size:' + TERM_FONT_SIZE + 'px;font-family:' + TERM_FONT_FAMILY;
    probe.textContent = 'W'.repeat(100);
    document.body.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    const w = rect.width / 100;
    const h = rect.height;
    if (!(w > 0) || !(h > 0)) return { w: TERM_FONT_SIZE * 0.6, h: Math.ceil(TERM_FONT_SIZE * 1.2 * TERM_LINE_HEIGHT) };
    cellMetrics = { w, h: Math.ceil(h * TERM_LINE_HEIGHT) };
    return cellMetrics;
  }

  // 新 session 會落在哪塊區域：待填的空 pane > 目前 tab（新 tab 佔滿同一塊）> term-wrap
  function newSessionTargetEl() {
    if (pendingFillPaneId) {
      const pendTab = tabOfLeaf(pendingFillPaneId);
      const leaf = leaves.get(pendingFillPaneId);
      if (pendTab && pendTab.id === activeTabId && leaf && leaf.el && leaf.el.clientWidth > 0) return leaf.el;
    }
    const tab = activeTab();
    if (tab && tab.el && tab.el.clientWidth > 0) return tab.el;
    return document.getElementById('term-wrap');
  }

  // 回傳 { cols, rows }，塞進建立 session 的 request body
  function newSessionDims() {
    try {
      const el = newSessionTargetEl();
      if (!el) return {};
      const cell = measureCell();
      const cs = getComputedStyle(el);
      let availW = parseFloat(cs.width) || 0;
      let availH = parseFloat(cs.height) || 0;
      // 量到的若不是 pane 本身（例如整個 tab 容器），要先扣掉 pane 的 padding/border
      if (!el.classList.contains('term-pane')) { availW -= PANE_CHROME * 2; availH -= PANE_CHROME * 2; }
      availW -= TERM_SCROLLBAR_W;
      const cols = Math.floor(availW / cell.w);
      const rows = Math.floor(availH / cell.h);
      if (!(cols > 1) || !(rows > 0)) return {};
      return { cols, rows };
    } catch { return {}; }
  }
  const PROVIDER_UI = {
    claude: {
      cmdPlaceholder: '預設：claude.cmd（Win）/ claude（Unix）',
      cmdHint: '想跑別的 shell（如 cmd.exe / bash）才填。',
      argsPlaceholder: '預設：--dangerously-skip-permissions',
      argsHint: 'Space-separated args. Leave empty to use the provider default; enter a single space to force no args.',
      chips: ['--dangerously-skip-permissions', '--verbose', '--enable-auto-mode', '--debug'],
      defaultArgsText: '--dangerously-skip-permissions',
    },
    codex: {
      cmdPlaceholder: '預設：codex.cmd（Win）/ codex（Unix）',
      cmdHint: '通常留空即可；只有要覆蓋成別的執行檔才填。',
      argsPlaceholder: '預設：--dangerously-bypass-approvals-and-sandbox',
      argsHint: '0.142+ 已無 --full-auto。bypass = 全自動免確認（對齊 claude yolo）；resume 時此旗標會自動略過（resume 子命令不收）。',
      chips: ['--dangerously-bypass-approvals-and-sandbox', '--search'],
      defaultArgsText: '--dangerously-bypass-approvals-and-sandbox',
    },
  };
  let authToken = localStorage.getItem('kabby-auth-token') || '';
  let locked = false;            // 鎖定中（已清 token、登入頁蓋著），不關閉 session
  let authRequired = false;      // daemon 是否設了 AUTH_TOKEN（由 /api/health 得知）
  // WS URL：依頁面協定選 ws/wss（HTTPS 下必須 wss，否則 mixed-content 被擋），並帶 token
  function wsUrl(sessionId) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let u = `${proto}//${location.host}/ws/${encodeURIComponent(sessionId)}`;
    if (authToken) u += '?token=' + encodeURIComponent(authToken);
    return u;
  }
  // 所有 /api 請求走這裡：注入 token header + 統一 401 處理
  function apiFetch(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (authToken) headers['X-Kabby-Token'] = authToken;
    return fetch(API + path, { ...opts, headers }).then((r) => {
      if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
      return r;
    });
  }
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
  const expandedProfiles = new Set();      // 側欄哪些 profile 卡片是展開的
  let modalSelectedId = null;              // 「全部項目」modal 右側詳情面板目前選的項目
  const historyCache = new Map();          // profileId → history array
  let allProfiles = [];                    // 最近一次抓到的完整項目清單（sidebar 與 modal 共用）
  let projectsView = localStorage.getItem('kabby-projects-view') || 'grid';  // modal 版型：'grid' | 'list'
  const RECENT_DAYS = 7;                    // 側欄只顯示 N 天內用過的項目，其餘收進「全部項目」modal

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
  const projectsModal = document.getElementById('projects-modal');
  const apSearchEl = document.getElementById('ap-search');
  const apGridBtn = document.getElementById('ap-grid');
  const apListBtn = document.getElementById('ap-list');

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
  function providerUi(provider) {
    return PROVIDER_UI[provider] || PROVIDER_UI.claude;
  }
  function arraysEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function syncProviderArgsUi(form) {
    const ui = providerUi(form.provider.value || 'claude');
    form.cmd.placeholder = ui.cmdPlaceholder;
    if (form.cmdHint) form.cmdHint.textContent = ui.cmdHint;
    form.args.placeholder = ui.argsPlaceholder;
    if (form.argsHint) form.argsHint.textContent = ui.argsHint;
    const tokens = form.args.value.trim() ? form.args.value.trim().split(/\s+/) : [];
    if (form.provider.value === 'codex' && arraysEqual(tokens, PROVIDER_UI.claude.chips)) {
      form.args.value = '';
    }
    const activeTokens = form.args.value.trim() ? form.args.value.trim().split(/\s+/) : [];
    const hideChips = !ui.chips.length;
    form.chips.style.display = hideChips ? 'none' : '';
    for (const c of form.chips.querySelectorAll('.chip')) {
      const supported = ui.chips.includes(c.dataset.flag);
      c.style.display = supported ? '' : 'none';
      c.classList.toggle('active', supported && activeTokens.includes(c.dataset.flag));
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Profiles
  // ──────────────────────────────────────────────────────────────────────
  async function fetchProfiles() {
    try { return await apiFetch('/api/profiles').then((r) => r.json()); }
    catch { return []; }
  }

  async function fetchHistory(profileId) {
    try {
      const data = await apiFetch('/api/profiles/' + encodeURIComponent(profileId) + '/history').then((r) => r.json());
      historyCache.set(profileId, data);
      return data;
    } catch {
      return [];
    }
  }

  // 該項目是否「近期」：busy（運行中）永遠算近期，否則看 lastUsedAt 是否在 RECENT_DAYS 內
  function isRecentProfile(p) {
    if (p.lastSessionBusy) return true;
    if (!p.lastUsedAt) return false;
    return (Date.now() - new Date(p.lastUsedAt).getTime()) < RECENT_DAYS * 86_400_000;
  }

  // 建一張項目卡片。側欄與 modal 共用；用 expandedSet / onToggle 區分各自的展開狀態。
  function createProfileCard(p, expandedSet, onToggle) {
    const card = document.createElement('div');
    card.className = 'profile-card' + (expandedSet.has(p.id) ? ' expanded' : '');
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
    head.addEventListener('click', () => onToggle(p.id));
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'profile-body';
    body.innerHTML = `
      <div class="profile-actions">
        <button class="btn primary tiny" data-action="new-chat">新對話</button>
        <button class="btn tiny" data-action="resume-last" ${(p.resumeSupported && p.lastSessionId && !p.lastSessionBusy) ? '' : 'disabled'}>接續上次</button>
        <button class="btn tiny" data-action="edit">編輯</button>
        <button class="btn tiny" data-action="open-folder" ${p.historySupported ? '' : 'disabled'}>歷史目錄</button>
        <button class="btn danger tiny" data-action="delete">刪除</button>
      </div>
      <div class="history-list" data-history-list>
        <div class="empty">${p.historySupported ? '點開項目自動讀取歷史…' : '此 provider 尚未接入對話歷史。'}</div>
      </div>
    `;
    card.appendChild(body);

    body.querySelector('[data-action="new-chat"]').addEventListener('click', (e) => { e.stopPropagation(); launchProfile(p.id); });
    body.querySelector('[data-action="resume-last"]').addEventListener('click', (e) => { e.stopPropagation(); if (p.resumeSupported && p.lastSessionId) launchProfile(p.id, p.lastSessionId); });
    body.querySelector('[data-action="edit"]').addEventListener('click', (e) => { e.stopPropagation(); openProfileModal(p); });
    body.querySelector('[data-action="open-folder"]').addEventListener('click', (e) => { e.stopPropagation(); openHistoryFolder(p.id); });
    body.querySelector('[data-action="delete"]').addEventListener('click', (e) => { e.stopPropagation(); deleteProfile(p.id, p.name); });

    if (expandedSet.has(p.id)) {
      renderHistoryList(p.id, body.querySelector('[data-history-list]'));
    }
    return card;
  }

  function renderProfiles(profiles) {
    allProfiles = profiles;
    if (!profiles.length) {
      profileListEl.innerHTML = '<div class="empty-hint">尚無項目。點右上「+ 項目」建立。</div>';
      return;
    }
    profileListEl.innerHTML = '';
    const recent = profiles.filter(isRecentProfile);
    if (!recent.length) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = `近 ${RECENT_DAYS} 天沒有活動的項目。點下方「全部項目」找。`;
      profileListEl.appendChild(hint);
    }
    for (const p of recent) {
      profileListEl.appendChild(createProfileCard(p, expandedProfiles, toggleProfile));
    }

    // 「全部項目」入口：開 modal（grid/list + 搜尋）
    const more = document.createElement('button');
    more.className = 'btn tiny';
    more.id = 'open-all-projects';
    more.style.cssText = 'display:block; width:calc(100% - 12px); margin:6px; text-align:center;';
    more.textContent = `📁 全部項目 (${profiles.length})`;
    more.title = '開啟所有項目（可搜尋、grid/list 切換、展開歷史接續舊 session）';
    more.addEventListener('click', openProjectsModal);
    profileListEl.appendChild(more);

    // modal 開著時，資料刷新（busy/最近時間變動）也同步重繪
    if (projectsModal && projectsModal.classList.contains('visible')) renderProjectsModal();
  }

  async function toggleProfile(id) {
    const profile = allProfiles.find((p) => p.id === id);
    if (expandedProfiles.has(id)) {
      expandedProfiles.delete(id);
    } else {
      expandedProfiles.add(id);
      if (!profile || profile.historySupported) await fetchHistory(id);     // 預先抓
    }
    await refreshProfiles();
  }

  // ── 「全部項目」modal（左:緊湊卡片 grid/list；右:選取項目的操作+歷史詳情）──
  //   不在 grid 內就地展開（會把卡片撐高、打亂排版），改成點卡片 → 右側詳情面板。
  function renderProjectsModal() {
    const body = document.getElementById('ap-body');
    if (!body) return;
    const q = (apSearchEl.value || '').trim().toLowerCase();
    let list = allProfiles;
    if (q) {
      list = list.filter((p) =>
        (p.name || '').toLowerCase().includes(q) || (p.cwd || '').toLowerCase().includes(q));
    }
    document.getElementById('ap-count').textContent =
      q ? `(${list.length} / ${allProfiles.length})` : `(${allProfiles.length})`;
    apGridBtn.classList.toggle('active', projectsView === 'grid');
    apListBtn.classList.toggle('active', projectsView === 'list');
    body.className = 'projects-body ' + projectsView;
    body.innerHTML = '';
    // 選取的項目被搜尋濾掉 → 清空選取
    if (modalSelectedId && !list.some((p) => p.id === modalSelectedId)) modalSelectedId = null;
    if (!list.length) {
      body.innerHTML = '<div class="ap-empty">沒有符合的項目。</div>';
    } else {
      for (const p of list) body.appendChild(createModalGridCard(p));
    }
    renderModalDetail();
  }

  // 緊湊卡片：只有名稱/路徑/最近活動，點擊 → 選進右側詳情（不就地展開）
  function createModalGridCard(p) {
    const card = document.createElement('div');
    card.className = 'ap-card' + (p.id === modalSelectedId ? ' selected' : '');
    card.dataset.id = p.id;
    card.innerHTML = `
      <div class="profile-name"><span>${escapeHtml(p.name)}</span>${p.lastSessionBusy ? '<span class="badge warn">last 掛載中</span>' : ''}</div>
      <div class="profile-meta">${escapeHtml(shorten(p.cwd, 32))}</div>
      <div class="profile-meta">最近：${escapeHtml(timeAgo(p.lastUsedAt))}</div>`;
    card.addEventListener('click', () => selectModalProfile(p.id));
    return card;
  }

  async function selectModalProfile(id) {
    modalSelectedId = id;
    const profile = allProfiles.find((p) => p.id === id);
    if (!profile || profile.historySupported) await fetchHistory(id); // 預抓歷史
    renderProjectsModal();
  }

  // 右側詳情：複用 createProfileCard（永遠展開、head 點擊不收合）→ 操作鈕 + 歷史列表
  function renderModalDetail() {
    const detail = document.getElementById('ap-detail');
    if (!detail) return;
    const p = modalSelectedId && allProfiles.find((x) => x.id === modalSelectedId);
    if (!p) {
      detail.innerHTML = '<div class="ap-detail-empty">← 點左側項目，這裡顯示操作與歷史</div>';
      return;
    }
    detail.innerHTML = '';
    detail.appendChild(createProfileCard(p, { has: () => true }, () => {}));
  }

  function openProjectsModal() {
    projectsModal.classList.add('visible');
    renderProjectsModal();
    apSearchEl.focus();
    apSearchEl.select();
  }
  function closeProjectsModal() { projectsModal.classList.remove('visible'); }
  function setProjectsView(v) {
    projectsView = v;
    try { localStorage.setItem('kabby-projects-view', v); } catch {}
    renderProjectsModal();
  }

  async function renderHistoryList(profileId, container) {
    let history = historyCache.get(profileId);
    if (!history) history = await fetchHistory(profileId);
    if (!history.length) {
      const profile = allProfiles.find((p) => p.id === profileId);
      container.innerHTML = profile && !profile.historySupported
        ? '<div class="empty">此 provider 尚未接入對話歷史。</div>'
        : '<div class="empty">此目錄目前無可接續的對話歷史。</div>';
      return;
    }
    container.innerHTML = '';
    for (const h of history) {
      const item = document.createElement('div');
      item.className = 'history-item' + (h.busy ? ' busy' : '');
      // 有 /rename 自訂名 → 名字當主標、首句摘要降級為副標；沒有就照舊只顯示摘要
      const titleRow = h.title
        ? `<div class="summary"><span class="title">${escapeHtml(h.title)}</span> <span class="badge named" title="cc /rename 設定的名稱">named</span></div>
           <div class="meta" style="color:#666">${escapeHtml(h.summary || '(無摘要)')}</div>`
        : `<div class="summary">${escapeHtml(h.summary || '(無摘要)')}</div>`;
      item.innerHTML = `
        ${titleRow}
        <div class="meta">
          <span>${escapeHtml(timeAgo(new Date(h.mtime).toISOString()))}</span>
          <span>·</span>
          <span>${escapeHtml(h.sessionId.slice(0, 8))}</span>
        </div>
      `;
      if (!h.busy) {
        item.title = '點擊接續這個 session';
        item.addEventListener('click', () => launchProfile(profileId, h.sessionId));
      } else {
        item.title = '此 session 已被另一個 kabby session 掛載中';
      }
      container.appendChild(item);
    }
  }

  async function launchProfile(profileId, resume) {
    try {
      const res = await apiFetch('/api/profiles/' + encodeURIComponent(profileId) + '/launch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...newSessionDims(), ...(resume ? { resume } : {}) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
      // 新 PTY 上線 → busy set 變了，清 history cache 讓展開的歷史列表反映
      historyCache.clear();
      await Promise.all([refreshProfiles(), refreshSessions()]);
      if (projectsModal.classList.contains('visible')) closeProjectsModal();
      openSession(json.id, json);
    } catch (err) {
      alert('啟動失敗：' + err.message);
    }
  }

  async function openHistoryFolder(profileId) {
    try {
      const info = await apiFetch('/api/profiles/' + encodeURIComponent(profileId) + '/history-dir').then((r) => r.json());
      if (info.unsupported) {
        alert('此 provider 目前尚未支援歷史目錄。');
        return;
      }
      if (!info.exists) {
        alert('該 cwd 目前還沒有對話歷史目錄。\n預期位置：' + info.dir);
        return;
      }
      await apiFetch('/api/viewer/open-folder', {
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
      const res = await apiFetch('/api/profiles/' + encodeURIComponent(id), { method: 'DELETE' });
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
    try { return await apiFetch('/api/sessions').then((r) => r.json()); }
    catch { return null; }   // null = 抓取失敗（401 / 鎖定 / 網路），別誤判成「沒有 session」而清掉 panes
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
          ${s.resumeSessionId ? `<span class="badge" title="${escapeHtml((s.provider || 'session') + ' resume id')}">resumed</span>` : ''}
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
    if (locked) return;                  // 鎖定中：保留現有 panes，WS 照常串流在背後
    const sessions = await fetchSessions();
    if (!sessions) return;               // 抓取失敗：保留現有 panes，不清空
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
    if (locked) return;
    const profiles = await fetchProfiles();
    allProfiles = profiles;
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
      fontSize: TERM_FONT_SIZE,
      fontFamily: TERM_FONT_FAMILY,
      lineHeight: TERM_LINE_HEIGHT,
      theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#aeafad' },
      scrollback: 5000,
      allowProposedApi: true,
    });
    // 這些組合鍵保留給 kabby（切 tab / split / 關 pane），xterm 不處理
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        if (['ArrowLeft', 'ArrowRight', 'KeyD', 'KeyE', 'KeyW', 'KeyB'].includes(e.code)) return false;
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
    const ws = new WebSocket(wsUrl(leaf.sessionId));
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
      else if (msg.type === 'blocked') {
        showToast('⚠ 輸入含敏感詞「' + (msg.words || []).join('、') + '」，已攔截未送出', 'warn');
      }
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

  // 輕量 toast（敏感詞攔截提示等）
  function showToast(text, kind) {
    const host = document.getElementById('toast-host');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = text;
    host.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 4000);
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
    leafLiveSync(); // 焦點換了 → live 小面板跟著移到新 pane
  }

  // ── 焦點 session 即時 live 小面板（主介面浮層,右上角,可收合）────────────
  // 跟著鍵盤焦點走;只輪詢「當前焦點 session」的 analyzeSession,顯示最近幾輪
  // token / spike,讓你邊跑 cc 邊看 token 暴增,不必開監控。
  let leafLiveOn = false;
  let leafLiveExpanded = false;
  let leafLiveTimer = null;
  let leafLiveTargetSid = null;
  let leafLiveProvider = 'claude';
  let leafLiveEl = null;

  function leafLiveEnsureEl() {
    if (leafLiveEl) return leafLiveEl;
    const el = document.createElement('div');
    el.className = 'leaf-live';
    el.innerHTML = '<div class="ll-head"><span class="ll-ico">📊</span>'
      + '<span class="ll-sum">live</span><span class="ll-dot2">●</span></div>'
      + '<div class="ll-body"></div>';
    el.querySelector('.ll-head').addEventListener('click', (e) => {
      e.stopPropagation();
      leafLiveExpanded = !leafLiveExpanded;
      el.classList.toggle('expanded', leafLiveExpanded);
    });
    el.addEventListener('mousedown', (e) => e.stopPropagation()); // 不搶 pane 焦點
    leafLiveEl = el;
    return el;
  }

  function leafLiveStop() { if (leafLiveTimer) { clearInterval(leafLiveTimer); leafLiveTimer = null; } }
  function leafLiveStart() { if (!leafLiveTimer) leafLiveTimer = setInterval(leafLiveRefresh, 4000); }

  // 焦點切換 / 開關時呼叫:把浮層掛到焦點 session pane,啟動/停止輪詢
  function leafLiveSync() {
    const leaf = leaves.get(focusedPaneId);
    const sid = leaf && leaf.sessionId ? leaf.sessionId : null;
    if (!leafLiveOn || !sid) {
      if (leafLiveEl && leafLiveEl.parentNode) leafLiveEl.parentNode.removeChild(leafLiveEl);
      leafLiveStop();
      leafLiveTargetSid = null;
      return;
    }
    const el = leafLiveEnsureEl();
    el.classList.toggle('expanded', leafLiveExpanded);
    if (el.parentNode !== leaf.el) leaf.el.appendChild(el);
    if (sid !== leafLiveTargetSid) {
      leafLiveTargetSid = sid;
      leafLiveProvider = (leaf.info && leaf.info.provider) || 'claude'; // 依 session 的 provider 路由 analysis
      el.querySelector('.ll-body').innerHTML = '<div style="padding:6px;color:#888">載入…</div>';
      leafLiveRefresh();
    }
    leafLiveStart();
  }

  async function leafLiveRefresh() {
    const sid = leafLiveTargetSid;
    if (!sid || !leafLiveEl) return;
    let a;
    try { a = await apiFetch('/api/usage/' + encodeURIComponent(sid) + '/analysis?provider=' + (leafLiveProvider || 'claude')).then((r) => r.json()); }
    catch { return; }
    if (sid !== leafLiveTargetSid) return; // 焦點已換,丟棄
    leafLiveRender(a);
  }

  function leafLiveRender(a) {
    const el = leafLiveEl;
    if (!el) return;
    const turns = (a && a.turns) || [];
    const last = turns[turns.length - 1];
    const recentSpike = turns.slice(-6).some((t) => (t.tokens.cacheCreate || 0) > SPIKE_CW);
    el.classList.toggle('has-spike', recentSpike);
    el.querySelector('.ll-sum').textContent = last ? `#${last.order + 1} ${monFmtUsd(last.costUsd)}` : 'live';
    el.querySelector('.ll-ico').textContent = recentSpike ? '🔴' : '📊';
    const dot = el.querySelector('.ll-dot2');
    const act = monIsActive(a);
    dot.textContent = act ? '●' : '○';
    dot.style.color = act ? '#4caf50' : '#777';
    const rows = [];
    for (let i = turns.length - 1; i >= 0 && rows.length < 15; i--) {
      const t = turns[i];
      const cw = t.tokens.cacheCreate || 0;
      const spike = cw > SPIKE_CW;
      const tools = (t.tools || []).map((x) =>
        monEsc(x.name) + (x.hint ? `<span class="h"> ${monEsc(x.hint)}</span>` : '')).join('、') || '<span class="h">(純文字)</span>';
      const prev = turns[i - 1];
      const ing = spike && prev && prev.tools && prev.tools.length
        ? `<div class="ll-ing">↑ #${prev.order + 1} ${monEsc(prev.tools[0].name)} 結果</div>` : '';
      rows.push(`<div class="ll-row${spike ? ' spike' : ''}"><div class="ll-r1"><span class="ll-n">#${t.order + 1}</span><span class="ll-cost">${monFmtUsd(t.costUsd)}</span><span class="ll-tools">${spike ? '🔴 ' : ''}${tools}</span></div><div class="ll-r2">out <b>${monFmtK(t.tokens.output)}</b> · cw <b class="${spike ? 'hot' : ''}">${monFmtK(cw)}</b> · cr ${monFmtK(t.tokens.cacheRead)}</div>${ing}</div>`);
    }
    el.querySelector('.ll-body').innerHTML = rows.join('') || '<div style="padding:6px;color:#888">無逐輪資料</div>';
  }

  function leafLiveToggle() {
    leafLiveOn = !leafLiveOn;
    try { localStorage.setItem('kabby.leafLive', leafLiveOn ? '1' : '0'); } catch {}
    const btn = document.getElementById('leaflive-btn');
    if (btn) btn.classList.toggle('on', leafLiveOn);
    if (leafLiveOn && !leafLiveExpanded) leafLiveExpanded = true; // 首次開啟直接展開,讓使用者看到
    leafLiveSync();
  }

  function leafLiveInit() {
    try { leafLiveOn = localStorage.getItem('kabby.leafLive') === '1'; } catch {}
    const btn = document.getElementById('leaflive-btn');
    if (btn) { btn.classList.toggle('on', leafLiveOn); btn.addEventListener('click', leafLiveToggle); }
    leafLiveSync();
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
      apiFetch('/api/sessions/' + encodeURIComponent(sid), { method: 'DELETE' })
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
    apiFetch('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' })
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
    const resumeTail = s.resumeSessionId
      ? ` · ${s.provider === 'codex' ? 'codex' : 'cc'}:${s.resumeSessionId.slice(0, 8)}`
      : '';
    metaEl.textContent = `${shorten(s.cwd || '', 50)} · ${s.cols || '?'}x${s.rows || '?'}${resumeTail}`;
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
    provider: document.getElementById('sm-provider'),
    name: document.getElementById('sm-name'),
    cwd: document.getElementById('sm-cwd'),
    cmd: document.getElementById('sm-cmd'),
    cmdHint: document.getElementById('sm-cmd-hint'),
    args: document.getElementById('sm-args'),
    argsHint: document.getElementById('sm-args-hint'),
    err: document.getElementById('sm-error'),
    submit: document.getElementById('sm-submit'),
    chips: document.getElementById('sm-arg-chips'),
  };
  function smOpen() {
    sm.err.textContent = '';
    syncProviderArgsUi(sm);
    sm.modal.classList.add('visible');
    setTimeout(() => sm.name.focus(), 50);
  }
  function smClose() { sm.modal.classList.remove('visible'); }
  function smReset() { sm.provider.value = 'claude'; sm.name.value = sm.cwd.value = sm.cmd.value = sm.args.value = ''; syncProviderArgsUi(sm); }
  function smTokens() { return sm.args.value.trim() ? sm.args.value.trim().split(/\s+/) : []; }
  function smSyncChips() {
    const set = new Set(smTokens());
    for (const c of sm.chips.querySelectorAll('.chip')) c.classList.toggle('active', set.has(c.dataset.flag));
  }
  sm.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    const flag = chip.dataset.flag; const t = smTokens(); const i = t.indexOf(flag);
    if (i === -1) t.push(flag); else t.splice(i, 1);
    sm.args.value = t.join(' '); syncProviderArgsUi(sm);
  });
  sm.args.addEventListener('input', () => syncProviderArgsUi(sm));
  sm.provider.addEventListener('change', () => syncProviderArgsUi(sm));

  async function smSubmit() {
    const name = sm.name.value.trim();
    if (!name) { sm.err.textContent = '請輸入名稱'; return; }
    const body = { name, provider: sm.provider.value || 'claude', ...newSessionDims() };
    if (sm.cwd.value.trim()) body.cwd = sm.cwd.value.trim();
    if (sm.cmd.value.trim()) body.cmd = sm.cmd.value.trim();
    const args = parseArgsRaw(sm.args.value);
    if (args !== undefined) body.args = args;
    sm.submit.disabled = true; sm.err.textContent = '';
    try {
      const res = await apiFetch('/api/sessions', {
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
    provider: document.getElementById('pm-provider'),
    name: document.getElementById('pm-name'),
    cwd: document.getElementById('pm-cwd'),
    cmd: document.getElementById('pm-cmd'),
    cmdHint: document.getElementById('pm-cmd-hint'),
    args: document.getElementById('pm-args'),
    argsHint: document.getElementById('pm-args-hint'),
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
      pm.provider.value = profile.provider || 'claude';
      pm.name.value = profile.name;
      pm.cwd.value = profile.cwd;
      pm.cmd.value = profile.cmd || '';
      pm.args.value = (profile.args || []).join(' ');
      pm.del.style.display = '';
    } else {
      pm.editingId = null;
      pm.title.textContent = '新建項目';
      pm.provider.value = 'claude';
      pm.name.value = pm.cwd.value = pm.cmd.value = pm.args.value = '';
      pm.del.style.display = 'none';
    }
    syncProviderArgsUi(pm);
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
    pm.args.value = t.join(' '); syncProviderArgsUi(pm);
  });
  pm.args.addEventListener('input', () => syncProviderArgsUi(pm));
  pm.provider.addEventListener('change', () => syncProviderArgsUi(pm));

  async function pmSubmit() {
    const name = pm.name.value.trim();
    const cwd = pm.cwd.value.trim();
    if (!name) { pm.err.textContent = '請輸入項目名稱'; return; }
    if (!cwd) { pm.err.textContent = '請輸入工作目錄'; return; }
    const body = { name, cwd, provider: pm.provider.value || 'claude' };
    if (pm.cmd.value.trim()) body.cmd = pm.cmd.value.trim();
    const args = pm.args.value.trim() ? parseArgsRaw(pm.args.value) : [];
    body.args = args;
    pm.submit.disabled = true; pm.err.textContent = '';
    try {
      const path = pm.editingId
        ? '/api/profiles/' + encodeURIComponent(pm.editingId)
        : '/api/profiles';
      const method = pm.editingId ? 'PUT' : 'POST';
      const res = await apiFetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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

  // 側欄收合（toggle）— 狀態存 localStorage；收合後 panes 由 ResizeObserver 自動補滿
  function setSidebarCollapsed(collapsed) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    try { localStorage.setItem('kabby-sidebar-collapsed', collapsed ? '1' : '0'); } catch {}
    const t = activeTab();
    if (t) fitTab(t);
  }
  function toggleSidebar() {
    setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
  }
  document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);
  try { if (localStorage.getItem('kabby-sidebar-collapsed') === '1') document.body.classList.add('sidebar-collapsed'); } catch {}

  // Help modal
  const openHelp = () => { helpModal.classList.add('visible'); };
  const closeHelp = () => { helpModal.classList.remove('visible'); };
  document.getElementById('help-btn').addEventListener('click', openHelp);
  document.getElementById('help-close').addEventListener('click', closeHelp);
  document.getElementById('help-redraw').addEventListener('click', () => { redrawFocused(); closeHelp(); });

  openViewerBtn.addEventListener('click', async () => {
    try {
      const res = await apiFetch('/api/viewer/open', { method: 'POST' });
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
    const monModalEl = document.getElementById('monitor-modal');
    const inModal = sm.modal.classList.contains('visible') || pm.modal.classList.contains('visible') || helpModal.classList.contains('visible') || monModalEl.classList.contains('visible') || projectsModal.classList.contains('visible');
    if (!inModal) return;
    if (e.key === 'Escape') {
      if (sm.modal.classList.contains('visible')) smClose();
      if (pm.modal.classList.contains('visible')) pmClose();
      if (helpModal.classList.contains('visible')) closeHelp();
      if (monModalEl.classList.contains('visible')) monModalEl.classList.remove('visible');
      if (projectsModal.classList.contains('visible')) closeProjectsModal();
    } else if (e.key === 'Enter') {
      if (sm.modal.classList.contains('visible')) smSubmit();
      else if (pm.modal.classList.contains('visible')) pmSubmit();
    }
  });

  // F1 開幫助；? 也可（但要在 xterm 沒 focus 時才生效，避免吃掉 cc 自己的 ? 提示鍵）
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('monitor-modal').classList.contains('visible')) return; // 監控開著時不攔 F1/?
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
    } else if (e.code === 'KeyB') {
      e.preventDefault(); e.stopPropagation();
      toggleSidebar();
    }
  }, true);

  window.addEventListener('resize', () => {
    const t = activeTab();
    if (t) fitTab(t);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Login (token gate)
  // ──────────────────────────────────────────────────────────────────────
  const loginModal = document.getElementById('login-modal');
  const loginTokenEl = document.getElementById('login-token');
  const loginErrorEl = document.getElementById('login-error');
  const lockBtn = document.getElementById('lock-btn');

  function showLogin() {
    loginModal.classList.add('visible');
    setTimeout(() => loginTokenEl.focus(), 50);
  }
  function hideLogin() { loginModal.classList.remove('visible'); }
  function updateLockBtn() { lockBtn.style.display = (authRequired && !locked) ? '' : 'none'; }

  // 鎖定：清掉本機 token + 蓋上不透明登入頁。WS 不關、不 DELETE session（PTY 照活）。
  // 週期刷新被 locked 擋住，所以 panes 不會被清；解鎖後一切照舊。
  function lock() {
    locked = true;
    authToken = '';
    try { localStorage.removeItem('kabby-auth-token'); } catch {}
    loginTokenEl.value = '';
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    updateLockBtn();
    showLogin();
  }
  lockBtn.addEventListener('click', lock);

  async function submitLogin() {
    const val = loginTokenEl.value.trim();
    if (!val) { loginErrorEl.textContent = '請輸入 token'; return; }
    // 用受保護的 endpoint 驗證（不走 apiFetch，401 在這裡自訂提示）
    try {
      const r = await fetch(API + '/api/sessions', { headers: { 'X-Kabby-Token': val } });
      if (r.status === 401) { loginErrorEl.textContent = 'token 不正確'; return; }
      authToken = val;
      localStorage.setItem('kabby-auth-token', val);
      loginErrorEl.textContent = '';
      loginTokenEl.value = '';
      locked = false;
      hideLogin();
      updateLockBtn();
      refreshAll();
    } catch (err) {
      loginErrorEl.textContent = '連線失敗：' + err.message;
    }
  }
  document.getElementById('login-submit').addEventListener('click', submitLogin);
  loginTokenEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });

  // ──────────────────────────────────────────────────────────────────────
  // 聊天室（房主面板）— 建房綁 session、key 分享、聊天、訪客權限開關
  // 訪客端在 /room.html（key + 暱稱入房）；這裡是房主管理視角
  // ──────────────────────────────────────────────────────────────────────
  let rooms = [];
  let selectedRoomId = null;
  let roomWs = null;              // 選中房間的聊天 WS（/ws/room/:id）
  let roomPollTimer = null;

  const roomBtn = document.getElementById('room-btn');
  const roomListEl = document.getElementById('room-list');
  const roomChatTitleEl = document.getElementById('room-chat-title');
  const roomChatConnEl = document.getElementById('room-chat-conn');
  const roomChatMsgsEl = document.getElementById('room-chat-msgs');
  const roomChatInputEl = document.getElementById('room-chat-input');
  const roomChatSendBtn = document.getElementById('room-chat-send');
  const roomModal = document.getElementById('room-modal');

  // http（非 https）下 navigator.clipboard 不可用 → textarea + execCommand fallback
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return Promise.resolve(ok);
    } catch { return Promise.resolve(false); }
  }

  function guestLink(room) {
    return location.origin + '/room.html?key=' + encodeURIComponent(room.key);
  }

  // ── 聊天共用：貼圖壓縮 / lightbox / @mention 渲染 ──
  // 圖片 → data URL：大圖用 canvas 縮到 1600px 內、轉 JPEG；gif 保留動圖（超限就拒收）
  const CHAT_IMG_MAX = 2 * 1024 * 1024; // base64 字串長度上限（跟後端一致）
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
    if (raw.length <= 300_000) return raw;   // 小圖不重壓
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

  // 文字裡的 @暱稱 上色；selfName 被 tag 時加 .me
  function renderChatText(text, selfName) {
    return escapeHtml(text).replace(/@([^\s@]{1,24})/g, (m0, name) =>
      `<span class="mention${name === selfName ? ' me' : ''}">@${name}</span>`);
  }
  function isMentioned(text, selfName) {
    return typeof text === 'string' && selfName && text.includes('@' + selfName);
  }

  // @mention 自動補齊：偵測輸入框游標前的 @prefix，彈候選清單（↑↓ / Enter / Tab / 點擊）
  function setupMention(inputEl, popEl, getCandidates) {
    let items = [];
    let active = 0;
    let atStart = -1;   // 目前補齊中的 '@' 位置；-1 = 未開啟

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
      // '@' 要在字串頭或空白後，且 @ 到游標間不含空白
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
    inputEl.addEventListener('blur', () => setTimeout(close, 150)); // 留時間給點擊
    popEl.addEventListener('mousedown', (e) => {
      const mi = e.target.closest('.mi');
      if (mi) { e.preventDefault(); pick(parseInt(mi.dataset.i, 10)); }
    });
    return { isOpen: () => popEl.classList.contains('visible') };
  }

  function setRoomPanel(open) {
    document.body.classList.toggle('room-open', open);
    roomBtn.classList.toggle('on', open);
    try { localStorage.setItem('kabby-room-panel', open ? '1' : '0'); } catch {}
    const t = activeTab();
    if (t) fitTab(t);   // 第三欄出現/消失 → 終端 refit
    if (open) {
      refreshRooms();
      if (!roomPollTimer) roomPollTimer = setInterval(refreshRooms, 5000);
    } else if (roomPollTimer) {
      clearInterval(roomPollTimer);
      roomPollTimer = null;
    }
  }

  async function refreshRooms() {
    if (locked) return;
    let list;
    try { list = await apiFetch('/api/rooms').then((r) => r.json()); }
    catch { return; }
    rooms = Array.isArray(list) ? list : [];
    if (selectedRoomId && !rooms.some((r) => r.id === selectedRoomId)) {
      // 選中的房沒了（被關）→ 收掉聊天
      roomChatDisconnect();
      selectedRoomId = null;
      roomChatTitleEl.textContent = '未選擇房間';
      roomChatMsgsEl.innerHTML = '';
    }
    renderRooms();
  }

  function renderRooms() {
    if (!rooms.length) {
      roomListEl.innerHTML = '<div class="room-empty">尚無聊天室。點「＋ 建房」綁定一個運行中 session。<br>訪客入口：<code>/room.html</code></div>';
      return;
    }
    roomListEl.innerHTML = '';
    for (const room of rooms) {
      const card = document.createElement('div');
      card.className = 'room-card' + (room.id === selectedRoomId ? ' selected' : '');
      const online = room.guests.filter((g) => g.online).length;
      card.innerHTML = `
        <div class="rc-name">
          <span>${escapeHtml(room.name)}</span>
          <span class="badge">${online}/${room.guests.length} 在線</span>
          ${room.allowWrite ? '<span class="badge warn">可寫</span>' : ''}
        </div>
        <div class="rc-meta">綁定：${escapeHtml(room.sessionName || room.sessionId.slice(0, 8))}</div>
        <div class="rc-meta">key: <span class="rc-key">${escapeHtml(room.key)}</span></div>
        <div class="rc-guests">${room.guests.map((g) =>
          `<span class="rc-guest-chip ${g.online ? 'online' : ''}">${escapeHtml(g.nickname)}</span>`).join('') || '<span style="color:#666;font-size:10px">還沒有訪客</span>'}</div>
        <div class="rc-actions">
          <button class="btn tiny" data-action="copy-link" title="複製訪客入房連結（含 key）">複製連結</button>
          <label class="rc-write-toggle" title="訪客可否在終端輸入（即時生效，伺服器端強制）">
            <input type="checkbox" data-action="allow-write" ${room.allowWrite ? 'checked' : ''} /> 可輸入
          </label>
          <button class="btn danger tiny" data-action="close-room" style="margin-left:auto">關房</button>
        </div>
      `;
      card.addEventListener('click', () => selectRoom(room.id));
      card.querySelector('[data-action="copy-link"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await copyText(guestLink(room));
        showToast(ok ? '已複製訪客連結：' + guestLink(room) : '複製失敗，連結：' + guestLink(room), ok ? '' : 'warn');
      });
      const writeToggle = card.querySelector('[data-action="allow-write"]');
      writeToggle.addEventListener('click', (e) => e.stopPropagation());
      writeToggle.addEventListener('change', async (e) => {
        e.stopPropagation();
        const want = writeToggle.checked;
        if (want && !confirm('開放訪客輸入 = 訪客能在這台機器的終端執行任意指令（用你的權限）。確定開放？')) {
          writeToggle.checked = false;
          return;
        }
        try {
          await apiFetch('/api/rooms/' + encodeURIComponent(room.id), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ allowWrite: want }),
          });
          refreshRooms();
        } catch { writeToggle.checked = !want; }
      });
      card.querySelector('[data-action="close-room"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`關閉聊天室「${room.name}」？所有訪客會被斷開。（session 本身不受影響）`)) return;
        try { await apiFetch('/api/rooms/' + encodeURIComponent(room.id), { method: 'DELETE' }); } catch {}
        refreshRooms();
      });
      roomListEl.appendChild(card);
    }
  }

  function selectRoom(id) {
    if (selectedRoomId === id) return;
    selectedRoomId = id;
    renderRooms();
    roomChatConnect(id);
  }

  const roomChatImgBtn = document.getElementById('room-chat-img');
  function setRoomChatEnabled(on) {
    roomChatInputEl.disabled = !on;
    roomChatSendBtn.disabled = !on;
    roomChatImgBtn.disabled = !on;
  }

  function roomChatDisconnect() {
    if (roomWs) { try { roomWs.close(); } catch {} roomWs = null; }
    setRoomChatEnabled(false);
    roomChatConnEl.textContent = '';
  }

  function roomChatConnect(roomId) {
    roomChatDisconnect();
    const room = rooms.find((r) => r.id === roomId);
    roomChatTitleEl.textContent = room ? room.name : '聊天';
    roomChatMsgsEl.innerHTML = '<div class="msg system">連線中…</div>';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let url = `${proto}//${location.host}/ws/room/${encodeURIComponent(roomId)}`;
    if (authToken) url += '?token=' + encodeURIComponent(authToken);
    const ws = new WebSocket(url);
    roomWs = ws;
    ws.onopen = () => {
      roomChatConnEl.textContent = '● 已連線';
      roomChatConnEl.style.color = '#4caf50';
      setRoomChatEnabled(true);
    };
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'room-init') {
        roomChatMsgsEl.innerHTML = '';
        for (const m of msg.chatLog || []) roomAppendChat(m, true);
      } else if (msg.type === 'chat') {
        roomAppendChat(msg);
      } else if (msg.type === 'room-presence') {
        // 在線名單變動 → 更新該房卡片（rooms 快取就地改，不打 API）
        const r = rooms.find((x) => x.id === roomId);
        if (r) { r.guests = msg.guests || []; renderRooms(); }
      } else if (msg.type === 'room-closed') {
        roomAppendChat({ from: 'system', text: '房間已關閉' });
        refreshRooms();
      }
    };
    ws.onclose = () => {
      if (roomWs === ws) {
        roomChatConnEl.textContent = '○ 已斷線';
        roomChatConnEl.style.color = '#f44336';
        setRoomChatEnabled(false);
      }
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  const HOST_SELF_NAME = '房主';
  function roomAppendChat(m, isReplay) {
    const el = document.createElement('div');
    if (m.from === 'system') {
      el.className = 'msg system';
      el.textContent = m.text;
    } else {
      const mentioned = m.from !== 'host' && isMentioned(m.text, HOST_SELF_NAME);
      el.className = 'msg ' + (m.from === 'host' ? 'host' : 'guest') + (mentioned ? ' mentioned' : '');
      const ts = m.ts ? new Date(m.ts).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
      let body = m.text ? renderChatText(m.text, HOST_SELF_NAME) : '';
      if (m.image) body += `<img class="chat-img" src="${m.image}" alt="貼圖" />`;
      else if (m.imageExpired) body += '<span class="img-expired">[圖片已釋放（僅保留最近 20 張）]</span>';
      el.innerHTML = `<span class="who">${escapeHtml(m.from === 'host' ? HOST_SELF_NAME : m.nickname || '訪客')}</span>`
        + `${body}<span class="ts">${ts}</span>`;
      const img = el.querySelector('.chat-img');
      if (img) img.addEventListener('click', () => openLightbox(m.image));
      if (mentioned && !isReplay) showToast(`💬 ${m.nickname || '訪客'} 在聊天室 tag 了你`, 'warn');
    }
    roomChatMsgsEl.appendChild(el);
    roomChatMsgsEl.scrollTop = roomChatMsgsEl.scrollHeight;
  }

  function roomSendChat() {
    const text = roomChatInputEl.value.trim();
    if (!text || !roomWs || roomWs.readyState !== WebSocket.OPEN) return;
    roomWs.send(JSON.stringify({ type: 'chat', text }));
    roomChatInputEl.value = '';
  }

  async function roomSendImage(file) {
    if (!roomWs || roomWs.readyState !== WebSocket.OPEN) { showToast('未連線，圖片未送出', 'warn'); return; }
    let dataUrl = null;
    try { dataUrl = await prepareChatImage(file); } catch {}
    if (!dataUrl) { showToast('圖片讀取失敗或壓縮後仍超過大小上限', 'warn'); return; }
    roomWs.send(JSON.stringify({ type: 'chat', image: dataUrl }));
  }

  // ── 建房 modal ──
  const rm = {
    modal: roomModal,
    session: document.getElementById('rm-session'),
    name: document.getElementById('rm-name'),
    key: document.getElementById('rm-key'),
    allowWrite: document.getElementById('rm-allow-write'),
    err: document.getElementById('rm-error'),
    submit: document.getElementById('rm-submit'),
  };
  async function rmOpen() {
    const sessions = (await fetchSessions()) || [];
    const alive = sessions.filter((s) => s.alive);
    if (!alive.length) { showToast('沒有運行中的 session，先開一個再建房', 'warn'); return; }
    rm.session.innerHTML = alive.map((s) =>
      `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}（${escapeHtml(shorten(s.cwd, 30))}）</option>`).join('');
    rm.name.value = '';
    rm.key.value = '';
    rm.allowWrite.checked = false;
    rm.err.textContent = '';
    rm.modal.classList.add('visible');
    setTimeout(() => rm.key.focus(), 50);
  }
  function rmClose() { rm.modal.classList.remove('visible'); }
  async function rmSubmit() {
    const sessionId = rm.session.value;
    if (!sessionId) { rm.err.textContent = '請選擇 session'; return; }
    const body = { sessionId, allowWrite: rm.allowWrite.checked };
    if (rm.name.value.trim()) body.name = rm.name.value.trim();
    if (rm.key.value.trim()) body.key = rm.key.value.trim();
    if (body.allowWrite && !confirm('開放訪客輸入 = 訪客能在這台機器的終端執行任意指令（用你的權限）。確定？')) return;
    rm.submit.disabled = true; rm.err.textContent = '';
    try {
      const res = await apiFetch('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
      rmClose();
      await refreshRooms();
      selectRoom(json.id);
      const ok = await copyText(guestLink(json));
      showToast((ok ? '房間已建立，訪客連結已複製：' : '房間已建立，訪客連結：') + guestLink(json));
    } catch (err) { rm.err.textContent = err.message; }
    finally { rm.submit.disabled = false; }
  }

  roomBtn.addEventListener('click', () => setRoomPanel(!document.body.classList.contains('room-open')));
  document.getElementById('room-hide-btn').addEventListener('click', () => setRoomPanel(false));
  document.getElementById('room-new-btn').addEventListener('click', rmOpen);
  document.getElementById('rm-cancel').addEventListener('click', rmClose);
  rm.submit.addEventListener('click', rmSubmit);
  roomChatSendBtn.addEventListener('click', roomSendChat);

  // @mention 補齊：候選 = 選中房間的訪客暱稱（mention 開著時 Enter 是選字，不送出）
  const roomMention = setupMention(
    roomChatInputEl,
    document.getElementById('room-mention-pop'),
    () => {
      const room = rooms.find((r) => r.id === selectedRoomId);
      return room ? room.guests.map((g) => g.nickname) : [];
    }
  );
  roomChatInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !roomMention.isOpen()) roomSendChat();
  });

  // 貼圖：🖼 按鈕選檔 / 輸入框直接 Ctrl+V 貼截圖
  const roomChatFileEl = document.getElementById('room-chat-file');
  roomChatImgBtn.addEventListener('click', () => roomChatFileEl.click());
  roomChatFileEl.addEventListener('change', () => {
    if (roomChatFileEl.files[0]) roomSendImage(roomChatFileEl.files[0]);
    roomChatFileEl.value = '';
  });
  roomChatInputEl.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) { e.preventDefault(); roomSendImage(item.getAsFile()); }
  });

  // 面板寬度拖曳（左緣把手）：寬度存 --room-w + localStorage，拖完 refit 終端
  (function initRoomResize() {
    const handle = document.getElementById('room-resize');
    try {
      const saved = parseInt(localStorage.getItem('kabby-room-w') || '', 10);
      if (saved >= 240 && saved <= 720) document.body.style.setProperty('--room-w', saved + 'px');
    } catch {}
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      const onMove = (ev) => {
        const w = Math.max(240, Math.min(720, window.innerWidth - ev.clientX));
        document.body.style.setProperty('--room-w', w + 'px');
      };
      const onUp = (ev) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        handle.classList.remove('dragging');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        const w = Math.max(240, Math.min(720, window.innerWidth - ev.clientX));
        try { localStorage.setItem('kabby-room-w', String(w)); } catch {}
        const t = activeTab();
        if (t) fitTab(t);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  })();

  roomModal.addEventListener('click', (e) => { if (e.target === roomModal) rmClose(); });
  document.addEventListener('keydown', (e) => {
    if (!roomModal.classList.contains('visible')) return;
    if (e.key === 'Escape') rmClose();
    else if (e.key === 'Enter') rmSubmit();
  });
  try { if (localStorage.getItem('kabby-room-panel') === '1') setRoomPanel(true); } catch {}

  // ──────────────────────────────────────────────────────────────────────
  // 監控頁（唯讀 pull：讀 /api/usage + /api/usage/sensitive；背景 watcher 維護索引）
  // ──────────────────────────────────────────────────────────────────────
  const monModal = document.getElementById('monitor-modal');
  const monTotals = document.getElementById('mon-totals');
  const monUsageEl = document.getElementById('mon-usage');
  const monDashEl = document.getElementById('mon-dash');
  const monLiveTabEl = document.getElementById('mon-livetab');
  const monSensEl = document.getElementById('mon-sensitive');
  const monUpdated = document.getElementById('mon-updated');
  const monSwBadge = document.getElementById('mon-sw-badge');
  const monLiveEl = document.getElementById('mon-live');
  let monWs = null;            // 即時推送 WS
  let monConvoOpen = false;    // 有對話展開時，即時更新不重繪表格（避免收合）
  let monConvoLiveTimer = null; // 展開列右側 live feed 的輪詢 timer
  let monTabLiveTimer = null;   // 頂部 Live 分頁的輪詢 timer
  let monProvider = 'claude';   // 監控頁目前看的 provider（頂部切換器）
  // 監控 API 一律帶 ?provider=，路由到對應採集器（claude / codex 各自獨立索引）
  function monUrl(path) { return path + (path.includes('?') ? '&' : '?') + 'provider=' + monProvider; }
  const SPIKE_CW = 15000;       // cacheCreate 超過此值 → 標紅（spike）。之後可做成設定項。
  const LIVE_ACTIVE_MS = 3 * 60 * 1000; // 最後一輪在 3 分鐘內 → 視為「進行中」,啟動輪詢

  const monFmt = (n) => (n || 0).toLocaleString('en-US');
  const monFmtK = (n) => { n = n || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n); };
  function monFmtTs(s) { if (!s) return '-'; try { return new Date(s).toLocaleString('zh-TW', { hour12: false }); } catch { return s; } }
  function monFmtUsd(n) { n = n || 0; return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function monEsc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  function openMonitor() { monModal.classList.add('visible'); monConvoOpen = false; loadMonitor(); monLiveConnect(); }
  function closeMonitor() { monModal.classList.remove('visible'); monLiveDisconnect(); monStopConvoLive(); monStopTabLive(); }

  async function loadMonitor() {
    monTotals.innerHTML = '<span style="color:#888">載入中…</span>';
    try {
      const [usage, sens] = await Promise.all([
        apiFetch(monUrl('/api/usage')).then((r) => r.json()),
        apiFetch(monUrl('/api/usage/sensitive')).then((r) => r.json()),
      ]);
      monRenderTotals(usage.totals, usage.updatedAt);
      monRenderUsage(usage.sessions || []);
      monRenderCharts(usage.byModel || [], usage.byDay || []);
      monRenderSensitive(sens.hits || []);
      monRenderRateLimits(usage.rateLimits);
    } catch (err) {
      if (err.message === 'unauthorized') return; // apiFetch 已彈登入
      monTotals.innerHTML = '<span style="color:#f48771">載入失敗：' + monEsc(err.message) + '</span>';
    }
  }

  // 即時 WS：watcher 每次掃描推一份聚合 view → 更新總覽/圖表（表格在無展開時也刷新）
  function monLiveConnect() {
    monLiveDisconnect();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let url = `${proto}//${location.host}/api/usage/stream`;
    if (authToken) url += '?token=' + encodeURIComponent(authToken);
    try { monWs = new WebSocket(url); } catch { return; }
    monWs.onopen = () => monLiveEl.classList.add('on');
    monWs.onclose = () => monLiveEl.classList.remove('on');
    monWs.onerror = () => monLiveEl.classList.remove('on');
    monWs.onmessage = (ev) => {
      let view;
      try { view = JSON.parse(ev.data); } catch { return; }
      if (!view || view.type !== 'usage') return;
      // 兩個 provider 的 watcher 都會推；只套用目前選的 provider
      if ((view.provider || 'claude') !== monProvider) return;
      monApplyView(view);
      monLiveEl.classList.remove('pulse'); void monLiveEl.offsetWidth; monLiveEl.classList.add('pulse');
    };
  }
  function monLiveDisconnect() {
    if (monWs) { try { monWs.close(); } catch {} monWs = null; }
    monLiveEl.classList.remove('on');
  }

  // 套用一份推送來的 view（不抓 sensitive 清單——那要另一個 endpoint）
  function monApplyView(view) {
    monRenderTotals(view.totals, view.updatedAt);
    monRenderCharts(view.byModel || [], view.byDay || []);
    monRenderRateLimits(view.rateLimits);
    // 表格：有對話展開時不重繪（避免把使用者正在看的內容收掉）
    if (!monConvoOpen) monRenderUsage(view.sessions || []);
    // 敏感詞分頁開著才順手刷新命中清單
    if (monSensEl.classList.contains('active')) {
      apiFetch(monUrl('/api/usage/sensitive')).then((r) => r.json())
        .then((s) => monRenderSensitive(s.hits || [])).catch(() => {});
    }
  }

  // Rate-limit 面板（codex 專屬）：rateLimits 來自 codex rollout 的帳號額度資訊。
  function monRenderRateLimits(rl) {
    const el = document.getElementById('mon-ratelimit');
    if (!el) return;
    if (monProvider !== 'codex' || !rl) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = '';
    const bar = (label, w) => {
      if (!w) return '';
      const pct = Math.min(100, Math.round(w.used_percent || 0));
      const reset = w.resets_at ? new Date(w.resets_at * 1000).toLocaleString('zh-TW', { hour12: false }) : '-';
      const mins = w.window_minutes ? (w.window_minutes >= 1440 ? (w.window_minutes / 1440) + '天' : w.window_minutes >= 60 ? (w.window_minutes / 60) + '時' : w.window_minutes + '分') : '';
      const hot = pct >= 90 ? '#e5534b' : pct >= 60 ? '#d7ba7d' : '#6cc04a';
      return `<div class="rl-row"><span class="rl-label">${monEsc(label)}${mins ? ' (' + mins + ')' : ''}</span>`
        + `<span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, pct)}%;background:${hot}"></span></span>`
        + `<span class="rl-val">${pct}%</span><span class="rl-reset">重置 ${monEsc(reset)}</span></div>`;
    };
    el.innerHTML = `<div class="rl-head">Codex 額度 · plan <b>${monEsc(rl.plan_type || '?')}</b></div>`
      + bar('主要視窗', rl.primary) + bar('次要視窗', rl.secondary);
  }

  function monBarRow(label, value, max, valStr, color) {
    const pct = Math.max(2, Math.round((value / (max || 1)) * 100));
    return `<div class="bar-row"><span class="bar-label" title="${monEsc(label)}">${monEsc(label)}</span>`
      + `<span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${color}"></span></span>`
      + `<span class="bar-val">${valStr}</span></div>`;
  }

  function monRenderCharts(byModel, byDay) {
    const mMax = Math.max(1, ...byModel.map((b) => b.costUsd));
    const modelBars = byModel.length
      ? byModel.map((b) => monBarRow(b.model, b.costUsd, mMax,
          `${monFmtUsd(b.costUsd)} · ${monFmt(b.turns)} turns`, '#6cc04a')).join('')
      : '<div class="mon-empty">尚無資料（點「重審歷史」可套用到既有對話）</div>';
    const recent = byDay.slice(-30);
    const dMax = Math.max(1, ...recent.map((b) => b.costUsd));
    const dayBars = recent.length
      ? recent.map((b) => monBarRow(b.day, b.costUsd, dMax,
          `${monFmtUsd(b.costUsd)} · ${monFmt(b.turns)} turns`, '#0e9bd6')).join('')
      : '<div class="mon-empty">尚無資料</div>';
    monDashEl.innerHTML =
      `<div class="chart-block"><h3>成本 — 按 Model</h3>${modelBars}</div>` +
      `<div class="chart-block"><h3>成本趨勢 — 按日（近 30 天）</h3>${dayBars}</div>`;
  }

  function monRenderTotals(t, updatedAt) {
    t = t || { tokens: {} };
    const tk = t.tokens || {};
    monUpdated.textContent = updatedAt ? ('索引更新：' + monFmtTs(updatedAt)) : '';
    const sw = t.sensitiveHits || 0;
    monSwBadge.style.display = sw ? '' : 'none';
    monSwBadge.textContent = sw;
    monTotals.innerHTML = [
      ['Sessions', monFmt(t.sessions)],
      ['Turns', monFmt(t.turns)],
      ['Input', monFmt(tk.input)],
      ['Output', monFmt(tk.output)],
      ['Cache 建立', monFmt(tk.cacheCreate)],
      ['Cache 讀取', monFmt(tk.cacheRead)],
      ['成本估算', monFmtUsd(t.costUsd), 'cost'],
      ['敏感詞命中', monFmt(sw), sw ? 'warn' : ''],
    ].map(([k, v, cls]) => `<div class="stat"><span class="k">${k}</span><span class="v ${cls || ''}">${v}</span></div>`).join('');
  }

  function monRenderUsage(sessions) {
    if (!sessions.length) {
      monUsageEl.innerHTML = '<div class="mon-empty">尚無採集到的 session。daemon 重啟後背景 watcher 會開始採集。</div>';
      return;
    }
    const rows = sessions.map((s) => {
      const models = Object.keys(s.models || {}).join(', ') || '-';
      const sw = s.sensitiveHitCount || 0;
      const summary = monEsc(s.summary) || '<span style="color:#666">(空)</span>';
      return `<tr class="sess-row" data-sid="${monEsc(s.sessionId)}">
        <td><div class="mon-summary" title="${monEsc(s.summary)}">${summary}</div>
            <div style="color:#666;font-size:10px">${monEsc(s.sessionId.slice(0, 8))} · ${monEsc(s.cwd || s.projectDir || '')}</div></td>
        <td class="mon-model">${monEsc(models)}</td>
        <td class="num">${monFmt(s.turns)}</td>
        <td class="num">${monFmt(s.tokens.input)}</td>
        <td class="num">${monFmt(s.tokens.output)}</td>
        <td class="num">${monFmt(s.tokens.cacheRead)}</td>
        <td class="num mon-cost">${monFmtUsd(s.costUsd)}</td>
        <td class="num">${sw ? `<span class="mon-sw-count">${sw}</span>` : '-'}</td>
        <td style="color:#888;white-space:nowrap">${monFmtTs(s.lastTs)}</td>
      </tr>
      <tr class="convo-row" data-for="${monEsc(s.sessionId)}" style="display:none"><td colspan="9" style="background:#1b1b1b"><div class="convo-body"></div></td></tr>`;
    }).join('');
    monUsageEl.innerHTML = `<table class="mon-table">
      <thead><tr><th>Session</th><th>Model</th><th>Turns</th><th>Input</th><th>Output</th><th>Cache讀</th><th>成本</th><th>敏感</th><th>最後活動</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    monUsageEl.querySelectorAll('tr.sess-row').forEach((tr) => {
      tr.addEventListener('click', () => monToggleConvo(tr.dataset.sid));
    });
  }

  async function monToggleConvo(sid) {
    const convoRow = monUsageEl.querySelector(`tr.convo-row[data-for="${CSS.escape(sid)}"]`);
    if (!convoRow) return;
    if (convoRow.style.display !== 'none') {
      convoRow.style.display = 'none';
      monStopConvoLive();
      monConvoOpen = !!monUsageEl.querySelector('tr.convo-row:not([style*="display: none"])');
      return;
    }
    convoRow.style.display = '';
    monConvoOpen = true;
    monStopConvoLive(); // 切換到別的 session 前先停舊輪詢
    const body = convoRow.querySelector('.convo-body');
    body.innerHTML = '<div style="color:#888;padding:8px">分析中…</div>';
    try {
      // 並行抓「成本歸因」與「完整對話」
      const [analysis, c] = await Promise.all([
        apiFetch(monUrl('/api/usage/' + encodeURIComponent(sid) + '/analysis')).then((r) => r.json()).catch(() => null),
        apiFetch(monUrl('/api/usage/' + encodeURIComponent(sid) + '/conversation')).then((r) => r.json()),
      ]);
      const turns = c.turns || [];
      const convoHtml = turns.length
        ? '<div class="mon-convo">' + turns.map((t) => {
            const tok = t.tokens ? ` · in ${monFmtK(t.tokens.input)} out ${monFmtK(t.tokens.output)}` : '';
            return `<div class="turn ${monEsc(t.role)}"><div class="role">${monEsc(t.role)}${t.model ? ' · ' + monEsc(t.model) : ''}${tok}</div><div class="text">${monEsc(t.text)}</div></div>`;
          }).join('') + '</div>'
        : '<div class="mon-empty">無對話內容</div>';
      // 左:歸因 + 對話;右:live 逐輪 feed
      body.innerHTML = `<div class="convo-main">${monRenderAnalysis(analysis)}${convoHtml}</div>`
        + `<div class="convo-live">${monRenderLive(analysis)}</div>`;
      monMaybeStartConvoLive(sid, analysis, convoRow); // 進行中才輪詢
    } catch (err) {
      if (err.message === 'unauthorized') return;
      body.innerHTML = '<div style="color:#f48771;padding:8px">載入失敗：' + monEsc(err.message) + '</div>';
    }
  }

  function monStopConvoLive() {
    if (monConvoLiveTimer) { clearInterval(monConvoLiveTimer); monConvoLiveTimer = null; }
  }

  // 最後一輪在 LIVE_ACTIVE_MS 內 → 視為進行中
  function monIsActive(a) {
    const ts = a && a.turns && a.turns.length ? a.turns[a.turns.length - 1].ts : null;
    return ts ? (Date.now() - new Date(ts).getTime() < LIVE_ACTIVE_MS) : false;
  }

  // 進行中的 session → 每 4s 重抓 analysis 刷新右側 live feed;變 idle 或收合即停
  function monMaybeStartConvoLive(sid, analysis, convoRow) {
    if (!monIsActive(analysis)) return;
    monConvoLiveTimer = setInterval(async () => {
      if (!convoRow.isConnected || convoRow.style.display === 'none') { monStopConvoLive(); return; }
      try {
        const a = await apiFetch(monUrl('/api/usage/' + encodeURIComponent(sid) + '/analysis')).then((r) => r.json());
        const el = convoRow.querySelector('.convo-live');
        if (el) el.innerHTML = monRenderLive(a);
        if (!monIsActive(a)) monStopConvoLive();
      } catch { monStopConvoLive(); }
    }, 4000);
  }

  // Live 逐輪 feed（右側欄 / 頂部分頁共用）：newest-first,cacheCreate>SPIKE_CW 標紅,
  // spike 顯示「↑ 上一輪工具的結果被 ingest」。
  function monRenderLive(a, opts) {
    opts = opts || {};
    if (!a || !a.turns || !a.turns.length) return '<div class="mon-empty">無逐輪資料</div>';
    const turns = a.turns; // oldest-first
    const active = monIsActive(a);
    const head = `<div class="live-head" title="費率 ${monEsc(monRateHint(a))}">${monEsc(opts.title || 'LIVE 逐輪')} · ${a.requests} 輪 · <span class="mon-cost">${monFmtUsd(a.costUsd)}</span> `
      + (active ? '<span class="live-dot">●live</span>' : '<span class="live-idle">idle</span>') + '</div>';
    const rows = [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      const cw = t.tokens.cacheCreate || 0;
      const spike = cw > SPIKE_CW;
      const ownTools = (t.tools || []).map((x) =>
        monEsc(x.name) + (x.hint ? `<span class="lh"> ${monEsc(x.hint)}</span>` : '')).join('、');
      const prev = turns[i - 1];
      const ingest = spike && prev && prev.tools && prev.tools.length
        ? `<div class="lr-ingest">↑ 吞入 #${prev.order + 1} 的 ${monEsc(prev.tools[0].name)}${prev.tools[0].hint ? ' ' + monEsc(prev.tools[0].hint) : ''} 結果</div>`
        : '';
      rows.push(`<div class="live-row${spike ? ' spike' : ''}">
        <div class="lr-head"><span class="lr-n">#${t.order + 1}</span>${spike ? '<span class="lr-flag">🔴</span>' : ''}<span class="lr-cost">${monFmtUsd(t.costUsd)}</span><span class="lr-tools">${ownTools || '<span class="lh">(純文字)</span>'}</span></div>
        <div class="lr-tok">out <b>${monFmtK(t.tokens.output)}</b> · cw <b class="${spike ? 'hot' : ''}">${monFmtK(cw)}</b> · cr ${monFmtK(t.tokens.cacheRead)} · in ${monFmtK(t.tokens.input)}</div>
        ${ingest}
      </div>`);
    }
    return head + '<div class="live-list">' + rows.join('') + '</div>';
  }

  // 費率參考字串（USD / 1M token）。成本是「若走 API 計價」的等值,非真實帳單。
  function monRateHint(a) {
    const rates = (a && a.rates) || {};
    const models = Object.keys(rates);
    if (!models.length) return '';
    return models.map((m) => {
      const r = rates[m];
      const short = m.replace('claude-', '');
      return `${short}: in$${r.input} out$${r.output} cw5m$${r.cacheWrite5m} cw1h$${r.cacheWrite1h} cr$${r.cacheRead}`;
    }).join(' ｜ ') + '（/1M token · 等值估算非帳單）';
  }

  // 成本歸因面板:診斷 + 最貴的輪 + 來源拆分 + 工具計數
  function monRenderAnalysis(a) {
    if (!a || !a.requests) return '';
    const tot = a.totalUnits || 1;
    const findings = (a.findings || []).map((f) =>
      `<div class="mon-finding ${monEsc(f.level)}"><div class="ft">${monEsc(f.title)}</div><div class="fd">${monEsc(f.detail)}</div></div>`).join('');

    // 來源拆分（成本單位佔比）
    const sp = a.split || {};
    const seg = (label, v) => `<span class="seg">${label} <b>${((v / tot) * 100).toFixed(0)}%</b></span>`;
    const splitHtml = `<div class="mon-split">${seg('Output(5×)', sp.output)}${seg('CacheCreate(1.25×)', sp.cacheCreate)}${seg('CacheRead(0.1×)', sp.cacheRead)}${seg('Input(1×)', sp.input)}</div>`;

    // 最貴的輪
    const rows = (a.topByUnits || []).map((r) => {
      const tools = r.tools && r.tools.length
        ? r.tools.map((t) => monEsc(t.name) + (t.hint ? ` <span class="hint">${monEsc(t.hint)}</span>` : '')).join('; ')
        : (r.thinking ? '<span class="hint">(thinking / 純文字)</span>' : '<span class="hint">(純文字)</span>');
      return `<tr>
        <td class="l">#${r.order + 1}</td>
        <td class="mon-cost">${monFmtUsd(r.costUsd)}</td>
        <td>${(r.pct * 100).toFixed(1)}%</td>
        <td>${monFmt(r.tokens.output)}</td>
        <td>${monFmt(r.tokens.cacheCreate)}</td>
        <td>${monFmt(r.tokens.cacheRead)}</td>
        <td class="l">${tools}</td>
      </tr>`;
    }).join('');
    const turnsTable = rows ? `<table class="mon-turns">
      <thead><tr><th class="l">輪</th><th>成本</th><th>佔比</th><th>Output</th><th>CacheCreate</th><th>CacheRead</th><th class="l">觸發工具</th></tr></thead>
      <tbody>${rows}</tbody></table>` : '';

    // 工具計數
    const tc = Object.entries(a.toolCounts || {}).sort((x, y) => y[1] - x[1]);
    const chips = tc.length
      ? `<div class="mon-toolchips">${tc.map(([n, c]) => `<span class="chip">${monEsc(n)} <b>${c}</b></span>`).join('')}</div>`
      : '';

    return `<div class="mon-analysis">
      <h4>診斷（${a.requests} 個回應 · 此 session 等值成本 <span class="mon-cost">${monFmtUsd(a.costUsd)}</span>）</h4>
      ${findings}
      <h4>成本來源拆分</h4>
      ${splitHtml}
      <h4>最貴的輪</h4>
      ${turnsTable}
      <div class="mon-rate-hint">費率 ${monEsc(monRateHint(a))}</div>
      ${chips ? '<h4>工具呼叫</h4>' + chips : ''}
    </div>`;
  }

  function monRenderSensitive(hits) {
    if (!hits.length) {
      monSensEl.innerHTML = '<div class="mon-empty">目前無敏感詞命中。詞庫：<code>~/.kabby/sensitive-words.json</code>（改完按「重審歷史」可套用到舊對話）</div>';
      return;
    }
    monSensEl.innerHTML = hits.map((h) => `<div class="mon-hit">
      <span class="word">${monEsc(h.word)}</span>
      <span class="role">${monEsc(h.role)}</span>
      <span class="snippet" title="${monEsc(h.snippet)}">${monEsc(h.snippet)}</span>
      <span class="where">${monEsc(h.sessionId.slice(0, 8))} · ${monFmtTs(h.ts)}</span>
    </div>`).join('');
  }

  monModal.querySelectorAll('.mon-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      monModal.querySelectorAll('.mon-tab').forEach((b) => b.classList.toggle('active', b === btn));
      const v = btn.dataset.view;
      monUsageEl.classList.toggle('active', v === 'usage');
      monLiveTabEl.classList.toggle('active', v === 'live');
      monDashEl.classList.toggle('active', v === 'dash');
      monSensEl.classList.toggle('active', v === 'sensitive');
      if (v === 'live') monLoadLiveTab(); else monStopTabLive();
    });
  });

  // 頂部 Live 分頁:自動鎖定「最近活動」的 session,全寬顯示其 live feed 並輪詢
  function monStopTabLive() {
    if (monTabLiveTimer) { clearInterval(monTabLiveTimer); monTabLiveTimer = null; }
  }
  async function monRenderLiveTabFor(sid) {
    try {
      const a = await apiFetch(monUrl('/api/usage/' + encodeURIComponent(sid) + '/analysis')).then((r) => r.json());
      // 仍停在 Live 分頁才更新（使用者可能已切走）
      if (!monLiveTabEl.classList.contains('active')) return;
      monLiveTabEl.innerHTML = `<div class="livetab-wrap" data-sid="${monEsc(sid)}">`
        + `<div class="livetab-bar">追蹤最近活動 session：<code>${monEsc(sid.slice(0, 8))}</code></div>`
        + monRenderLive(a, { title: 'Live 逐輪（自動鎖定）' }) + '</div>';
      if (!monIsActive(a)) monStopTabLive(); // 已 idle 就停輪詢(畫面保留)
    } catch (err) {
      if (err.message === 'unauthorized') return;
      monLiveTabEl.innerHTML = '<div class="mon-empty">載入失敗：' + monEsc(err.message) + '</div>';
    }
  }
  async function monLoadLiveTab() {
    monStopTabLive();
    monLiveTabEl.innerHTML = '<div style="color:#888;padding:8px">尋找最近活動 session…</div>';
    let sessions = [];
    try {
      const usage = await apiFetch(monUrl('/api/usage')).then((r) => r.json());
      sessions = usage.sessions || []; // 已按 lastTs desc 排序
    } catch (err) {
      if (err.message === 'unauthorized') return;
      monLiveTabEl.innerHTML = '<div class="mon-empty">載入失敗：' + monEsc(err.message) + '</div>';
      return;
    }
    const top = sessions[0];
    if (!top) { monLiveTabEl.innerHTML = '<div class="mon-empty">尚無 session</div>'; return; }
    await monRenderLiveTabFor(top.sessionId);
    // 持續輪詢:每 4s 重新挑「最近活動」的 session 並刷新（最新 session 可能換人）
    monTabLiveTimer = setInterval(async () => {
      if (!monModal.classList.contains('visible') || !monLiveTabEl.classList.contains('active')) { monStopTabLive(); return; }
      let s2 = [];
      try { s2 = (await apiFetch(monUrl('/api/usage')).then((r) => r.json())).sessions || []; } catch { return; }
      if (s2[0]) monRenderLiveTabFor(s2[0].sessionId);
    }, 4000);
  }
  // Provider 切換器（claude / codex）：切換 → 重抓對應 provider 的資料
  function monSetProvider(p) {
    if (p === monProvider) return;
    monProvider = p;
    monConvoOpen = false;
    monStopConvoLive(); monStopTabLive();
    document.querySelectorAll('#mon-provider .mon-prov').forEach((b) =>
      b.classList.toggle('active', b.dataset.provider === p));
    // 切 provider 後若停在 Live 分頁 → 重載該分頁,否則載總覽
    if (monLiveTabEl.classList.contains('active')) monLoadLiveTab();
    loadMonitor();
  }
  document.querySelectorAll('#mon-provider .mon-prov').forEach((b) =>
    b.addEventListener('click', () => monSetProvider(b.dataset.provider)));

  document.getElementById('monitor-btn').addEventListener('click', openMonitor);
  document.getElementById('mon-close').addEventListener('click', closeMonitor);

  // 「全部項目」modal 控制
  document.getElementById('ap-close').addEventListener('click', closeProjectsModal);
  projectsModal.addEventListener('click', (e) => { if (e.target === projectsModal) closeProjectsModal(); });
  apGridBtn.addEventListener('click', () => setProjectsView('grid'));
  apListBtn.addEventListener('click', () => setProjectsView('list'));
  apSearchEl.addEventListener('input', renderProjectsModal);
  document.getElementById('mon-refresh').addEventListener('click', loadMonitor);
  document.getElementById('mon-rebuild').addEventListener('click', async () => {
    if (!confirm('重審歷史：砍索引從頭全掃，重新計算所有既有對話的 token/成本（套用 requestId 去重修正，數字會校正到正確值）並套用目前敏感詞庫。資料量大時較久，確定？')) return;
    monTotals.innerHTML = '<span style="color:#888">重審中（全掃）…</span>';
    try {
      await apiFetch(monUrl('/api/usage?rebuild=1')).then((r) => r.json());
      await loadMonitor();
    } catch (err) {
      if (err.message === 'unauthorized') return;
      monTotals.innerHTML = '<span style="color:#f48771">重審失敗：' + monEsc(err.message) + '</span>';
    }
  });

  leafLiveInit(); // 焦點 session 即時 live 小面板（按鈕事件 + 還原開關狀態）

  // 週期刷新運行中 session 的 metadata；profile 不需高頻（鎖定中各自會 early-return）
  setInterval(refreshSessions, 3000);
  setInterval(refreshProfiles, 10_000);

  // Boot：先問 daemon 是否需要 token；需要且本機沒存 token → 顯示登入頁
  async function boot() {
    let health = {};
    try { health = await fetch(API + '/api/health').then((r) => r.json()); } catch {}
    authRequired = !!health.authRequired;
    updateLockBtn();
    if (authRequired && !authToken) { showLogin(); return; }
    refreshAll();   // token 若過期/錯誤，apiFetch 收到 401 會自動 showLogin
  }
  boot();
})();













