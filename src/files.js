/**
 * 唯讀檔案下載服務（/api/files）。
 *
 * 讓內網其他機器從本機串流拉大型檔案（模型檔幾十 GB）：
 *   GET /api/files/list?path=&recursive=1   列目錄
 *   GET /api/files/stat?path=&hash=1        檔案資訊 + sha256（快取 / 串流計算）
 *   GET /api/files/raw?path=                串流下載，支援 Range 斷點續傳
 *
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

/**
 * 建立 /api/files router。
 * @param {object} opts
 * @param {string|null} opts.root       分享根目錄（未設 = 功能關閉，全部 404）
 * @param {string} [opts.allowIps]      逗號分隔 IP 白名單（空 = 不限）
 * @param {(line:string)=>void} [opts.log]  存取日誌輸出（預設 stderr）
 */
function createFilesRouter({ root, allowIps = '', log = (line) => console.error(line) } = {}) {
  const router = express.Router();

  if (!root) {
    router.use((req, res) => res.status(404).json({ error: 'files service disabled' }));
    return router;
  }

  const allowSet = parseAllowIps(allowIps);
  const rootAbs = path.resolve(root);
  const rootName = path.basename(rootAbs) || rootAbs.replace(/[\\/:]+/g, '');
  const hashCache = new Map();    // key → sha256 hex
  const hashInflight = new Map(); // key → Promise<sha256 hex>

  /** 取 root 的 realpath（每次請求取，root 被搬動 / 換 junction 也正確） */
  async function getRootReal() {
    try {
      return await fs.promises.realpath(rootAbs);
    } catch {
      throw new FilesError(503, 'files root unavailable');
    }
  }

  /**
   * 使用者路徑 → { rootReal, real, rel, st }。
   * realpath 後確認仍在 root 底下（防 symlink / junction 逃逸），且解析後不落在點開頭的檔案或目錄。
   */
  async function resolveUserPath(raw, { required }) {
    const segs = splitUserPath(raw, { required });
    const rootReal = await getRootReal();
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
    const rel = toRel(rootReal, real);
    if (rel.split('/').some((s) => s.startsWith('.'))) throw new FilesError(404, 'not found');
    const st = await fs.promises.stat(real);
    return { rootReal, real, rel, st };
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
      const { rootReal, real, rel, st } = await resolveUserPath(req.query.path, { required: false });
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
            path: toRel(rootReal, abs),
            size: d.isDirectory() ? 0 : est.size,
            mtime: est.mtime.toISOString(),
            isDir: d.isDirectory(),
          });
          if (recursive && d.isDirectory()) stack.push(abs);
        }
      }
      const body = { root: rootName, path: rel, entries };
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
      const { rootReal, rel, st } = await resolveUserPath(req.query.path, { required: true });
      relForLog = rel;
      if (!st.isFile()) throw new FilesError(400, 'not a file');
      // 傳相對路徑 + root：dotfiles 檢查只看 root 以下的部分（root 本身路徑含點目錄也不受影響）
      res.sendFile(rel, { root: rootReal, dotfiles: 'deny', acceptRanges: true, lastModified: true, etag: true }, (err) => {
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

module.exports = { createFilesRouter, normalizeIp, splitUserPath, isInside };
