# AGENTS.md — kabby 指令索引

> 跨工具指令檔。codex / opencode 原生讀本檔；Claude Code 經 `CLAUDE.md` 的 `@AGENTS.md` 匯入。
> 本檔只做索引，不重複規範內容；下方 `agentpacks:index` 區塊由 Agent 套件自動維護，勿手改。

## 回應語言

- AI 一律以**繁體中文**回覆。

## 目錄約定

| 位置 | 用途 |
|---|---|
| `.agent/spec/` | 規範本體（單一真相來源）。新增規範：在這裡加檔，再到下方「專案自訂規範」加一列 |
| `.agent/capabilities/skills/<name>/` | 共用 skill 本體（SKILL.md、腳本、references 只在這裡改） |
| `.claude/skills/`、`.agents/skills/`、`.opencode/skills/` | 自動產生的 skill 入口，勿手改（注意：Codex 用的是複數 `.agents/`，與 `.agent/` 不同） |
| `.agent/agent-env.json` | 本專案啟用哪些 agent |
| `.agent/agent-packs.lock.json` | Agent 套件安裝紀錄 |

## 專案自訂規範

不屬於 Agent 套件、由本專案自己維護的規範列在這裡（需要每次 session 載入的，另在表下加一行 `@.agent/spec/<檔名>`，供 Claude Code 匯入）。

| 規範 | 檔案 | 載入 | 什麼時候要讀 |
|---|---|---|---|

<!-- agentpacks:index:start -->
## AgentPacks 索引（自動產生，勿手改本區塊）

### 規範索引（.agent/spec/）

| 規範 | 檔案 | 載入 | 什麼時候要讀 |
|---|---|---|---|
| 專案目錄約定（非程式目錄） | `.agent/spec/layout.md` | 自動 | 新增頂層目錄、放文件 / 設計稿 / 暫存檔，或判斷哪裡是程式碼時 |
| 通用開發規則 | `.agent/spec/coding.md` | 自動 | 寫程式、搜尋檔案、串接 API、執行任務時 |
| Session 進度規範（快照 / 歷史 / ROADMAP） | `.agent/spec/session.md` | 按需 | 寫入或整理 .agent/session.md、session-log、ROADMAP 時（save / resume / roadmap skill 會讀） |
| WePages / TaskHub 工單 API | `.agent/spec/wepages.md` | 按需 | 查詢、建立、更新工單或驗收清單時 |

### 自動載入（Claude Code）

Claude Code 會展開下列匯入行；codex / opencode 不展開，請依上表直接開檔閱讀。

@.agent/spec/layout.md
@.agent/spec/coding.md

### 共用 Agent Skills

- **canonical**：`.agent/capabilities/skills/<name>/`；SKILL.md、腳本與 references 只在這裡維護。
- **入口（自動產生，勿手改）**：`.claude/skills/`、`.agents/skills/`。
- **同步**：修改 canonical 後執行 `python .agent/scripts/sync_agent_skills.py`；`--check` 驗證入口沒有漂移。

| skill | 套件 | 用途 |
|---|---|---|
| `save` | dev-base | 存檔 session 進度：舊快照追加到 .agent/session-log/YYYY-MM.md，再覆蓋寫入新的 .agent/session.md（≤10… |
| `resume` | dev-base | 恢復上次的工作狀態：讀 .agent/session.md 摘要進度並確認待辦；快照不存在但有舊紀錄（session-log/legacy-*.md）時，先合併… |
| `bye` | dev-base | 結束 session：先執行 save 存檔進度，再告別。當用戶呼叫 /bye、說「今天先到這 / 收工 / 結束」時觸發。 |
| `task` | dev-base | 把目前專案進度整理成 agent 的任務清單（task / todo 工具），標示狀態與依賴。當用戶呼叫 /task、說「列出任務 / 建立任務清單 / 追蹤進… |
| `roadmap` | dev-base | 維護 .agent/ROADMAP.md 專案里程碑與週誌（init / update / review），補 commit message 不足的語境與跨 s… |
| `report` | dev-base | 產生專案狀態報告：git 狀態、專案結構、session 進度、TODO / FIXME 與改進建議。當用戶呼叫 /report、說「專案狀態報告 / 目前專案… |
| `conv` | dev-base | 對話歸檔與載入：檔案不存在時把本次討論整理存到 .agent/conv/conv_<主題>.md，存在時載入並接續討論。當用戶呼叫 /conv <主題>、說「把… |
| `readme` | dev-base | 生成或更新專案 README.md：技術棧、安裝步驟、啟動方式、環境變數、目錄結構、常用命令，保留手寫章節。當用戶呼叫 /readme、說「更新 README … |
| `review` | dev-base | 對最近修改的檔案做 code review：安全、程式品質、最佳實踐，依嚴重等級列出問題與修復建議。當用戶呼叫 /review、說「review 一下 / 幫我… |
| `wp` | wp-skills | 統一操作 WePages / TaskHub 工單（列表、查詢、更新、完成、子清單、驗收勾選…），依參數自動判斷操作；本地走 curl + .claude/ap… |
| `wp-verify` | wp-skills | 建立本階段驗收：寫 docs/valid/<task-id>-<slug>.md 驗收文檔 + 在 WePages 建驗收組 + 加驗收項。當用戶呼叫 /wp-… |
| `wp-attach` | wp-skills | 把一個或多個 task id 追加到 .claude/api.conf 的 WEPAGES_TASK_IDS 白名單（wepages task 綁定）。當用戶呼… |
| `wp-cleanup` | wp-skills | 清理 .claude/api.conf 綁定中已 completed / cancelled / archived 的 task id。當用戶呼叫 /wp-cl… |
| `auto-execute` | wp-skills | 自動執行 WePages 智能工單（Smart Tickets）：掃描 pending 工單、執行並把結果或討論問題寫回工單（透過 wepages MCP）。當… |
<!-- agentpacks:index:end -->

<!-- agentpacks:dev-base:start -->
## Session 進度（AgentPacks / dev-base）

- **Session 開始**：先讀 `.agent/session.md`（現況快照），摘要進度並確認待辦；與目前 git 分支不一致時提醒用戶。
- **Session 結束或用戶要求存檔**：用 `save` skill 覆蓋更新快照（舊快照先追加到 `.agent/session-log/YYYY-MM.md`），快照**不超過 100 行**。
- `.agent/session.md` 不存在、但 `.agent/session-log/legacy-*.md` 存在時：用 `resume` skill 從舊紀錄合併出第一份快照。
- 中長期階段與跨 session 決策寫 `.agent/ROADMAP.md`（`roadmap` skill）。完整規範見 `.agent/spec/session.md`。
- 舊位置 `.claude/session.md`、`.codex/session.md`、`.claude/docs/ROADMAP.md` 已停用，**不要再寫入**。

@.agent/session.md
<!-- agentpacks:dev-base:end -->
