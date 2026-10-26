---
name: readme
description: 生成或更新專案 README.md：技術棧、安裝步驟、啟動方式、環境變數、目錄結構、常用命令，保留手寫章節。當用戶呼叫 /readme、說「更新 README / 補 README」時觸發。
version: 1.0.0
origin: agentpacks/dev-base
---

# /readme — 更新 README

## 執行步驟

1. 讀取現有 `README.md`（若存在）。
2. 掃描專案，識別：
   - 主要技術棧與框架
   - 入口檔案與關鍵模組
   - 設定檔（`.env.example`、`config/` 等）
   - 已定義的 scripts / commands（package.json scripts、Makefile、bat 等）
3. 讀 `AGENTS.md`（及 `.agent/spec/` 相關規範）取得專案類型、目錄約定、可用 skill。
4. 生成或更新 `README.md`，包含：

```markdown
# <專案名稱>

<簡短描述>

## 技術棧
- <框架 / 語言 / 版本>

## 安裝步驟
1. <clone / 安裝依賴 / 環境設定>

## 啟動方式
<啟動指令>

## 環境變數說明
| 變數名 | 說明 | 預設值 |
|--------|------|--------|

## 目錄結構
<專案目錄樹>

## 常用命令
| 命令 | 說明 |
|------|------|
```

5. README 已存在時，保留用戶手寫的自訂章節，只更新可自動偵測的部分。
6. 告知用戶已更新，摘要變更內容。
