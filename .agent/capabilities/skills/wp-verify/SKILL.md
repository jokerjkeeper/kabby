---
name: wp-verify
description: 建立本階段驗收：寫 docs/valid/<task-id>-<slug>.md 驗收文檔 + 在 WePages 建驗收組 + 加驗收項。當用戶呼叫 /wp-verify、說「建立驗收 / 交付驗收」時觸發。
version: 1.0.1
origin: agentpacks/wp-skills
---

# wp-verify — 建立本階段驗收（驗收文檔 + 驗收組 + 驗收清單）

當本項目某個**階段功能完成**、要交付驗收時用這個 skill。
它一次做完三件事：在本 repo 寫驗收文檔 → 在 WePages 建立一個「驗收組」→ 把驗收點逐條加進該組（未勾）。

之後驗收方（你或另一個 CC）用 `/wp pending` 看待驗收、`/wp verify #ID` 逐條勾選。

> 與 `/wp review` 的差異：`/wp review` 只是把工單狀態切到 `reviewing` 並加備注；
> `/wp-verify` 是真正建立**可勾選的驗收清單 + 驗收文檔**。兩者可搭配（先 verify 建清單，再 review 切狀態）。

## 參數格式

```
/wp-verify [#工單ID] [驗收組標題]
```

- 都可省略：ID 從上下文 / `WEPAGES_TASK_IDS` 推斷；標題可由本階段工作內容自動命名（如「階段二：權限控管」）。

## 執行環境（最先判斷）

同 `/wp`：

- 工具清單有 `mcp__wepages-tasks__*` → 用 MCP 工具。
- 沒有 → 用 **curl + REST API**（先 `source .claude/api.conf`）。絕不因「看不到 MCP」就放棄，直接走 curl。

## 執行流程

### Step 1：確定目標工單

1. 參數有 `#ID` → 用它。
2. 否則看本次 session 正在處理哪個工單。
3. 仍不確定 → `list_tasks`（curl：`GET /api/task/list?task_ids=$WEPAGES_TASK_IDS` 或 `?project_id=$WEPAGES_PROJECT_ID`）列出讓用戶選。

### Step 2：整理本階段驗收點

回顧本次 session 完成的工作，整理成**可獨立驗證**的驗收點清單。每點要能回答「怎麼驗、預期看到什麼」。
若用戶已口述驗收內容，以用戶為準；否則先列草稿給用戶確認再繼續。

決定**驗收組標題**（階段名，如「階段一：登入流程」）。

### Step 3：寫驗收文檔到本 repo

路徑：`docs/valid/<task-id>-<slug>.md`（slug 取自標題；目錄不存在就建）。

文檔內容每條驗收點包含：

```markdown
# 驗收：<標題>（task #<id>）

> 生成時間：<日期>　對應 WePages 驗收組：建立後回填 group id

## 1. <驗收點名稱>
- **步驟**：<怎麼操作>
- **預期**：<預期結果>
- **實際**：<驗收時填>　☐ 通過 / ☐ 不通過

## 2. ...
```

文檔內文是**過程記錄**，後續驗收只在 WePages 勾選、不改文檔（要留 git 歷史）。

### Step 4：在 WePages 建立驗收組

> 下方 curl 是 WePages 的寫法（端點名稱兩種後端不同，**以 `.agent/spec/wepages.md` 為準**：WePages 用 `acceptance/list`、`acceptance/group/create`；TaskHub 用 `acceptance/get`、`acceptance/group/add`）；`doc_path` 的目錄也依 spec（TaskHub 專案慣例為 `aispec/valid/`）。

- MCP：`create_acceptance_group(task_id, title, doc_path)` → 取得 `group_id`
- curl：
  ```bash
  source .claude/api.conf
  curl -s -X POST "$WEPAGES_URL/api/task/acceptance/group/create" \
    -H "Authorization: Bearer $WEPAGES_TOKEN" -H "Content-Type: application/json" \
    -d '{"task_id":<id>,"title":"<標題>","doc_path":"docs/valid/<id>-<slug>.md"}'
  ```
  從回傳取 `group_id`。

### Step 5：加入驗收項

- MCP：`add_acceptance_items(group_id, ["驗收點1","驗收點2", ...])`
- curl：
  ```bash
  curl -s -X POST "$WEPAGES_URL/api/task/acceptance/item/add" \
    -H "Authorization: Bearer $WEPAGES_TOKEN" -H "Content-Type: application/json" \
    -d '{"group_id":<gid>,"items":["驗收點1","驗收點2"]}'
  ```

驗收項標題用**簡短一句**（細節留在文檔）；項目順序對應文檔編號。

### Step 6：（可選）切換工單狀態到 reviewing

若本階段確實交付待驗收，提醒用戶可順手 `/wp review #<id>`（本 skill 不自動切，避免誤改狀態）。

### Step 7：輸出摘要

```
已建立驗收
  工單：#<id> <title>
  驗收組：#<group_id>「<標題>」
  驗收文檔：docs/valid/<id>-<slug>.md
  驗收項：N 條（皆未勾）

驗收方查看：/wp verify #<id>　｜　跨工單待驗收：/wp pending
```

## 注意事項

- **一階段一組**：同一工單不同階段各建一組驗收，不要把新階段的驗收點塞進舊組。
- **驗收項不計入主進度**：勾不勾驗收項都不影響工單 progress（progress 只看一般子清單）。
- `doc_path` 用**相對 repo 根**的路徑（如 `docs/valid/44-login.md`），不要寫絕對路徑。
- 端點細節與欄位見 `.agent/spec/wepages.md` 的「驗收清單」章節。
- 前提：本目錄已用 launcher「Agent 套件」安裝 wepages 或 taskhub pack 綁定，且 `.claude/api.conf` 存在、服務有運行。
