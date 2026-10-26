---
name: wp-attach
description: 把一個或多個 task id 追加到 .claude/api.conf 的 WEPAGES_TASK_IDS 白名單（wepages task 綁定）。當用戶呼叫 /wp-attach #id 時觸發。
version: 1.0.0
origin: agentpacks/wp-skills
---

# wp-attach — 把 task id 加入當前目錄的綁定

把一個或多個 task id 追加到當前目錄 `.claude/api.conf` 的 `WEPAGES_TASK_IDS` 白名單。
避免你手動編輯 conf 檔。

## 使用方式

```
/wp-attach #145                    → 追加單個
/wp-attach #145,146,147            → 一次追加多個（逗號分隔）
/wp-attach #145 146 147            → 空格分隔也接受
```

## 執行流程

### Step 1：驗證前置條件

- 確認 `.claude/api.conf` 存在；不存在則提示用戶先用 launcher「Agent 套件」安裝 wepages pack（task 綁定）
- 讀取 `WEPAGES_TOKEN` / `WEPAGES_URL`

### Step 2：解析參數

從用戶輸入解析出 task id 列表（支援 `#`、逗號、空格混用）：
- `#145,146,#147` → `[145, 146, 147]`
- `145 146 147` → `[145, 146, 147]`

### Step 3：驗證每個 task id 存在

```bash
source .claude/api.conf
for id in $NEW_IDS; do
  curl -s "$WEPAGES_URL/api/task/get?id=$id" -H "Authorization: Bearer $WEPAGES_TOKEN"
done
```

- 任一 task 不存在 / 無權訪問 → 警告，問用戶要不要跳過該 id 繼續

### Step 4：合併 task_ids，去重，寫回 api.conf

```bash
# 當前 conf 內的 IDs
OLD_IDS=$(grep '^WEPAGES_TASK_IDS=' .claude/api.conf | cut -d= -f2)

# 合併 + 去重（保持原順序，新 id 加在末尾）
# 寫回 .claude/api.conf 那一行（用 sed in-place 或重新生成）
```

實作建議：用 Python 一次處理（避免 sed 跨平台問題）：

```python
import re
from pathlib import Path

conf = Path('.claude/api.conf')
lines = conf.read_text(encoding='utf-8').splitlines()

old_ids = []
for i, line in enumerate(lines):
    if line.startswith('WEPAGES_TASK_IDS='):
        old_ids = [x.strip() for x in line.split('=', 1)[1].split(',') if x.strip()]
        idx = i
        break
else:
    # 不存在則 append
    idx = len(lines)
    lines.append('WEPAGES_TASK_IDS=')

new_ids = [str(x) for x in NEW_IDS]  # 從用戶輸入解析來的
seen = set(old_ids)
merged = list(old_ids)
added = []
for nid in new_ids:
    if nid not in seen:
        merged.append(nid)
        added.append(nid)
        seen.add(nid)

lines[idx] = 'WEPAGES_TASK_IDS=' + ','.join(merged)
conf.write_text('\n'.join(lines) + '\n', encoding='utf-8')

print(f'已加入：{added}')
print(f'已存在跳過：{[x for x in new_ids if x not in added]}')
print(f'當前共綁定 {len(merged)} 筆 task')
```

### Step 5：輸出摘要

```
已加入綁定：#145 (任務標題A), #146 (任務標題B)
已存在跳過：#147
當前共綁定 5 筆 task

提醒：請在新 cc session 中再次 source api.conf 載入新配置
```

## 注意事項

- 已存在的 task id 自動去重，不會重複加入
- 順序保留：舊 id 在前、新 id 在後（不重排）
- 命令僅修改本地 conf，**不會在 wepages 後端做任何動作**（task 本身不會被「綁定」到目錄；只是 cc 端記得它）
- 對應的「移除」操作請用 `/wp-cleanup`（清掃已完成 task）或手動編輯 conf
