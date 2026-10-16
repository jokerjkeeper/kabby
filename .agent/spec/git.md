# Git 規格（agent 依據・canonical）

> 本檔為 git 提交 / 分支規範的**單一真相來源**，供 cc / codex / opencode 遵循。
> 由 `AGENTS.md` 索引載入。成員說明版見 `docs/Git提交規範.md`（內容以本檔為準）。

## 1. commit message 格式

```
[type][模組][模組…] 標題

內文（選填，與標題空一行；merge 自動訊息要保留就放這）
工單: #<id>
```

- 框框**全部連寫，框框之間不空格**；最後一個框框與標題之間**空一個半形空格**。
- 標題**不含框框**，**最少 3 字**，上限 50 字，結尾**不加句點**。
- 內文選填；有則與標題**空一行**。
- `工單: #<id>` 只在工單驅動時加（cc 直接做工單自動帶）。
- 一筆改動同時符合多個 **type** → **拆成多筆 commit**。
- 動到多個系統 → 掛多個模組 tag。

範例：
```
[新增][UI] 更名中文共用atlas名稱
[刪除][UI] 刪除錯誤命名atlas
[新增][戰場] 新增060地劫神CUTIN
```

## 2. type 詞表（第一框・封閉・動作）

`新增`(新功能/新機台)、`合併`(分支合併)、`修改`(改舊功能)、`修正`(修 bug)、`刪除`(刪功能)、`重構`(整理碼不改功能)、`效能`(不改功能改善效能)、`測試`(測試/單元測試)、`退版`(退舊版)、`註解`(改/加註解)、`組態`(組態檔/專案檔，與碼無關)。

## 3. 模組 tag（後續框・受控・系統層）

- 用**系統 / 模組層**名稱：戰場、大地圖、幻世牌、轉職、回憶錄、UI、GM…
- **相同系統不細分**（都是戰場就一律 `[戰場]`）。
- 與**知識庫 feature / wiki `system` / codereview 分類同源**，使 git tag ↔ wiki 系統頁對齊。
- 受控詞表本體由維護者統一維護（待建，與 wiki feature 同源）。

## 4. 分組規則（cc 給提案，逐筆可調）

- 預設**一工單一 commit**。
- 程式碼 vs 美術素材 → **拆兩筆**。
- 例外：**UI 相關 → 程式 + 素材合併一筆**。
- 複數 type → 拆開。

## 5. 美術素材與 Unity .meta

- 非程式內容（`.png` / `.mat` / `.prefab` / `.asset` / 美術路徑）→ 標「需人工確認」，cc 不自動 commit，需人點頭。
- Unity `.meta` 必須與其資產**配對 commit**；缺配對要擋並提示。

## 6. 分支策略（方案 B：工單分支 + 測試 gate）

```
develop ──┬─ task/<id>-<slug>   (cc 在此 commit)
          └─ …
   人工 push task 分支 → 測試人 pull 該分支測試 → 確認 → merge 回 develop → push develop
```

- cc 從 `develop` 切本地分支 `task/<id>-<slug>`，於分支上 commit。
- 批量：cc 可一次處理 N 筆工單，逐筆切分支、各自拆 commit，互不污染。
- task 分支與 develop 的 push、merge 皆由人操作。

## 7. pull / push

- cc commit 前只 `git fetch` + 落後提醒，**不自動 pull**。
- `git pull --rebase` 在**手動 push 前**做。
- **cc 只 commit、不 push**；push 由人操作。
- 禁止直接在 `main` / `master` 開發或 push；非預期分支要警告。

## 8. 選用

- `Co-Authored-By: Claude …` footer：**預設不加**（與原格式一致）；團隊要署名再開啟。

## 9. 自動化：`/wp-commit` skill（待建）

呼叫後 cc：檢查 repo/分支 + fetch 提醒 → 切/確認工單分支 → 依 §4 拆組、標資產/.meta → 依 §1~3 產【commit 清單 + log 預覽】等確認 → 確認後逐筆 commit（資產需額外點頭）→ 提示 push 由人、先 `pull --rebase`。
