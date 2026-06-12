/**
 * cc JSONL 背景採集 watcher（監控 B 方案「持續/Push」核心）。
 *
 * 原計劃：採集是常駐的——監看 ~/.claude/projects，jsonl 一變就增量入庫，
 * 索引永遠最新、不靠人來看才掃。這是 B 方案勝過 CCHV（按需重掃）的前提，
 * 也是日後「即時告警 / 敏感詞即時審計」成立的基礎。
 *
 * 設計：
 *   - fs.watch(recursive) 監看整個 projects 樹（零依賴，不引 chokidar）。
 *   - debounce/合流：active cc session 會連續 append，事件爆量；用「首事件後
 *     固定窗口觸發一次」而非「每事件重置計時」，確保連續寫入下也會週期性掃描。
 *   - 不重疊：掃描期間來的事件記成 dirty，掃完再補一輪。
 *   - 啟動先掃一次（warm up），之後靠事件驅動。
 *   - 採集引擎是增量的（只讀新 byte），所以每次掃很便宜。
 */
const fs = require('fs');
const collector = require('./cc-collector');
const { PROJECTS_DIR } = require('./cc-history');

let watcher = null;
let timer = null;
let scanning = false;
let dirty = false;
let debounceMs = 1500;
let started = false;
let onScan = null; // 每次掃描後回呼（daemon 用來 WS 廣播給監控頁）

/** 設定掃描後回呼：fn(view)。view = scanAll() 的聚合結果。 */
function setOnScan(fn) { onScan = fn; }

function runScan() {
  timer = null;
  if (scanning) {
    dirty = true; // 正在掃，等掃完再補
    return;
  }
  if (!dirty) return;
  dirty = false;
  scanning = true;
  try {
    const view = collector.scanAll();
    console.log(
      `[usage-watcher] scan: sessions=${view.totals.sessions} turns=${view.totals.turns} ` +
      `in=${view.totals.tokens.input} out=${view.totals.tokens.output}`
    );
    if (onScan) {
      try { onScan(view); } catch (e) { console.error('[usage-watcher] onScan error:', e.message); }
    }
  } catch (err) {
    console.error('[usage-watcher] scan error:', err.message);
  } finally {
    scanning = false;
    if (dirty) schedule(); // 掃描期間又有新變動 → 再排一次
  }
}

function schedule() {
  // 已有計時器或正在掃 → 不重置（確保首事件後 debounceMs 內必觸發）
  if (timer || scanning) return;
  timer = setTimeout(runScan, debounceMs);
}

function onChange() {
  dirty = true;
  schedule();
}

/** 啟動背景採集。opts.debounceMs 可調合流窗口。回傳 true=已啟動。 */
function start(opts = {}) {
  if (started) return true;
  if (typeof opts.debounceMs === 'number') debounceMs = opts.debounceMs;

  if (!fs.existsSync(PROJECTS_DIR)) {
    console.warn(`[usage-watcher] ${PROJECTS_DIR} 不存在，暫不啟動（等目錄出現後可重啟 daemon）`);
    return false;
  }

  // 啟動先 warm up 掃一次，索引立刻可用
  dirty = true;
  runScan();

  try {
    watcher = fs.watch(PROJECTS_DIR, { recursive: true }, (eventType, filename) => {
      // 只在意 jsonl 變動（含子目錄）；filename 在某些平台可能為 null，保守一律觸發
      if (filename == null || String(filename).endsWith('.jsonl')) onChange();
    });
    watcher.on('error', (err) => console.error('[usage-watcher] watch error:', err.message));
    started = true;
    console.log(`[usage-watcher] watching ${PROJECTS_DIR} (debounce ${debounceMs}ms)`);
    return true;
  } catch (err) {
    console.error('[usage-watcher] fs.watch 失敗:', err.message);
    return false;
  }
}

/** 停止背景採集（daemon 關閉時呼叫）。 */
function stop() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (watcher) {
    try { watcher.close(); } catch {}
    watcher = null;
  }
  started = false;
}

module.exports = { start, stop, setOnScan };
