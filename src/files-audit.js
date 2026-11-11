/**
 * /api/files 的存取稽核與即時狀態。
 *
 * - 持久化：每個請求一行 JSONL，寫到 <logDir>/files-YYYY-MM-DD.jsonl（本地日期），保留 logDays 天
 * - 即時：進行中的下載、正在算的 sha256、最近 200 筆事件、自啟動以來的統計（給 /api/files/activity）
 * - 被拒請求也記，但每個 IP 每分鐘最多寫 deniedPerMin 筆，超過的只計數，之後補一筆 suppressed 摘要
 *   （防止內網有東西狂打 401 把磁碟寫爆；統計計數不受限）
 * - 寫檔失敗只在 stderr 警告（每分鐘最多一次），不影響下載
 * 絕不記錄 token：事件欄位是白名單，呼叫端也不會傳 header 進來。
 */
const fs = require('fs');
const path = require('path');

const RECENT_MAX = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_FILE_RE = /^files-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const EVENT_FIELDS = ['ts', 'ip', 'method', 'endpoint', 'path', 'range', 'status', 'bytes', 'size', 'ms', 'result', 'reason', 'suppressed'];

/** 本地日期 YYYY-MM-DD */
function localDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 只留白名單欄位、去掉空值 */
function pickEvent(ev) {
  const out = {};
  for (const k of EVENT_FIELDS) {
    const v = ev[k];
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string|null} opts.logDir      JSONL 目錄（null = 只記記憶體，不落檔）
 * @param {number} [opts.logDays=30]     保留天數
 * @param {number} [opts.deniedPerMin=60] 每個 IP 每分鐘最多寫幾筆被拒事件
 * @param {(line:string)=>void} [opts.warn] 警告輸出（預設 stderr）
 * @param {()=>number} [opts.now]        時鐘（測試用）
 */
function createFilesAudit({ logDir = null, logDays = 30, deniedPerMin = 60, warn = (l) => console.error(l), now = () => Date.now() } = {}) {
  const startedAt = now();
  const recent = [];
  const active = new Map();   // id → 下載狀態
  const hashing = new Map();  // id → 計算狀態
  const deniedWindows = new Map();  // ip → { start, count, suppressed }
  const stats = {
    since: new Date(startedAt).toISOString(),
    requests: 0,
    bytesSent: 0,
    bytesByIp: {},
    byStatus: {},
    denied: 0,
    deniedByReason: {},
  };
  let nextId = 1;
  let writable = logDir ? null : false;   // null = 尚未確認
  let lastWarnAt = 0;
  let writeChain = Promise.resolve();
  let timers = [];

  /** 寫檔失敗警告（限流） */
  function warnWrite(err) {
    writable = false;
    if (now() - lastWarnAt < 60 * 1000) return;
    lastWarnAt = now();
    warn(`[files] 警告：存取日誌寫入失敗（${err.code || err.message}），下載不受影響`);
  }

  /** 排隊 append 一行 JSONL */
  function appendLine(obj) {
    if (!logDir) return;
    const file = path.join(logDir, `files-${localDate(now())}.jsonl`);
    const line = JSON.stringify(obj) + '\n';
    writeChain = writeChain
      .then(() => fs.promises.mkdir(logDir, { recursive: true }))
      .then(() => fs.promises.appendFile(file, line, 'utf8'))
      .then(() => { writable = true; })
      .catch(warnWrite);
  }

  /** 被拒事件限流：回傳 true = 這筆要寫檔 */
  function allowDeniedWrite(ip) {
    const t = now();
    let w = deniedWindows.get(ip);
    if (!w || t - w.start >= 60 * 1000) {
      if (w && w.suppressed) flushSuppressedFor(ip, w);
      w = { start: t, count: 0, suppressed: 0 };
      deniedWindows.set(ip, w);
    }
    if (w.count < deniedPerMin) { w.count++; return true; }
    w.suppressed++;
    return false;
  }

  function flushSuppressedFor(ip, w) {
    const ev = { ts: new Date(now()).toISOString(), ip, result: 'denied', reason: 'suppressed', suppressed: w.suppressed };
    w.suppressed = 0;
    appendLine(ev);
  }

  /** 把已滿一分鐘的限流視窗收掉，補寫 suppressed 摘要 */
  function flushSuppressed({ force = false } = {}) {
    const t = now();
    for (const [ip, w] of deniedWindows) {
      if (!force && t - w.start < 60 * 1000) continue;
      if (w.suppressed) flushSuppressedFor(ip, w);
      if (t - w.start >= 60 * 1000) deniedWindows.delete(ip);
    }
  }

  /**
   * 記一筆請求事件（請求結束時呼叫）。
   * ev: { ip, method, endpoint, path, range, status, bytes, size, ms, result, reason }
   */
  function record(ev) {
    const event = pickEvent({ ts: new Date(now()).toISOString(), ...ev });
    stats.requests++;
    stats.byStatus[event.status] = (stats.byStatus[event.status] || 0) + 1;
    if (event.bytes) {
      stats.bytesSent += event.bytes;
      stats.bytesByIp[event.ip] = (stats.bytesByIp[event.ip] || 0) + event.bytes;
    }
    if (event.result === 'denied') {
      stats.denied++;
      stats.deniedByReason[event.reason] = (stats.deniedByReason[event.reason] || 0) + 1;
      if (!allowDeniedWrite(event.ip || '')) return;
    }
    recent.push(event);
    if (recent.length > RECENT_MAX) recent.shift();
    appendLine(event);
  }

  /** 開始一個下載；回傳 handle：add(bytes) 累加、end() 移除 */
  function startDownload({ ip, path: p, range, total }) {
    const id = nextId++;
    const item = { id, ip, path: p, range: range || null, sent: 0, total, startedAt: now() };
    active.set(id, item);
    return {
      add(n) { item.sent += n; },
      end() { active.delete(id); },
    };
  }

  /** 開始一個 sha256 計算；回傳 handle：progress(bytes)、end() */
  function startHash({ path: p, size }) {
    const id = nextId++;
    const item = { path: p, size, done: 0, startedAt: now() };
    hashing.set(id, item);
    return {
      progress(n) { item.done += n; },
      end() { hashing.delete(id); },
    };
  }

  /** activity 快照 */
  function snapshot() {
    const t = now();
    return {
      active: [...active.values()].map((d) => {
        const secs = Math.max((t - d.startedAt) / 1000, 0.001);
        return {
          id: d.id, ip: d.ip, path: d.path, range: d.range, sent: d.sent, total: d.total,
          startedAt: new Date(d.startedAt).toISOString(),
          mibps: Math.round((d.sent / 1048576 / secs) * 100) / 100,
        };
      }),
      hashing: [...hashing.values()].map((h) => ({
        path: h.path, size: h.size, done: h.done, startedAt: new Date(h.startedAt).toISOString(),
      })),
      recent: recent.slice().reverse(),
      stats: JSON.parse(JSON.stringify(stats)),
      log: { enabled: !!logDir, writable: writable !== false, days: logDays },
    };
  }

  /** 刪掉超過保留天數的日誌檔（依檔名日期判斷）；回傳刪除數 */
  async function cleanup() {
    if (!logDir) return 0;
    let names;
    try {
      names = await fs.promises.readdir(logDir);
    } catch (err) {
      if (err.code !== 'ENOENT') warnWrite(err);
      return 0;
    }
    const cutoff = localDate(now() - logDays * DAY_MS);
    let removed = 0;
    for (const name of names) {
      const m = LOG_FILE_RE.exec(name);
      if (!m || m[1] >= cutoff) continue;
      try {
        await fs.promises.unlink(path.join(logDir, name));
        removed++;
      } catch (err) {
        warn(`[files] 警告：清除過期日誌失敗 ${name}（${err.code || err.message}）`);
      }
    }
    return removed;
  }

  /** 確認日誌目錄可寫（啟動時呼叫） */
  async function checkWritable() {
    if (!logDir) return false;
    try {
      await fs.promises.mkdir(logDir, { recursive: true });
      await fs.promises.access(logDir, fs.constants.W_OK);
      writable = true;
    } catch (err) {
      warnWrite(err);
    }
    return writable === true;
  }

  /** 啟動：檢查目錄、清過期檔，之後每日清一次、每分鐘收限流摘要 */
  async function start() {
    await checkWritable();
    await cleanup();
    timers = [
      setInterval(() => { cleanup().catch(() => {}); }, DAY_MS),
      setInterval(() => flushSuppressed(), 60 * 1000),
    ];
    for (const t of timers) t.unref();
  }

  function stop() {
    for (const t of timers) clearInterval(t);
    timers = [];
  }

  /** 等所有排隊中的寫入完成（測試 / 關機用） */
  function drain() {
    return writeChain;
  }

  return { record, startDownload, startHash, snapshot, cleanup, start, stop, drain, flushSuppressed, checkWritable };
}

module.exports = { createFilesAudit, localDate };
