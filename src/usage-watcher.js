/**
 * JSONL 背景採集 watcher（監控 B 方案「持續/Push」核心）。
 *
 * 採集是常駐的——監看歷史目錄，jsonl 一變就增量入庫，索引永遠最新。
 * 這是 B 方案勝過 CCHV（按需重掃）的前提，也是即時告警/敏感詞審計的基礎。
 *
 * 設計：
 *   - fs.watch(recursive) 監看整棵樹（零依賴，不引 chokidar）。
 *   - debounce/合流：active session 連續 append，事件爆量；用「首事件後固定窗口
 *     觸發一次」而非「每事件重置」，確保連續寫入也週期掃描。
 *   - 不重疊：掃描期間來的事件記 dirty，掃完補一輪。
 *   - 啟動先掃一次（warm up）。採集引擎是增量的（只讀新 byte），每次掃很便宜。
 *
 * createWatcher 是工廠：每個 provider（claude → ~/.claude/projects、
 * codex → ~/.codex/sessions）各建一個實例，互不干擾。
 */
const fs = require('fs');

function createWatcher({ watchDir, collector, label }) {
  let watcher = null;
  let timer = null;
  let scanning = false;
  let dirty = false;
  let debounceMs = 1500;
  let started = false;
  let onScan = null;

  function setOnScan(fn) { onScan = fn; }

  function runScan() {
    timer = null;
    if (scanning) { dirty = true; return; }
    if (!dirty) return;
    dirty = false;
    scanning = true;
    try {
      const view = collector.scanAll();
      console.log(
        `[usage-watcher:${label}] scan: sessions=${view.totals.sessions} turns=${view.totals.turns} ` +
        `in=${view.totals.tokens.input} out=${view.totals.tokens.output}`
      );
      if (onScan) {
        try { onScan(view); } catch (e) { console.error(`[usage-watcher:${label}] onScan error:`, e.message); }
      }
    } catch (err) {
      console.error(`[usage-watcher:${label}] scan error:`, err.message);
    } finally {
      scanning = false;
      if (dirty) schedule();
    }
  }

  function schedule() {
    if (timer || scanning) return;
    timer = setTimeout(runScan, debounceMs);
  }

  function onChange() {
    dirty = true;
    schedule();
  }

  function start(opts = {}) {
    if (started) return true;
    if (typeof opts.debounceMs === 'number') debounceMs = opts.debounceMs;

    if (!fs.existsSync(watchDir)) {
      console.warn(`[usage-watcher:${label}] ${watchDir} 不存在，暫不啟動（等目錄出現後可重啟 daemon）`);
      return false;
    }

    dirty = true;
    runScan();

    try {
      watcher = fs.watch(watchDir, { recursive: true }, (eventType, filename) => {
        if (filename == null || String(filename).endsWith('.jsonl')) onChange();
      });
      watcher.on('error', (err) => console.error(`[usage-watcher:${label}] watch error:`, err.message));
      started = true;
      console.log(`[usage-watcher:${label}] watching ${watchDir} (debounce ${debounceMs}ms)`);
      return true;
    } catch (err) {
      console.error(`[usage-watcher:${label}] fs.watch 失敗:`, err.message);
      return false;
    }
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    started = false;
  }

  return { start, stop, setOnScan };
}

module.exports = { createWatcher };
