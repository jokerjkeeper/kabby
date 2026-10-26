---
name: task
description: 把目前專案進度整理成 agent 的任務清單（task / todo 工具），標示狀態與依賴。當用戶呼叫 /task、說「列出任務 / 建立任務清單 / 追蹤進度」時觸發。
version: 1.0.0
origin: agentpacks/dev-base
---

# /task — 任務進度追蹤

用 agent 內建的任務 / todo 工具追蹤進度（Claude Code：TaskCreate / TaskUpdate / TaskList；其他 agent 用各自的 plan / todo 機制，沒有時以 markdown 清單回報）。

## 執行步驟

1. **收集當前狀態**
   - 讀 `.agent/session.md`（若存在）了解當前任務與待辦
   - 回顧本次 session 的對話，識別所有任務項目
2. **檢查現有任務**：先列出已有任務，避免重複建立。
3. **建立或更新任務**，每項包含：
   - 標題：簡潔的祈使句（例「實作用戶登入功能」）
   - 說明：上下文與驗收標準
   - 狀態：`pending` / `in_progress` / `completed`
4. **設定依賴**：任務有先後順序時建立 blocks / blocked-by 關係（工具支援時）。
5. **輸出摘要**：列出建立 / 更新的任務與狀態、整體進度概覽。

任務清單只存在本次 session；需要跨 session 保留的待辦，用 `save` 寫進 `.agent/session.md`。
