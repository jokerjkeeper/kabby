/**
 * 檔案傳輸監控頁：每 2 秒輪詢 GET /api/files/activity，顯示進行中的下載、SHA256 計算、最近事件與統計。
 * token 沿用主頁存在 localStorage 的 kabby-auth-token；所有字串一律走 textContent，不拼 HTML。
 */
(function filesMonitor() {
  const POLL_MS = 2000;
  const token = localStorage.getItem('kabby-auth-token') || '';
  const $ = (id) => document.getElementById(id);

  /** bytes → 人看的單位 */
  function fmtBytes(n) {
    if (n === undefined || n === null) return '';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let v = Number(n);
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  /** 毫秒 → 人看的時長 */
  function fmtMs(ms) {
    if (ms === undefined || ms === null) return '';
    if (ms < 1000) return `${ms} ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)} s`;
    return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-TW', { hour12: false });
  }

  /** 建元素：el('div', {className}, [子節點或字串]) */
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c ?? '')));
    return node;
  }

  function progressItem(pathText, infoText, ratio, barClass) {
    const bar = el('div', { className: `bar ${barClass || ''}` }, [el('div')]);
    bar.firstChild.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
    return el('div', { className: 'item' }, [
      el('div', { className: 'row' }, [el('span', { className: 'path', textContent: pathText }), el('span', { className: 'info', textContent: infoText })]),
      bar,
    ]);
  }

  function setNotice(text) {
    $('notice').textContent = text || '';
    $('notice').classList.toggle('show', !!text);
  }

  function renderStats(a) {
    const s = a.stats || {};
    const byIp = Object.entries(s.bytesByIp || {}).map(([ip, b]) => `${ip}: ${fmtBytes(b)}`).join('\n') || '—';
    const byStatus = Object.entries(s.byStatus || {}).map(([k, v]) => `${k}×${v}`).join('  ') || '—';
    const denied = Object.entries(s.deniedByReason || {}).map(([k, v]) => `${k}×${v}`).join('  ');
    const cards = [
      ['總傳出', fmtBytes(s.bytesSent || 0)],
      ['請求數', String(s.requests || 0)],
      ['被拒', String(s.denied || 0) + (denied ? `（${denied}）` : ''), true],
      ['各 IP 傳出', byIp, true],
      ['狀態碼', byStatus, true],
      ['稽核日誌', a.log && a.log.enabled ? (a.log.writable ? `可寫，保留 ${a.log.days} 天` : '⚠ 無法寫入') : '未落檔', true],
    ];
    $('stats').replaceChildren(...cards.map(([k, v, small]) => el('div', { className: 'stat' }, [
      el('div', { className: 'k', textContent: k }),
      el('div', { className: `v${small ? ' small' : ''}`, textContent: v, style: 'white-space: pre-line' }),
    ])));
    $('since').textContent = s.since ? `自 ${new Date(s.since).toLocaleString('zh-TW', { hour12: false })} 起` : '';
    const cfg = a.config || {};
    $('cfg-meta').textContent = `分享：${(cfg.roots || []).join(', ') || '—'} ｜ 允許 IP：${(cfg.allowIps || []).join(', ') || '不限'}`;
  }

  function renderActive(list) {
    $('active-count').textContent = list.length ? `${list.length} 個` : '';
    if (!list.length) return $('active').replaceChildren(el('div', { className: 'empty', textContent: '目前沒有下載' }));
    $('active').replaceChildren(...list.map((d) => {
      const ratio = d.total ? d.sent / d.total : 0;
      const info = `${d.ip} ｜ ${fmtBytes(d.sent)} / ${fmtBytes(d.total)}（${(ratio * 100).toFixed(1)}%）｜ ${d.mibps} MiB/s${d.range ? ` ｜ ${d.range}` : ''}`;
      return progressItem(d.path, info, ratio);
    }));
  }

  function renderHashing(list) {
    $('hash-count').textContent = list.length ? `${list.length} 個` : '';
    if (!list.length) return $('hashing').replaceChildren(el('div', { className: 'empty', textContent: '目前沒有計算' }));
    $('hashing').replaceChildren(...list.map((h) => {
      const ratio = h.size ? h.done / h.size : 0;
      return progressItem(h.path, `${fmtBytes(h.done)} / ${fmtBytes(h.size)}（${(ratio * 100).toFixed(1)}%）`, ratio, 'hash');
    }));
  }

  function renderRecent(list) {
    if (!list.length) {
      return $('recent').replaceChildren(el('tr', {}, [el('td', { colSpan: 9, className: 'empty', textContent: '尚無事件' })]));
    }
    $('recent').replaceChildren(...list.map((e) => el('tr', { className: e.result || '' }, [
      el('td', { textContent: fmtTime(e.ts) }),
      el('td', { textContent: e.ip || '' }),
      el('td', { textContent: e.endpoint || '' }),
      el('td', { className: 'path', textContent: e.path || '' }),
      el('td', { textContent: e.range || '' }),
      el('td', { className: 'num', textContent: e.status ?? '' }),
      el('td', { className: 'num', textContent: e.bytes ? fmtBytes(e.bytes) : '' }),
      el('td', { className: 'num', textContent: fmtMs(e.ms) }),
      el('td', { textContent: e.reason ? `${e.result}（${e.reason}${e.suppressed ? ` ×${e.suppressed}` : ''}）` : (e.result || '') }),
    ])));
  }

  /** 拉一次 activity 並重繪 */
  async function poll() {
    try {
      const res = await fetch('/api/files/activity', { headers: token ? { 'X-Kabby-Token': token } : {} });
      if (res.status === 401) {
        $('conn-dot').className = 'off';
        setNotice('未登入或 token 失效：請先在 kabby 主頁登入，再重新整理本頁。');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const a = await res.json();
      $('conn-dot').className = 'on';
      $('updated').textContent = `更新於 ${new Date().toLocaleTimeString('zh-TW', { hour12: false })}`;
      if (!a.enabled) {
        setNotice('/api/files 未啟用：在 .env 設定 KABBY_FILES_ROOTS（或 KABBY_FILES_ROOT）後重啟 kabby。');
        return;
      }
      setNotice('');
      renderStats(a);
      renderActive(a.active || []);
      renderHashing(a.hashing || []);
      renderRecent(a.recent || []);
    } catch (err) {
      $('conn-dot').className = 'off';
      setNotice(`無法取得狀態：${err.message}`);
    }
  }

  poll();
  setInterval(poll, POLL_MS);
})();
