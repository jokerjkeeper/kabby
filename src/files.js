/**
 * 唯讀檔案下載服務（/api/files）。
 *
 * 讓內網其他機器從本機串流拉大型檔案（模型檔幾十 GB）：
 *   GET /api/files/list?path=&recursive=1   列目錄
 *   GET /api/files/stat?path=&hash=1        檔案資訊 + sha256（快取 / 串流計算）
 *   GET /api/files/raw?path=                串流下載，支援 Range 斷點續傳
 *
 * 分享根目錄：KABBY_FILES_ROOTS（多根，路徑第一段是名稱）或舊的 KABBY_FILES_ROOT（單根）。
 * 掛在 daemon 的 token middleware 之後，沿用 AUTH_TOKEN。本模組再加三道關：
 *   1. 帶 cf-connecting-ip / x-forwarded-for 的請求（經 tunnel / 代理轉入）一律 403
 *   2. KABBY_FILES_ALLOW_IPS 白名單（看 socket 位址，不信任 header）
 *   3. 路徑檢查：拒絕絕對路徑 / .. / ADS / UNC / 空字元，realpath 後必須仍在 root 底下
 * 點開頭的檔案或目錄一律不提供（list 不列、stat / raw 回 404）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const IS_WINDOWS = process.platform === 'win32';
const LIST_LIMIT = 100000;
const HASH_CHUNK = 1024 * 1024;

// 經 tunnel / 反向代理轉入的特徵 header；出現就拒絕
const PROXY_HEADERS = ['cf-connecting-ip', 'x-forwarded-for'];

/** 錯誤帶 HTTP status，handler 統一轉成 JSON 回應（訊息固定，不洩漏實際路徑） */
class FilesError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 去掉 IPv4-mapped IPv6 前綴（::ffff:10.1.2.3 → 10.1.2.3） */
function normalizeIp(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** 解析逗號分隔的白名單字串 → Set（空 = 不限） */
function parseAllowIps(value) {
  return new Set(String(value || '').split(',').map((s) => normalizeIp(s.trim())).filter(Boolean));
}

/** Windows 檔案系統不分大小寫，比對路徑時統一轉小寫 */
function cmpKey(p) {
  return IS_WINDOWS ? p.toLowerCase() : p;
}

/** child 是否等於 parent 或在 parent 底下（兩者都必須是 realpath） */
function isInside(parent, child) {
  const p = cmpKey(parent);
  const c = cmpKey(child);
  if (c === p) return true;
  const base = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(base);
}

/** 絕對路徑 → 相對 root、以 / 分隔 */
function toRel(rootReal, abs) {
  return path.relative(rootReal, abs).split(path.sep).join('/');
}

/**
 * 驗證使用者傳入的相對路徑，回傳拆好的路徑段。
 * 不合規丟 400；含點開頭段丟 404（當作不存在）。
 */
function splitUserPath(raw, { required }) {
  if (raw === undefined || raw === '') {
    if (required) throw new FilesError(400, 'path required');
    return [];
  }
  if (typeof raw !== 'string') throw new FilesError(400, 'invalid path');
  if (raw.includes('\0') || raw.includes(':')) throw new FilesError(400, 'invalid path');   // 空字元 / 磁碟代號 / ADS
  if (/^[\\/]/.test(raw) || path.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new FilesError(400, 'invalid path');   // 絕對路徑 / UNC（\\server\share、//server/share）
  }
  const segs = raw.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..')) throw new FilesError(400, 'invalid path');
  if (segs.some((s) => s.startsWith('.'))) throw new FilesError(404, 'not found');
  return segs;
}

const ROOT_NAME_RE = /^[a-z0-9_-]+$/;

/** 是否為絕對路徑（Windows 用 win32 規則：磁碟代號 / UNC） */
function isAbsPath(p) {
  return IS_WINDOWS ? path.win32.isAbsolute(p) : path.isAbsolute(p);
}

/**
 * 解析 /api/files 設定（啟動時呼叫一次）。
 * - roots（KABBY_FILES_ROOTS）：`名稱=路徑;名稱=路徑`，路徑第一段當名稱選根目錄（multi 模式）
 * - root（KABBY_FILES_ROOT）：舊的單一根目錄，路徑不帶名稱前綴（single 模式）
 * 兩個都設以 roots 為準。設定不合規 → mode='off' 並回 errors（daemon 照常啟動，只停用 /api/files）。
 * @returns {{ mode:'off'|'single'|'multi', roots:{name:string, abs:string}[], errors:string[], warnings:string[] }}
 */
function parseFilesConfig({ root, roots } = {}) {
  const result = { mode: 'off', roots: [], errors: [], warnings: [] };
  const rootsStr = String(roots || '').trim();
  const rootStr = String(root || '').trim();

  if (rootsStr) {
    if (rootStr) result.warnings.push('KABBY_FILES_ROOT 與 KABBY_FILES_ROOTS 都有設，以 KABBY_FILES_ROOTS 為準');
    const seen = new Set();
    for (const item of rootsStr.split(';').map((x) => x.trim()).filter(Boolean)) {
      const eq = item.indexOf('=');
      if (eq <= 0) { result.errors.push(`格式錯誤（應為 名稱=路徑）：${item}`); continue; }
      const name = item.slice(0, eq).trim();
      const dir = item.slice(eq + 1).trim();
      if (!ROOT_NAME_RE.test(name)) { result.errors.push(`名稱不合法（限 a-z 0-9 _ -）：${name}`); continue; }
      if (seen.has(name)) { result.errors.push(`名稱重複：${name}`); continue; }
      seen.add(name);
      if (!dir || !isAbsPath(dir)) { result.errors.push(`${name} 的路徑必須是絕對路徑：${dir}`); continue; }
      let st = null;
      try { st = fs.statSync(dir); } catch {}
      if (!st || !st.isDirectory()) { result.errors.push(`${name} 的路徑不存在或不是目錄：${dir}`); continue; }
      result.roots.push({ name, abs: path.resolve(dir) });
    }
    if (!result.errors.length && !result.roots.length) result.errors.push('KABBY_FILES_ROOTS 沒有任何根目錄');
    if (result.errors.length) result.roots = [];
    else result.mode = 'multi';
    return result;
  }

  if (rootStr) {
    const abs = path.resolve(rootStr);
    result.roots.push({ name: path.basename(abs) || abs.replace(/[\\/:]+/g, ''), abs });
    result.mode = 'single';
  }
  return result;
}

/**
 * 建立 /api/files router。
 * @param {object} opts
 * @param {string|null} [opts.root]     舊的單一分享根目錄（KABBY_FILES_ROOT）
 * @param {string|null} [opts.roots]    多根目錄（KABBY_FILES_ROOTS，`名稱=路徑;…`），有設以它為準
 * @param {object} [opts.config]        已解析好的 parseFilesConfig() 結果（給了就不再解析 root / roots）
 * @param {string} [opts.allowIps]      逗號分隔 IP 白名單（空 = 不限）
 * @param {(line:string)=>void} [opts.log]  存取日誌輸出（預設 stderr）
 * 設定為 off（未設或不合規）時全部回 404。
 */
function createFilesRouter({ root, roots, config, allowIps = '', log = (line) => console.error(line) } = {}) {
  const router = express.Router();
  const cfg = config || parseFilesConfig({ root, roots });

  if (cfg.mode === 'off') {
    router.use((req, res) => res.status(404).json({ error: 'files service disabled' }));
    return router;
  }

  const multi = cfg.mode === 'multi';
  const rootByName = new Map(cfg.roots.map((r) => [r.name, r]));
  const allowSet = parseAllowIps(allowIps);
  const hashCache = new Map();    // key → sha256 hex
  const hashInflight = new Map(); // key → Promise<sha256 hex>

  /** 取根目錄的 realpath（每次請求取，根目錄被搬動 / 換 junction 也正確） */
  async function getRootReal(rootDef) {
    try {
      return await fs.promises.realpath(rootDef.abs);
    } catch {
      throw new FilesError(503, 'files root unavailable');
    }
  }

  /** 對外路徑：multi 模式加上「名稱/」前綴 */
  function publicPath(rootDef, relInRoot) {
    if (!multi) return relInRoot;
    return relInRoot ? `${rootDef.name}/${relInRoot}` : rootDef.name;
  }

  /**
   * 使用者路徑 → { rootDef, rootReal, real, relInRoot, rel, st }；multi 模式且路徑為空時回 { isRootList:true }。
   * realpath 後確認仍在「該名稱對應的根目錄」底下（防 symlink / junction 逃逸），且解析後不落在點開頭的檔案或目錄。
   */
  async function resolveUserPath(raw, { required }) {
    let segs = splitUserPath(raw, { required });
    let rootDef = cfg.roots[0];
    if (multi) {
      if (!segs.length) return { isRootList: true };
      rootDef = rootByName.get(segs[0]);
      if (!rootDef) throw new FilesError(404, 'unknown root');
      segs = segs.slice(1);
    }
    const rootReal = await getRootReal(rootDef);
    const candidate = path.resolve(rootReal, ...segs);
    if (!isInside(rootReal, candidate)) throw new FilesError(400, 'invalid path');
    let real;
    try {
      real = await fs.promises.realpath(candidate);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new FilesError(404, 'not found');
      throw new FilesError(400, 'invalid path');
    }
    if (!isInside(rootReal, real)) throw new FilesError(400, 'invalid path');
    const relInRoot = toRel(rootReal, real);
    if (relInRoot.split('/').some((s) => s.startsWith('.'))) throw new FilesError(404, 'not found');
    const st = await fs.promises.stat(real);
    return { rootDef, rootReal, real, relInRoot, rel: publicPath(rootDef, relInRoot), st };
  }

  /** multi 模式根清單：每個根目錄一筆（不回絕對路徑；暫時無法存取的根略過） */
  async function listRoots() {
    const entries = [];
    for (const rootDef of cfg.roots) {
      try {
        const st = await fs.promises.stat(await getRootReal(rootDef));
        entries.push({ path: rootDef.name, size: 0, mtime: st.mtime.toISOString(), isDir: true });
      } catch {}
    }
    return { root: null, path: '', entries };
  }

  /** 串流計算 sha256；同一檔（key 相同）正在算時共用同一個 Promise */
  function computeSha256(real, key) {
    if (hashInflight.has(key)) return hashInflight.get(key);
    const promise = new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(real, { highWaterMark: HASH_CHUNK });
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    }).then((hex) => {
      hashCache.set(key, hex);
      return hex;
    }).finally(() => {
      hashInflight.delete(key);
    });
    hashInflight.set(key, promise);
    return promise;
  }

  /** 一行存取日誌 */
  function accessLog(req, fields) {
    const parts = [`[files] ${new Date().toISOString()}`, `ip=${normalizeIp(req.socket.remoteAddress)}`];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null || v === '') continue;
      parts.push(k === 'op' || k === 'result' ? String(v) : `${k}=${v}`);
    }
    log(parts.join(' '));
  }

  /** 把 FilesError / 其他錯誤轉成 JSON 回應 */
  function sendError(res, err) {
    const status = err instanceof FilesError ? err.status : 500;
    const message = err instanceof FilesError ? err.message : 'internal error';
    if (!res.headersSent) res.status(status).json({ error: message });
    return status;
  }

  // 關卡 1、2：代理 header、IP 白名單
  router.use((req, res, next) => {
    if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (allowSet.size && !allowSet.has(normalizeIp(req.socket.remoteAddress))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  });

  // GET /list?path=<相對目錄>&recursive=1
  router.get('/list', async (req, res) => {
    try {
      const resolved = await resolveUserPath(req.query.path, { required: false });
      // multi 模式根清單：只列第一層名稱，不遞迴（避免一次掃整棵上百 GB 的樹）
      if (resolved.isRootList) return res.json(await listRoots());
      const { rootDef, rootReal, real, rel, st } = resolved;
      if (!st.isDirectory()) throw new FilesError(400, 'not a directory');
      const recursive = req.query.recursive === '1' || req.query.recursive === 'true';
      const entries = [];
      let truncated = false;
      const stack = [real];
      // 走訪目錄：不跟進 symlink / junction（list 只列真實檔案），跳過點開頭的項目
      while (stack.length && !truncated) {
        const dir = stack.pop();
        let dirents;
        try {
          dirents = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          continue;   // 權限不足等：略過該目錄
        }
        dirents.sort((a, b) => a.name.localeCompare(b.name));
        for (const d of dirents) {
          if (d.name.startsWith('.') || d.isSymbolicLink()) continue;
          if (!d.isFile() && !d.isDirectory()) continue;
          const abs = path.join(dir, d.name);
          let est;
          try {
            est = await fs.promises.stat(abs);
          } catch {
            continue;
          }
          if (entries.length >= LIST_LIMIT) { truncated = true; break; }
          entries.push({
            path: publicPath(rootDef, toRel(rootReal, abs)),
            size: d.isDirectory() ? 0 : est.size,
            mtime: est.mtime.toISOString(),
            isDir: d.isDirectory(),
          });
          if (recursive && d.isDirectory()) stack.push(abs);
        }
      }
      const body = { root: rootDef.name, path: rel, entries };
      if (truncated) body.truncated = true;
      res.json(body);
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /stat?path=<檔案>&hash=1
  router.get('/stat', async (req, res) => {
    const wantHash = req.query.hash === '1' || req.query.hash === 'true';
    const started = Date.now();
    let relForLog = typeof req.query.path === 'string' ? req.query.path : '';
    try {
      const { real, rel, st } = await resolveUserPath(req.query.path, { required: true });
      relForLog = rel;
      if (!st.isFile()) throw new FilesError(400, 'not a file');
      const key = `${real}|${st.size}|${st.mtimeMs}`;
      let sha256 = hashCache.get(key) || null;
      let cached = !!sha256;
      if (!sha256 && wantHash) sha256 = await computeSha256(real, key);
      if (wantHash) {
        accessLog(req, { op: 'hash', path: rel, status: 200, ms: Date.now() - started, result: cached ? 'cached' : 'ok' });
      }
      res.json({ path: rel, size: st.size, mtime: st.mtime.toISOString(), sha256 });
    } catch (err) {
      const status = sendError(res, err);
      if (wantHash) accessLog(req, { op: 'hash', path: relForLog, status, ms: Date.now() - started, result: 'error' });
    }
  });

  // GET /raw?path=<檔案>：交給 send 處理 Range / ETag / Last-Modified；斷線時 send 會關掉 read stream
  router.get('/raw', async (req, res) => {
    const started = Date.now();
    let relForLog = typeof req.query.path === 'string' ? req.query.path : '';
    let bytes = 0;
    let errored = false;
    // 計算實際傳出的 body bytes
    const origWrite = res.write;
    res.write = function countingWrite(chunk, ...rest) {
      if (chunk) bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      return origWrite.call(this, chunk, ...rest);
    };
    res.once('close', () => {
      const result = errored ? 'error' : (res.writableFinished ? 'ok' : 'aborted');
      accessLog(req, {
        op: 'raw', path: relForLog, range: req.headers.range, status: res.statusCode,
        bytes, ms: Date.now() - started, result,
      });
    });
    try {
      const { rootReal, relInRoot, rel, st } = await resolveUserPath(req.query.path, { required: true });
      relForLog = rel;
      if (!st.isFile()) throw new FilesError(400, 'not a file');
      // 傳相對路徑 + root：dotfiles 檢查只看 root 以下的部分（root 本身路徑含點目錄也不受影響）
      res.sendFile(relInRoot, { root: rootReal, dotfiles: 'deny', acceptRanges: true, lastModified: true, etag: true }, (err) => {
        if (!err) return;
        if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET' || res.destroyed) return;   // 用戶端斷線
        errored = true;
        if (!res.headersSent) {
          const status = err.status || err.statusCode || 500;
          res.status(status).json({ error: status === 404 ? 'not found' : status === 416 ? 'range not satisfiable' : 'internal error' });
        } else {
          res.destroy();
        }
      });
    } catch (err) {
      errored = true;
      sendError(res, err);
    }
  });

  return router;
}

module.exports = { createFilesRouter, parseFilesConfig, normalizeIp, splitUserPath, isInside };
