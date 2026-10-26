---
name: review
description: 對最近修改的檔案做 code review：安全、程式品質、最佳實踐，依嚴重等級列出問題與修復建議。當用戶呼叫 /review、說「review 一下 / 幫我檢查這次改動」時觸發。
version: 1.0.0
origin: agentpacks/dev-base
---

# /review — Code Review

## 執行步驟

1. **取得變更範圍**
   - 未提交：`git diff --name-only`
   - 已暫存：`git diff --cached --name-only`
   - 都沒有時，取最近一次 commit：`git diff HEAD~1 --name-only`
2. **逐一審查變更檔案**

### 安全問題（CRITICAL）
- hardcoded 的密鑰、API key、token、密碼
- SQL injection、XSS、路徑穿越
- 缺少輸入驗證、不安全的依賴使用

### 程式品質（HIGH）
- 函數超過 50 行、檔案超過 800 行、巢狀超過 4 層
- 缺少錯誤處理
- 殘留的 console.log / print 除錯語句
- 未處理的 TODO / FIXME

### 最佳實踐（MEDIUM）
- 命名是否清楚
- 可抽取的重複程式碼
- 新增程式碼是否缺測試
- 是否符合專案既有風格（`.agent/spec/coding.md` 與專案規範）

3. **審查報告**：每個問題列出
   - 嚴重等級：CRITICAL / HIGH / MEDIUM / LOW
   - 位置：檔案路徑與行號
   - 問題描述與修復建議
4. **總結**
   - 審查檔案數、各等級問題數
   - 無 CRITICAL / HIGH → 建議通過；有 → 明確指出必須修復後才能提交
