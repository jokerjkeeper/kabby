# 讓 kabby 在 GCP 上常駐（systemd service）

目標：把 kabby daemon 設成 systemd service，達成**開機自啟、崩潰自動重啟、不隨 SSH 斷線而停**。搭配 `docs/cloudflare-tunnel.html` 一起看（那份負責對外暴露，這份負責讓 kabby 本體一直活著）。

---

## 前置

- GCP server（Linux，以下以 Debian/Ubuntu 為例）
- 已安裝 **Node.js 20.12+**（kabby 用內建 `process.loadEnvFile` 載入 `.env`，需要這版以上）
- kabby 已 clone、跑過 `npm install`（會編譯 `node-pty` 原生模組）
- 專案根目錄有 `.env`，內含 `AUTH_TOKEN`（見 `.env.example`）

> ⚠️ **node-pty 是原生模組**：service 用的 node 必須跟當初 `npm install` 編譯時的是同一版。下面用絕對路徑指定 node，避免版本對不上。

確認 node 的絕對路徑（unit 檔要用）：

```bash
which node      # 例如 /usr/bin/node 或 /home/you/.nvm/versions/node/v22.15.0/bin/node
```

如果是 nvm 裝的，路徑會在 `~/.nvm/...`；建議直接用那個絕對路徑，或改用系統層安裝的 node。

---

## 建立 service

假設 kabby 在 `/home/youruser/kabby`、以 `youruser`（非 root）執行。建立 unit 檔：

```bash
sudo nano /etc/systemd/system/kabby.service
```

貼入（把 `youruser`、路徑、node 路徑換成你的實際值）：

```ini
[Unit]
Description=kabby daemon (PTY multiplexer for Claude Code)
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/kabby
ExecStart=/usr/bin/node src/daemon.js
Restart=always
RestartSec=3
# 讓崩潰重啟不會被 systemd 當成「狂當機」而停掉
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
```

> **環境變數怎麼來？** kabby 啟動時會自動讀**專案根目錄的 `.env`**（`loadEnvFile`），所以這裡**不需要** systemd 的 `EnvironmentFile`，把設定放 `.env` 即可。
> 若你偏好用 systemd 管環境變數，也可改成 `EnvironmentFile=/home/youruser/kabby/.env`（但 systemd 的解析與 `.env` 引號規則略有差異，建議二選一、別兩邊都設）。

---

## 啟用 + 啟動

```bash
sudo systemctl daemon-reload          # 讓 systemd 讀到新 unit
sudo systemctl enable --now kabby     # 設開機自啟 + 立刻啟動
sudo systemctl status kabby           # 看狀態（應為 active (running)）
```

看即時日誌（就是原本 `npm start` 會印的那些）：

```bash
sudo journalctl -u kabby -f
```

啟動成功會看到：

```
kabby daemon listening on http://127.0.0.1:3700
[auth] AUTH_TOKEN enabled — /api + WS 需要 token
```

---

## 日常維護

| 動作 | 指令 |
|---|---|
| 重啟（改了 `.env` 或拉了新 code 後） | `sudo systemctl restart kabby` |
| 停止 | `sudo systemctl stop kabby` |
| 看狀態 | `sudo systemctl status kabby` |
| 看日誌（跟隨） | `sudo journalctl -u kabby -f` |
| 看最近日誌 | `sudo journalctl -u kabby -n 100 --no-pager` |
| 取消開機自啟 | `sudo systemctl disable kabby` |
| 改了 unit 檔後 | `sudo systemctl daemon-reload && sudo systemctl restart kabby` |

> ⚠️ **重啟會結束目前所有 cc session**（PTY 隨 daemon 退出）。重要工作先處理完再 restart。

更新流程範例：

```bash
cd /home/youruser/kabby
git pull
npm install            # 若依賴有變（含 node-pty 需重編時）
sudo systemctl restart kabby
```

---

## 安全提醒

- **以非 root 使用者跑**（unit 裡的 `User=`）。kabby 會 spawn 帶 `--dangerously-skip-permissions` 的 cc，用 root 跑風險過高。
- `.env` 權限收緊，避免同機其他帳號讀到 token：
  ```bash
  chmod 600 /home/youruser/kabby/.env
  ```
- kabby 維持綁 `127.0.0.1`（預設），對外一律走 Cloudflare Tunnel（見 `docs/cloudflare-tunnel.html`），**不要**開 GCP 的 3700 inbound。

---

## 疑難排解

- **`status` 顯示 failed、日誌有 `MODULE_NOT_FOUND` 或 node-pty 相關錯**：多半是 service 用的 node 版本跟編譯 node-pty 的不同。用 `which node` 的絕對路徑替換 `ExecStart` 的 `/usr/bin/node`，必要時 `npm rebuild` 後再 restart。
- **`EADDRINUSE: 3700`**：已有另一個 kabby（或舊的）在跑。`sudo lsof -i:3700` 找出來，或 `sudo systemctl stop kabby` 後確認沒有殘留 node 行程。
- **環境變數沒生效**：確認 `.env` 在 `WorkingDirectory`（專案根目錄）下、node 版本 ≥ 20.12；`journalctl` 看啟動那行有沒有印 `[auth] AUTH_TOKEN enabled`。
