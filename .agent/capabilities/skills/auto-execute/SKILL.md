---
name: auto-execute
description: 自動執行 WePages 智能工單（Smart Tickets）：掃描 pending 工單、執行並把結果或討論問題寫回工單（透過 wepages MCP）。當用戶呼叫 /auto-execute 時觸發。
version: 1.0.0
origin: agentpacks/wp-skills
---

# WePages 智能工單自動執行器

掃描 WePages 智能工單中 `status=pending`（等待執行）的工單，自動執行並將結果或討論問題寫回工單。

> **跨項目使用方式**：在目標項目的根目錄執行 Claude Code，呼叫 `bind_project` 綁定該項目後再執行 `/auto-execute`。所有 smart_ticket 操作會自動限定在綁定項目範圍內。

---

## 概念

| 項目 | 說明 |
|------|------|
| 來源任務 (Task) | WePages 工單，儲存於 `tasks` 表 |
| 智能工單 (Smart Ticket) | 由任務派發而來，獨立的執行載體，儲存於 `smart_tickets` 表 |
| 對話記錄 (Messages) | smart_ticket 的 `role=claude`/`user` 訊息流 |

### 策略 (strategy)

| 策略 | 行為 | 執行方式 |
|------|------|----------|
| `plan` | 先擬定執行計劃，等用戶確認後才實際執行 | 主 session 串行 |
| `agent` | 直接執行，僅在遇到不確定時才停下提問 | 主 session 串行 |
| `review` | 針對既有結果做審核，輸出意見而不修改代碼 | subagent 並行（不改文件，無衝突風險） |

### 並行原則

- **plan / agent 工單永遠串行**：同一時間只處理一筆 coding 工單，避免同一項目文件被多個 agent 同時修改造成衝突
- **review 工單可並行**：review 只讀不寫，可以 spawn subagent 與主 session 同步執行
- coding 工單完成後若有對應 review 工單待執行，自動 spawn subagent 審核

### 狀態流轉 (status)

```
pending（等待執行）
  → planning（擬定計劃中，僅 plan 策略）
    → waiting_feedback（等待用戶確認計劃）
      → executing（執行中）
        → done（已完成）
        → failed（執行失敗）
      ↘ waiting_feedback（執行中遇到問題又需要反饋）
```

---

## 執行流程

### Step 0：確認綁定項目

若 session 尚未綁定項目，先綁定（避免操作到其他項目的工單）：

```
mcp__wepages-tasks__list_projects()
mcp__wepages-tasks__bind_project(project="<當前項目名>")
```

> 若用戶在非項目目錄執行（如直接在 wepages 目錄調試），可跳過綁定，但 list_smart_tickets 會列出全部 pending 工單需要自行挑選。

---

### Step 1：掃描待執行工單

先掃描 coding 工單（plan/agent），再掃描 review 工單：

```python
# 1-A. 掃描 coding 工單（串行，limit=1）
coding_ticket = mcp__wepages-tasks__list_smart_tickets(
    status="pending", strategy_exclude="review", limit=1
)

# 1-B. 掃描 review 工單（可並行，limit=5）
review_tickets = mcp__wepages-tasks__list_smart_tickets(
    status="pending", strategy="review", limit=5
)
```

- 若兩者都沒有 → 輸出「目前沒有待執行的智能工單」並結束
- coding 工單優先執行（主 session），完成後才掃描下一筆
- review 工單在 coding 執行完後（或無 coding 工單時）spawn subagent 並行執行

---

### Step 2：鎖定工單、讀取完整 context

依工單策略決定 lock status：

```
# plan 策略：先進入 planning，避免被重複認領
mcp__wepages-tasks__update_smart_ticket(ticket_id=X, status="planning")

# agent 策略：直接 executing
mcp__wepages-tasks__update_smart_ticket(ticket_id=X, status="executing")

# review 策略：直接 executing（subagent 內執行）
mcp__wepages-tasks__update_smart_ticket(ticket_id=X, status="executing")
```

讀取完整 context：

```
mcp__wepages-tasks__get_smart_ticket(ticket_id=X)
mcp__wepages-tasks__get_smart_ticket_messages(ticket_id=X)
mcp__wepages-tasks__get_checklist(task_id=<工單對應 task_id>)
```

context 包含：
- `task_description`：原始需求
- `plan_content`：先前擬定的計劃（若有）
- `current_question`：上次提出的待回覆問題（若有）
- `user_feedback`：用戶最新回覆（若有）
- `execution_log`：累積的執行記錄
- messages：完整對話歷程（含 `[已派發]` 與所有 `[🤖]` `[👤]` 訊息）

---

### Step 3：寫入開工訊息

```
mcp__wepages-tasks__add_smart_ticket_message(
  ticket_id=X,
  content="[🤖 開始執行] 已讀取 N 則歷史訊息，從上次停點繼續。"
)
```

---

### Step 4：依策略執行

#### 4-A. Strategy = `plan`（先擬計劃）—— 主 session

1. 若 `plan_content` 為空 → 擬定計劃，寫入 `plan_content`，提出確認問題
   ```
   mcp__wepages-tasks__update_smart_ticket(
     ticket_id=X,
     plan_content="<詳細的執行步驟列表>",
     current_question="計劃如上，是否確認執行？有需要調整的地方請反饋。",
     status="waiting_feedback"
   )
   mcp__wepages-tasks__add_smart_ticket_message(
     ticket_id=X,
     content="[🤖 已擬定計劃] 等待用戶確認。"
   )
   ```
   → **結束本次執行**，等下次 loop 觸發

2. 若 `plan_content` 已存在且有 `user_feedback`（用戶已回覆）：
   - 用戶回覆同意 → 進入 4-B（agent 模式實際執行）
   - 用戶回覆要求調整 → 修改 `plan_content`，再次 `waiting_feedback`

#### 4-B. Strategy = `agent`（直接執行）—— 主 session

直接在主 session 內執行實際工作（讀文件、改代碼、跑指令）。
所有操作都在主 session context 中進行，執行歷程同步寫回 DB。

執行中若遇到需要決策的情況，停下並輸出問題（見 Step 5-A）。

#### 4-C. Strategy = `review`（審核既有結果）—— subagent 並行

spawn 獨立 subagent 執行審核，不佔用主 session：

```
subagent prompt：
你是一位資深 code reviewer，針對工單成果做審核（不修改代碼）。

【工單資訊】
- ST#{ticket_id} | 對應任務 #{task_id}
- 需求說明: {task_description}

【執行記錄】
{execution_log}

【對話歷程】
{messages 摘要}

【任務要求】
- 列出 ✅ 良好實踐、⚠️ 改進建議、❌ 嚴重問題
- 不修改任何文件
- 完成後透過 MCP 呼叫 update_smart_ticket 寫回審核結果，status="done"
- 若發現嚴重問題需要用戶決策，status="waiting_feedback"
```

---

### Step 5：依執行結果寫回

#### 5-A. 需要用戶反饋（執行中遇到不確定）

```
mcp__wepages-tasks__update_smart_ticket(
  ticket_id=X,
  current_question="<問題清單>",
  status="waiting_feedback",
  execution_log="<舊 log>\n\n[<時間戳>] 已完成：<步驟摘要>"
)
mcp__wepages-tasks__add_smart_ticket_message(
  ticket_id=X,
  content="[🤖 需確認]\n<問題清單>\n\n[🤖 已完成步驟]\n<摘要>"
)
```

輸出提示：「ST#{id} 已暫停，等待用戶在 WebUI 提交反饋。」

#### 5-B. 執行完成

```
mcp__wepages-tasks__add_smart_ticket_message(
  ticket_id=X,
  content="[🤖 執行完成]\n<完成摘要>\n\n變更清單：\n<文件變更或操作記錄>"
)
mcp__wepages-tasks__update_smart_ticket(
  ticket_id=X,
  status="done",
  current_question="",
  execution_log="<舊 log>\n\n[<時間戳>] 執行完成"
)

# 同步更新來源任務狀態
mcp__wepages-tasks__update_task(task_id=<task_id>, status="reviewing", progress=100)
```

coding 工單完成後，檢查是否有對應的 review 工單待執行：
```
review_pending = mcp__wepages-tasks__list_smart_tickets(
    status="pending", strategy="review", task_id=<task_id>
)
# 若有 → 自動 spawn subagent 執行 review（見 4-C）
```

#### 5-C. 執行失敗

```
mcp__wepages-tasks__add_smart_ticket_message(
  ticket_id=X,
  content="[🤖 執行失敗]\n<錯誤摘要與原因>"
)
mcp__wepages-tasks__update_smart_ticket(
  ticket_id=X,
  status="failed",
  current_question="<請求用戶介入的說明>",
  execution_log="<舊 log>\n\n[<時間戳>] 失敗：<錯誤摘要>"
)
```

---

## 搭配 /loop 使用

```
/loop 10m /auto-execute
```

每 10 分鐘自動掃描一次。沒有 pending 工單時靜默等待。

**執行順序保證：**
1. 同一 loop 週期內，coding 工單（plan/agent）最多執行 1 筆
2. review 工單可以在 coding 完成後或無 coding 工單時並行 spawn
3. 下一筆 coding 工單在當前 coding 工單到達終態（done/waiting_feedback/failed）後才被認領

---

## 用戶操作流程

1. **建立任務**：在 WePages WebUI 建立工單，填寫需求
2. **派發為智能工單**：在 task detail 點「派發到智能工單」，選擇策略（plan / agent / review）
3. **切到目標項目目錄**：cd 到該任務對應的代碼項目根目錄
4. **啟動 Claude Code**：在該目錄執行 claude，並 `bind_project("<項目名>")`
5. **啟動 loop**：`/loop 10m /auto-execute`
6. **等待執行**：Claude 自動讀取 pending 工單並執行
7. **若收到問題反饋**：到 smart_ticket detail 頁面提交反饋
8. **重新觸發**：在 WebUI 點「派送執行（保留反饋）」，loop 下次觸發會繼續

---

## ⚠️ update_smart_ticket 注意事項

### input 過長截斷問題

`update_smart_ticket` 每次呼叫的 JSON input 有長度上限。若同時傳入多個大欄位（`execution_log` + `plan_content` + `current_question`），總長度超限時 Claude Code harness 會在送達 MCP server 前就攔截，導致空參數錯誤並反覆重試。

**原則：每次 update 只傳必要欄位，不要一次塞全部。**

```python
# ✅ 正確：拆開分次更新
mcp__wepages-tasks__update_smart_ticket(ticket_id=X, status="done")
mcp__wepages-tasks__update_smart_ticket(ticket_id=X, execution_log="<本次新增的片段>")

# ❌ 錯誤：一次傳入所有大欄位（容易超長截斷）
mcp__wepages-tasks__update_smart_ticket(
    ticket_id=X,
    status="done",
    execution_log="<數千字的完整 log>",
    plan_content="<完整計劃>",
    current_question="<問題>"
)
```

**execution_log 寫法：**
- 每次只傳本輪新增的片段，server 端會自動累加
- 不要在 client 端把舊 log 拼接後整段傳入

**錯誤排查順序：**
1. 先嘗試最小參數：`update_smart_ticket(ticket_id=X, status="done")`
2. 若最小參數仍失敗 → MCP server 本身問題，查 server log
3. 若最小參數成功 → 確認是 input 過長，拆欄位分次傳

---

## 關鍵 MCP 工具速查

| 工具 | 用途 |
|------|------|
| `bind_project` | 綁定當前項目，限定 smart_ticket 操作範圍 |
| `list_smart_tickets(status, strategy, limit)` | 掃描待執行工單 |
| `get_smart_ticket(ticket_id)` | 讀取單一工單完整資訊 |
| `get_smart_ticket_messages(ticket_id)` | 讀取對話歷史 |
| `add_smart_ticket_message(ticket_id, content)` | 寫入 Claude 訊息（role=claude） |
| `update_smart_ticket(ticket_id, ...)` | 更新狀態 / 計劃 / 待回覆問題 / 執行記錄 |
| `dispatch_smart_ticket(task_id, strategy)` | 從 task 派發新的 smart_ticket（一般由 UI 觸發，MCP 備用） |

---

## 後期擴充預留

- plan → agent → review 流水線：plan 確認後自動進入 agent 執行，完成後自動派發 review 工單
- 自動化測試 hook：5-B 完成後自動跑專案測試套件，失敗則轉 5-C
- 子清單同步：執行過程中更新 `task_checklist` 完成狀態
