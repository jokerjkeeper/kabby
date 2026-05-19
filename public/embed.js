/* kabby embed — minimal attach for iframe use */
(() => {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('session');
  const token = params.get('token');

  const dot = document.getElementById('dot');
  const info = document.getElementById('info');
  const errEl = document.getElementById('error');
  const termHost = document.getElementById('term');

  if (!sessionId) {
    showError('缺少 ?session=<id|name> 參數');
    return;
  }

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'Cascadia Code', Consolas, monospace",
    theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#aeafad' },
    scrollback: 5000,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(termHost);
  try { fit.fit(); } catch {}

  let ws = null;
  let reconnectTimer = null;

  function setStatus(connected, label) {
    dot.className = 'dot ' + (connected ? 'connected' : 'disconnected');
    info.innerHTML = `<b>${escapeHtml(sessionId)}</b> · ${escapeHtml(label)}`;
  }

  function connect() {
    setStatus(false, 'connecting…');
    let url = `ws://${location.host}/ws/${encodeURIComponent(sessionId)}`;
    if (token) url += '?token=' + encodeURIComponent(token);
    ws = new WebSocket(url);

    ws.onopen = () => {
      setStatus(true, 'connected');
      sendResize();
    };
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'output') term.write(msg.data);
      else if (msg.type === 'exit') {
        term.write(`\r\n\x1b[33m[session exited code=${msg.code}]\x1b[0m\r\n`);
        setStatus(false, `exited (code=${msg.code})`);
      }
    };
    ws.onclose = (ev) => {
      if (ev.code === 1006 || ev.code === 0) {
        setStatus(false, 'disconnected — retrying in 3s');
        reconnectTimer = setTimeout(connect, 3000);
      } else if (ev.code === 4040 || ev.code === 1011) {
        setStatus(false, 'session not found');
      } else {
        setStatus(false, `closed (code=${ev.code})`);
        reconnectTimer = setTimeout(connect, 3000);
      }
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  function sendResize() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }

  term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  window.addEventListener('resize', () => {
    try { fit.fit(); } catch {}
    sendResize();
  });

  function showError(msg) {
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
    termHost.style.display = 'none';
    setStatus(false, 'error');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }

  connect();
})();
