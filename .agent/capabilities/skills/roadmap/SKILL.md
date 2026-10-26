---
name: roadmap
description: 維護 .agent/ROADMAP.md 專案里程碑與週誌（init / update / review），補 commit message 不足的語境與跨 session 決策。當用戶呼叫 /roadmap、說「整理里程碑 / 更新週誌 / 專案走到哪」時觸發。
version: 1.0.0
origin: agentpacks/dev-base
---

# /roadmap — 專案里程碑與週誌

> 維護 `.agent/ROADMAP.md`，提供**跨 session 的中長期視角**。
> Session.md 記錄「當前幾週做什麼」；ROADMAP.md 記錄「整個專案走到哪裡、下一階段往哪走」。
> 特別適合用來補「commit message 不足時的語境」（如 `u`、`update` 這類無資訊訊息）。

---

## 使用方式

| 用法 | 行為 |
|------|------|
| `/roadmap` | 自動判斷：檔案不存在 → init；存在且距上次更新 ≥ 7 天 → update；否則 → review |
| `/roadmap init` | 建立 `.agent/ROADMAP.md` 骨架 |
| `/roadmap update` | 從 git log 回補最新週誌條目 |
| `/roadmap review` | 只讀不寫，摘要當前階段、最近進度、下一個里程碑 |

---

## 執行步驟

### 前置檢查（所有模式）

1. 確認當前工作目錄是 git repo（`git rev-parse --is-inside-work-tree`）
2. 讀取（若存在）：
   - `AGENTS.md`（理解專案類型、技術棧與規範索引）
   - `.agent/session.md`（取得當前任務上下文）
   - `README.md`（取得專案描述與架構）
3. 若沒有上述任一檔案，先問用戶專案是否需要 ROADMAP（小型 / 實驗性 repo 可能不需要）

### 模式 A：`init`（建立骨架）

適用於：`.agent/ROADMAP.md` 不存在。

1. 用 `git log --pretty=format:"%h %ad %s" --date=short` 取完整 commit 歷史
2. 從 commit message、檔案變動、README 推斷**階段劃分**（Phase 0 ~ Phase N）：
   - Phase 0 通常是「骨架 / 原型」
   - 中間階段按主要功能里程碑切分（例：引入新模型、新增標注管線、重構架構）
   - 最後一個 Phase 標記為「進行中」或「待啟動」
3. 從最近 4-8 週的 commit 建立**倒序週誌**，每週條目包含：
   - 日期（以「Week of YYYY-MM-DD」為單位）
   - 完成項目（`git log --since` 取得）
   - **語境說明**：為什麼這週做這些事（從 commit message、`.agent/session.md` 或 `.agent/session-log/` 推斷，若無法推斷就留 TODO 給用戶補）
4. 寫入 `.agent/ROADMAP.md`，使用下方「文件格式」範本
5. 告知用戶：已 init，建議檢查並補上語境說明

### 模式 B：`update`（週誌更新）

適用於：檔案已存在。

1. 讀取現有 `.agent/ROADMAP.md`，找出最新週誌條目的日期
2. `git log --since="<該日期>"` 取得新增 commit
3. 將新 commit 歸入：
   - 若屬於當週（最新週誌條目的同一週） → 追加到現有條目
   - 若為新週 → 在倒序最上方插入新 `### Week of YYYY-MM-DD` 區塊
4. 若偵測到重要里程碑（例：新增主要目錄、引入新技術、大幅重構），建議推進 Phase 階段
5. 更新「下一個里程碑」區塊（若當前里程碑已完成）
6. 告知用戶：已補入 N 個 commit 到 M 個週誌條目

### 模式 C：`review`（只讀摘要）

適用於：用戶想快速了解專案狀態，不修改檔案。

1. 讀取 `.agent/ROADMAP.md`
2. 向用戶回報：
   - 當前所在 Phase 與階段名稱
   - 最近一週的完成項目
   - 下一個里程碑與預計時間
   - 未解決的風險 / 阻塞
3. 不寫入檔案

### 自動模式（`/roadmap` 無參數）

1. 檢查 `.agent/ROADMAP.md` 是否存在：
   - 不存在 → 走模式 A（init）
2. 若存在，用 `git log -1 --format=%cd --date=short -- .agent/ROADMAP.md` 取得該檔最後修改日
   - 距今 ≥ 7 天 → 走模式 B（update）
   - 距今 < 7 天 → 走模式 C（review）
3. 執行前告知用戶選擇的模式與原因

---

## 文件格式

```markdown
# ROADMAP — 專案里程碑與週誌

> Session.md 記錄短期狀態；ROADMAP.md 記錄中長期視角。

---

## 一、整體階段

\`\`\`
[Phase 0] 原型與骨架 ─────────────── 已完成（~YYYY-MM-DD）
    └─ 主要產出...

[Phase 1] <核心功能引入> ──────────── 已完成（~YYYY-MM-DD）
    └─ 主要產出...

[Phase N] <當前階段> ─────────────── 進行中
    └─ 主要產出...
\`\`\`

---

## 二、週誌（倒序）

### Week of YYYY-MM-DD（當前週）

- ✅ <完成項目 + commit hash>
- 🔄 <進行中>
- ⏭️ <下一步>

**語境**：<為什麼做這些；若無法推斷留 TODO>

### Week of YYYY-MM-DD

...

---

## 三、重要決策（跨 session）

| 日期 | 決策 | 語境 |
|------|------|------|
| | | |

---

## 四、下一個里程碑

**目標**：<一句話>

**內容**：
1. ...

**預計時間**：<N session / N 週>

**風險 / 已知阻塞**：
- ...
```

---

## 注意事項

- **檔案位置固定為 `.agent/ROADMAP.md`**，與 `.agent/session.md` 同在 `.agent/`；規範見 `.agent/spec/session.md`
- **不綁定領域詞彙**：命令邏輯通用，內容由實際專案的 git log / docs 推斷
- **語境優先**：commit message 是「做了什麼」，ROADMAP 應補「為什麼做」
- **Phase 劃分避免過細**：一個中等專案通常 3-5 個 Phase 就夠；太多會失去「中長期視角」的意義
- **風險提示**：若 git log 有大量無資訊 commit（如 `u`、`update`、`fix`），回報用戶並建議日後依 `.agent/spec/git.md`（若有）撰寫 commit message
- **init 後不要自動 commit**：留給用戶檢查、補語境後自行 commit
