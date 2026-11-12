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
{ "ok": true, "authRequired": true, "sessions": 3, "profiles": 5, "viewerConfigured": true, "sttConfigured": true }
```

`sttConfigured`：是否設定了語音輸入的 STT 位址（`KABBY_STT_URL`，有預設值所以通常為 `true`；服務實際是否在跑請看 `GET /api/stt/status`）。

`authRequired`：daemon 是否設了 `AUTH_TOKEN`。前端 / wepages 可據此決定是否要帶 token。**此 endpoint 不需 token。**

### `GET /api/sessions`

列所有活著的 session。

```json
[
  {
    "id": "8f4b...",
    "name": "unity",
    "cwd": "D:/Projects/my-app",
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
| `cmd` | string | | 自動尋找（`.env` 的 `KABBY_CLAUDE_CMD` → PATH 上的 `claude.exe` / `claude.cmd` → `~/.local/bin` → `%APPDATA%
pm`） | 要 spawn 的執行檔；只填 `claude` 也會自動補 `.exe` / `.cmd` |
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

### `GET /api/sessions/:id/chat?key=&after=`

對話視圖用的增量 items（token 認證）。daemon 把 kabby session 對應到 cc 的對話存檔（resume 的 id，或 PTY 啟動後才建立的那份；`/clear` 開新檔會跟過去），逐 content block 展平。

- `key`：上次回應的 `key`（對話存檔 id）；第一次帶空字串
- `after`：已收到的 item 數；第一次帶 `-1`

```json
{ "key": "<cc session id>", "total": 42, "from": 40, "reset": false, "provider": "claude",
  "items": [
    { "kind": "user", "text": "…", "ts": "…" },
    { "kind": "assistant", "text": "markdown…", "model": "…", "ts": "…" },
    { "kind": "tool", "id": "toolu_…", "name": "Read", "input": { "file_path": "…" }, "ts": "…" },
    { "kind": "result", "toolUseId": "toolu_…", "content": "…", "isError": false, "ts": "…" }
  ] }
```

- 沒有新資料：`{ key, total, unchanged: true }`
- `key` 與上次不同（`/clear` 換檔）或 `after` 超出：`reset: true`，`items` 從頭給
- 還沒有存檔：`{ notFound: true }`；provider 不支援：`{ unsupported: true }`
- 工具 input 與 result 的長字串截斷在 4096 字；thinking、sidechain（subagent）、meta 訊息與 slash 指令輸出不列入
- Codex 目前由摘要降級：工具只有 `input.hint`，沒有 result

## Profiles API（Phase 2.5）

項目（profile）= 保存的 session 啟動配置 (name, cwd, cmd, args)。存在 `%USERPROFILE%\.kabby\profiles.json`，daemon 重啟保留。

### `GET /api/profiles`

列所有 profile。每筆多帶一個 `lastSessionBusy` 旗標：若 `lastSessionId` 已被運行中的 kabby session 掛載中，則為 `true`（UI 用來 disable「接續上次」按鈕）。

```json
[
  {
    "id": "...",
    "name": "unity",
    "cwd": "D:/Projects/my-app",
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
{ "dir": "C:\\Users\\<user>\\.claude\\projects\\D--Git-kabby", "exists": true }
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

共享終端房間：房主建房綁一個 running session（**一 session 至多一房**），其他人憑「密碼」入房。密碼決定角色：

| 角色 | 密碼 | 看終端 | 寫終端 | 房間管理 |
|---|---|---|---|---|
| `master` 房主 | 主密碼 | ✅ | ✅（凍結時仍可寫） | 凍結 / 踢人 / 關房 |
| `collab` 協作 | 協作密碼 | ✅ | ✅（`frozen=true` 時暫唯讀） | ❌ |
| `guest` 訪客 | 訪客密碼 | ✅ | ❌ | ❌ |

三組密碼建房時至少設一組、彼此不可相同、且**全域唯一**（憑密碼即可解析房+角色）。房間存記憶體，daemon 重啟 / 綁定 session 結束即關房。訪客頁：`/room.html`。本機 `AUTH_TOKEN` 擁有者是超級管理員（建/殺 session、建房、跨房管理），不受房間密碼影響。

### `POST /api/rooms/join`（**不需 token**，防爆破限流：同 IP 5 分鐘內錯 10 次 → 429）

Request：`{ "password": "master1234", "nickname": "小明" }`（相容舊欄位 `key`），或用分享連結的邀請碼 `{ "invite": "<token>", "nickname": "小明" }`（URL 不含明文密碼）
Response：`{ "ticket": "...", "roomId": "...", "roomName": "...", "sessionId": "...", "sessionName": "...", "role": "master|collab|guest", "allowWrite": <該角色當下有效寫入權>, "nickname": "小明" }`

ticket 是之後 WS 連線的憑證（`/ws/:sessionId?ticket=`，內含角色），房間關閉或 daemon 重啟即失效。

### `GET /api/rooms/guest/conversation?ticket=`（**ticket 認證**，不需 token）

訪客看綁定 session 的乾淨版對話記錄（讀 provider 對話 JSONL，跟監控頁同一套採集器）。回 `{ turns: [{ ts, role, text, model?, tokens? }] }`；找不到存檔回 `{ turns: [], notFound: true }`。不回傳 `file` 等本機路徑。
定位規則：resume 的 session 直接用該對話 id；新 session 取該 cwd 下「PTY 啟動後仍有更新」的最新一份（若同 cwd 另有 kabby 之外的活躍 cc，可能對應錯，屬已知限制）。

### `GET /api/rooms/guest/chat?ticket=&key=&after=`（**ticket 認證**，不需 token）

訪客頁「💬 對話」視圖的增量 items。`key` / `after` 與回應格式同房主的 [`GET /api/sessions/:id/chat`](#get-apisessionsidchatkeyafter)。只讀：送出訊息仍走訪客的終端 WS `input`，受房間寫入權管制（唯讀 / 凍結時伺服器端擋下）。ticket 無效 `401`、session 已結束 `404`。

### `GET /api/rooms`（token）

列所有房間，含三組密碼（`masterPass`/`collabPass`/`guestPass`，供房主端顯示）、三組邀請碼（`masterInvite`/`collabInvite`/`guestInvite`，用來組不含明文密碼的入房連結 `/room.html?invite=<token>`）、`frozen`、`guests: [{ ticket, nickname, role, joinedAt, online }]`。

### `POST /api/rooms`（token)

`{ "sessionId": "<id|name>", "name?": "...", "masterPass?", "collabPass?", "guestPass?", "frozen?": false }` → `201` 房間 JSON。session 必須存在且 alive、且尚未綁房；密碼至少一組、互異、全域唯一（否則 `400`）。

### `PATCH /api/rooms/:id`（token）

`{ "frozen": true|false }` — 全房凍結開關，即時生效：協作者變唯讀、房主不受影響。各訪客依角色收到 `room-config` 推送。

### `DELETE /api/rooms/:id`（token）

關房：所有訪客收到 `room-closed` 後被斷開，tickets 回收。

---

## 語音輸入（STT 代理）

🎙 按住說話：瀏覽器錄音轉成 16kHz 單聲道 WAV，POST 給 daemon，daemon **原樣轉發**（不解析 multipart）到 `{KABBY_STT_URL}/transcribe`（Voicebox / Whisper）。瀏覽器不直連 STT，沿用 kabby 自己的 token / ticket 認證。轉寫結果只填進輸入框或打進終端（不補 `\r`），**不會自動送出**。

| 路由 | 認證 | 用途 |
|---|---|---|
| `GET /api/stt/status` | token | 房主端探測 STT 服務 |
| `POST /api/stt/transcribe` | token | 房主端轉寫 |
| `GET /api/rooms/guest/stt/status?ticket=` | ticket | 訪客端探測（不回傳 `url`） |
| `POST /api/rooms/guest/stt/transcribe?ticket=` | ticket | 訪客端轉寫；同一 ticket 同時只收一筆（否則 `429`） |

唯讀訪客也能用轉寫來填聊天框；**終端寫入權仍由 WS `input` 依角色 / 凍結判斷**（見 WebSocket 一節），轉寫 API 本身不寫終端。

### `GET /api/stt/status`

daemon 探測 `{KABBY_STT_URL}/health`（逾時 2 秒，結果快取 10 秒）。前端約每 30 秒輪詢一次，`available: true` 才讓 🎙 亮起。

```json
{ "available": true, "gpu": "CUDA (NVIDIA GeForce RTX 3060)", "url": "http://127.0.0.1:17493" }
{ "available": false, "error": "語音服務未啟動（ECONNREFUSED）", "url": "http://127.0.0.1:17493" }
```

### `POST /api/stt/transcribe`

`Content-Type: multipart/form-data`，欄位同 Voicebox：`file`（必填，wav/mp3/m4a/ogg/flac/aac/webm/opus）、`language`（選填，例 `zh`）、`model`（選填）。上限 25MB，逾時 `KABBY_STT_TIMEOUT_MS`（預設 60 秒）。

| 狀態 | Body | 說明 |
|---|---|---|
| `200` | `{ "text": "你好…", "duration": 4.07 }` | 轉寫成功 |
| `202` | `{ "loading": true, "error": "語音模型載入中，請稍候再試" }` | 模型首次使用、下載中；前端提示稍後再試，不自動重試 |
| `400` | `{ "error": "..." }` | 不是 multipart，或 STT 回報參數錯誤（例如 model 不合法） |
| `413` | `{ "error": "音檔過大（上限 25MB）" }` | 超過大小上限（含 chunked 上傳，邊轉發邊計量） |
| `502` | `{ "error": "語音服務未啟動（KABBY_STT_URL=...）" }` | 連不上 STT 服務 |
| `504` | `{ "error": "語音轉寫逾時（>60 秒）" }` | 超過逾時 |
| 其他 | `{ "error": "<STT detail>" }` | STT 端錯誤（例如 `500`）原樣轉成一行訊息 |

```bash
curl -H "X-Kabby-Token: $AUTH_TOKEN" -F file=@hello.wav -F language=zh http://localhost:3700/api/stt/transcribe
```

---

## 唯讀檔案下載（/api/files）

讓內網其他機器從本機串流拉大型檔案（例：GPU 機從 kabby 主機拉幾十 GB 的模型檔），支援 Range 斷點續傳。**只讀**：不提供上傳、刪除、改名。

### 設定（`.env`，全部選填）

| 變數 | 說明 |
|---|---|
| `KABBY_FILES_ROOTS` | 多個分享根目錄，`名稱=絕對路徑` 以分號分隔（例 `repo=D:\work\project;models=D:\shared\models`），每項以第一個 `=` 切開。名稱限 `[a-z0-9_-]+`、不可重複；路徑必須是已存在的目錄。**不合規 → 啟動時印錯誤並停用 `/api/files`**（daemon 照常啟動） |
| `KABBY_FILES_ROOT` | 舊的單一根目錄（絕對路徑，例 `D:\shared\models`），路徑不帶名稱前綴。與 `KABBY_FILES_ROOTS` 同時設時以 ROOTS 為準並印警告 |
| `KABBY_FILES_ALLOW_IPS` | 來源 IP 白名單，逗號分隔；空 = 不限。每項可寫單一 IP（`192.168.1.20`）、結尾萬用字元（`192.168.1.*` = 該 /24、`192.168.*.*` = /16）或 CIDR（`192.168.1.0/24`），可混寫。`*` 只能放在結尾的整段（`10.*.1.5`、`10.1.1.1*`、單獨 `*` 都不合法）。不合法項目啟動時警告並略過；**全部不合法時一律拒絕**（寫錯不會變成不限）。`::ffff:192.168.1.20` 這類 IPv4-mapped IPv6 會自動比對成 IPv4；IPv6 只支援完整位址比對 |

兩個都沒設 = 功能關閉，`/api/files/*` 一律 `404`。daemon 要讓別台機器連得到，需 `HOST=0.0.0.0` 並設 `AUTH_TOKEN`。

### 路徑格式

| 模式 | 請求的 `path` | 回應裡的 `path` |
|---|---|---|
| 多根（`KABBY_FILES_ROOTS`） | 第一段是根目錄名稱：`repo/executor/pull.py`、`models/hf/vae/x.safetensors` | 一律帶名稱前綴，可直接拿去打 `stat` / `raw` |
| 單根（`KABBY_FILES_ROOT`） | 相對根目錄：`sdxl/model.safetensors` | 相對根目錄 |

- 多根模式下，名稱區分大小寫；未知名稱 → `404 { "error": "unknown root" }`。
- 名稱後面的部分照下面的路徑檢查，`realpath` 不可逃出**該名稱對應的根目錄**。所以就算 `repo` 裡有指向 `models` 的 junction，也會被擋成 `400`，請改用 `models/...` 路徑。
- sha256 快取以實際檔案路徑為 key，與名稱無關。

### 安全規則（依序檢查）

1. **token**：沿用 `AUTH_TOKEN`（掛在 token middleware 之後），失敗 `401`。**請用 `X-Kabby-Token` header**；`?token=` 雖然可用，但會出現在存取日誌與代理 log 裡，下載端不要用。
2. **拒絕經 tunnel / 代理轉入的請求**：只要 header 帶 `cf-connecting-ip` 或 `x-forwarded-for`，一律 `403`，不管來源 IP 與 token。原因：cloudflared / 反向代理轉進來的連線，socket 位址是 `127.0.0.1`；這條確保即使白名單含 `127.0.0.1`，外部請求也進不來。
3. **IP 白名單**：看 TCP socket 的來源位址（不信任任何 header），不在名單內 `403`。建議只填下載端機器，本機自測時再暫時加 `127.0.0.1`。用萬用字元或 CIDR 開整個網段時，留意同網段裡是否有不該能下載的機器。
4. **路徑檢查**：`path` 一律是相對於根目錄的路徑（`/` 或 `\` 分隔皆可，回應一律 `/`）。
   - 絕對路徑、磁碟代號、UNC、含 `:`（Windows ADS）、空字元、任何 `..` 段 → `400 { "error": "invalid path" }`
   - `realpath` 後不在根目錄底下（symlink / junction 逃逸）→ `400`
   - 點開頭的檔案或目錄（`.gitattributes`、`.cache/` …）→ 視為不存在，`404`；`list` 也不列出
   - 錯誤訊息不包含實際路徑

### `GET /api/files/list?path=<相對目錄>&recursive=1`

`recursive=1` 遞迴列出（最多 100,000 筆，超過時多回 `"truncated": true`）。不跟進 symlink / junction。`entries[].path` 的格式見上方「路徑格式」，可直接拿去打 `stat` / `raw`。

**多根模式，`path` 省略或空字串 → 根清單**：每個根目錄一筆，`root` 為 `null`，不回絕對路徑。帶 `recursive=1` 也只列這一層，不往下掃。

```json
{
  "root": null,
  "path": "",
  "entries": [
    { "path": "repo", "size": 0, "mtime": "2026-11-11T02:00:00.000Z", "isDir": true },
    { "path": "models", "size": 0, "mtime": "2026-11-11T03:10:01.000Z", "isDir": true }
  ]
}
```

**列某個目錄**（多根模式，`?path=models/hf&recursive=1`）：

```json
{
  "root": "models",
  "path": "models/hf",
  "entries": [
    { "path": "models/hf/vae", "size": 0, "mtime": "2026-11-11T03:10:01.000Z", "isDir": true },
    { "path": "models/hf/vae/x.safetensors", "size": 6938078334, "mtime": "2026-11-11T03:12:45.123Z", "isDir": false }
  ]
}
```

- `root` 是根目錄名稱。單根模式下 `path` 省略 = 根目錄，`root` 是根目錄的資料夾名稱，`path` 不帶前綴。
- `path` 指向檔案 → `400 { "error": "not a directory" }`。

### `GET /api/files/stat?path=<檔案>&hash=1`

```json
{ "path": "sdxl/model.safetensors", "size": 6938078334, "mtime": "2026-11-11T03:12:45.123Z", "sha256": "9f2c…" }
```

- `sha256`：有快取直接回；沒快取且沒帶 `hash=1` 時為 `null`。
- `hash=1`：串流計算（不整檔讀進記憶體；30GB 約需數分鐘，請把下載端的 HTTP timeout 拉長）。同一檔案正在算時，後到的請求等同一個計算結果，不會重算。用戶端中途斷線，計算仍會完成並寫入快取。
- 快取在記憶體（daemon 重啟即清），key = 實際路徑 + size + mtime；檔案一變就失效。
- `path` 指向目錄 → `400 { "error": "not a file" }`。

### `GET /api/files/raw?path=<檔案>`

串流下載原始內容（Content-Type 依副檔名推斷，未知時為 `application/octet-stream`）。

- 回應 header：`Accept-Ranges: bytes`、`Content-Length`、`ETag`、`Last-Modified`
- **Range 續傳**：`Range: bytes=<start>-[<end>]` → `206` + `Content-Range: bytes <start>-<end>/<size>`；超出檔案大小 → `416`
- 支援 `If-Range`（搭配 ETag / Last-Modified，檔案變了就回完整 `200`）
- 用戶端中途斷線會關閉讀檔 stream，不會留下 fd

```bash
# 取前 100 bytes（回 206、長度 100）
curl -H "X-Kabby-Token: $AUTH_TOKEN" -r 0-99 "http://127.0.0.1:3700/api/files/raw?path=sdxl/model.safetensors" -o part.bin
# 斷點續傳
curl -H "X-Kabby-Token: $AUTH_TOKEN" -C - "http://192.168.1.10:3700/api/files/raw?path=sdxl/model.safetensors" -o model.safetensors
```

### 稽核日誌（JSONL）

`/api/files` 的每個請求（含被拒的 401 / 403 / 400）寫一行 JSON 到 `<KABBY_FILES_LOG_DIR>/files-YYYY-MM-DD.jsonl`（本地日期，每日一檔）。`/activity` 輪詢不寫。

| 變數 | 預設 | 說明 |
|---|---|---|
| `KABBY_FILES_LOG_DIR` | `~/.kabby/logs/files` | 日誌目錄（kabby 資料目錄，不在 repo 內） |
| `KABBY_FILES_LOG_DAYS` | `30` | 保留天數；啟動時與每 24 小時清掉更舊的 `files-*.jsonl` |

```json
{"ts":"2026-11-11T13:19:49.183Z","ip":"192.168.1.20","method":"GET","endpoint":"raw","path":"models/w.bin","range":"bytes=0-99","status":206,"bytes":100,"size":3000000,"ms":13,"result":"ok"}
{"ts":"2026-11-11T13:19:49.228Z","ip":"192.168.1.99","method":"GET","endpoint":"list","status":401,"ms":0,"result":"denied","reason":"bad_token"}
{"ts":"2026-11-11T13:19:49.272Z","ip":"192.168.1.20","method":"GET","endpoint":"raw","path":"repo/../models/w.bin","status":400,"bytes":0,"ms":1,"result":"denied","reason":"invalid_path"}
```

| 欄位 | 說明 |
|---|---|
| `ts` | ISO 時間（UTC） |
| `ip` | 來源 IP（socket 位址，已去 `::ffff:`） |
| `method` / `endpoint` | `GET` / `list`、`stat`、`hash`（`stat?hash=1`）、`raw`、`other` |
| `path` | 解析成功時為正規化路徑；被拒時為收到的原始字串（截 512 字） |
| `range` | 請求的 `Range` header |
| `status` / `ms` | HTTP 狀態、耗時 |
| `bytes` | raw 實際傳出的 body bytes（中途斷線時為已送出量） |
| `size` | 檔案大小（stat / hash / raw） |
| `result` | `ok` / `aborted`（用戶端中途斷線）/ `error` / `cached`（hash 走快取）/ `denied` |
| `reason` | 失敗原因：被拒（`result=denied`）為 `bad_token` / `proxy_header` / `ip_not_allowed` / `invalid_path` / `dotfile`；其他錯誤為 `not_found` / `unknown_root` / `not_a_file` / `not_a_directory` / `range_not_satisfiable` / `root_unavailable` |

- **絕不記錄 token**：認證失敗只記 `reason:"bad_token"`。事件欄位是白名單，不含任何 header 與 query（`?token=` 不會被寫入）。
- **被拒限流**：每個 IP 每分鐘最多寫 60 筆被拒事件，超過的只計數，之後補一筆 `{"result":"denied","reason":"suppressed","suppressed":N}`。`activity` 的統計照常完整計數。目的是防止內網有東西一直亂打，把磁碟寫爆。
- **寫檔失敗**（目錄不可寫、磁碟滿）只在 stderr 警告（每分鐘最多一次），不影響下載。

stderr 另外保留一行簡要日誌（只記 `raw` 與 `hash`）：

```
[files] 2026-11-11T03:20:11.002Z ip=192.168.1.20 raw path=models/w.bin range=bytes=0-99 status=206 bytes=100 ms=3 ok
```

### `GET /api/files/activity`

即時狀態，給 kabby 主頁的「📦 檔案傳輸」監控頁（`/files.html`，每 2 秒輪詢）使用。**只需 token**，不套 `KABBY_FILES_ALLOW_IPS` 與代理 header 檢查（跟 kabby 其他 API 同一個標準）。輪詢不寫稽核日誌。`/api/files` 未啟用時回 `{ "enabled": false }`。

```json
{
  "enabled": true,
  "active": [
    { "id": 7, "ip": "192.168.1.20", "path": "models/hf/vae/x.safetensors", "range": "bytes=1048576-",
      "sent": 524288000, "total": 6937029758, "startedAt": "2026-11-11T13:20:01.000Z", "mibps": 104.2 }
  ],
  "hashing": [
    { "path": "models/hf/unet.safetensors", "size": 32000000000, "done": 8000000000, "startedAt": "2026-11-11T13:19:00.000Z" }
  ],
  "recent": [ { "ts": "…", "ip": "…", "endpoint": "raw", "status": 206, "result": "ok", "…": "同 JSONL 欄位，最新在前，最多 200 筆" } ],
  "stats": {
    "since": "2026-11-11T13:00:00.000Z", "requests": 42, "bytesSent": 21474836480,
    "bytesByIp": { "192.168.1.20": 21474836480 },
    "byStatus": { "200": 30, "206": 8, "401": 2, "400": 2 },
    "denied": 4, "deniedByReason": { "bad_token": 2, "invalid_path": 2 }
  },
  "log": { "enabled": true, "writable": true, "days": 30 },
  "config": { "mode": "multi", "roots": ["repo", "models"], "allowIps": ["192.168.1.20"] }
}
```

- `active[].mibps`：這次下載開始以來的平均速度。`total` 是這次要傳的量：有 Range 時為區段長度，沒有時為整個檔案。
- `hashing[].done`：已讀取的 bytes，用來算進度。
- `stats`：自 daemon 啟動以來的累計，重啟歸零。
- 不回傳任何絕對路徑（日誌目錄也只回是否可寫）。

---

## WebSocket

### `ws://localhost:3700/ws/:id`（HTTPS 下用 `wss://`）

> 頁面若以 `https://` 載入（例：經 Cloudflare Tunnel），WS 必須改用 `wss://`，否則被瀏覽器當 mixed-content 擋掉。kabby 前端與 `embed.js` 已依 `location.protocol` 自動切換。

`:id` 可填 UUID 或 name。連上之後：

1. Server 立刻 broadcast 整個 scrollback（一筆 `{type:'output', data:"..."}`），讓 xterm 重繪畫面
2. 加入 session 的 `clients` set，之後 PTY 任何輸出都會收到
3. 該 client 可發 `input` / `resize` 訊息影響 PTY

**認證**：`?token=`（本機房主，完整權限）或 `?ticket=`（憑密碼換來的角色憑證，僅限該房綁定的 session）。ticket 連線依角色管制（伺服器端強制）：`input` 依 master / collab（非 frozen）/ guest 決定是否寫入；`resize` 一律忽略。master ticket 另可送 `room-admin` 控制訊息。

### Client → Server 訊息

| `type` | 欄位 | 行為 |
|---|---|---|
| `input` | `data: string` | 寫進 PTY（依角色/凍結管制：guest 恆擋、collab 凍結時擋、master 放行） |
| `resize` | `cols: number, rows: number` | resize PTY（latest-resize-wins，多 client 互覆蓋；ticket 連線忽略） |
| `chat` | `text?: string, image?: string` | （訪客連線）發聊天訊息，廣播全房。`image` 為 data URL（`data:image/png|jpeg|webp|gif;base64,...`，≤2M 字元，前端已壓縮；伺服器只保留每房最近 20 張，舊圖退化成 `imageExpired`） |
| `room-admin` | `action: 'freeze'\|'unfreeze'\|'kick'\|'close'`, `ticket?`（kick 用） | **僅 master ticket**：凍結/解凍全房、踢人、關房 |

非 JSON 或未知 type 一律忽略。

### Server → Client 訊息

| `type` | 欄位 | 時機 |
|---|---|---|
| `output` | `data: string` | PTY 任何輸出 / 新 client 連上時的 scrollback replay |
| `termsize` | `cols, rows` | attach 時 + 每次 PTY resize（訪客端跟著 `term.resize`；host 端忽略） |
| `exit` | `code: number, signal: string\|null` | PTY 進程結束 |
| `blocked` | `words: string[]` | 輸入含敏感詞被攔截 |
| `room-init` | `room{frozen,allowWrite,...}, role, nickname, chatLog, guests` | （訪客）連上時的房間狀態（含自己的角色與有效寫入權）+ 聊天歷史 |
| `chat` | `from, nickname, text, image?, imageExpired?, ts` | 房內聊天訊息（`from: host\|guest\|system`） |
| `room-presence` | `guests: [{ticket,nickname,role,online,...}]` | 訪客加入 / 離開 |
| `room-config` | `frozen?: boolean, allowWrite?: boolean` | 凍結狀態變更；`allowWrite` 為該訪客依角色算出的有效寫入權 |
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
