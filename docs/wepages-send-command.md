# Wepages → kabby：從工單頁送指令給 cc

> 把這份整份貼給 wepages 端的 cc 即可，它是自包含的。
> 目的：在 wepages 工單頁做一個「送指令」功能，把任意字串（例如一個 cc slash command）當成鍵盤輸入打進某個 kabby session 的 cc，cc 就會執行。

---

## 一句話原理

kabby 的每個 session 背後是一個 cc 的 PTY。kabby 提供一個 endpoint，能把字串「當鍵盤輸入」寫進那個 PTY —— 等同於有人在終端裡打了那串字。所以送 `"/generate\r"` 就相當於在 cc 裡輸入 `/generate` 然後按 Enter，cc 會去跑那個 skill。

**輸出不用你處理**：只要該 task 已經掛載了這個 kabby session（iframe 嵌著 `embed.html?session=<id>`），cc 的執行過程會即時顯示在那個終端裡（因為 kabby 會把輸出 broadcast 給所有 attach 的 client）。

---

## 核心 API

```http
POST  <kabby-server>/api/sessions/<sessionId>/input
Content-Type: application/json
Authorization: Bearer <AUTH_TOKEN>        # 見下方「認證」

{ "data": "/generate\r" }
```

- 成功回 `{ "ok": true }`
- session 已結束（PTY 死了）回 `{ "ok": true_or_false }` 中的 `{ "ok": false }`
- 找不到該 session 回 `404`
- token 不對回 `401 { "error": "unauthorized" }`

`<sessionId>` 可填 session 的 `id`（UUID，建議）或 `name`。

---

## `data` 字串的規則（重要）

| 規則 | 說明 |
|---|---|
| **結尾要 `\r`** | `\r`（carriage return）才等於「按 Enter」送出。**不要用 `\n`**，cc 不會當成送出 |
| 沒有 `\r` 的效果 | 字串只會停在 cc 的輸入框，不執行（適合「先填字、之後再送」的情境） |
| 多行 | 一般 slash command 一行就好。要送多行內容時，行間用 `\r` |

範例：
- 送一個 skill：`{ "data": "/generate\r" }`
- 送一段文字訊息：`{ "data": "幫我把這個工單的內容整理成 spec\r" }`

---

## 認證（token）

kabby 部署版會設 `AUTH_TOKEN`，此時 **`/api/*` 都需要 token**。三種傳法擇一（後端都接受）：

1. `Authorization: Bearer <token>`（建議）
2. `X-Kabby-Token: <token>` header
3. 網址加 `?token=<token>` query

本機開發版若沒設 `AUTH_TOKEN`，token 可省略。要先確認的話，打開放的健康檢查（不需 token）：

```http
GET <kabby-server>/api/health
→ { "ok": true, "authRequired": true, ... }   // authRequired 告訴你要不要帶 token
```

---

## server URL（本機 vs 遠端）

| 環境 | `<kabby-server>` |
|---|---|
| 本機 | `http://localhost:3700` |
| 遠端（Cloudflare Tunnel） | `https://kabby.你的網域`（**無 port**，對外是 443） |

建議跟你「選擇 kabby session」那個可切換的 server 設定共用同一個值。

---

## 取得 sessionId

就是你列 session 列表那支（同樣要帶 token）：

```http
GET  <kabby-server>/api/sessions
Authorization: Bearer <AUTH_TOKEN>

→ [ { "id": "8f4b...", "name": "unity", "cwd": "...", "clientCount": 2, "alive": true }, ... ]
```

拿其中的 `id`（或 `name`）當 `POST .../sessions/<id>/input` 的 `<id>`。
通常就用該 task 已綁定/已掛載的那個 session id。

---

## 完整範例（前端 fetch）

```js
async function sendToKabby(server, sessionId, token, text) {
  const res = await fetch(`${server}/api/sessions/${encodeURIComponent(sessionId)}/input`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ data: text.endsWith('\r') ? text : text + '\r' }),
  });
  if (res.status === 401) throw new Error('token 不正確');
  const json = await res.json();
  if (!json.ok) throw new Error('session 已結束或無法寫入');
  return json;
}

// 用法：送一個 skill
await sendToKabby('https://kabby.你的網域', sessionId, token, '/generate');
```

---

## 注意事項

1. **cc 要在等輸入的狀態**：cc 正忙、或卡在某個選單/子提問時注入，可能會錯位或被當成回答。最理想是在 cc 閒置（顯示輸入提示）時送。wepages 端可不必判斷，但使用者要有這個認知。
2. **一次送吃不乾淨時，拆兩次**：少數情況 TUI 對「文字 + Enter 一起送」會處理不完整。先送 `{ "data": "/generate" }`，隔 ~100ms 再送 `{ "data": "\r" }`。先用一次送試，不行再拆。
3. **輸入會 broadcast**：送進去的字所有 attach 的 client 都會看到（含你的 iframe、以及桌面 kabby Web UI）。這是預期行為。

---

## CORS（跨域呼叫時）

wepages（例如 `http://localhost:5002`）跨域打 kabby `/api/*` 時：

- kabby 端要把 wepages 的 origin 加進 `KABBY_ALLOWED_ORIGINS`（kabby 的 `.env`），否則瀏覽器擋跨域。
- kabby 已允許的請求 header：`Content-Type`、`X-Kabby-Token`、`Authorization`（preflight 會放行）。
- 若看到 `... header field authorization is not allowed ...` 之類的 CORS 錯誤，代表 kabby 端 `.env` 沒設好或沒重啟 —— 那是 kabby 部署設定的問題，不是 wepages 的程式問題。

---

## 錯誤碼速查

| 回應 | 意思 | 對策 |
|---|---|---|
| `200 { ok: true }` | 成功送出 | — |
| `200 { ok: false }` | session 還在但 PTY 已死，寫不進去 | 提示使用者該 session 已結束 |
| `401 { error: "unauthorized" }` | 沒帶 / 帶錯 token | 檢查 token |
| `404 { error: "not found" }` | sessionId 不存在 | 重新抓 `/api/sessions` 列表 |
| CORS preflight 失敗 | kabby 的 `KABBY_ALLOWED_ORIGINS` 沒含你的 origin | 通知 kabby 端設定 |
