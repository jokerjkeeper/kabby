---
name: wp-cleanup
description: 清理 .claude/api.conf 綁定中已 completed / cancelled / archived 的 task id。當用戶呼叫 /wp-cleanup 時觸發。
version: 1.0.0
origin: agentpacks/wp-skills
---

# wp-cleanup — 清理當前目錄綁定中已結束的 task

掃描 `.claude/api.conf` 中 `WEPAGES_TASK_IDS` 的每個 task id，
查詢 wepages 後端狀態，把已 `completed` / `cancelled` / `is_archived` 的 task 從綁定中移除。

## 為什麼需要這個

通常**不需要**清理 — 後端 list_tasks 已會自動 filter 掉這些 task，所以即使 conf 裡留著也不影響使用。

要跑 cleanup 的場景：
- conf 累積太多歷史 task（如 100+），主觀想整理乾淨
- 想看一份只含 active task 的乾淨清單

## 使用方式

```
/wp-cleanup            → 互動式：列出會移除哪些 task，要求確認後才寫回
/wp-cleanup --dry      → 只顯示會移除的清單，不真寫
/wp-cleanup --yes      → 直接清，不問確認（適合腳本場景）
```

## 執行流程

### Step 1：驗證前置

- 確認 `.claude/api.conf` 存在
- source 取得 `WEPAGES_TOKEN` / `WEPAGES_URL` / `WEPAGES_TASK_IDS`
- 若 TASK_IDS 為空 → 直接輸出「無 task 可清理」並結束

### Step 2：逐一查 task 狀態

```bash
source .claude/api.conf
IFS=',' read -ra IDS <<< "$WEPAGES_TASK_IDS"
for id in "${IDS[@]}"; do
  curl -s "$WEPAGES_URL/api/task/get?id=$id" -H "Authorization: Bearer $WEPAGES_TOKEN"
done
```

或一次 list 批量查：

```bash
curl -s "$WEPAGES_URL/api/task/list?task_ids=$WEPAGES_TASK_IDS&limit=200" \
  -H "Authorization: Bearer $WEPAGES_TOKEN"
```

### Step 3：分類

對每個 task 判斷：
- `status` in (`completed`, `cancelled`) → 移除
- `is_archived` = true → 移除
- 查不到 task（404）→ 移除（task 已刪）
- 其他 → 保留

### Step 4：顯示變更預覽

```
即將移除（共 7 筆）：
  #68   遊戲數據表格分析/驗收功能            (completed)
  #71   給蘇州一個盈利項目                  (completed)
  #115  製作demo版本功能                    (archived)
  #83   性能問題                            (cancelled)
  ...

保留（共 4 筆）：
  #131  自動化開發工程系統                  (in_progress)
  #130  修改自動回報功能                    (waiting_feedback)
  #145  ...                                 (pending)
  #146  ...                                 (in_progress)
```

`--dry` 模式到這裡就停。

### Step 5：確認 + 寫回（除非 --yes）

詢問：「確認移除這 7 筆？(y/N)」 → 是才寫回 api.conf。

寫回邏輯（建議用 Python，跨平台）：

```python
from pathlib import Path

KEEP_IDS = [...]  # 保留的 id 列表（字串）
conf = Path('.claude/api.conf')
lines = conf.read_text(encoding='utf-8').splitlines()

for i, line in enumerate(lines):
    if line.startswith('WEPAGES_TASK_IDS='):
        lines[i] = 'WEPAGES_TASK_IDS=' + ','.join(KEEP_IDS)
        break

conf.write_text('\n'.join(lines) + '\n', encoding='utf-8')
```

### Step 6：輸出摘要

```
清理完成
  原本：11 筆 task
  移除：7 筆（completed/cancelled/archived）
  保留：4 筆

提醒：請在新 cc session 中再次 source api.conf 載入新配置
```

## 注意事項

- 這個命令**只動本地 conf**，不會在 wepages 後端做任何動作
- 移除 = 「不再列入綁定」，task 本身在 wepages 上仍存在
- 想加回某個 task：`/wp-attach #<id>`
- 想看「不執行的話現在會有多少要清」：先跑 `/wp-cleanup --dry`
