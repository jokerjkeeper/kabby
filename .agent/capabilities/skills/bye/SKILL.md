---
name: bye
description: 結束 session：先執行 save 存檔進度，再告別。當用戶呼叫 /bye、說「今天先到這 / 收工 / 結束」時觸發。
version: 1.0.0
origin: agentpacks/dev-base
---

# /bye — 結束 Session

## 執行步驟

1. 依 `save` skill（`.agent/capabilities/skills/save/SKILL.md`）完整執行存檔。
2. 存檔完成後，提示用戶：
   - 快照已更新，下次可用 `resume` 接續
   - 有未 commit 的變更時列出來（`git status --short`），提醒換電腦前要 commit / push（含 `.agent/session.md` 與 session-log）
3. 告別，不再接受新的任務指令。
