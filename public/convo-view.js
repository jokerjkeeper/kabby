/**
 * 對話記錄檢視器（訪客 room.js 與房主 app.js 共用）。
 *
 * 一份邏輯來源：markdown 渲染（含表格）、搜尋高亮、工具呼叫展開、簡潔（文科生）
 * 模式、匯出 MD/HTML、自動刷新。呼叫端只需提供 DOM 元素 + 一個 fetchTurns()。
 *
 * createConvoView(opts) → { open, close, toggle, refresh, isOpen }
 *   opts.elements = { panel, body, status, search?, toolsToggle?, readerToggle?,
 *                     closeBtn?, refreshBtn?, exportMdBtn?, exportHtmlBtn?, triggerBtn? }
 *   opts.fetchTurns = async () => ({ turns:[...], unsupported?, notFound? })
 *   opts.onToast = (text, kind) => {}   // 選用
 *   opts.refreshMs = 8000               // 選用
 */
(function () {
  // 簡潔模式的主要過濾靠「是否帶工具」（過場 narration 在 cc 與 tool_use 同輪、codex 端已把
  // function_call 掛到該輪）。長度只是次要護欄，擋「好的/收到/Done」這種極短的純文字 ack，
  // 門檻放低以免誤藏真正的短結論。
  const READER_MIN = 20;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtTs(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString('zh-TW', { hour12: false }); } catch { return ''; }
  }

  // ── 輕量 Markdown（先整段 escape 再轉換 → 無 HTML 注入疑慮）──
  function mdInline(s) {   // s 已 escape
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function mdSplitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  }
  function mdIsTableSep(line) {
    if (!line || line.indexOf('|') < 0) return false;   // 排除純 --- 分隔線（那是 hr）
    const cells = mdSplitRow(line);
    return cells.length >= 1 && cells.every((c) => /^:?-{2,}:?$/.test(c));
  }
  function mdBlock(raw) {
    const lines = escapeHtml(raw).split('\n');
    const html = [];
    let list = null;   // 'ul' | 'ol'
    let para = [];
    const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };
    const flushPara = () => {
      if (para.length) { html.push('<p>' + para.map(mdInline).join('<br>') + '</p>'); para = []; }
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 表格：本列含 | 且下一列是分隔列
      if (line.indexOf('|') >= 0 && mdIsTableSep(lines[i + 1])) {
        flushPara(); closeList();
        const header = mdSplitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && !/^\s*$/.test(lines[i]) && lines[i].indexOf('|') >= 0) {
          rows.push(mdSplitRow(lines[i])); i++;
        }
        i--;
        let t = '<table class="md-table"><thead><tr>'
          + header.map((c) => `<th>${mdInline(c)}</th>`).join('') + '</tr></thead>';
        if (rows.length) {
          t += '<tbody>' + rows.map((r) =>
            '<tr>' + header.map((_, ci) => `<td>${mdInline(r[ci] || '')}</td>`).join('') + '</tr>'
          ).join('') + '</tbody>';
        }
        html.push(t + '</table>');
        continue;
      }
      if (/^\s*$/.test(line)) { flushPara(); closeList(); continue; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { flushPara(); closeList(); html.push(`<div class="md-h md-h${h[1].length}">${mdInline(h[2])}</div>`); continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); closeList(); html.push('<hr class="md-hr">'); continue; }
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.、)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const want = ul ? 'ul' : 'ol';
        if (list !== want) { closeList(); html.push(`<${want} class="md-list">`); list = want; }
        html.push('<li>' + mdInline((ul || ol)[1]) + '</li>');
        continue;
      }
      const bq = line.match(/^\s*&gt;\s?(.*)$/);   // 已 escape，'>' 是 &gt;
      if (bq) { flushPara(); closeList(); html.push(`<div class="md-bq">${mdInline(bq[1])}</div>`); continue; }
      closeList();
      para.push(line);
    }
    flushPara(); closeList();
    return html.join('');
  }
  function renderMarkdown(src) {
    const parts = String(src).split(/```/);   // 奇數段 = 圍欄程式碼
    return parts.map((part, i) => {
      if (i % 2 === 0) return mdBlock(part);
      let code = part;
      const nl = code.indexOf('\n');
      if (nl >= 0 && /^[\w+#.-]*\s*$/.test(code.slice(0, nl))) code = code.slice(nl + 1);   // 去掉語言標記行
      return `<pre class="md-code">${escapeHtml(code.replace(/\n$/, ''))}</pre>`;
    }).join('');
  }

  const hasText = (t) => !!(t.text && t.text.trim());
  const hasTools = (t) => !!(t.tools && t.tools.length);

  // 在已渲染 DOM 內以文字節點高亮命中（安全，不破壞 markdown 標籤）
  function highlight(root, q) {
    if (!q) return;
    const needle = q.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets = [];
    let n;
    while ((n = walker.nextNode())) {
      if (n.parentNode && n.parentNode.nodeName === 'MARK') continue;
      if (n.nodeValue.toLowerCase().indexOf(needle) >= 0) targets.push(n);
    }
    for (const node of targets) {
      const text = node.nodeValue, lo = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let idx = 0, pos;
      while ((pos = lo.indexOf(needle, idx)) >= 0) {
        if (pos > idx) frag.appendChild(document.createTextNode(text.slice(idx, pos)));
        const mark = document.createElement('mark');
        mark.className = 'cv-hit';
        mark.textContent = text.slice(pos, pos + needle.length);
        frag.appendChild(mark);
        idx = pos + needle.length;
      }
      if (idx < text.length) frag.appendChild(document.createTextNode(text.slice(idx)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  window.createConvoView = function (opts) {
    const el = opts.elements || {};
    const fetchTurns = opts.fetchTurns;
    const toast = opts.onToast || function () {};
    const REFRESH_MS = opts.refreshMs || 8000;

    let timer = null;
    let turnsAll = [];   // 最近一次抓到的原始 turns
    let query = '';      // 搜尋字串
    let showTools = false;
    let reader = false;  // 簡潔（文科生）模式
    let lastMeta = {};

    function toolsHtml(tools) {
      if (!showTools || reader || !tools || !tools.length) return '';
      return '<div class="cv-tools">' + tools.map((x) => {
        const hint = x.hint ? `<span class="cv-tool-hint">${escapeHtml(x.hint)}</span>` : '';
        return `<span class="cv-tool">🔧 ${escapeHtml(x.name)}${hint}</span>`;
      }).join('') + '</div>';
    }

    // 依目前狀態算出要顯示的 turns
    function visibleTurns() {
      let turns = turnsAll.filter((t) => hasText(t) || (showTools && !reader && hasTools(t)));
      if (reader) {
        // 只留 user + 「純文字、無工具、夠長」的 assistant（過場/工具細節全濾掉）
        turns = turns.filter((t) => t.role === 'user'
          || (hasText(t) && !hasTools(t) && t.text.trim().length >= READER_MIN));
      }
      const q = query.trim().toLowerCase();
      if (q) {
        turns = turns.filter((t) =>
          (t.text && t.text.toLowerCase().indexOf(q) >= 0)
          || (t.tools || []).some((x) => (x.name + ' ' + (x.hint || '')).toLowerCase().indexOf(q) >= 0));
      }
      return turns;
    }

    function render() {
      const q = query.trim();
      const turns = visibleTurns();
      if (!turns.length) {
        el.body.innerHTML = `<div class="cv-empty">${
          lastMeta.unsupported ? '這個 provider 尚未支援對話記錄。'
          : lastMeta.notFound ? '還沒找到這個 session 的對話存檔。<br>對話開始後（第一則訊息送出後）再按「刷新」。'
          : q ? `找不到符合「${escapeHtml(q)}」的內容。`
          : reader && turnsAll.length ? '簡潔模式下沒有可顯示的結論訊息（可關掉簡潔模式看完整對話）。'
          : '目前沒有對話內容。'}</div>`;
        el.status.textContent = (q || reader) && turnsAll.length ? '0 則' : '';
        return;
      }
      const stick = el.body.scrollTop + el.body.clientHeight >= el.body.scrollHeight - 30;
      el.body.innerHTML = turns.map((t) => {
        const model = t.model ? `<span class="cv-model">${escapeHtml(t.model)}</span>` : '';
        const body = hasText(t)
          ? (t.role === 'assistant'
              ? `<div class="cv-text md">${renderMarkdown(t.text)}</div>`
              : `<div class="cv-text">${escapeHtml(t.text)}</div>`)
          : '';
        return `<div class="cv-turn ${escapeHtml(t.role)}">
          <div class="cv-role"><span>${t.role === 'user' ? '👤 USER' : '🤖 ASSISTANT'}</span>${model}<span class="cv-ts">${fmtTs(t.ts)}</span></div>
          ${body}${toolsHtml(t.tools)}
        </div>`;
      }).join('');
      if (q) highlight(el.body, q);
      const label = reader ? '簡潔' : '自動刷新中';
      el.status.textContent = q
        ? `${turns.length} 則命中（共 ${turnsAll.length}）`
        : `${turns.length} 則 · ${label}`;
      if (stick && !q) el.body.scrollTop = el.body.scrollHeight;
    }

    async function refresh() {
      if (!turnsAll.length) el.status.textContent = '載入中…';
      let data;
      try {
        data = await fetchTurns();
      } catch (err) {
        el.status.textContent = '載入失敗：' + (err && err.message ? err.message : err);
        return;
      }
      turnsAll = (data && data.turns) || [];
      lastMeta = { unsupported: data && data.unsupported, notFound: data && data.notFound };
      render();
    }

    // ── 匯出 ──
    function download(name, mime, content) {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function exportName(ext) {
      const d = new Date(), p = (x) => String(x).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
      return `kabby-對話記錄-${stamp}.${ext}`;
    }
    function exportTurns() {
      // 匯出遵循目前顯示規則（簡潔模式 → 只匯出結論），但不受搜尋過濾
      const savedQuery = query; query = '';
      const turns = visibleTurns();
      query = savedQuery;
      return turns;
    }
    function toMarkdown() {
      return exportTurns().map((t) => {
        const who = t.role === 'user' ? '👤 USER' : `🤖 ASSISTANT${t.model ? ' (' + t.model + ')' : ''}`;
        const ts = fmtTs(t.ts);
        let s = `## ${who}${ts ? ' — ' + ts : ''}\n\n${t.text || ''}`;
        if (showTools && !reader && hasTools(t)) {
          s += (t.text ? '\n\n' : '') + t.tools.map((x) => `- 🔧 \`${x.name}\`${x.hint ? ' ' + x.hint : ''}`).join('\n');
        }
        return s;
      }).join('\n\n---\n\n');
    }
    function toHtml() {
      const rows = exportTurns().map((t) => {
        const who = t.role === 'user' ? '👤 USER' : `🤖 ASSISTANT${t.model ? ' (' + escapeHtml(t.model) + ')' : ''}`;
        const body = hasText(t)
          ? (t.role === 'assistant' ? `<div class="md">${renderMarkdown(t.text)}</div>` : `<pre class="usr">${escapeHtml(t.text)}</pre>`)
          : '';
        const tools = (showTools && !reader && hasTools(t))
          ? '<div class="tools">' + t.tools.map((x) => `🔧 ${escapeHtml(x.name)}${x.hint ? ' <i>' + escapeHtml(x.hint) + '</i>' : ''}`).join(' · ') + '</div>'
          : '';
        return `<section class="${t.role}"><h3>${who} <span>${fmtTs(t.ts)}</span></h3>${body}${tools}</section>`;
      }).join('\n');
      return `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
<title>kabby 對話記錄</title><style>
body{font:14px/1.6 -apple-system,"Segoe UI",sans-serif;max-width:900px;margin:24px auto;padding:0 16px;background:#fff;color:#1a1a1a}
section{margin:0 0 20px;padding:12px 16px;border:1px solid #e2e2e2;border-radius:8px}
section.user{background:#f2faf6;border-color:#cfe8dc}
h3{margin:0 0 8px;font-size:12px;color:#666;font-weight:600}h3 span{font-weight:400;color:#999}
pre.usr{white-space:pre-wrap;word-break:break-word;margin:0}
.md code{background:#f0f0f0;border-radius:3px;padding:0 4px;font-family:Consolas,monospace}
.md pre.md-code{background:#f6f6f6;border:1px solid #e2e2e2;border-radius:5px;padding:10px;overflow-x:auto}
.md .md-table{border-collapse:collapse;margin:8px 0}.md .md-table th,.md .md-table td{border:1px solid #ddd;padding:5px 10px}
.md .md-table th{background:#f2f2f2}
.tools{margin-top:8px;font-size:12px;color:#8a6d3b}.tools i{color:#999;font-style:normal}
</style></head><body>
<h1>📜 kabby 對話記錄</h1><p style="color:#999">匯出時間：${escapeHtml(fmtTs(Date.now()))}</p>
${rows}
</body></html>`;
    }

    // ── 開關 ──
    function isOpen() { return el.panel.classList.contains('visible'); }
    function open() {
      el.panel.classList.add('visible');
      if (el.triggerBtn) el.triggerBtn.classList.add('on');
      el.body.innerHTML = '';
      refresh().then(() => { if (!query.trim()) el.body.scrollTop = el.body.scrollHeight; });
      if (!timer) timer = setInterval(refresh, REFRESH_MS);
    }
    function close() {
      el.panel.classList.remove('visible');
      if (el.triggerBtn) el.triggerBtn.classList.remove('on');
      if (timer) { clearInterval(timer); timer = null; }
    }
    function toggle() { isOpen() ? close() : open(); }

    // ── 事件綁定 ──
    if (el.closeBtn) el.closeBtn.addEventListener('click', close);
    if (el.refreshBtn) el.refreshBtn.addEventListener('click', refresh);
    if (el.search) el.search.addEventListener('input', () => { query = el.search.value; render(); });
    if (el.toolsToggle) el.toolsToggle.addEventListener('click', () => {
      showTools = !showTools;
      el.toolsToggle.classList.toggle('on', showTools);
      render();
    });
    if (el.readerToggle) el.readerToggle.addEventListener('click', () => {
      reader = !reader;
      el.readerToggle.classList.toggle('on', reader);
      if (el.toolsToggle) el.toolsToggle.classList.toggle('disabled', reader);   // 簡潔模式下工具無意義
      render();
    });
    if (el.exportMdBtn) el.exportMdBtn.addEventListener('click', () => {
      if (!turnsAll.length) return toast('目前沒有可匯出的對話', 'warn');
      download(exportName('md'), 'text/markdown;charset=utf-8', toMarkdown());
    });
    if (el.exportHtmlBtn) el.exportHtmlBtn.addEventListener('click', () => {
      if (!turnsAll.length) return toast('目前沒有可匯出的對話', 'warn');
      download(exportName('html'), 'text/html;charset=utf-8', toHtml());
    });
    el.panel.addEventListener('click', (e) => { if (e.target === el.panel) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) {
        if (query.trim()) { query = ''; if (el.search) el.search.value = ''; render(); return; }
        close();
      }
    });

    return { open, close, toggle, refresh, isOpen };
  };
})();
