# 參考產品分析：Kanban Code (langwatch/kanban-code)

> 上游：https://github.com/langwatch/kanban-code
> 分析日期：2026-09-16 · 目的：作為 kabby UI / 終端渲染的對照組

## 一、產品定位

以看板（Kanban）方式管理**多個平行運行的 Claude Code agent session**。
每個任務是一張卡，卡片自動綁定：Claude session + git worktree + tmux 終端 + GitHub PR。
卡片依「真實活動訊號」自動在欄位間流動（Backlog → In Progress → Waiting → In Review → Done → All Sessions）。

核心賣點與 kabby 重疊處：多 session 管理、終端嵌入、session 續接、遠端執行。
不重疊處：git worktree 綁定、PR 狀態追蹤、Pushover 手機推播、BM25 全文檢索、fork/checkpoint。

## 二、Monorepo 結構：一個 repo 四個產物

| 目錄 | 產物 | 技術棧 |
|---|---|---|
| `Sources/` | macOS 原生 App（主力） | Swift 6.2 / SwiftUI + AppKit |
| `windows/` | Windows 原生 App（移植） | Tauri 2 (Rust) + React 18 + TypeScript |
| `cli/` | `kanban` CLI | Node.js + TypeScript |
| `web/` | 分享用聊天室網頁 | React 19 + Vite 6 + Tailwind 3 |

## 三、macOS 版（Swift）

- **Swift 6.2 / SwiftPM**，`platforms: .macOS(.v26)` — 只支援 macOS 26 Tahoe，為了使用
  **Liquid Glass 工具列**（`ToolbarSpacer`、分離式 glass pills）。UI 好看的來源之一。
- UI 為 **SwiftUI + AppKit 混合**（system tray、`NSPopUpButton`）。`Sources/KanbanCode/` 共 72 個檔。
- **架構：Elm/Redux 單向資料流**（`docs/architecture.md`）
  - 單一 `AppState` struct → `store.dispatch(action)` → 純 `Reducer` → async `Effect`（由 actor 執行）
  - 作者明說「不是 TCA，是自己寫的約 400 行」
  - 起因：原本 in-memory 狀態與磁碟 `links.json` 兩個真相來源、5 個寫入者互相競爭，
    造成卡片在欄位間跳動、終端消失、重複卡片
- **Clean Architecture 分層**：`KanbanCodeCore`（純 Swift、零 UI）分
  `Domain/Entities`、`Domain/Ports`（protocol）、`UseCases`、`Adapters`（實作）；App target 只有 View。
- **依賴極少且全部 vendored**：`SwiftTerm`（終端模擬器）、`swift-markdown-ui` fork（聊天 Markdown）。
  傳遞依賴只有 swift-argument-parser / swift-cmark / NetworkImage。
- **Swift 6 concurrency 坑**：`CLAUDE.md` 有專章 —— `DispatchSource` event handler 在 `@MainActor`
  方法內建立會繼承 isolation，跑在背景 GCD queue 時直接 runtime crash，必須抽到 `nonisolated`。
- **自帶診斷**：main thread watchdog（>500ms 自動跑 `sample`）、`vmmap` 記憶體快照、
  terminal throughput log，全寫到 `~/.kanban-code/logs/`。

## 四、Windows 版（Tauri 移植）

- **Tauri 2 + Rust 2021**；前端 React 18 + TS + Vite 6 + Tailwind 4
  + **zustand**（狀態）+ **@dnd-kit**（看板拖拉）+ **xterm.js 6 + tauri-pty**（終端）+ fuse.js（模糊搜尋）。
- Rust 端 42 個檔，等於把 `KanbanCodeCore` 用 Rust 重寫一次，檔名幾乎一一對應：
  `session_discovery.rs`、`card_reconciler.rs`、`bm25.rs`、`git_worktree.rs`、`hook_manager.rs`、
  `tmux.rs`、`coordination_store.rs`、`browser_webviews.rs`…
- Rust 依賴：tokio、serde、notify（檔案監看）、reqwest（rustls，避開 Windows openssl 工具鏈）、
  clap、walkdir、chrono。Tauri 開 `unstable` feature 以使用 `Window::add_child` 做多分頁內嵌瀏覽器。
- Release profile 調得很兇：`lto = true` / `opt-level = "s"` / `panic = "abort"` / `strip`；
  dev 用 `debug = 1` 避開 PDB 超過 LNK1140 上限。

## 五、CLI（`kanban`）

- Node ESM + TypeScript，`commander`、`express 5`（share server）、`chokidar`、`yaml`、
  **`@slack/web-api` + `socket-mode`**（Slack bridge）。測試用 node 內建 `node:test` + tsx。
- 定位是**給 master agent 用的編排介面**：每個指令都有 `--json`，
  可用 `kanban send` / `capture` / `interrupt` 透過 tmux 操控其他 Claude session。
- 另有 subagents、channels、handles、remote-proxy、cloudflare tunnel、self-compact 等模組。

## 六、Web（`@kanban-code/share-web`）

React 19 + Vite 6 + TS 5.7 + Tailwind 3 + shadcn 風格（cva / clsx / tailwind-merge / lucide）。
Vitest + Testing Library。功能即一個分享給訪客的聊天室（JoinScreen / ChatRoom / Composer / MessageList）
—— 與 kabby 的 `room.html` 定位相同。

## 七、核心整合點

- Claude Code **hooks** + 直接讀 `~/.claude/projects/*.jsonl`
  （自寫 JSONL parser、transcript reader、context usage、BM25 全文檢索）
- **tmux**（每個 session 跑在 tmux 裡，使用者可自行 attach）
- **git worktree**、**gh CLI**（PR 狀態）、**Pushover**（手機推播）、**mutagen**（遠端機同步）
- 不只 Claude：`Adapters/` 下同時有 **Codex** 與 **Gemini** 的 session discovery / parser
  （與 kabby 的 `providers.js` 思路相同）

## 八、工程配置

Conventional Commits + **release-please**（自動 changelog / 版號，`CHANGELOG.md` 已 98KB）、
GitHub Actions（cli-ci / release / workflow-pin-check）、`Makefile` 手工組 `.app` bundle
（自寫 Info.plist、ad-hoc codesign、把 CLI 塞進 bundle）、`specs/` 下 15 個主題的規格文件。

---

## 九、對 kabby 的觀察結論

### 9.1 為什麼它跑起來卡（Windows 版）

依原始碼定位，主因是**背景輪詢做全量重掃**：

1. `lib.rs:1502 start_polling` —— 每 **5 秒** 呼叫 `board_state.refresh()` →
   `session_discovery::discover_sessions()`
2. `session_discovery.rs:250 scan_directory` —— 走訪 `~/.claude/projects/` 下**每個**目錄的**每個** `.jsonl`
3. 對每個檔案呼叫 `jsonl_parser::extract_metadata()` ——
   **逐行 `serde_json::from_str` 讀完整個檔案**。它有讀 mtime，但**沒有拿 mtime 當快取鍵跳過未變更的檔案**
4. 同一輪還要再跑 `codex_sessions::discover()` + `gemini_sessions::discover()`

→ Claude 歷史越多（數百 MB transcript 很常見），每 5 秒就是一次數百 MB 的磁碟讀 + JSON parse。
Windows 檔案系統與 Defender 即時掃描讓成本再放大。

次要因素：
- 另有兩個 5 秒迴圈（remote/mutagen status）、60 秒 PR 輪詢、30 秒 self-compact 輪詢
- 前端開 `React.StrictMode`（dev 下所有 effect 跑兩次），`CardDetailView.tsx` 單檔 2680 行的巨型元件
- xterm 用 DOM renderer（未載入 webgl addon）+ `scrollback: 20000`
- 若是用 `npm run tauri dev` 跑 —— Rust 是 debug build（`debug=1`、無 LTO），前端是 Vite dev server，
  跟 `npm run tauri build` 出來的 release（LTO + `opt-level="s"`）差距很大
- 內嵌瀏覽器分頁用 Tauri unstable 的 `add_child`，每個分頁一個 WebView2

**對 kabby 的啟示**：`cc-collector.js` / `usage-watcher.js` 若也在掃 `~/.claude/projects`，
務必用 mtime + size 當快取鍵，只重讀變更過的檔案，並記住每檔上次讀到的 offset 做增量 parse。

### 9.2 為什麼它的終端文字版面比 kabby 清晰

兩邊用的都是 xterm.js + FitAddon + Cascadia Code，差別在**尺寸協商**：

| | kanban-code | kabby |
|---|---|---|
| PTY 初始尺寸 | fit 完才 spawn，用 `proposeDimensions()` 的 cols/rows | `session.js:12` 寫死 `cols=220, rows=50`，client 連上後才 resize |
| PTY 尺寸來源 | 唯一一個 xterm（1 terminal : 1 pty） | 多個 pane / 多個 client 各自 `sendResize`，互相覆蓋 |
| scrollback | 原生 PTY byte stream 直送 | RingBuffer 100KB 上限，**整段丟最舊 chunk** 後 replay |
| 版面 | `lineHeight: 1.3` + 容器 `padding: 8px` | 無 lineHeight、無 padding |

主要嫌疑（依嚴重度排序）：

1. **PTY 起始 220×50 與實際視窗寬度不符**（`src/session.js:12`）
   cc 在 220 欄的世界裡畫出 TUI 邊框與硬換行，等 client fit 完（例如 100 欄）才 resize。
   已經寫進 scrollback 的那些 220 欄長行，會在 100 欄處被 xterm 重新折行 —— **這就是「邊緣斷層」**。
   修法：建立 session 時就由 client 帶著真實 cols/rows 進來，或延後 spawn 到第一個 client 連上。
2. **RingBuffer 丟棄最舊 chunk 會截斷 ANSI 狀態**（`src/ring-buffer.js:20`）
   註解自己也承認「最差情況是開頭幾百 bytes 不完整」。實務上被切掉的可能是 CSI/SGR 的開頭，
   replay 時 xterm 收到半截控制碼，後續整片顏色 / 游標定位錯亂。
   修法：dump 前用正則剝掉開頭不完整的 escape 序列，或在每次丟 chunk 後補一次 `\x1b[0m`。
3. **多 pane / 多 client 尺寸互打**（`public/app.js:713`、`src/daemon.js:620`）
   同一 session 開在兩個 pane 或「桌面 + iframe embed」時，兩邊 ResizeObserver 各送各的尺寸，
   PTY 在兩個值間反覆跳，cc 反覆重繪，畫面留下上一尺寸的殘行。
   修法：同一 session 只讓「主控 client」有 resize 權（訪客已擋，但本機多 pane 沒擋），
   或取所有 attach client 的最小 cols/rows。
4. **版面細節**：kabby 沒設 `lineHeight`，終端容器也沒 padding，
   FitAddon 算出的最後一欄容易被 scrollbar 蓋住；加 `lineHeight: 1.2~1.3` 與容器 8px padding
   可觀感上大幅改善。
5. 兩邊都沒載 `@xterm/addon-webgl`。DOM renderer 在 CJK 寬字元與 box-drawing 字元上會累積子像素漂移，
   載入 webgl addon 可一併解決。kabby 用 xterm 5.5，可考慮升到 6.x。
