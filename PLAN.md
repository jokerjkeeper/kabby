# kabby — PTY 多工器 daemon (v1)

> **此檔目的**：給下一個 cc session 接手用。在 `` 目錄開新 cc 後，直接讀本檔即可進入後續 Phase 實作。
> **原始 plan 位置**：`~/.claude/plans/<plan-name>.md`（已同步）

---

## Context

**為什麼做這個**

- 現有 ai-terminal（`<ai-terminal 專案>\`）以 iframe 嵌入 wepages 任務模組，每次點 Terminal 都是「開一個新的 cc」。
- 使用者實際工作流是：先在桌面用一個 terminal 開 cc 進入專案（例如 `D:\Projects\my-app\`），跑了一陣子之後想在 wepages 的「任務」分頁上**接續**這個 cc，而不是重開一個。
- 同時要保留未來在「子清單」點擊項目，自動把 `task #123 + 子項內容` 餵進那個 cc 的能力。
- 等於需要一個「PTY 多工器 daemon」：一個 cc 進程、多個 client（桌面 UI + 任務頁面 iframe）雙向 attach，行為類似 `tmux attach`。

**目標**

做一個叫 kabby 的新專案（位於 ``），跟 ai-terminal 完全獨立（ai-terminal 維持原樣，wepages 現有 Terminal 按鈕的行為不動）。kabby 自己跑在 port 3700，wepages 之後在任務 Terminal 按鈕上加一個 modal，讓使用者選「新開 cc（走 ai-terminal）」或「掛載 kabby session」。

**設計決策已確認**

- kabby 是新專案，不修改 ai-terminal
- v1 用 Web UI（kabby daemon 自己 serve），未來再考慮 Electron
- session 命名由使用者建立時輸入（內部仍有 UUID）
- 項目（profile）配置保存在 user-level (`~/.kabby/profiles.json`)，不入 repo，跟著機器走

---

## 架構總覽

```
                ┌──────────────────────────────────────┐
                │  kabby daemon (Node.js, port 3700)   │
                │                                       │
                │   Session Registry (Map<id, Session>) │
                │   Profile Store (~/.kabby/...)        │
                │                                       │
                │   ┌─────────────┐  ┌─────────────┐    │
                │   │ Session A   │  │ Session B   │    │
                │   │ name: unity │  │ name: rs    │    │
                │   │ pty → cc    │  │ pty → cc    │    │
                │   │ buffer:ring │  │ buffer:ring │    │
                │   │ clients:{}  │  │ clients:{}  │    │
                │   └─────────────┘  └─────────────┘    │
                └──────────┬───────────────┬────────────┘
                           │ WS fan-out    │
            ┌──────────────┴──┐   ┌────────┴────────────┐
            │ kabby Web UI    │   │ wepages 任務 iframe │
            │ (新分頁)        │   │ (attach 模式)       │
            └─────────────────┘   └─────────────────────┘
```

**核心抽象：Session**

每個 kabby Session 物件持有：
- `id`（UUID）+ `name`（使用者取的）+ `cwd` + `createdAt`
- 一個 node-pty 進程（跑 cc）
- `scrollback: RingBuffer`（約 100 KB，新 client attach 時 replay）
- `clients: Set<WebSocket>`（fan-out 對象）
- `ccSessionId`（args 含 `--resume <id>` 時記下，用於佔用偵測）
- `profileId`（由 profile 啟動時記下）

**Fan-out 邏輯**
- PTY 輸出 → 寫進 scrollback + 廣播給所有 `clients`
- 任一 client 輸入 → 直接寫進 PTY（v1 不處理輸入衝突，多人同時打字就 interleave，後續可加 readonly 觀察者模式）
- Client 斷線 → 從 `clients` 移除，**PTY 不動**
- 新 client 連線 → 加入 `clients`，先發 scrollback 內容讓 xterm 還原畫面

**持久化邊界**
- PTY 與 daemon 同壽：daemon 進程活著就活著，browser 刷新/關閉**不影響** PTY。
- daemon 進程被殺 → 所有 PTY 死。
- 跨系統重啟存活 = v2 議題（要 Windows 工作排程 / 服務 / Electron 常駐），v1 不做。
- Profile 配置跨重啟存活（檔案持久化），但**運行中的 PTY 不**。

---

## 階段拆解

### Phase 1：核心 daemon（最小可跑） ✓

**目標**：一個能開 cc、多 client 同時 attach 的 daemon。沒 UI，用 curl + 兩個 wscat 驗證。

| 檔案 | 用途 |
|---|---|
| `package.json` | 依賴：`node-pty`、`ws`、`express`、`cors` |
| `src/daemon.js` | Entry point：起 HTTP server + WS server，掛 API |
| `src/session.js` | `Session` class：封裝 PTY、scrollback、clients、fan-out |
| `src/registry.js` | `Map<id, Session>` 單例 + name/id 雙向查找 |
| `src/ring-buffer.js` | 簡易 ring buffer（fixed size，append + dump） |

**HTTP API**

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/api/sessions` | — | `[{id, name, cwd, createdAt, clientCount, ...}]` |
| `POST` | `/api/sessions` | `{name, cwd, cmd?, args?}` | `{id, name, cwd, ...}` |
| `GET` | `/api/sessions/:id` | — | session 詳細 |
| `DELETE` | `/api/sessions/:id` | — | `{ok: true}` 殺 PTY |
| `POST` | `/api/sessions/:id/input` | `{data: "..."}` | `{ok: true}` 用於子清單注入 |

**WebSocket**

- `ws://localhost:3700/ws/:sessionId`
- 連上 → 先 push scrollback → 加入 `clients` set
- 收 `{type:'input', data}` → 寫 PTY
- 收 `{type:'resize', cols, rows}` → resize PTY（latest-resize-wins）
- PTY 輸出 → broadcast `{type:'output', data}` 給所有 clients

**驗收**：`test/smoke.js`（用 `cmd.exe` 代替 cc 跑），兩個 client 同連同 session，A 打字 B 收到，第三個後加入經 scrollback 還原歷史。

---

### Phase 2：Web UI（kabby daemon 自己 serve） ✓

**目標**：開瀏覽器到 `http://localhost:3700`，能看到 session 列表、建立新 session、切換 tab、跟 cc 互動。

新建：
- `public/index.html` — SPA 主頁（左 sidebar 列 session，右 main area 是 xterm）
- `public/embed.html` — 給 wepages iframe 用的**精簡版**，只接收 `?session=<id>` 然後直接 attach，沒 sidebar/新建功能
- `public/app.js`、`public/embed.js` — xterm.js 連線邏輯

**UI 元素**
- Sidebar：session 列表 + 「+ 新建 session」按鈕
- 新建 modal：name、cwd、cmd、args 欄位 + 常用 args chip 切換
- Main：xterm.js + FitAddon，連到當前選中的 session
- Tab 切換不重新連線（不同 session 對應不同 WS 連線，背景保留）

**驗收**：兩個 chrome 視窗開同一個 `http://localhost:3700`，建一個 session、進入、A 視窗輸入 `ls`，B 視窗看得到輸出；A 視窗刷新後重連能看到刷新前的 scrollback。

---

### Phase 2.5：項目（profile）+ cc 歷史接續 ✓

**目標**：把 session 啟動配置保存成「項目」（profile），下次一鍵建立；並能列出該 cwd 的 cc 對話歷史，選一個「接續」進入。

**新建檔案**：

| 檔案 | 用途 |
|---|---|
| `src/profile-store.js` | `~/.kabby/profiles.json` 持久化 CRUD（user-level，不入 repo） |
| `src/cc-history.js` | 解析 `~/.claude/projects/<encoded-cwd>/*.jsonl`，取摘要 + 時間 |

**Profile 結構**

```json
{
  "id": "<uuid>",
  "name": "unity",
  "cwd": "D:/Projects/my-app",
  "cmd": "claude.cmd" | null,
  "args": ["--dangerously-skip-permissions"] | null,
  "createdAt": "<iso>",
  "lastUsedAt": "<iso>" | null,
  "lastSessionId": "<cc-session-uuid>" | null
}
```

**新增 HTTP API**

| Method | Path | 用途 |
|---|---|---|
| `GET` | `/api/profiles` | 列項目（含 `lastSessionBusy` 標記） |
| `POST` | `/api/profiles` | 建項目 |
| `PUT` | `/api/profiles/:id` | 編輯 |
| `DELETE` | `/api/profiles/:id` | 刪除 |
| `GET` | `/api/profiles/:id/history` | 列該 cwd 的 cc session 歷史（含 `busy` 標記） |
| `GET` | `/api/profiles/:id/history-dir` | 回該 project 的 jsonl 目錄路徑 |
| `POST` | `/api/profiles/:id/launch` | 用 profile 啟動 PTY，body `{resume?}` 帶 `--resume <uuid>` |
| `POST` | `/api/viewer/open` | 啟動外部 viewer（需 env `KABBY_VIEWER_PATH`） |
| `POST` | `/api/viewer/open-folder` | 用系統檔案總管打開指定目錄 |

**佔用偵測（避免雙開驅動同一個 cc session）**

- `Session.ccSessionId`：args 含 `--resume <id>` 時記下
- `Registry.busyCcSessionIds()` 集合：所有 alive session 的 ccSessionId
- launch 時若 `resume` 已在 busy set → 409
- profile / history 列表回傳時帶 `busy` / `lastSessionBusy` 標記，UI 把按鈕 disabled

**cc project 目錄編碼規則**

```
D:\Git\kabby                → D--Git-kabby
D:\Projects\my-app        → D--Projects-my-app       ← 底線也換
D:\Git\claude-code-2.1.88   → D--Git-claude-code-2-1-88  ← 點號也換
```

規則：`[^A-Za-z0-9]` 一律換成 `-`，連續不合併。Windows drive letter 統一大寫，去尾巴 slash。

**UI 改動**

- Sidebar 拆兩 section：上方 **Projects**（profile 卡片，可展開列歷史），下方 **Running**（運行中 PTY）
- Header 兩個按鈕：**+ 項目**（建 profile）、**+ 臨時**（建 PTY 不存 profile）
- Project 卡片內按鈕：新對話 / 接續上次 / 編輯 / 歷史目錄
- 展開後顯示 cc session 歷史列表，點擊接續；busy 的 disabled
- 「viewer」按鈕（在 Projects section 標題列右側）：啟動外部 portable exe，需設定 `KABBY_VIEWER_PATH`

**外部 viewer**

- 不整合 viewer 本體（它是獨立 Electron app）
- env 變數 `KABBY_VIEWER_PATH=<absolute path to claude-code-history-viewer.exe>`
- daemon `spawn(detached, unref)` 起來，kabby 不負責對話檢視 UI

**驗收**

1. 建 profile → 出現在 Projects → 展開看 cc 歷史 → 點任一接續 → PTY 起來且帶 `--resume`
2. 同一個 cc session id 不能被兩個 kabby session 同時 attach（第二次點會被擋）
3. 編輯 / 刪除 profile 正常
4. 設定 `KABBY_VIEWER_PATH` 後，viewer 按鈕啟用，點擊開啟外部 app

---

### Phase 3：wepages 整合（attach modal）

**目標**：wepages 任務頁的 Terminal 按鈕點下去先彈 modal，讓使用者選「新 cc」或「attach kabby」。

修改檔案：

| 檔案 | 改動 |
|---|---|
| `<wepages 專案>\web\templates\task\detail.html` | 原本 `openTaskTerminal()`（line 391-423）改成先開選擇 modal；新增 modal HTML（仿照 dispatch modal line 305-345 的中央彈窗風格） |
| 同檔 inline `<script>` | modal 選擇邏輯：選「新 cc」→ 維持原行為設 iframe.src 指向 3600；選「attach kabby」→ 先 `fetch('http://localhost:3700/api/sessions')`，列出，使用者點選 → iframe.src 設為 `http://localhost:3700/embed.html?session=<id>` |
| `<wepages 專案>\web\static\css\task.css` | 新 modal 樣式（可抄 dispatch modal 風格） |

**綁定記憶**：使用者點過一次 attach 後，記在 `localStorage[`task-${id}-kabby`] = sessionId`。下次點 Terminal 直接跳過 modal 自動 attach（modal 上提供「換 session」按鈕可重選）。v1 不動 wepages DB schema。

**Modal 結構**（仿 dispatch modal）：

```
┌─ 選擇 Terminal 來源 ─────────────────┐
│                                       │
│  ┌────────────┐  ┌────────────────┐  │
│  │  新開 cc   │  │ 掛載 kabby     │  │
│  │  (3600)    │  │ (列出 sessions)│  │
│  └────────────┘  └────────────────┘  │
│                                       │
│  選中後 →                            │
│  ┌─────────────────────────────────┐ │
│  │ ○ unity (D:\Projects\...) 2 clt  │ │
│  │ ○ rs    (D:\Projects\...)     │ │
│  └─────────────────────────────────┘ │
│                          [取消][確認] │
└───────────────────────────────────────┘
```

**驗收**：在 wepages 任務頁 → Terminal → 選 attach kabby → 列出剛才用 kabby Web UI 建的 session → 點選 → iframe 顯示 attach 上去的 cc 畫面，跟 kabby Web UI tab 雙向同步。

---

### Phase 4：子清單 → kabby 注入 *(棄置 — 2026-05-19)*

> **狀態變更**：原本規劃的「點子清單注入文字到 PTY」決定**不實作**。
>
> **原因**：cc 是 LLM agent，比 wepages 端注入靜態字串更靈活。實際工作流改成：使用者在 wepages 任務頁掛載 kabby session（Phase 3），然後直接在 cc 對話框打「讀工單 #123 並處理子清單」，由 cc 自己讀 wepages 工單內容、判斷子項、執行。比起前端組合 `# task #123 子項: ...\r` 字串注入，這條路徑：
> - 不用 wepages 維護注入格式
> - cc 能跨子項看完整工單上下文做判斷
> - 不需要為「沒綁過 kabby」做 fallback 提示
>
> **保留 API**：`POST /api/sessions/:id/input` 仍可用（這是 Phase 1 既有 API，沒移除），未來若要做機器人自動觸發等用途仍可呼叫。
>
> 以下原規劃保留作為文檔，**不執行**。

**目標**：點擊任務子清單項目，把 `# task <id>: <子項內容>` 送進那個 task 綁定的 kabby session。

修改檔案：

| 檔案 | 改動 |
|---|---|
| `<wepages 專案>\web\templates\task\detail.html` | 子清單項目（line 146-203 區域的 `.checklist-item`）加「→ 發送到 kabby」按鈕或長按事件 |
| 同檔 inline `<script>` | 點擊時 `fetch('http://localhost:3700/api/sessions/<bound-id>/input', {method:'POST', body:JSON.stringify({data: "...\\r"})})` |

**綁定來源**：直接讀 Phase 3 寫在 localStorage 的 `task-${id}-kabby`。沒綁過 → 跳出提示「請先在 Terminal 掛載 kabby session」。

**注入格式**（暫定，可調）：
```
# task #123 子項: 重構 PlayerController 的 input handling\r
```
寫進 PTY 後 cc 會把它當成使用者輸入。

**驗收**：開任務 → 掛載過 kabby → 點任一子項 → kabby session 那邊看到該行注入並由 cc 處理。

---

## 關鍵設計取捨

- **多 client 輸入衝突**：v1 不處理，兩個 client 同時打字會 interleave。實務上桌面 UI + 任務 iframe 同時打字機率低，先用文檔說明即可。未來可加 `?role=viewer` 參數做唯讀模式。
- **TTY size 衝突**：latest-resize-wins。多 client 視窗大小不同，最後 resize 的那個說了算。如果造成 cc UI 錯亂，使用者可以手動 resize 自己的視窗重設。
- **Scrollback 大小**：100 KB（約 1500 行）足以還原大部分對話畫面。超過就丟舊的。
- **認證**：v1 同 ai-terminal，可選 `AUTH_TOKEN` env 變數，query param 帶 token。本機開發可不設。
- **跨重啟持久化**：PTY 不做（daemon 殺了都死）；Profile 配置有做（檔案）。要 daemon 常駐請手動把 `node src/daemon.js` 用 PM2 / Windows 工作排程包起來。
- **佔用偵測限制**：只追蹤明確帶 `--resume <id>` 啟動的 cc session；新開（cc 自己生 uuid）的 session id kabby 不知道，不會去搶。
- **不在範圍**：修改 ai-terminal、Electron 桌面包、LLM 自動回應（ai-terminal 的 InterceptLayer/decision-engine）、cc 程式以外的 shell 類型、整合 history viewer 的對話檢視 UI（純外部開啟）。

---

## 關鍵檔案

**新建（kabby 專案，路徑為 ``）**
- `package.json`
- `src\daemon.js`
- `src\session.js`
- `src\registry.js`
- `src\ring-buffer.js`
- `src\profile-store.js`  *(Phase 2.5)*
- `src\cc-history.js`  *(Phase 2.5)*
- `public\index.html`
- `public\embed.html`
- `public\app.js`
- `public\embed.js`

**User-level（不入 repo）**
- `~/.kabby/profiles.json` — Phase 2.5 項目清單

**可參考重用（不修改，位於 ai-terminal 原處）**
- `<ai-terminal 專案>\src\session-manager.js:61-85` — node-pty spawn cc 的寫法
- `<ai-terminal 專案>\src\index.js:43-109` — WS 接 PTY 的訊息格式（input/output/resize/exit JSON）
- `<ai-terminal 專案>\public\index.html` — xterm.js + FitAddon + 自動重連模板
- 上述三檔已 copy 至 `reference\from-ai-terminal\` 跨機器可移植

**修改（wepages，Phase 3-4）**
- `<wepages 專案>\web\templates\task\detail.html`（modal HTML、Terminal 按鈕邏輯、子清單點擊）
- `<wepages 專案>\web\static\css\task.css`（modal 樣式）

**外部相依（Phase 2.5）**
- `<history-viewer.exe 的絕對路徑>` — 透過 env `KABBY_VIEWER_PATH` 配置

---

## 驗證流程（end-to-end）

每個 Phase 結束都跑下面的對應子集；全部完成跑全套：

1. **Phase 1**：`npm start` → curl POST 建 session → 兩個 wscat 同時連同 id → A 打字 B 收到。或直接跑 `node test/smoke.js`。
2. **Phase 2**：`http://localhost:3700` → 點「+ 臨時」輸入名稱 + cwd → cc 啟動畫面出現 → 開第二個 chrome 視窗連同一 URL → session 列表看得到 → 點選 → 雙向同步。
3. **Phase 2.5**：「+ 項目」建 profile → 展開列出 cc 歷史 session → 點任一接續 → PTY 帶 `--resume` 啟動；同 cc session id 不能被雙開（第二次嘗試 409）。
4. **Phase 3**：wepages 任務頁 → Terminal → modal 出現 → 選 attach → 列表看到 unity → 點選 → iframe 跟 kabby Web UI 的 unity tab 雙向同步。
5. **Phase 4**：任務頁子清單點任一項 → kabby unity tab 出現 `# task #<id> 子項: ...` → cc 開始處理。

**回歸測試**：上述操作期間，wepages「新開 cc」選項仍可正常開到 ai-terminal（port 3600），證明沒打壞舊功能。
