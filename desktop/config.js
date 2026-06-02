/* kabby-desktop 設定
 *
 * exe 純粹是一個 attach 到 daemon 的 client（等同瀏覽器開 web UI），
 * 本身不啟動 daemon。daemon 請另外用 `npm start` 起。
 *
 * DAEMON_URL：要連的 daemon HTTP 位址。
 *   - 預設連本機 127.0.0.1:3700
 *   - 換 port / 連遠端（cloudflared 之類）只改這裡，或設環境變數 KABBY_DAEMON_URL
 *
 * 注意：token（AUTH_TOKEN）不在這裡處理——daemon 吐出來的 UI 會在連線需要時
 * 自動跳登入頁讓使用者輸入，並存進 localStorage，Electron 視窗會記住。
 */
module.exports = {
  DAEMON_URL: process.env.KABBY_DAEMON_URL || 'http://127.0.0.1:3700',

  // 視窗預設大小
  WINDOW_WIDTH: 1280,
  WINDOW_HEIGHT: 820,
};
