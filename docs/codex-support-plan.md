# Codex Support Plan

這份計劃對應 branch `codex/provider-abstraction`。

## 這一輪已落地

目標是先把 kabby 從「Claude-only」拉成「provider-aware」。目前已完成：

- `Session` 新增 `provider`
- `Session` 預設啟動命令改由 provider 決定
  - `claude` → `claude.cmd` / `claude`
  - `codex` → `codex.cmd` / `codex`
- `Profile` schema 新增 `provider`，舊資料自動視為 `claude`
- `/api/sessions` 與 `/api/profiles` 可接受 `provider`
- Web UI 建臨時 session / 建 profile 時可選 provider
- provider 抽象檔：`src/providers.js`
- Claude history / resume 保留原功能，但明確只在 `provider=claude` 啟用

## 目前刻意沒做的

這一輪先不承諾 Codex 與 Claude 完全 parity。以下能力仍是 Claude-only：

- `profile history`
- `history-dir`
- `--resume <id>` history resume
- `~/.claude/projects` watcher
- token / cost / sensitive monitoring
- viewer 整合

## 後續分期

### Phase A — Provider 骨架穩定化

目標：把抽象層整理乾淨，避免之後越補越亂。

建議項目：

- session/profile list UI 顯示 provider badge
- profile 卡片依 provider 顯示/隱藏 history 相關動作
- API docs / README 全面改成 provider-aware
- `ccSessionId` 舊欄位逐步退場，改用通用 `resumeSessionId`
- 把 Claude 專屬字樣（`cc`）改成 provider-neutral 命名

### Phase B — Codex History Feasibility

目標：確認 Codex 本地是否有可依賴的 session history source of truth。

需要回答：

- Codex session 歷史落在哪裡？
- 是否有 project/cwd 對應關係？
- 是否有穩定 session id？
- 是否支援 CLI resume？若支援，參數是什麼？
- 是否有結構化 usage / model / request metadata？

若這些答案成立，才值得做真正的 Codex history adapter。

### Phase C — Codex Resume / Busy Detection

前提：Phase B 找到可靠的 session id 與 resume 模式。

建議項目：

- `src/providers/codex-history.js` 或等價 adapter
- `GET /api/profiles/:id/history` 對 `provider=codex` 生效
- `POST /api/profiles/:id/launch` 支援 Codex resume
- registry 佔用偵測改為完全 provider-generic

### Phase D — Codex Monitoring

前提：Codex 有可解析的本地結構化資料源；否則不建議硬做。

可能方向：

- 若有本地 json/jsonl 歷史 → 仿 Claude collector/watcher
- 若沒有結構化歷史，只剩 PTY output → 不建議照搬現有監控，訊噪比會很差
- 成本分析也必須先有 model/usage metadata，否則只能做很粗的近似估算

## 建議的程式結構演進

目前這輪先用 `src/providers.js` 集中 provider metadata。若要繼續做深，建議拆成：

- `src/providers/index.js`
- `src/providers/claude.js`
- `src/providers/codex.js`
- `src/providers/claude-history.js`
- `src/providers/codex-history.js`

讓每個 provider 各自定義：

- default command / args
- resume arg builder / parser
- history support
- viewer support
- monitoring support

## Review 重點

你 review 這個 branch 時，可以先看這幾件事：

1. provider schema 放在 profile/session 這層，是否符合你要的抽象邊界
2. Codex 預設命令用 `codex.cmd` / `codex` 是否符合你的使用方式
3. Claude-only 能力先保留、不硬抽成假通用，這個節奏是否合理
4. 下一階段要先做 UI polish，還是直接先去探 Codex history source
