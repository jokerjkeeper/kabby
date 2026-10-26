# WePages 工單系統 — API 參考

本目錄已綁定到 WePages 工單管理系統的一**批** task。可透過 REST API 操作。

## 綁定範圍

設定檔 `.claude/api.conf`：
- `WEPAGES_TOKEN` — API 認證 Token
- `WEPAGES_URL` — 服務地址
- `WEPAGES_TASK_IDS` — 本目錄綁定的 task id 清單（逗號分隔，**優先**）
- `WEPAGES_PROJECT_ID` — 兜底項目 ID（TASK_IDS 為空時使用）
- `WEPAGES_PROJECT_NAME` — 項目名稱註記

載入方式：`source .claude/api.conf`

## API 速查

所有 list 操作**必帶 `task_ids=$WEPAGES_TASK_IDS`**，否則會撈到別目錄處理的 task。

| 操作 | 範例 |
|------|------|
| 列出本目錄工單 | `curl "$WEPAGES_URL/api/task/list?task_ids=$WEPAGES_TASK_IDS&limit=100" -H "Authorization: Bearer $WEPAGES_TOKEN"` |
| 取單一工單 | `curl "$WEPAGES_URL/api/task/get?id=<task_id>" -H "Authorization: Bearer $WEPAGES_TOKEN"` |
| 建立工單 | `curl -X POST "$WEPAGES_URL/api/task/create" -H "Authorization: Bearer $WEPAGES_TOKEN" -H "Content-Type: application/json" -d '{"title":"...","project_id":'$WEPAGES_PROJECT_ID'}'` |
| 更新工單 | `curl -X POST "$WEPAGES_URL/api/task/update" -H "Authorization: Bearer $WEPAGES_TOKEN" -H "Content-Type: application/json" -d '{"id":<id>,"status":"in_progress","progress":50,"note":"..."}'` |
| 完成工單 | `curl -X POST "$WEPAGES_URL/api/task/complete" -H "Authorization: Bearer $WEPAGES_TOKEN" -H "Content-Type: application/json" -d '{"id":<id>}'` |
| 子清單列表 | `curl "$WEPAGES_URL/api/task/checklist/list?task_id=<id>" -H "Authorization: Bearer $WEPAGES_TOKEN"` |
| 子清單新增 | `curl -X POST "$WEPAGES_URL/api/task/checklist/add" -H "Authorization: Bearer $WEPAGES_TOKEN" -H "Content-Type: application/json" -d '{"task_id":<id>,"items":["..."]}'` |
| 子清單切換 | `curl -X POST "$WEPAGES_URL/api/task/checklist/toggle/<id>" -H "Authorization: Bearer $WEPAGES_TOKEN"` |
| 列出項目 | `curl "$WEPAGES_URL/api/task/projects" -H "Authorization: Bearer $WEPAGES_TOKEN"` |
| 取驗收清單 | `curl "$WEPAGES_URL/api/task/acceptance/list?task_id=<id>" -H "Authorization: Bearer $WEPAGES_TOKEN"` |
| 建驗收組 | `curl -X POST "$WEPAGES_URL/api/task/acceptance/group/create" -H "Authorization: Bearer $WEPAGES_TOKEN" -H "Content-Type: application/json" -d '{"task_id":<id>,"title":"<標題>","doc_path":"docs/valid/<id>-<slug>.md"}'` → 回 `group_id`（建立本階段驗收優先用 `wp-verify`） |
| 加驗收項 | `curl -X POST "$WEPAGES_URL/api/task/acceptance/item/add" -H "Authorization: Bearer $WEPAGES_TOKEN" -H "Content-Type: application/json" -d '{"group_id":<gid>,"items":["驗收點1","驗收點2"]}'` |
| 待驗收總覽 | `curl "$WEPAGES_URL/api/task/acceptance/pending" -H "Authorization: Bearer $WEPAGES_TOKEN"` |
| 勾選驗收項 | 沿用 `POST /api/task/checklist/toggle/<item_id>`（驗收項本質即 checklist row） |

## 任務欄位

- status: `pending` / `assigned` / `in_progress` / `waiting_feedback` / `reviewing` / `completed` / `cancelled`
- priority: `urgent` / `high` / `medium` / `low`
- task_type: `bug` / `feature` / `discuss` / `optimize` / `other`
- note: 新增備注時傳入，會自動追加到備注列表

## 關鍵注意事項

1. **list_tasks 必帶 `?task_ids=$WEPAGES_TASK_IDS`** — 否則會撈到別目錄的 task
2. **建立新 task 後執行 `/wp-attach #<id>`** 把新 task 加入綁定
3. **已 completed / archived 的 task 不必清理** — 後端 list 會自動 filter；要主動清理用 `/wp-cleanup`
4. 智能工單 `/auto-execute` 也透過 task_ids 過濾範圍，不會誤跑別目錄的 smart_ticket
5. 工單操作用 `wp-skills` pack 的 `wp`、`wp-verify` 等 skill；更新 / 完成工單的 id 一律放 JSON body（後端沒有 `/update/<id>` 路由）
6. 操作工單前先 `source .claude/api.conf` 載入環境變數
