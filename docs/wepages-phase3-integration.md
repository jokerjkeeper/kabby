# Wepages × kabby 整合 — Phase 3 工作指引

> 把這份文件整份貼給 wepages 端的 cc。它是自包含的，不需要再額外解釋。

---

## 背景（必讀）

我們有一個新 daemon 叫 **kabby**（本專案），跑在 `http://localhost:3700`。它做的事情是「PTY 多工器」：一個 cc 進程、多個 client 同時 attach，類似 `tmux attach`。

現況：wepages 任務頁的 Terminal 按鈕目前點下去會直接開 `http://localhost:3600/...`（ai-terminal），每次都是「**新開一個 cc**」。

**這次要做的事**：點 Terminal 按鈕後，**先彈出一個 modal**，讓使用者選擇：

- **新開 cc** —— 維持原本行為，iframe.src 指 `http://localhost:3600/...?cwd=...`
- **掛載 kabby session** —— 列出 kabby daemon 目前活著的 session，使用者點選一個，iframe.src 設為 `http://localhost:3700/embed.html?session=<id>`

掛載過一次後，該 task 跟 kabby session 的綁定關係寫到 `localStorage`，下次點 Terminal 直接走 attach 路徑（modal 上提供「換 session」按鈕讓人重選）。

---

## 不要動的東西

- ❌ 不要修改原本的 ai-terminal 內嵌工具（另一個獨立專案）任何代碼
- ❌ 不要刪掉「新開 cc」這條老路，它必須繼續可用（這是回歸測試基準）
- ❌ 不要碰 wepages 的 DB schema，綁定關係用 `localStorage` 即可
- ❌ 不要嘗試代理或包裝 kabby API，前端直接 fetch `http://localhost:3700` 就好（kabby daemon 已設 `Access-Control-Allow-Origin: *`）

---

## kabby 提供的 API（你會用到的部分）

> 完整 API 在 [`docs/api.md`](./api.md)。

### 列出活著的 kabby session

```http
GET http://localhost:3700/api/sessions
```

回應：

```json
[
  {
    "id": "8f4b1d2c-...",
    "name": "unity",
    "cwd": "D:/Projects/my-app",
    "clientCount": 2,
    "alive": true,
    "ccSessionId": "abc-..."   // 若是 --resume 啟動會有
  }
]
```

### Embed 頁面 URL（要塞進 iframe.src）

```
http://localhost:3700/embed.html?session=<id-or-name>
```

可以用 `id`（UUID）或 `name`（使用者取的）。建議用 `id` 比較穩定（name 可改）。

### 注入文字進 PTY（給 Phase 4 子清單用，這次先不做但可以一起寫好）

```http
POST http://localhost:3700/api/sessions/<id>/input
Content-Type: application/json

{ "data": "# task #123 子項: ...\r" }
```

注意 `\r` 必填，cc 才會把它當成 Enter 送出。

---

## 修改清單

### 1. 修改 `web/templates/task/detail.html`

#### 1.1 找到 `openTaskTerminal()` 函數

用 grep 找：

```
grep -n "openTaskTerminal" web/templates/task/detail.html
```

當前邏輯大概是「設 iframe.src 指 ai-terminal:3600，加上 cwd 參數」。**保留這個邏輯，但包到一個內部函數**裡，例如 `openAiTerminalNew(cwd)`。

#### 1.2 改寫 `openTaskTerminal()` 為「先彈 modal」

新邏輯：

```js
function openTaskTerminal() {
  const taskId = /* 從現有上下文取 */;
  const cwd = /* 從現有上下文取 */;

  // 若之前綁定過 kabby session，跳過 modal 直接 attach
  const boundKey = `task-${taskId}-kabby`;
  const boundSessionId = localStorage.getItem(boundKey);
  if (boundSessionId) {
    openKabbyAttach(boundSessionId);
    return;
  }

  // 否則開 modal 讓使用者選
  showTerminalSourceModal({ taskId, cwd });
}

function openAiTerminalNew(cwd) {
  // 把原本的 iframe.src 設定邏輯搬進來，**不要刪掉這個 fallback**
  const iframe = document.getElementById('task-terminal-iframe'); // 用實際 id
  iframe.src = `http://localhost:3600/?cwd=${encodeURIComponent(cwd || '')}`;
}

function openKabbyAttach(sessionId) {
  const iframe = document.getElementById('task-terminal-iframe');
  iframe.src = `http://localhost:3700/embed.html?session=${encodeURIComponent(sessionId)}`;
}
```

#### 1.3 新增 Terminal Source Modal

在原本 dispatch modal 附近（用 grep 找 `dispatch` 系列 modal 的位置）加入：

```html
<!-- Terminal 來源選擇 modal -->
<div id="terminal-source-modal" class="modal" style="display: none;">
  <div class="modal-backdrop" onclick="closeTerminalSourceModal()"></div>
  <div class="modal-content terminal-source-modal-content">
    <div class="modal-header">
      <h3>選擇 Terminal 來源</h3>
      <button class="modal-close" onclick="closeTerminalSourceModal()">×</button>
    </div>
    <div class="modal-body">
      <div class="terminal-source-options">
        <button type="button" class="terminal-source-card" data-source="new-cc">
          <div class="card-title">🆕 新開 cc</div>
          <div class="card-desc">啟動一個全新的 Claude Code（走 ai-terminal :3600）</div>
        </button>
        <button type="button" class="terminal-source-card" data-source="kabby">
          <div class="card-title">🔌 掛載 kabby session</div>
          <div class="card-desc">接續桌面已開的 cc（kabby :3700）</div>
        </button>
      </div>

      <!-- kabby session 列表（選 kabby 後顯示） -->
      <div id="kabby-session-picker" style="display:none; margin-top: 16px;">
        <div class="picker-title">選擇一個 kabby session：</div>
        <div id="kabby-session-list" class="kabby-session-list">
          <div class="kabby-loading">載入中…</div>
        </div>
        <div class="kabby-hint">
          沒看到要的 session？先在 kabby Web UI（<a href="http://localhost:3700" target="_blank">localhost:3700</a>）建立。
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeTerminalSourceModal()">取消</button>
      <button class="btn btn-primary" id="terminal-source-confirm" onclick="confirmTerminalSource()" disabled>確認</button>
    </div>
  </div>
</div>
```

#### 1.4 對應的 JS 邏輯

```js
let _terminalModalState = {
  taskId: null,
  cwd: null,
  selectedSource: null,
  selectedKabbySessionId: null,
};

function showTerminalSourceModal({ taskId, cwd }) {
  _terminalModalState = { taskId, cwd, selectedSource: null, selectedKabbySessionId: null };
  document.getElementById('terminal-source-modal').style.display = 'flex';
  document.getElementById('kabby-session-picker').style.display = 'none';
  document.getElementById('terminal-source-confirm').disabled = true;
  // reset card highlight
  document.querySelectorAll('.terminal-source-card').forEach((c) => c.classList.remove('selected'));
}

function closeTerminalSourceModal() {
  document.getElementById('terminal-source-modal').style.display = 'none';
}

// 點兩張卡片
document.querySelectorAll('.terminal-source-card').forEach((card) => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.terminal-source-card').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
    const source = card.dataset.source;
    _terminalModalState.selectedSource = source;
    if (source === 'new-cc') {
      document.getElementById('kabby-session-picker').style.display = 'none';
      document.getElementById('terminal-source-confirm').disabled = false;
    } else if (source === 'kabby') {
      document.getElementById('kabby-session-picker').style.display = '';
      loadKabbySessions();
      // 還沒選 session 不能確認
      document.getElementById('terminal-source-confirm').disabled = true;
    }
  });
});

async function loadKabbySessions() {
  const listEl = document.getElementById('kabby-session-list');
  listEl.innerHTML = '<div class="kabby-loading">載入中…</div>';
  try {
    const res = await fetch('http://localhost:3700/api/sessions');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const sessions = await res.json();
    if (!sessions.length) {
      listEl.innerHTML = '<div class="kabby-empty">kabby 沒有活著的 session。請先到 kabby Web UI 建立。</div>';
      return;
    }
    listEl.innerHTML = '';
    sessions.forEach((s) => {
      const item = document.createElement('label');
      item.className = 'kabby-session-item';
      item.innerHTML = `
        <input type="radio" name="kabby-session-pick" value="${escapeHtml(s.id)}" />
        <div class="ks-info">
          <div class="ks-name">${escapeHtml(s.name)}</div>
          <div class="ks-meta">${escapeHtml(s.cwd || '')} · ${s.clientCount} clt${s.ccSessionId ? ' · resumed' : ''}</div>
        </div>
      `;
      item.querySelector('input').addEventListener('change', (e) => {
        _terminalModalState.selectedKabbySessionId = e.target.value;
        document.getElementById('terminal-source-confirm').disabled = false;
      });
      listEl.appendChild(item);
    });
  } catch (err) {
    listEl.innerHTML = `<div class="kabby-error">無法連到 kabby daemon (${escapeHtml(err.message)})。<br>確認 daemon 是否在 localhost:3700 跑著。</div>`;
  }
}

function confirmTerminalSource() {
  const { taskId, cwd, selectedSource, selectedKabbySessionId } = _terminalModalState;
  if (selectedSource === 'new-cc') {
    openAiTerminalNew(cwd);
  } else if (selectedSource === 'kabby' && selectedKabbySessionId) {
    localStorage.setItem(`task-${taskId}-kabby`, selectedKabbySessionId);
    openKabbyAttach(selectedKabbySessionId);
  } else {
    return;
  }
  closeTerminalSourceModal();
}

// 若已經有綁定，在 modal 外另外提供「換 session」入口
// 例如在 terminal toolbar 加個按鈕：
function switchKabbySession() {
  const taskId = /* 從現有上下文取 */;
  localStorage.removeItem(`task-${taskId}-kabby`);   // 清掉舊綁
  showTerminalSourceModal({
    taskId,
    cwd: /* 從現有上下文取 */,
  });
}

// 工具函數（若沒有自己的就用這個）
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}
```

> 如果原本的 Terminal 按鈕區域有顯示「已掛載 kabby: <name>」的位置，可以加進去；不必要的話 v1 先不加，靠 iframe URL 自證。

---

### 2. 新增 CSS 到 `web/static/css/task.css`

加在檔案末尾即可：

```css
/* ─────────────────────────────────────────────
   Terminal Source Modal (kabby 整合)
   ───────────────────────────────────────────── */
.terminal-source-modal-content {
  min-width: 460px;
  max-width: 580px;
}

.terminal-source-options {
  display: flex;
  gap: 12px;
  margin-bottom: 8px;
}

.terminal-source-card {
  flex: 1;
  background: #f8f9fa;
  border: 2px solid #dee2e6;
  border-radius: 6px;
  padding: 16px 14px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  text-align: left;
}
.terminal-source-card:hover { background: #e9ecef; border-color: #adb5bd; }
.terminal-source-card.selected {
  border-color: #0d6efd;
  background: #e7f1ff;
}
.terminal-source-card .card-title {
  font-size: 14px;
  font-weight: 600;
  color: #212529;
  margin-bottom: 4px;
}
.terminal-source-card .card-desc {
  font-size: 12px;
  color: #6c757d;
  line-height: 1.4;
}

.picker-title {
  font-size: 13px;
  color: #495057;
  margin-bottom: 8px;
}

.kabby-session-list {
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid #dee2e6;
  border-radius: 4px;
  background: #fff;
}

.kabby-session-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid #f1f3f5;
  cursor: pointer;
}
.kabby-session-item:last-child { border-bottom: 0; }
.kabby-session-item:hover { background: #f8f9fa; }
.kabby-session-item input[type="radio"] { margin: 0; flex: 0 0 auto; }
.kabby-session-item .ks-info { flex: 1; min-width: 0; }
.kabby-session-item .ks-name {
  font-weight: 600;
  color: #212529;
  font-size: 13px;
}
.kabby-session-item .ks-meta {
  font-size: 11px;
  color: #6c757d;
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kabby-loading, .kabby-empty, .kabby-error {
  padding: 12px;
  font-size: 12px;
  color: #6c757d;
  text-align: center;
}
.kabby-error { color: #c92a2a; }
.kabby-hint {
  margin-top: 8px;
  font-size: 11px;
  color: #868e96;
}
.kabby-hint a { color: #0d6efd; }
```

> 如果 wepages 已有自己的 modal/btn 樣式變數，把上面的 hex 顏色換成對應變數。

---

## 整合測試（end-to-end）

照順序跑：

1. **kabby daemon 跑起來**：在 kabby 專案目錄執行 `npm start`，看到 `kabby daemon listening on http://localhost:3700`
2. **建一個 kabby session**：開 `http://localhost:3700`，點「+ 臨時」或「+ 項目」建立一個，名稱 `unity`
3. **wepages dev server 起來**（看 `<wepages 專案>\main.py` 的 port）
4. **開任務頁**，點 Terminal → 出現 modal（新流程）
5. **選「新開 cc」→ 確認** → iframe 顯示 ai-terminal:3600（老行為，回歸 OK）
6. 關 iframe / 重開任務頁，點 Terminal → modal 又出現（因為還沒綁定）
7. **選「掛載 kabby session」→ 看到 unity → 點選 → 確認** → iframe 顯示 kabby:3700/embed.html，attach 上去看到 cc 畫面
8. **再關再開任務頁，點 Terminal → 應該跳過 modal，直接 attach** 上次選的 kabby session
9. **打開 kabby Web UI 同 session tab → 兩邊雙向同步**（kabby 那邊 sidebar 看到 `clientCount: 2`）
10. **「換 session」按鈕**（若有加）→ 清 localStorage → modal 又出現

---

## 完成後請告知

請回報：

- 改了哪幾個檔（含 line range）
- 步驟 5-9 是否全通過
- 有沒有遇到 CORS / port / iframe 嵌入相關問題
- 是否在 terminal toolbar 加了「換 session」按鈕；如果沒加，當前怎麼解綁

---

## 常見坑（提前說）

- **CORS**：kabby 已用 `cors({ origin: true })` 全開，不會擋 wepages 的請求。若還是看到 CORS 錯誤，先確認你 fetch 的 URL 是 `http://localhost:3700`（不是 `127.0.0.1`，雖然兩者通常等價）
- **WS 也要從 iframe 通**：embed.html 內部會用 `ws://localhost:3700/ws/<id>` 連回 kabby，這跟你的 wepages port 無關
- **iframe 沙箱**：如果 wepages 給 iframe 加了嚴格的 sandbox，要確認 `allow-scripts` 跟 `allow-same-origin` 沒被拿掉，否則 embed.html 內的 WS 跟 xterm 會壞
- **localStorage 跨頁**：寫在 wepages 自己的 origin 下，不會跟 kabby 的 localStorage 衝突
- **kabby daemon 沒跑時**：fetch 會 ConnectionRefused，loadKabbySessions 會走 catch 顯示錯誤訊息，符合預期；確認 UI 不會 crash 整個 task 頁面即可
