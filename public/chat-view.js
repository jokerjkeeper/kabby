/**
 * 對話視圖（每個 pane 可在「終端｜對話」互切；app.js 用）。
 *
 * cc 照樣跑在 PTY；這裡輪詢 daemon 的 /api/sessions/:id/chat 取「增量 items」，
 * 畫成工具卡片 + markdown 回覆；底部輸入框把文字寫回 PTY（等同在終端打字按 Enter）。
 * TUI 才有的互動（權限確認、/ 指令選單）不在 jsonl 裡 → 偵測到工具久無結果時提示切回終端。
 *
 * createChatView(opts) → { show, hide, dispose, isVisible, appendText, focus }
 *   opts.host        掛載點（leaf.el，position:relative）
 *   opts.fetchChat   async (key, after) => /chat 回應 JSON
 *   opts.send        (data) => boolean   寫 PTY（未連線回 false）
 *   opts.onSwitchToTerm () => void
 *   opts.onToast     (text, kind) => void
 *   opts.bindVoice   (btn, onText) => void   選用：🎙 按鈕
 */
(function () {
  const POLL_MS = 1500;
  const WAIT_HINT_MS = 3000;     // 工具超過這麼久沒結果 → 提示「終端可能在等你」
  const MAX_INITIAL = 400;       // 首次載入只畫最後 N 筆（長 session 的 DOM 護欄）
  const FOLD_LINES = 12;         // 長訊息摺疊門檻
  const FOLD_CHARS = 800;
  const md = () => window.KabbyMd;

  function esc(s) { return md().escapeHtml(s == null ? '' : String(s)); }

  // 工具卡片標題列的提示（與後端 toolHint 同一優先序）
  function toolSummary(input) {
    if (!input || typeof input !== 'object') return '';
    const h = input.file_path || input.notebook_path || input.command || input.pattern || input.path
      || input.url || input.query || input.description || input.prompt || input.hint || '';
    return String(h).replace(/\s+/g, ' ');
  }
  const TOOL_ICON = { Read: '≡', Write: '✎', Edit: '✎', MultiEdit: '✎', NotebookEdit: '✎', Bash: '$',
    Glob: '◇', Grep: '⌕', WebFetch: '⇣', WebSearch: '⌕', Task: '◈', Agent: '◈', TodoWrite: '☑' };

  function preBlock(text, cls) {
    return `<pre class="cv-pre${cls ? ' ' + cls : ''}">${esc(text)}</pre>`;
  }

  // 依工具種類畫 input（Edit 類畫紅綠 diff、Bash 畫指令、TodoWrite 畫清單，其餘 JSON）
  function renderToolInput(name, input) {
    input = input || {};
    const file = input.file_path ? `<div class="cv-file">${esc(input.file_path)}</div>` : '';
    if (name === 'Edit' && (input.old_string != null || input.new_string != null)) {
      return file + preBlock(input.old_string || '', 'del') + preBlock(input.new_string || '', 'add');
    }
    if (name === 'MultiEdit' && Array.isArray(input.edits)) {
      return file + input.edits.map((e) => preBlock(e.old_string || '', 'del') + preBlock(e.new_string || '', 'add')).join('');
    }
    if (name === 'Write' && input.content != null) return file + preBlock(input.content);
    if (name === 'Bash' && input.command) {
      return (input.description ? `<div class="cv-file">${esc(input.description)}</div>` : '') + preBlock('$ ' + input.command);
    }
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      const mark = { completed: '☑', in_progress: '▶', pending: '☐' };
      return '<ul class="cv-todos">' + input.todos.map((t) =>
        `<li class="${esc(t.status)}">${mark[t.status] || '☐'} ${esc(t.content || t.activeForm || '')}</li>`).join('') + '</ul>';
    }
    if (name === 'Read' && input.file_path && Object.keys(input).length <= 3) return file;
    return preBlock(JSON.stringify(input, null, 2));
  }

  window.createChatView = function (opts) {
    const root = document.createElement('div');
    root.className = 'chat-pane';
    root.style.display = 'none';
    root.innerHTML = `
      <div class="chat-scroll"><div class="chat-list"></div></div>
      <div class="chat-banner" style="display:none"><span>⏳ 工具執行中，或終端正在等你確認（權限 / 選單）</span>
        <button class="btn tiny" data-act="term">切到終端</button></div>
      <div class="chat-input">
        <textarea rows="3" data-voice-hotkey="1" placeholder="問 cc（Enter 送出、Shift+Enter 換行；權限確認與 / 選單請切回終端）"></textarea>
        <div class="chat-actions">
          <button class="btn tiny chat-mic" title="🎙 按住說話，放開後把文字放進輸入框">🎙</button>
          <button class="btn tiny" data-act="esc" title="送 Esc 給 cc（中斷目前回應）">⏹ 中斷</button>
          <span class="chat-state"></span>
          <span class="spacer"></span>
          <button class="btn tiny" data-act="term" title="切回終端（看原始畫面 / 處理權限確認）">終端</button>
          <button class="btn primary tiny" data-act="send">送出</button>
        </div>
      </div>`;
    opts.host.appendChild(root);
    root.addEventListener('mousedown', (e) => e.stopPropagation());   // 不讓 pane 的 mousedown 把焦點搶回 xterm

    const scrollEl = root.querySelector('.chat-scroll');
    const listEl = root.querySelector('.chat-list');
    const bannerEl = root.querySelector('.chat-banner');
    const ta = root.querySelector('textarea');
    const stateEl = root.querySelector('.chat-state');
    const micBtn = root.querySelector('.chat-mic');
    if (opts.bindVoice) opts.bindVoice(micBtn, (t) => appendText(t));
    else micBtn.remove();

    let key = '';
    let total = 0;               // 已收到的 item 數（= 下次 after）
    let cards = new Map();       // toolUseId → { el, name, input, result, waitingSince }
    let timer = null;
    let inflight = false;
    let visible = false;
    let disposed = false;
    let pendingSince = 0;        // 送出後等回應中（timestamp）；0 = 沒在等
    let statusNote = '';

    function nearBottom() { return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 40; }
    function scrollBottom() { scrollEl.scrollTop = scrollEl.scrollHeight; }

    function setNote(html) {
      statusNote = html;
      paintState();
    }
    function paintState() {
      stateEl.innerHTML = pendingSince ? '<span class="chat-dots">等待回應</span>' : statusNote;
    }

    function resetList() {
      listEl.innerHTML = '';
      cards = new Map();
      total = 0;
    }

    function cardBody(c) {
      let html = renderToolInput(c.name, c.input);
      if (c.result) html += `<div class="cv-result-label">${c.result.isError ? '錯誤' : '結果'}</div>` + preBlock(c.result.content || '(無輸出)', c.result.isError ? 'err' : 'out');
      return html;
    }
    function paintCard(c) {
      const st = c.el.querySelector('.cv-st');
      if (c.result) { st.textContent = c.result.isError ? '✗' : '✓'; st.className = 'cv-st ' + (c.result.isError ? 'err' : 'ok'); }
      else if (c.id) { st.textContent = '…'; st.className = 'cv-st run'; }
      else { st.textContent = ''; }
      if (c.el.classList.contains('open')) c.el.querySelector('.cv-card-body').innerHTML = cardBody(c);
    }

    // 長訊息可摺疊：超過 FOLD_LINES 行或 FOLD_CHARS 字才加「展開 / 收合」鈕。
    // 使用者訊息預設收合（常是貼上的長文、背景任務通知），回覆預設展開。
    function makeFoldable(wrap, content, text, collapsed) {
      const lines = String(text).split('\n').length;
      if (lines <= FOLD_LINES && text.length <= FOLD_CHARS) return;
      content.classList.add('cv-fold');
      const btn = document.createElement('button');
      btn.className = 'cv-fold-btn';
      const paint = (c) => {
        content.classList.toggle('collapsed', c);
        btn.textContent = c ? `▾ 展開全文（${lines} 行）` : '▴ 收合';
      };
      btn.addEventListener('click', () => {
        const willCollapse = !content.classList.contains('collapsed');
        paint(willCollapse);
        if (willCollapse) wrap.scrollIntoView({ block: 'nearest' });   // 收合後別讓畫面停在一片空白
      });
      paint(collapsed);
      wrap.appendChild(btn);
    }

    function renderItem(it) {
      if (it.kind === 'result') {
        const c = it.toolUseId && cards.get(it.toolUseId);
        if (c) { c.result = it; c.waitingSince = 0; paintCard(c); }
        return;
      }
      const el = document.createElement('div');
      if (it.kind === 'user') {
        el.className = 'cv-msg user';
        el.innerHTML = `<div class="cv-bubble">${esc(it.text)}</div>`;
        makeFoldable(el, el.firstChild, it.text, true);
      } else if (it.kind === 'assistant') {
        el.className = 'cv-msg assistant';
        el.innerHTML = `<div class="cv-text md">${md().render(it.text)}</div>`;
        makeFoldable(el, el.firstChild, it.text, false);
      } else if (it.kind === 'tool') {
        el.className = 'cv-card';
        const sum = toolSummary(it.input);
        el.innerHTML = `<div class="cv-card-head"><span class="cv-ico">${esc(TOOL_ICON[it.name] || '•')}</span>`
          + `<span class="cv-name">${esc(it.name)}</span><span class="cv-sum">${esc(sum)}</span>`
          + `<span class="cv-st"></span></div><div class="cv-card-body"></div>`;
        const c = { id: it.id, el, name: it.name, input: it.input, result: null, waitingSince: it.id ? Date.now() : 0 };
        if (it.id) cards.set(it.id, c);
        el.querySelector('.cv-card-head').addEventListener('click', () => {
          el.classList.toggle('open');
          el.querySelector('.cv-card-body').innerHTML = el.classList.contains('open') ? cardBody(c) : '';
        });
        paintCard(c);
      } else return;
      listEl.appendChild(el);
    }

    function applyResponse(r) {
      if (r.unsupported) { setNote('此 provider 不支援對話記錄'); return; }
      if (r.notFound) {
        if (!total) listEl.innerHTML = '<div class="cv-empty">還沒有對話記錄<br>在下方輸入第一句話，cc 回應後會出現在這裡</div>';
        return;
      }
      if (r.reset || r.key !== key) {
        resetList();
        key = r.key;
      }
      if (r.unchanged) return;
      const stick = nearBottom() || r.reset;
      let items = r.items || [];
      // 舊的已經結束的卡片（初次載入）不該觸發「在等你」提示
      const initial = total === 0;
      if (initial && items.length > MAX_INITIAL) {
        const skipped = items.length - MAX_INITIAL;
        items = items.slice(skipped);   // 邊界上的 result 若對不到卡片就略過，無妨
        const note = document.createElement('div');
        note.className = 'cv-skip';
        note.textContent = `較早的 ${skipped} 筆略過（完整內容請用上方「對話記錄」）`;
        listEl.appendChild(note);
      }
      let gotReply = false;
      for (const it of items) {
        renderItem(it);
        if (it.kind === 'assistant' || it.kind === 'tool') gotReply = true;
      }
      if (initial) for (const c of cards.values()) c.waitingSince = 0;
      total = r.total;
      if (pendingSince && gotReply && !initial) pendingSince = 0;
      paintState();
      if (stick) scrollBottom();
    }

    function updateBanner() {
      const now = Date.now();
      let waiting = false;
      for (const c of cards.values()) {
        if (!c.result && c.waitingSince && now - c.waitingSince > WAIT_HINT_MS) { waiting = true; break; }
      }
      bannerEl.style.display = waiting ? '' : 'none';
      if (pendingSince && now - pendingSince > 10 * 60 * 1000) { pendingSince = 0; paintState(); }
    }

    async function tick() {
      if (inflight || disposed) return;
      inflight = true;
      try {
        const r = await opts.fetchChat(key, key ? total : -1);
        if (!disposed) {
          if (statusNote) setNote('');   // 清掉上次的錯誤
          applyResponse(r);
        }
      } catch (err) {
        setNote('<span style="color:#e06c6c">讀取失敗：' + esc(err.message || err) + '</span>');
      } finally {
        inflight = false;
        if (!disposed) updateBanner();
      }
    }

    // 送出：一律以 bracketed paste 包文字（多行不會被當成多次 Enter），稍後再補 \r 送出。
    // 文字與 \r 分兩次寫：cc（Ink）會把「同一批到達、含 \r 的輸入」當成貼上而只換行不送出。
    function submit() {
      const text = ta.value.replace(/\s+$/, '');
      if (!text.trim()) return;
      const body = text.replace(/\r?\n/g, '\r');
      if (!opts.send('\x1b[200~' + body + '\x1b[201~')) {
        if (opts.onToast) opts.onToast('session 未連線，訊息未送出', 'warn');
        return;
      }
      setTimeout(() => opts.send('\r'), 80);
      ta.value = '';
      pendingSince = Date.now();
      paintState();
      scrollBottom();
      setTimeout(tick, 400);
    }

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        submit();
      }
    });
    root.addEventListener('click', (e) => {
      const act = e.target.closest && e.target.closest('[data-act]');
      if (!act) return;
      const a = act.dataset.act;
      if (a === 'send') submit();
      else if (a === 'term') opts.onSwitchToTerm();
      else if (a === 'esc') { opts.send('\x1b'); pendingSince = 0; paintState(); }
    });

    function appendText(t) {
      if (window.KabbyVoice) window.KabbyVoice.appendToInput(ta, t);
      else { ta.value += t; ta.focus(); }
    }

    function show() {
      if (disposed) return;
      visible = true;
      root.style.display = '';
      tick();
      if (!timer) timer = setInterval(tick, POLL_MS);
      ta.focus();
    }
    function hide() {
      visible = false;
      root.style.display = 'none';
      if (timer) { clearInterval(timer); timer = null; }
    }
    function dispose() {
      hide();
      disposed = true;
      root.remove();
    }

    return { show, hide, dispose, appendText, isVisible: () => visible, focus: () => ta.focus() };
  };
})();
