/* kabby-desktop — Electron 主進程
 *
 * 角色：一個沒有網址列的瀏覽器視窗，loadURL 到 daemon。
 * daemon 吐出的就是完整 web UI，連線目標由那個頁面自己依 location.host 計算，
 * 所以這支 main.js 不碰任何 UI 邏輯、也不需要 node-pty。
 *
 * 連不上 daemon：彈「連接失敗」對話框，給「重試 / 離開」。
 */
const { app, BrowserWindow, dialog } = require('electron');
const { DAEMON_URL, WINDOW_WIDTH, WINDOW_HEIGHT } = require('./config');

/** @type {BrowserWindow | null} */
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    backgroundColor: '#1e1e1e', // 配合 UI 深色背景，避免載入時白屏閃爍
    autoHideMenuBar: true,      // 隱藏原生選單列（Alt 可暫時叫出）
    title: 'kabby',
    webPreferences: {
      // 載入的是 daemon 的遠端頁面，主進程不需要任何 node 能力，全部關掉最安全
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  loadDaemon();
}

/** 載入 daemon 頁面；loadURL 的 promise 失敗會被 did-fail-load 接手處理，這裡吞掉避免 unhandled rejection */
function loadDaemon() {
  if (!mainWindow) return;
  mainWindow.loadURL(DAEMON_URL).catch(() => { /* 交給 did-fail-load 處理 */ });
}

app.whenReady().then(() => {
  createWindow();

  // 主框架載入失敗（daemon 沒開、連線被拒等）→ 彈連接失敗對話框
  app.on('web-contents-created', (_e, contents) => {
    contents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      // errorCode === -3 是 ERR_ABORTED（通常為使用者主動取消/重導），不視為失敗
      if (!isMainFrame || errorCode === -3) return;
      showConnectionFailed(errorDescription);
    });
  });

  // macOS：dock 點擊重開視窗（Windows 用不到，順手相容）
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/** 彈出「連接失敗」對話框。showMessageBoxSync 回傳被點按鈕的索引（0=重試，1=離開） */
function showConnectionFailed(detail) {
  if (!mainWindow) return;
  const response = dialog.showMessageBoxSync(mainWindow, {
    type: 'error',
    title: '連接失敗',
    message: `無法連接到 kabby daemon\n${DAEMON_URL}`,
    detail: `請確認 daemon 已啟動（在 kabby 目錄執行 npm start）。\n\n${detail || ''}`.trim(),
    buttons: ['重試', '離開'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (response === 0) {
    loadDaemon(); // 重試
  } else {
    app.quit();   // 離開
  }
}

app.on('window-all-closed', () => {
  app.quit();
});
