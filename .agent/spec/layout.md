# 專案目錄約定（非程式目錄）

> AgentPacks agent-env 規範。機器可讀版本在 `.agent/layout.json`（歸專案所有，可依專案增減）。
> launcher 與 wiki pack 依此判斷「哪裡是程式碼」：頂層目錄扣掉下列保留目錄後，含程式檔的就是 `code_roots`。

## 保留目錄（頂層，不放程式碼）

| 目錄 | 用途 |
|---|---|
| `.*`（`.agent`、`.claude`、`.codex`、`.agents`、`.state`…） | agent / 工具設定與狀態 |
| `design/` | 設計稿、原型、UI 素材原檔 |
| `aispec/` | AI 產出的規格 / 報告（codereview 回顧等） |
| `docs/`、`doc/` | 人寫的文件 |
| `temp/`、`tmp/` | 暫存，不進版控 |
| `raw/`、`wiki/`、`outputs/` | wiki pack：原始來源 / 知識庫 / 查詢產出 |
| `spec/`、`specs/` | 需求 / 規格文件 |
| `node_modules/`、`dist/`、`build/`、`out/`、`coverage/`、`venv/`、`Library/`、`Temp/`、`obj/`、`bin/`… | 依賴與建置產物 |

## 規則

- 新增文件、設計稿、暫存檔時，放進上表對應目錄，**不要**在頂層另開新的非程式目錄；確有需要就同步加進 `.agent/layout.json` 的 `reserved_dirs`。
- 程式碼放在保留目錄以外（例 `src/`、`services/`、`sdk/`、`Assets/Scripts/`）；目錄名稱不限。
- 不要把程式碼放進保留目錄（例 `docs/` 裡的範例腳本不會被 code review 收集）。
- 調整程式目錄後，到 launcher「Agent 套件」重新安裝 wiki pack，`code_roots` 會依新結構重新偵測。
