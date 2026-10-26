---
name: resume
description: 恢復上次的工作狀態：讀 .agent/session.md 摘要進度並確認待辦；快照不存在但有舊紀錄（session-log/legacy-*.md）時，先合併出第一份快照。當用戶呼叫 /resume、說「繼續上次 / 上次做到哪」時觸發。
version: 1.0.0
origin: agentpacks/dev-base
---

# /resume — 恢復 Session

## 執行步驟

1. 讀取 `.agent/session.md`。
2. **不存在時**：
   - `.agent/session-log/legacy-*.md` 存在 → 依 `.agent/spec/session.md` 第六節「首次遷移」合併出第一份快照並寫入，告知用戶合併了哪些來源（例 legacy-claude 停在 10-21、legacy-codex 停在 10-24）。
   - 都沒有 → 告知用戶沒有可恢復的 session 紀錄，結束。
3. 向用戶摘要：
   - 狀態（進行中 / 已完成 / 阻塞）、最後更新時間與更新者（哪個 agent）
   - 當前任務、待辦、已知問題 / 阻塞
4. 用 `git branch --show-current` 確認分支，與快照記錄不一致時提醒。
5. 有需要的歷史細節（快照沒寫的）才去讀 `.agent/session-log/` 最近的月份檔，不要整份載入。
6. 詢問用戶要繼續哪個待辦，或有新任務。
