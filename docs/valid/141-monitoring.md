# 驗收：監控功能（cc 用量監控：token/成本分析 + 敏感詞審計）（task #141）

> 生成時間：2026-06-27　對應 WePages 驗收組：#1
> 對應 commit：`6adbf4e feat(monitoring): cc 用量監控 — B 採集 + D 輸入攔截`

## 1. Token / 成本分析採集與聚合
- **步驟**：`node test/usage-collector.js`；或起 daemon 後 `GET /api/usage`。
- **預期**：增量正確性全通過（逐行累加 / 重掃不重複 / 半行安全 / 截斷重建）；buildView 聚合 totals（sessions/turns/tokens/costUsd）與 per-session 明細、cwd 過濾、按 lastTs 排序皆正確。
- **實際**：測試全 PASS；整合掃描真實 cwd 得 sessions=3 turns=56。　☑ 通過 / ☐ 不通過

## 2. 定價 / 成本換算
- **步驟**：同上測試 D 段；檢查 `config/model-prices.json` 與 `src/pricing.js`。
- **預期**：cache 費率自動推導（5m=1.25× / 1h=2× / read=0.1×）；混 model 加總；家族 fallback（未知 opus 變體照 opus 算）；完全不認得的 model 列入 unknownModels 不計費；buildView 帶出 costUsd。
- **實際**：opus 全類 1M = $46.75、sonnet 1M output = $15 等斷言全過。　☑ 通過 / ☐ 不通過

## 3. 敏感詞審計偵測（只記不擋）
- **步驟**：同 usage-collector 測試 C 段；或 `GET /api/usage/sensitive`。
- **預期**：字面詞（不分大小寫、含子字串、中文）+ regex pattern 皆命中；命中記進 entry.sensitiveHits（含 word/role/snippet）；無 matcher 走零成本路徑不偵測；buildView 聚合 totals.sensitiveHits 與 session.sensitiveHitCount。
- **實際**：測試全 PASS；線上截圖敏感詞分頁正確命中 `密碼/password/信用卡` 與 `sk-…` regex（API key）。　☑ 通過 / ☐ 不通過

## 4. 敏感詞即時輸入攔截（D 方案）
- **步驟**：`node test/input-filter.js`。
- **預期**：matcher 為 null 原樣放行；乾淨行轉發含 Enter；命中攔下 Enter（不送 cc）並回報詞、buf 保留防繞過；退格 / Ctrl+U 改乾淨後放行；方向鍵不污染 buf；中文命中；bracketed paste 內容也檢查。預設 `blockInput:false`。
- **實際**：測試全 PASS。　☑ 通過 / ☐ 不通過

## 5. 監控 overlay 前端三分頁
- **步驟**：起 daemon，瀏覽器點右上「監控」按鈕。
- **預期**：頂部統計列（sessions/turns/input/output/cache建立/cache讀取/成本估算/敏感詞命中）；三分頁 Token用量 / 儀表板（按 model·按日圖表）/ 敏感詞（命中 badge）；重新整理 / 重審歷史 / 關閉 三按鈕。
- **實際**：線上截圖確認三分頁與統計列實跑（67 sessions / 成本 $1,268.16 / 敏感詞 15）。　☑ 通過 / ☐ 不通過

## 6. API 端點與 WS 即時推送
- **步驟**：檢查 `src/daemon.js` 路由；觀察監控頁「索引更新 … live」。
- **預期**：`GET /api/usage`（?cwd / ?refresh / ?rebuild）、`GET /api/usage/sensitive`、`GET /api/usage/:id/conversation`、`WS /api/usage/stream` 皆存在；WS 即時推送索引更新與攔截 toast。
- **實際**：端點齊全；截圖顯示 live（WS 連線中）。　☑ 通過 / ☐ 不通過
