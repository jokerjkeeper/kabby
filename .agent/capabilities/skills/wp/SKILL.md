---
name: wp
description: 統一操作 WePages / TaskHub 工單（列表、查詢、更新、完成、子清單、驗收勾選…），依參數自動判斷操作；本地走 curl + .claude/api.conf，Discord robot 走 MCP。當用戶呼叫 /wp 或要查詢 / 更新工單時觸發。
version: 1.0.1
origin: agentpacks/wp-skills
---

# WePages 工單管理

統一操作 WePages 工單系統的快捷指令。根據參數自動判斷操作類型。

## 執行環境與後端選擇（最先判斷，重要）

本 skill 有兩種執行後端，**執行任何操作前先判斷當前環境**：

- **Discord robot agent**：工具清單中有 `mcp__wepages-tasks__*` → 使用下方各操作標註的 MCP 工具。
- **本地 Claude Code session**：工具清單中**沒有** `mcp__wepages-tasks__*` → **改用 curl + REST API**。
  此時**絕對不要**回報「看不到工單系統 / MCP 沒連上 / 無法查詢」，也不要退回去翻 git——直接走 curl。

判斷依據：檢查當前是否有 `mcp__wepages-tasks__` 開頭的工具可用。

### curl 後端用法（本地 session）

先載入設定，再呼叫對應端點（完整端點對照見 `.agent/spec/wepages.md`）：

```bash
source .claude/api.conf   # 載入 WEPAGES_URL / WEPAGES_TOKEN / WEPAGES_TASK_ID
```

| 操作 | 對應 MCP 工具 | curl 端點 |
|------|--------------|-----------|
| 查工單 | `get_task` | `GET /api/task/get?id=<id>` |
| 列工單 | `list_tasks` | `GET /api/task/list?status=&q=&limit=` |
| 更新 | `update_task` | `POST /api/task/update`（id, status, progress, note, tags） |
| 完成 | — | `POST /api/task/complete`（id） |
| 新增備注 | `add_task_note` | `POST /api/task/update`（note 欄位，會自動追加） |
| 子清單查 | `get_checklist` | `GET /api/task/checklist/list?task_id=<id>` |
| 子清單勾選 | `toggle_checklist_item` | `POST /api/task/checklist/toggle/<id>` |
| 子清單新增 | `add_checklist_items` | `POST /api/task/checklist/add`（task_id, items[]） |
| 驗收（某task） | `get_acceptance` | `GET /api/task/acceptance/list?task_id=<id>`（TaskHub：`acceptance/get`） |
| 建驗收組 | `create_acceptance_group` | `POST /api/task/acceptance/group/create`（task_id, title, doc_path；TaskHub：`acceptance/group/add`） |
| 加驗收項 | `add_acceptance_items` | `POST /api/task/acceptance/item/add`（group_id, items[]） |
| 驗收項勾選 | `toggle_checklist_item` | `POST /api/task/checklist/toggle/<id>`（與子清單共用） |
| 待驗收總覽 | `list_pending_acceptance` | `GET /api/task/acceptance/pending` |

呼叫範例：
```bash
source .claude/api.conf
curl -s "$WEPAGES_URL/api/task/get?id=77" -H "Authorization: Bearer $WEPAGES_TOKEN"
```

> 前提：該專案的 `.claude/api.conf` 存在，且 `WEPAGES_URL` 指向的服務有在運行。
> 只有當 curl **也**連不上時，才回報無法連線（並指出可能是本地服務未啟動）。

---

## 參數格式

`/wp <操作> [工單ID] [附加內容]`

## 操作類型

### 1. 查詢工單：`/wp list` 或 `/wp #ID`

- `/wp list` — 列出所有進行中的工單（status: in_progress）
- `/wp list all` — 列出所有未完成工單（pending + in_progress + reviewing）
- `/wp list 關鍵字` — 搜尋工單
- `/wp #63` — 查看指定工單的詳細資訊與子清單

**執行：** 使用 `mcp__wepages-tasks__list_tasks` 或 `mcp__wepages-tasks__get_task`，呈現工單資訊。

---

### 2. 開始處理工單：`/wp start #ID`

- 將工單狀態更新為 `in_progress`
- 讀取工單詳情與子清單，摘要待辦事項
- 如有子清單，列出未完成項目

**執行：**
1. `mcp__wepages-tasks__get_task` 取得工單詳情
2. `mcp__wepages-tasks__update_task` 更新狀態為 `in_progress`
3. 向用戶摘要工單內容，確認開始工作

---

### 3. 更新為待驗收：`/wp review #ID`

- 將工單狀態更新為 `reviewing`
- 自動回顧本次 session 的工作內容，新增進度備注
- 列出子清單完成狀況

**執行：**
1. `mcp__wepages-tasks__get_task` 取得當前狀態
2. `mcp__wepages-tasks__add_task_note` 新增本次工作摘要備注
3. `mcp__wepages-tasks__update_task` 更新狀態為 `reviewing`
4. 向用戶確認已提交驗收

---

### 4. 更新為完成：`/wp done #ID`

- 將工單狀態更新為 `completed`，進度設為 100
- 新增完成備注（包含最終變更摘要）

**執行：**
1. `mcp__wepages-tasks__get_task` 取得當前狀態
2. `mcp__wepages-tasks__add_task_note` 新增完成摘要
3. `mcp__wepages-tasks__update_task` 更新狀態為 `completed`，進度 100
4. 向用戶確認工單已關閉

---

### 5. 新增備注：`/wp note #ID 備注內容`

- 將指定內容新增到工單的進度備注
- 如未提供備注內容，則自動回顧本次 session 對話，整理修正內容作為備注
- 可選附帶進度更新：`/wp note #63 修正完成 80`（最後的數字為進度百分比）

**執行：**
1. 解析備注內容與可選的進度數字
2. `mcp__wepages-tasks__add_task_note` 新增備注（如有進度數字則同時更新進度）
3. 向用戶確認備注已新增

---

### 6. 更新子清單：`/wp check #ID`

- 查看指定工單的子清單狀態
- `/wp check #ID #項目ID` — 勾選/取消勾選指定子清單項目
- `/wp check #ID all` — 根據本次 session 的工作內容，自動識別已完成的子清單項目並勾選
- `/wp check #ID add 項目1, 項目2` — 批次新增子清單項目

**執行：**
- 查看：`mcp__wepages-tasks__get_checklist`
- 勾選：`mcp__wepages-tasks__toggle_checklist_item`
- 新增：`mcp__wepages-tasks__add_checklist_items`
- 自動識別：回顧對話內容，比對子清單項目，批次勾選已完成的項目

---

### 7. 驗收清單：`/wp verify #ID` / `/wp pending`

驗收清單獨立於子清單（驗收項**不計入主進度**），結構為「驗收組 → 驗收項」，一個 task 可多組。

- `/wp verify #ID` — 查看該工單的所有驗收組與驗收項（含每組完成度與 `doc_path`）
- `/wp verify #ID check #項目ID` — 勾選/取消某驗收項
- `/wp pending` — 跨工單列出所有還有未勾項的待驗收組（綁定項目時自動只回本項目）

**建立**本階段驗收（寫文檔 + 建組 + 加項）請用獨立 skill **`/wp-verify`**，不要在這裡手動拼。

**執行：**
- 查看：`mcp__wepages-tasks__get_acceptance`（curl：`GET /api/task/acceptance/list?task_id=<id>`）（端點名稱兩種後端不同，**以 `.agent/spec/wepages.md` 為準**：WePages 用 `acceptance/list`、`acceptance/group/create`；TaskHub 用 `acceptance/get`、`acceptance/group/add`）
- 待驗收總覽：`mcp__wepages-tasks__list_pending_acceptance`（curl：`GET /api/task/acceptance/pending`）
- 勾選：`mcp__wepages-tasks__toggle_checklist_item`（驗收項與子清單共用此工具）

---

## 省略工單 ID 的行為

如果操作需要工單 ID 但未提供：
1. 先檢查本次 session 是否有正在處理的工單（從對話上下文推斷）
2. 如果有，自動使用該工單 ID
3. 如果沒有，列出所有進行中的工單讓用戶選擇

## 範例

```
/wp list              → 列出進行中工單
/wp #63               → 查看工單 #63 詳情
/wp start #63         → 開始處理工單 #63
/wp note #63          → 自動整理本次工作內容作為備注
/wp note #63 修正 DLC 模組 80  → 新增備注並更新進度到 80%
/wp check #63         → 查看子清單
/wp check #63 #44     → 勾選子清單項目 #44
/wp check #63 add 新增測試, 修正文件  → 新增子清單項目
/wp review #63        → 提交驗收
/wp verify #63        → 查看工單 #63 的驗收清單
/wp verify #63 check #88 → 勾選驗收項 #88
/wp pending           → 跨工單列出所有待驗收組
/wp done #63          → 標記完成
```

> 建立本階段驗收（寫 docs/valid 文檔 + 建驗收組 + 加驗收項）用 `/wp-verify`。
