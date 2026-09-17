# kabby

PTY 多工器 daemon — 一個 cc 進程，多個 client（桌面 UI、wepages iframe）同時 attach，行為類似 `tmux attach`。

## 為什麼做這個

現有的 ai-terminal（在 wepages 任務模組以 iframe 嵌入）每次點 Terminal 都是「開一個新的 cc」。實際工作流是：先在桌面 terminal 開 cc 進入專案，跑了一陣子後想在 wepages 任務分頁「接續」這個 cc，而不是重開。kabby 把 cc 進程的生命週期跟 client 連線解耦，讓 N 個視窗可以同時看同一個 cc。

詳細設計與分階段請見 [`PLAN.md`](./PLAN.md)。

## 畫面

![kabby Web UI — 多 tab、左側項目/Running 清單、右上 Live 面板與監控入口](docs/images/screenshot.png)

左側是項目（profile）與 Running session 清單，中間是可上下/左右分割的終端 pane，每個 tab 掛一個 cc session；上方狀態列顯示 cwd、PTY 尺寸與 resume 來源。

## 當前狀態：Phase 1 ✓

只有 daemon 跟 HTTP/WS API，**沒有 UI**。UI 在 Phase 2。
驗收方式：[`test/smoke.js`](./test/smoke.js)。

| Phase | 內容 | 狀態 |
|---|---|---|
| 1 | 核心 daemon（HTTP API + WS fan-out + scrollback replay） | ✓ 完成 |
| 2 | 自帶 Web UI（xterm.js + 多 session tab + Ctrl+Shift+←/→） | ✓ 完成 |
| 2.5 | 項目（profile）+ cc 歷史接續 + 外部 viewer 啟動 | ✓ 完成 |
| 3 | wepages 任務頁 Terminal 按鈕掛載 modal | ✓ 完成（wepages 端實作） |
| 4 | 子清單點擊 → kabby session input 注入 | ✗ 棄置（改由 cc 自主讀工單） |

## 安裝

```bash
git clone <repo>
cd kabby
npm install
```

需要 Node.js ≥ 18。`node-pty` 在 Windows 上會用預編譯的 ConPTY 後端，正常 `npm install` 即可。

## 啟動

```bash
npm start
# → kabby daemon listening on http://localhost:3700
```

開發時自動重啟：

```bash
npm run dev
```

### 環境變數

| 變數 | 預設 | 用途 |
|---|---|---|
| `PORT` | `3700` | HTTP + WS 共用 port |
| `HOST` | `127.0.0.1` | 監聽位址；設 `0.0.0.0` 開放區網直連（務必搭配 `AUTH_TOKEN`） |
| `AUTH_TOKEN` | （未設） | 設了之後 WS 連線必須帶 `?token=<value>` |
| `KABBY_VIEWER_PATH` | （未設） | cc history viewer 的 portable exe 絕對路徑；設了之後 UI 上「viewer」按鈕會啟用 |

## 聊天室（共享終端房間）

主頁右上「聊天室」按鈕可開右側面板：建立房間並綁定一個運行中 session，設定入房 key。

![建立聊天室：綁定 session、房間名稱、入房 key 與「允許訪客在終端輸入」開關](docs/images/room-create.png)

其他人開 `http://<host>:3700/room.html`（或用「複製連結」帶 `?key=`），輸入 key + 暱稱即可進房：

- **看終端**：即時看到綁定 session 的畫面（含 scrollback replay），跟隨房主的終端尺寸
- **文字聊天**：房內文字訊息（房主在側面板、訪客在右欄），保留最近 200 則；支援**貼圖**（Ctrl+V 貼截圖或 🖼 選檔，前端壓縮走 WS 存記憶體，每房保留最近 20 張）與 **@mention**（輸入 @ 自動補齊房內成員，被 tag 會高亮 + 提示）
- **面板寬度**：房主右側面板與訪客頁聊天欄左緣都可拖曳調寬（記在瀏覽器）
- **權限**：房間有「可輸入」開關（預設唯讀），房主可隨時切換、即時生效；唯讀攔截是**伺服器端強制**
- **安全**：訪客 key 只換得該房綁定 session 的 WS + 聊天，打不到其他 API；⚠ 開放「可輸入」等於讓訪客在這台機器用你的權限執行任意指令，只給信任的人
- 房間存在記憶體，daemon 重啟或綁定 session 結束即自動關房

## 監控（token 用量 / 對話 / 敏感詞）

主頁右上「監控」按鈕開唯讀監控面板：背景 watcher 持續掃 cc / Codex 的歷史 jsonl 建索引，頂端是總計（sessions、turns、input/output、cache 建立與讀取、成本估算、敏感詞命中數），下方分四個分頁。

![監控面板：總計列 + Token 用量分頁，逐 session 列出 model、turns、token、成本與最後活動時間](docs/images/monitor.png)

- **Token 用量**：逐 session 的 model / turns / input / output / cache 讀 / 成本 / 敏感詞命中 / 最後活動，可展開看逐輪明細
- **Live**：目前正在跑的 session 的即時逐輪用量
- **儀表板**：彙總圖表
- **敏感詞**：命中清單；詞庫在 `~/.kabby/sensitive-words.json`
- 右上 **Claude / Codex** 切換 provider；**重新整理**重讀索引，**重審歷史**砍索引全掃（重算 token/成本並套用目前詞庫到既有對話）

## 快速試用

```bash
# 建一個 session（v1 不需要 token）
curl -X POST http://localhost:3700/api/sessions ^
  -H "Content-Type: application/json" ^
  -d "{\"name\":\"unity\",\"cwd\":\"D:/Projects/my-app\"}"

# 列出所有 session
curl http://localhost:3700/api/sessions

# attach（任一 WS client，例如 wscat）
wscat -c ws://localhost:3700/ws/unity
```

詳細 API：[`docs/api.md`](./docs/api.md)
完整使用流程與排錯：[`docs/usage.md`](./docs/usage.md)

## 驗收測試

```bash
node test/smoke.js
```

此腳本用 `cmd.exe` 代替 cc 跑（避免依賴 claude 是否安裝），驗證：

- HTTP API 建立 / 刪除 session
- 兩個 WS client 同連同 session，A 打字 B 收到（fan-out）
- 第三個 client 後加入，能透過 scrollback replay 看到歷史輸出
- session 的 `clientCount` 正確反映 attach 數

## 專案結構

```
src/
  daemon.js        — Entry：HTTP server + WS upgrade + API routes
  session.js       — Session class：封裝 PTY + scrollback + clients
  registry.js      — 單例 Map<id, Session>，name 去重、ccSessionId 佔用查詢
  ring-buffer.js   — 100KB chunk-based ring buffer
  profile-store.js — ~/.kabby/profiles.json CRUD
  cc-history.js    — 解析 cc 對話歷史 jsonl
public/            — Web UI（SPA + embed.html）
docs/
  api.md           — HTTP + WS API 完整參考
  usage.md         — 從零開始使用 kabby 的步驟
PLAN.md            — 設計決策與 Phase 1-4 詳細規劃
```
