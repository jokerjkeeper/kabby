---
name: report
description: 產生專案狀態報告：git 狀態、專案結構、session 進度、TODO / FIXME 與改進建議。當用戶呼叫 /report、說「專案狀態報告 / 目前專案狀況」時觸發。
version: 1.0.0
origin: agentpacks/dev-base
---

# /report — 專案狀態報告

## 執行步驟

1. **Git 狀態**
   - 當前分支：`git branch --show-current`
   - 未提交變更：`git status --short`
   - 最近 10 筆 commit：`git log --oneline -10`
   - 是否有未合併的分支
2. **專案結構概覽**
   - 掃描根目錄主要資料夾與檔案（依 `.agent/layout.json` 區分程式與非程式目錄，若存在）
   - 從 package.json、requirements.txt、*.csproj 等判斷語言與框架
   - 統計主要檔案類型
3. **進度狀態**
   - 讀 `.agent/session.md`（若存在）摘要當前進度、待辦
   - 讀 `.agent/ROADMAP.md`（若存在）取當前階段與下一個里程碑
4. **問題與建議**
   - 未處理的 TODO / FIXME
   - 明顯的程式問題（超大檔案、缺少錯誤處理等）
   - 改進建議
5. **輸出報告**

```markdown
# 專案狀態報告
## 報告日期: YYYY-MM-DD

### Git 狀態
- 當前分支: xxx
- 未提交變更: N 個檔案
- 最近活動: <摘要>

### 專案概覽
- 語言 / 框架: xxx
- 主要模組: xxx

### 進度
- 狀態: [進行中 | 已完成 | 阻塞]
- 當前階段: <ROADMAP Phase，若有>
- 待辦: N 項

### 問題與建議
- <問題 / 建議列表>
```
