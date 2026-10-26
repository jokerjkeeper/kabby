---
name: save
description: 存檔 session 進度：舊快照追加到 .agent/session-log/YYYY-MM.md，再覆蓋寫入新的 .agent/session.md（≤100 行）。當用戶呼叫 /save、說「存檔 / 保存進度 / 記錄一下進度」或 session 要結束時觸發。
version: 1.0.0
origin: agentpacks/dev-base
---

# /save — 存檔 Session 進度

> 規範以 `.agent/spec/session.md` 為準（快照格式、100 行上限、log 追加格式）；執行前先讀它。

## 執行步驟

1. **收集資訊**
   - 分支：`git branch --show-current`
   - 現在時間（YYYY-MM-DD HH:MM）、自己是哪個 agent（claude / codex / opencode）
2. **重讀** `.agent/session.md`（可能已被另一個 agent 或另一台電腦經 git 更新）。
   - 不存在、但 `.agent/session-log/legacy-*.md` 存在：先依規範「首次遷移」合併舊紀錄，再接著做下面步驟。
3. **追加歷史**：快照存在且與要寫的新內容不同時，把舊快照全文追加到 `.agent/session-log/<當月>.md` 檔尾（格式見規範第四節）。月份檔不存在就建立。
4. **整理新快照**：回顧本次 session，承接舊快照中仍有效的待辦與問題，依規範第二節格式整理：
   - 當前任務、本次完成、待辦、近期決策（≤5 筆）、已知問題 / 阻塞
5. **檢查長度**：超過 100 行就依規範第三節精簡後再寫；重要決策若要移出快照，順手追加到 `.agent/ROADMAP.md`「重要決策」（檔案存在時）。
6. **覆蓋寫入** `.agent/session.md`。
7. 告知用戶已存檔：快照行數、追加到哪個 log 檔、待辦摘要。不要自動 commit。

## 注意

- 不得寫入舊位置 `.claude/session.md`、`.codex/session.md`。
- session-log 只追加，不修改或刪除既有內容。
