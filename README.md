# kabby

PTY 多工器 daemon — 一個 cc 進程，多個 client（桌面 UI、wepages iframe）同時 attach，行為類似 `tmux attach`。

## 為什麼做這個

現有的 ai-terminal（在 wepages 任務模組以 iframe 嵌入）每次點 Terminal 都是「開一個新的 cc」。實際工作流是：先在桌面 terminal 開 cc 進入專案，跑了一陣子後想在 wepages 任務分頁「接續」這個 cc，而不是重開。kabby 把 cc 進程的生命週期跟 client 連線解耦，讓 N 個視窗可以同時看同一個 cc。

詳細設計與分階段請見 [`PLAN.md`](./PLAN.md)。

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
| `AUTH_TOKEN` | （未設） | 設了之後 WS 連線必須帶 `?token=<value>` |
| `KABBY_VIEWER_PATH` | （未設） | cc history viewer 的 portable exe 絕對路徑；設了之後 UI 上「viewer」按鈕會啟用 |

## 快速試用

```bash
# 建一個 session（v1 不需要 token）
curl -X POST http://localhost:3700/api/sessions ^
  -H "Content-Type: application/json" ^
  -d "{\"name\":\"unity\",\"cwd\":\"D:/Projects/RS/my-app/unity\"}"

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
test/
  smoke.js         — Phase 1 整合驗收
reference/
  from-ai-terminal/  — 從 ai-terminal 複製的參考片段（不執行，僅供對照）
docs/
  api.md           — HTTP + WS API 完整參考
  usage.md         — 從零開始使用 kabby 的步驟
PLAN.md            — 設計決策與 Phase 1-4 詳細規劃
```

**User-level 資料**（不入 repo，跟著機器走）

```
%USERPROFILE%\.kabby\
  profiles.json    — 項目（profile）清單
```

## 跟 ai-terminal 的關係

kabby 是新專案，**不修改** `D:\Git\aiterm-repo\class\ai-terminal\tool\`。差異對照見 [`reference/from-ai-terminal/README.md`](./reference/from-ai-terminal/README.md)。


## Provider Setup

- `claude`: keeps the existing history resume, viewer, and monitoring integrations.
- `codex`: can now be created from the Web UI as a session or profile and attached normally; history resume and viewer are not wired yet.
- Both `+ Project` and `+ Temp` now include a provider picker, so you do not need to hand-edit `cmd` to launch Codex.
