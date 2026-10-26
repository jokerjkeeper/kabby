# Session 進度記錄
## 狀態: 已完成（對話視圖已 merge 並 push）
## 最後更新: 2026-10-16 11:10
## 當前分支: main（feature/chat-view 已 ff-merge 並 push：769bac4..0af6069）

### 當前任務
- **對話視圖（終端｜對話 互切）**：使用者想要類似 WePages「AI 對話」分頁 / VSCode Claude 擴充的對話式前端。已選方向 **A：疊在 PTY 上**（cc 照跑 PTY，前端讀 jsonl 渲染、輸入框寫回 PTY），版面 **pane 內互切**。計畫檔：`~/.claude/plans/goofy-coalescing-locket.md`。

### 已完成
- [x] `3562ed1` 後端：`cc-collector.readChatItems`（逐 block 展平 user/assistant/tool/result，含工具 input 與結果、4KB 截斷、byte offset 增量快取 LRU 32）；`GET /api/sessions/:id/chat?key=&after=`（unchanged / reset 協定）；`resolveConvoId` 抽出共用；codex 由摘要 turns 降級；`test/cc-chat-items.js`
- [x] `daaf73b` fix：PTY spawn 剔除父 cc 的 session 標記（`CLAUDE_CODE_CHILD_SESSION` 等 → 否則 PTY 裡 cc「Transcript saving is off」、對話記錄全失效）；jsonl 定位改用 **birthtime**（PTY 啟動後才建立），避免同 cwd 的 kabby 外 cc 搶綁定；`/clear` 換新檔會跟過去
- [x] `6bce372` 前端：`public/chat-view.js`（工具卡片可展開、Edit 紅綠 diff、Bash/TodoWrite、markdown、使用者泡泡、輸入框 bracketed paste + 80ms 後補 `\r`、⏹ 中斷=Esc、工具 >3s 無結果提示切回終端、首次載入只畫最後 400 筆）；狀態列「💬 對話 / ⌨ 終端」；視圖選擇存 localStorage `kabby.view.<sid>`；對話視圖疊在 xterm 上（終端尺寸不動）；語音在對話視圖時填入輸入框，輸入框 `data-voice-hotkey` 讓 Ctrl+Shift+V 照常
- [x] `3e27ad4` docs：三語 README「對話視圖」段 + Testing、`docs/api.md` /chat
- [x] 驗證：Playwright e2e（臨時 daemon :3791、真 cc haiku、cwd=J:\Git\kabby）**18/18 PASS**——單行/多行送出、工具卡 ✓ 與展開、回覆出現、等待狀態清除、reload 還原、切回終端尺寸正常可打字、`/clear` 後換新對話；test/ 五支單元測試 PASS。腳本：scratchpad `e2e-chat.js`（session 結束即消失）
- [x] 語音快捷鍵：使用者決定**維持 Ctrl+Shift+V**（上次阻塞已解）

### 待辦
- [x] 對話視圖 + 長訊息摺疊（0af6069）已 ff-merge 回 main 並 push（769bac4..0af6069）
- [ ] 使用者實測對話視圖（需重啟 :3700 daemon + Ctrl+F5）；摺疊門檻 12 行/800 字可再調
- [ ] （可選）codex 完整 reader（function_call 參數 + function_call_output 結果）
- [ ] （可選）room.html 訪客的對話視圖；貼圖進 PTY；切換快捷鍵
- [ ] 使用者用真麥克風實測終端 / 聊天 🎙 與快捷鍵
- [ ] （可選）Whisper `language=zh` 輸出簡體，要穩定轉繁可加 OpenCC
- [ ] **輪換 3 個 token**：AUTH_TOKEN、WEPAGES_TOKEN、舊 .env token；換完再把 repo 切 Public
- [ ] 使用者實測聊天室角色化權限
- [ ] （未完）tunnel/遠端外網（外部 cloudflared）
- [ ] （可清理）已合併的本機分支 `feature/voice-input`、`feature/voice-hotkey`（刪分支需使用者確認）

### 決策記錄
| 日期 | 決策 | 原因 | 替代方案 |
|------|------|------|----------|
| 2026-10-16 | 對話視圖走 A：PTY + 讀 jsonl，不改 headless stream-json | 改動小、保留多 client attach 與終端互切 | B：stream-json/Agent SDK（真串流、權限按鈕，但與 PTY 模式分家） |
| 2026-10-16 | 版面為 pane 內「終端｜對話」互切 | 使用者選擇；最小改動 | VSCode 式並排、只留對話視圖 |
| 2026-10-16 | 送出 = bracketed paste 包文字，80ms 後另送 `\r` | 同批含 `\r` 會被 Ink 當貼上只換行；多行需當一則 | 換行壓空格 |
| 2026-10-16 | jsonl 綁定用 birthtime 不用 mtime | 同 cwd 外部 cc 的舊檔 mtime 也在前進會搶綁定 | mtime（舊規則） |
| 2026-10-16 | PTY 剔除父 cc 的 session env 標記 | 從 cc 內啟動 daemon 時子 cc 不寫存檔 | 文件提醒 |
| 2026-10-16 | markdown 渲染由 convo-view.js 匯出 `window.KabbyMd`，未另拆 md.js | 少搬動既有程式碼 | 新檔 md.js |
| 2026-10-16 | 語音快捷鍵維持 Ctrl+Shift+V | 使用者決定 | F4／Alt+V |
| 2026-09-22 | 語音轉寫只填入、不自動送出 | 避免 Whisper 幻覺直接送給 AI | 自動送出 |
| 2026-09-24 | 快捷鍵 keydown 走 capture 階段 | 搶在 xterm 之前攔截 | xterm customKeyEventHandler |

### 已知問題
- 對話視圖回覆整段出現（jsonl 粒度），非逐字串流 — 設計限制
- 權限確認 / `/` 選單 / AskUserQuestion 只能在終端操作；對話視圖以「工具 >3s 無結果」提示條代替（長跑的 Bash 也會觸發，文案已寫「執行中或在等你確認」）
- 兩個全新 kabby session 同 cwd 同時首次發話，初次綁定可能互換（claimed 集合只在綁定後生效）— 罕見，未處理
- 終端內 `Ctrl`+`Shift`+`V` 被語音佔用 → 失去「貼上純文字」
- `test/smoke.js` 寫死 `localhost:3700` 且不帶 token — 測試需另起臨時 daemon
- Bash tool 在 heredoc 內會改寫跳脫字元 — 寫檔用 Write/Edit 或另存 .js 腳本
