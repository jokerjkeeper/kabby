---
name: resume
description: 恢復上次的工作狀態：讀 .agent/session.md 摘要進度並確認待辦；快照不存在但有舊紀錄（session-log/legacy-*.md）時，先合併出第一份快照。當用戶呼叫 /resume、說「繼續上次 / 上次做到哪」時觸發。
version: 1.0.0
origin: agentpacks/dev-base
---

# 共用 Skill 入口（自動產生）

完整閱讀並依 `.agent/capabilities/skills/resume/SKILL.md` 執行。該 canonical 檔及其 scripts / references 是唯一可修改來源；本入口不得手改。
