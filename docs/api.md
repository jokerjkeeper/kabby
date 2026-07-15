# kabby API 參考

Phase 1 提供 HTTP REST + 單一 WebSocket endpoint。所有路徑相對於 daemon 根（預設 `http://localhost:3700`）。

## 認證

由 env `AUTH_TOKEN` 控制（建議透過專案根目錄 `.env`，daemon 啟動時自動載入；見 `.env.example`）。

- **未設 `AUTH_TOKEN`**：所有請求免認證（本機開發）。
- **設了 `AUTH_TOKEN=xxx`**：
  - **HTTP `/api/*`**（`/api/health` 除外）：每個請求需帶 token，否則回 `401 { "error": "unauthorized" }`。token 放在 **`X-Kabby-Token` header** 或 **`?token=xxx` query** 皆可。
  - **WebSocket**：連線 URL 帶 `?token=xxx`，否則 401。
  - `/api/health`：永遠開放（liveness + 回報是否需要認證）。

> 部署：kabby 預設綁 `127.0.0.1`（env `HOST` 可改）。對外請以 Cloudflare Tunnel / reverse proxy 提供 TLS，token 在 TLS 上傳輸不會明文外洩。

## CORS

由 env `KABBY_ALLOWED_ORIGINS`（逗號分隔白名單）控制：

- **未設**：放行所有來源（`origin: *`，本機開發方便）。
- **有設**：只放行清單內 origin（例：`http://localhost:5002,http://127.0.0.1:5002`，給本機 wepages 跨來源呼叫 `/api/*`）。

允許的自訂 header：`Content-Type`、`X-Kabby-Token`。

## 給 wepages 串接的重點

wepages 以 iframe 嵌 kabby 終端，並打 `/api/sessions` 取 session 列表。當 kabby 設了 `AUTH_TOKEN`（遠端部署）時：

1. **session 列表**：`GET <server>/api/sessions` 要帶 `X-Kabby-Token` header 或 `?token=`。
2. **iframe 掛載**：`<server>/embed.html?session=<id|name>&token=<token>`（`embed.js` 用 `?token=` 連 WS）。
3. **遠端 URL** 用 `https://kabby.網域`（**無 port**，Cloudflare 對外 443）；本機用 `http://localhost:3700`。
4. 可先打 `GET /api/health` 看 `authRequired`，決定要不要附 token。

本機 kabby（沒設 `AUTH_TOKEN`）則以上 token 都可省略。

---

## HTTP API

### `GET /api/health`

健康檢查，順便回 session / profile 總數與 viewer 配置狀態。

```json
{ "ok": true, "authRequired": true, "sessions": 3, "profiles": 5, "viewerConfigured": true }
```

`authRequired`：daemon 是否設了 `AUTH_TOKEN`。前端 / wepages 可據此決定是否要帶 token。**此 endpoint 不需 token。**

### `GET /api/sessions`

列所有活著的 session。

```json
[
  {
    "id": "8f4b...",
    "name": "unity",
    "cwd": "D:/Projects/RS/my-app/unity",
    "createdAt": "2026-05-19T12:00:00.000Z",
    "cols": 220,
    "rows": 50,
    "clientCount": 2,
    "alive": true,
    "exitCode": null
  }
]
```

### `POST /api/sessions`

建立新 session。**name 必填且不可與現有活著的 session 重複**。

Request body：

| 欄位 | 型別 | 必填 | 預設 | 說明 |
|---|---|---|---|---|
| `name` | string | ✓ | — | 使用者取的識別名，可當 :id 用 |
| `cwd` | string | | `process.cwd()` | PTY 啟動的工作目錄 |
| `cmd` | string | | `claude.exe`（Win）/ `claude`（Unix） | 要 spawn 的執行檔 |
| `args` | string[] | | `["--dangerously-skip-permissions"]` | 傳給 `cmd` 的參數 |
| `cols` | number | | `220` | 初始 PTY 寬度 |
| `rows` | number | | `50` | 初始 PTY 高度 |

成功回 `201` + session 物件（同 GET 格式）。
重名回 `400 { "error": "session name already in use: ..." }`。

### `GET /api/sessions/:id`

`:id` 可填 UUID 或 name。

`404` 表示沒這 session。

### `DELETE /api/sessions/:id`

殺掉該 session 的 PTY 並從 registry 移除。所有 attach 的 WS 會收到 `{type:'exit', code, signal}` 然後被斷線。

成功：`{ "ok": true }`
找不到：`404`

## Profiles API（Phase 2.5）

項目（profile）= 保存的 session 啟動配置 (name, cwd, cmd, args)。存在 `%USERPROFILE%\.kabby\profiles.json`，daemon 重啟保留。

### `GET /api/profiles`

列所有 profile。每筆多帶一個 `lastSessionBusy` 旗標：若 `lastSessionId` 已被運行中的 kabby session 掛載中，則為 `true`（UI 用來 disable「接續上次」按鈕）。

```json
[
  {
    "id": "...",
    "name": "unity",
    "cwd": "D:/Projects/RS/my-app/unity",
    "cmd": "claude.cmd",
    "args": ["--dangerously-skip-permissions"],
    "createdAt": "...",
    "lastUsedAt": "...",
    "lastSessionId": "abc-...",
    "lastSessionBusy": false
  }
]
```

### `POST /api/profiles`

建 profile。Body：`{ name, cwd, cmd?, args? }`。`name` 不可重名；`cwd` 必填。

### `PUT /api/profiles/:id`

修改 profile（同欄位 + 後端內部欄位 lastUsedAt/lastSessionId）。

### `DELETE /api/profiles/:id`

刪 profile。**不影響** cc 的對話歷史 jsonl。

### `GET /api/profiles/:id/history`

讀該 profile 的 cwd 對應 cc 對話歷史。回 array，每筆：

```json
{
  "sessionId": "<cc-session-uuid>",
  "file": "<absolute jsonl path>",
  "summary": "(第一個 user message 前 120 字)",
  "firstUserAt": "<iso>",
  "mtime": 1779190000000,
  "size": 12345,
  "busy": false
}
```

`busy: true` 表示此 cc session 已被另一個運行中 kabby session 掛載，UI 應 disable 接續按鈕。

### `GET /api/profiles/:id/history-dir`

回該 project 的 cc 歷史目錄絕對路徑：

```json
{ "dir": "C:\\Users\\user\\.claude\\projects\\D--Git-kabby", "exists": true }
```

### `POST /api/profiles/:id/launch`

用 profile 啟動 PTY。Body：

```json
{ "resume": "<cc-session-uuid>", "sessionName": "可選自訂 name" }
```

`resume` 帶 → args 自動加 `--resume <uuid>`，並紀錄到 `Session.ccSessionId` 供佔用偵測。

**錯誤**：若 `resume` 已被另一個運行中 kabby session 掛載，回 `409 Conflict`。

---

## Viewer API（Phase 2.5）

### `POST /api/viewer/open`

啟動外部 viewer。前提：env `KABBY_VIEWER_PATH` 已設且檔案存在。

- 未設定：`503 { error: "viewer 未設定..." }`
- 檔案不存在：`503`
- 成功：`{ ok: true, path: "..." }`，viewer 以 detached 子進程啟動

### `POST /api/viewer/open-folder`

用系統檔案總管打開指定目錄。Body：`{ path: "..." }`。

跨平台：Windows `explorer.exe`、macOS `open`、Linux `xdg-open`。

---

### `POST /api/sessions/:id/input`

把字串寫進該 session 的 PTY，相當於使用者鍵盤輸入。**Phase 4 子清單注入**會用這個。

Request body：

```json
{ "data": "# task #123 子項: ...\r" }
```

回 `{ "ok": true }`。注意：

- `\r` (CR) 才會被 cc 當作換行送出，不要用 `\n`
- 內容會立刻 broadcast 給該 session 的所有 WS client
- 如果 session 已死（PTY exit），回 `{ "ok": false }`

---

## Rooms（聊天室）

共享終端房間：房主建房綁一個 running session，訪客憑 key 入房看終端（可選開放輸入）+ 文字聊天。房間存記憶體，daemon 重啟 / 綁定 session 結束即關房。訪客頁：`/room.html`。

### `POST /api/rooms/join`（**不需 token**，防爆破限流：同 IP 5 分鐘內錯 10 次 → 429）

Request：`{ "key": "test1234", "nickname": "小明" }`
Response：`{ "ticket": "...", "roomId": "...", "roomName": "...", "sessionId": "...", "sessionName": "...", "allowWrite": false, "nickname": "小明" }`

ticket 是之後 WS 連線的憑證（`/ws/:sessionId?ticket=`），房間關閉或 daemon 重啟即失效。

### `GET /api/rooms/guest/conversation?ticket=`（**ticket 認證**，不需 token）

訪客看綁定 session 的乾淨版對話記錄（讀 provider 對話 JSONL，跟監控頁同一套採集器）。回 `{ turns: [{ ts, role, text, model?, tokens? }] }`；找不到存檔回 `{ turns: [], notFound: true }`。不回傳 `file` 等本機路徑。
定位規則：resume 的 session 直接用該對話 id；新 session 取該 cwd 下「PTY 啟動後仍有更新」的最新一份（若同 cwd 另有 kabby 之外的活躍 cc，可能對應錯，屬已知限制）。

### `GET /api/rooms`（token）

列所有房間，含 `guests: [{ nickname, joinedAt, online }]`。

### `POST /api/rooms`（token)

`{ "sessionId": "<id|name>", "name?": "...", "key?": "至少4字元，留空自動產生", "allowWrite?": false }` → `201` 房間 JSON。session 必須存在且 alive。

### `PATCH /api/rooms/:id`（token）

`{ "allowWrite": true|false }` — 即時生效，訪客收到 `room-config` 推送。

### `DELETE /api/rooms/:id`（token）

關房：所有訪客收到 `room-closed` 後被斷開，tickets 回收。

---

## WebSocket

### `ws://localhost:3700/ws/:id`（HTTPS 下用 `wss://`）

> 頁面若以 `https://` 載入（例：經 Cloudflare Tunnel），WS 必須改用 `wss://`，否則被瀏覽器當 mixed-content 擋掉。kabby 前端與 `embed.js` 已依 `location.protocol` 自動切換。

`:id` 可填 UUID 或 name。連上之後：

1. Server 立刻 broadcast 整個 scrollback（一筆 `{type:'output', data:"..."}`），讓 xterm 重繪畫面
2. 加入 session 的 `clients` set，之後 PTY 任何輸出都會收到
3. 該 client 可發 `input` / `resize` 訊息影響 PTY

**認證**：`?token=`（房主，完整權限）或 `?ticket=`（聊天室訪客，僅限該房綁定的 session）。訪客連線受房間權限管制：`input` 只在房間 `allowWrite=true` 時生效（伺服器端強制），`resize` 一律忽略。

### Client → Server 訊息

| `type` | 欄位 | 行為 |
|---|---|---|
| `input` | `data: string` | 寫進 PTY（訪客受 `allowWrite` 管制） |
| `resize` | `cols: number, rows: number` | resize PTY（latest-resize-wins，多 client 互覆蓋；訪客忽略） |
| `chat` | `text?: string, image?: string` | （訪客連線）發聊天訊息，廣播全房。`image` 為 data URL（`data:image/png|jpeg|webp|gif;base64,...`，≤2M 字元，前端已壓縮；伺服器只保留每房最近 20 張，舊圖退化成 `imageExpired`） |

非 JSON 或未知 type 一律忽略。

### Server → Client 訊息

| `type` | 欄位 | 時機 |
|---|---|---|
| `output` | `data: string` | PTY 任何輸出 / 新 client 連上時的 scrollback replay |
| `termsize` | `cols, rows` | attach 時 + 每次 PTY resize（訪客端跟著 `term.resize`；host 端忽略） |
| `exit` | `code: number, signal: string\|null` | PTY 進程結束 |
| `blocked` | `words: string[]` | 輸入含敏感詞被攔截 |
| `room-init` | `room, nickname, chatLog, guests` | （訪客）連上時的房間狀態 + 聊天歷史 |
| `chat` | `from, nickname, text, image?, imageExpired?, ts` | 房內聊天訊息（`from: host\|guest\|system`） |
| `room-presence` | `guests: [...]` | 訪客加入 / 離開 |
| `room-config` | `allowWrite: boolean` | 房主切換輸入權限 |
| `room-closed` | `reason` | 房間關閉（`host-closed` / `session-exit`） |

### `ws://localhost:3700/ws/room/:roomId`（token）

房主聊天面板專用（chat-only，不串終端）。連上先收 `room-init`（含 `chatLog`），之後收發 `chat`、收 `room-presence` / `room-closed`。

### 錯誤狀態

| HTTP 升級回應 | 原因 |
|---|---|
| `404 Not Found` | URL pattern 不是 `/ws/:id` 或 session / 房間不存在 |
| `401 Unauthorized` | token 不符，且沒有有效的訪客 ticket |

---

## 設計取捨備忘

- **多 client 輸入衝突**：v1 不處理，兩個 client 同時打字會 interleave。實務上不易發生。未來可加 `?role=viewer` 唯讀模式。
- **Scrollback 大小**：100 KB（約 1500 行）。超過丟最舊的整塊 chunk（不切字節，保 ANSI escape 完整）。
- **Session 跨重啟存活**：v1 不做。daemon 殺了 PTY 都死。
- **重名**：只擋活著的 session；session exit 後 name 釋放。
- **id vs name**：所有接受 `:id` 的 endpoint 都同時接受 name（先查 id，再查 name）。
