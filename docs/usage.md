# kabby 使用手冊

> Phase 1 階段沒有 Web UI，本手冊以 curl + WS client（`wscat` 或 node script）為主。Phase 2 之後可直接開瀏覽器到 `http://localhost:3700` 操作。

## 0. 前置

- Node.js ≥ 18
- Windows / macOS / Linux 皆可（cc 進程的可用性看 OS）
- 想跑真正的 cc：本機要能在 PATH 找到 `claude`（Unix）/ `claude.cmd`（Windows，npm 裝的 shim，不是 `.exe`）

## 1. 啟動 daemon

```bash
cd D:\Git\kabby
npm install         # 第一次
npm start
```

成功會看到：

```
kabby daemon listening on http://localhost:3700
```

> 啟動失敗、port 占用 → 設 env：`PORT=3701 npm start`

## 2. 確認活著

```bash
curl http://localhost:3700/api/health
# {"ok":true,"sessions":0}
```

## 3. 建第一個 session

最小範例（用預設的 `claude --dangerously-skip-permissions`）：

```bash
curl -X POST http://localhost:3700/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"name":"unity","cwd":"D:/Projects/RS/my-app/unity"}'
```

PowerShell 寫法：

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://localhost:3700/api/sessions `
  -ContentType 'application/json' `
  -Body '{"name":"unity","cwd":"D:/Projects/RS/my-app/unity"}'
```

回應：

```json
{
  "id": "8f4b1d2c-...",
  "name": "unity",
  "cwd": "D:/Projects/RS/my-app/unity",
  "clientCount": 0,
  "alive": true
}
```

> 想跑別的命令（例如本機沒裝 cc，先用 cmd 練手）：
> ```json
> {"name":"test","cwd":"D:/Git/kabby","cmd":"cmd.exe","args":[]}
> ```

## 4. Attach（連到 PTY）

### 用 wscat

```bash
npm i -g wscat
wscat -c ws://localhost:3700/ws/unity
```

連上後直接收到 scrollback 重繪（如果是新 session 就只有 cc 的歡迎畫面）。輸入要用 JSON 包：

```
> {"type":"input","data":"ls\r"}
```

收到的也是 JSON：

```
< {"type":"output","data":"..."}
```

> 注意 wscat 是 raw WS client，不會幫你包 JSON 也不會解 ANSI；要看實際畫面建議等 Phase 2 的 Web UI。

### 用 node 一行腳本

```bash
node -e "const W=require('ws');const w=new W('ws://localhost:3700/ws/unity');w.on('message',m=>process.stdout.write(JSON.parse(m).data||''));process.stdin.on('data',d=>w.send(JSON.stringify({type:'input',data:d.toString()})));"
```

## 5. 多 client 同時 attach

開第二個 terminal 也跑 `wscat -c ws://localhost:3700/ws/unity`，會看到：

- 第二個 client 連上後**立刻看到歷史輸出**（scrollback replay）
- 從第一個 client 打字，第二個收得到（fan-out）
- `GET /api/sessions` 的 `clientCount` 變成 2

## 6. 從外部注入指令（Phase 4 預演）

不開 attach，直接把字串塞進 PTY：

```bash
curl -X POST http://localhost:3700/api/sessions/unity/input \
  -H "Content-Type: application/json" \
  -d '{"data":"# task #123 子項: 重構 foo\r"}'
```

所有 attach 中的 client 都會看到這行被注入。`\r` 必填，cc 才會把它當成 enter 送出。

## 7. 關掉 session

```bash
curl -X DELETE http://localhost:3700/api/sessions/unity
```

PTY 被殺，所有 attach 的 WS 收到 `{type:'exit',code:...}` 然後斷線。

## 8. 關閉 daemon

`Ctrl+C` 即可，會走 SIGINT handler：

1. 殺光所有活著的 session
2. 關 HTTP server
3. 2 秒後強制 exit

---

## 常見問題

### `npm install` 在 Windows 失敗，提示 node-gyp

通常是預編譯包不匹配你的 Node 版本。試試：

```bash
npm install --build-from-source
```

需要安裝 VS Build Tools 與 Python。或者降到 Node 18 LTS。

### 連 WS 立刻被斷

- 確認 URL 是 `/ws/:id` 不是 `/api/...`
- 確認那個 :id（UUID 或 name）真的存在：`curl http://localhost:3700/api/sessions`
- 設了 `AUTH_TOKEN`：URL 後面要加 `?token=xxx`

### `clientCount` 沒歸零

正常情況 WS 一斷會走 `detach`，`clientCount` 立刻 -1。如果看到沒減，可能是 client 異常斷線且 `close` 事件還沒觸發 —— 通常一兩秒後 TCP keepalive 會處理掉。

### PTY 卡住、視窗大小錯亂

多個 client 視窗大小不一，是 latest-resize-wins。在你想用的視窗手動 resize 一下重觸發即可。

---

## 接下來

- Phase 2：瀏覽器開 `http://localhost:3700` 直接用，不用 wscat
- Phase 3：wepages 任務頁 Terminal 按鈕掛載
- Phase 4：點子清單自動注入 task context
