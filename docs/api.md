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

## WebSocket

### `ws://localhost:3700/ws/:id`（HTTPS 下用 `wss://`）

> 頁面若以 `https://` 載入（例：經 Cloudflare Tunnel），WS 必須改用 `wss://`，否則被瀏覽器當 mixed-content 擋掉。kabby 前端與 `embed.js` 已依 `location.protocol` 自動切換。

`:id` 可填 UUID 或 name。連上之後：

1. Server 立刻 broadcast 整個 scrollback（一筆 `{type:'output', data:"..."}`），讓 xterm 重繪畫面
2. 加入 session 的 `clients` set，之後 PTY 任何輸出都會收到
3. 該 client 可發 `input` / `resize` 訊息影響 PTY

### Client → Server 訊息

| `type` | 欄位 | 行為 |
|---|---|---|
| `input` | `data: string` | 寫進 PTY |
| `resize` | `cols: number, rows: number` | resize PTY（latest-resize-wins，多 client 互覆蓋） |

非 JSON 或未知 type 一律忽略。

### Server → Client 訊息

| `type` | 欄位 | 時機 |
|---|---|---|
| `output` | `data: string` | PTY 任何輸出 / 新 client 連上時的 scrollback replay |
| `exit` | `code: number, signal: string\|null` | PTY 進程結束 |

### 錯誤狀態

| HTTP 升級回應 | 原因 |
|---|---|
| `404 Not Found` | URL pattern 不是 `/ws/:id` 或 session 不存在 |
| `401 Unauthorized` | 有設 `AUTH_TOKEN` 但 `?token=` 不符 |

---

## 設計取捨備忘

- **多 client 輸入衝突**：v1 不處理，兩個 client 同時打字會 interleave。實務上不易發生。未來可加 `?role=viewer` 唯讀模式。
- **Scrollback 大小**：100 KB（約 1500 行）。超過丟最舊的整塊 chunk（不切字節，保 ANSI escape 完整）。
- **Session 跨重啟存活**：v1 不做。daemon 殺了 PTY 都死。
- **重名**：只擋活著的 session；session exit 後 name 釋放。
- **id vs name**：所有接受 `:id` 的 endpoint 都同時接受 name（先查 id，再查 name）。
