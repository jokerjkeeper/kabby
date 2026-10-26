# Session 進度規範

> AgentPacks dev-base 規範。claude / codex / opencode 共用同一套檔案；
> 用戶在多台電腦（公司 / 家裡）之間切換，**三種檔案都進版控**，靠 git 同步。

## 一、三層檔案

| 檔案 | 內容 | 寫法 | 載入 |
|---|---|---|---|
| `.agent/session.md` | **現況快照**：狀態、當前任務、待辦、阻塞、近期決策 | 覆蓋，**≤ 100 行** | Claude Code 經 AGENTS.md 的 `@` 匯入自動載入；其他 agent session 開始時自行讀取 |
| `.agent/session-log/YYYY-MM.md` | 歷史：每次存檔前被取代的舊快照 | 只追加，不改舊內容 | 需要查歷史時才讀 |
| `.agent/ROADMAP.md` | 階段劃分、週誌、跨 session 重要決策 | `roadmap` skill 維護 | 需要時才讀 |

- `.agent/session-log/legacy-claude.md`、`legacy-codex.md`：從舊位置（`.claude/session.md`、`.codex/session.md`）搬來的原始紀錄，保留不改。
- 舊位置 `.claude/session.md`、`.codex/session.md`、`.claude/docs/ROADMAP.md` 停用，不得再寫入。

## 二、快照格式（`.agent/session.md`）

```markdown
# Session 進度
## 狀態: 進行中 | 已完成 | 阻塞
## 最後更新: YYYY-MM-DD HH:MM · <claude|codex|opencode> · <電腦名稱（選填）>
## 當前分支: <branch>

### 當前任務
- <正在做什麼、做到哪>

### 本次完成
- [x] <這次 session 完成的事；更早的已在 session-log>

### 待辦
- [ ] <下一步，依優先序>

### 近期決策（最多 5 筆，重要的另記 ROADMAP）
| 日期 | 決策 | 原因 |
|---|---|---|

### 已知問題 / 阻塞
- <問題> — <狀態>
```

## 三、長度上限：100 行

- 整份快照不超過 **100 行**。超過時先精簡再寫入：
  - 「本次完成」只留這次 session 的項目，合併瑣碎項。
  - 已完成的待辦移除；「近期決策」超過 5 筆時，較舊且仍重要的移到 ROADMAP「重要決策」。
  - 長篇說明、log、程式片段不放快照；需要保留就寫進 session-log 或 `docs/`。
- 快照是「下次接手要知道的事」，不是工作日誌。

## 四、存檔流程（`save` skill）

1. **重讀**目前的 `.agent/session.md`（可能剛被另一個 agent 或另一台電腦經 git 更新），新快照要承接其中仍有效的待辦與問題。
2. 若快照存在且內容有變，把**舊快照全文**追加到 `.agent/session-log/<當月 YYYY-MM>.md` 檔尾：
   ```markdown

   ---
   ## 快照 YYYY-MM-DD HH:MM · <agent>   ← 取舊快照的「最後更新」行

   <舊快照全文，標題層級原樣>
   ```
   月份檔不存在就建立，第一行寫 `# Session Log YYYY-MM`。
3. 覆蓋寫入新快照（≤ 100 行）。

## 五、多 agent / 多電腦

- 同一時間只有一份快照；任何 agent 寫入前都先重讀（見四之 1）。
- git 合併時 `.agent/session.md` 衝突：以兩邊的待辦與問題聯集重寫一份快照，兩邊原文都追加到 session-log。
- session-log 只追加，兩台電腦各自追加的內容合併時兩段都保留（依時間排序即可）。

## 六、首次遷移

`.agent/session.md` 不存在，但 `.agent/session-log/legacy-*.md` 存在時（dev-base 剛安裝）：

1. 每個 legacy 檔取**最新的一份快照**（舊格式是一再插在檔首的 `# Session 進度記錄` 區塊，通常第一個就是最新；以「最後更新」時間為準）。
2. 多個 legacy 檔（例 claude 與 codex 各自長了一段）→ 依時間合併：最新狀態為主，另一邊仍未完成的待辦與問題併入。
3. 依第二節格式寫出第一份快照（≤ 100 行），向用戶摘要合併了哪些來源。legacy 檔不修改。

## 七、Session-log 的增長

session-log 目前全部進版控、不自動刪除。日後過大再另訂歸檔或刪除機制（例：只保留近 N 個月）。
