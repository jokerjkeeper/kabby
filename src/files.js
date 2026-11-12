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
 *   2. KABBY_FILES_ALLOW_IPS 白名單（看 socket 位址，不信任 header；支援單一 IP、10.1.129.*、CIDR）
 *   3. 路徑檢查：拒絕絕對路徑 / .. / ADS / UNC / 空字元，realpath 後必須仍在 root 底下
 * 點開頭的檔案或目錄一律不提供（list 不列、stat / raw 回 404）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createFilesAudit } = require('./files-audit');

const IS_WINDOWS = process.platform === 'win32';
const LIST_LIMIT = 100000;
const HASH_CHUNK = 1024 * 1024;

// 經 tunnel / 反向代理轉入的特徵 header；出現就拒絕
const PROXY_HEADERS = ['cf-connecting-ip', 'x-forwarded-for'];

// 錯誤訊息 → 稽核日誌的 reason 代碼
const REASON_BY_MESSAGE = {
  'invalid path': 'invalid_path',
  'path required': 'invalid_path',
  'not found': 'not_found',
  'unknown root': 'unknown_root',
  'not a file': 'not_a_file',
  'not a directory': 'not_a_directory',
  'files root unavailable': 'root_unavailable',
};
// 這些 reason 算「被拒」（稽核重點，result=denied）；其餘錯誤 result=error
const DENIED_REASONS = new Set(['bad_token', 'proxy_header', 'ip_not_allowed', 'invalid_path', 'dotfile']);

/** 錯誤帶 HTTP status 與稽核 reason，handler 統一轉成 JSON 回應（訊息固定，不洩漏實際路徑） */
class FilesError extends Error {
  constructor(status, message, reason) {
    super(message);
    this.status = status;
    this.reason = reason || REASON_BY_MESSAGE[message] || 'error';
  }
}

/** 去掉 IPv4-mapped IPv6 前綴（::ffff:10.1.2.3 → 10.1.2.3） */
function normalizeIp(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** IPv4 字串 → 32-bit 無號整數；不是合法 IPv4 回 null */
function ipv4ToInt(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
}

/** 前綴長度 → 遮罩（/0 = 0、/32 = 全 1） */
function prefixMask(bits) {
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

/** 網段規則：base 已套遮罩 */
function v4Rule(text, ipInt, bits) {
  const mask = prefixMask(bits);
  return { text, kind: 'v4', base: (ipInt & mask) >>> 0, mask };
}

/**
 * 解析白名單的一筆。支援：
 *   10.1.129.20     單一 IPv4（::ffff: 前綴會去掉）
 *   10.1.129.*      萬用字元，只能放在結尾的整段（10.1.*.* 可、10.*.1.5 / 10.1.129.1* 不可）
 *   10.1.129.0/24   CIDR（/0 ~ /32）
 *   ::1             IPv6 只做完整字串比對
 * 不合法回 null。
 */
function parseAllowRule(entry) {
  const s = normalizeIp(entry);
  if (s.includes('*')) {
    const parts = s.split('.');
    const first = parts.indexOf('*');
    if (parts.length !== 4 || first < 1) return null;   // 單獨 * 或 *.x.x.x 不收（不限請留空）
    if (parts.slice(first).some((p) => p !== '*')) return null;
    const ipInt = ipv4ToInt(parts.map((p) => (p === '*' ? '0' : p)).join('.'));
    return ipInt === null ? null : v4Rule(s, ipInt, first * 8);
  }
  if (s.includes('/')) {
    const [ip, len, extra] = s.split('/');
    const ipInt = ipv4ToInt(ip);
    if (extra !== undefined || ipInt === null || !/^\d{1,2}$/.test(len) || Number(len) > 32) return null;
    return v4Rule(s, ipInt, Number(len));
  }
  const ipInt = ipv4ToInt(s);
  if (ipInt !== null) return v4Rule(s, ipInt, 32);
  if (/^[0-9a-f:]+$/i.test(s) && s.includes(':')) return { text: s, kind: 'exact', ip: s.toLowerCase() };
  return null;
}

/**
 * 解析逗號分隔的白名單字串。
 * 回傳 { configured, rules, invalid }：configured = 有填任何東西（空 = 不限）。
 * 有填但全部不合法時 rules 為空 → ipAllowed 一律拒絕（寫錯不能變成全開）。
 */
function parseAllowIps(value) {
  const entries = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  const rules = [];
  const invalid = [];
  for (const entry of entries) {
    const rule = parseAllowRule(entry);
    if (rule) rules.push(rule);
    else invalid.push(entry);
  }
  return { configured: entries.length > 0, rules, invalid };
}

/** 來源 IP 是否在白名單內（未設定 = 全部放行） */
function ipAllowed(allow, ip) {
  if (!allow.configured) return true;
  const addr = normalizeIp(ip || '');
  const ipInt = ipv4ToInt(addr);
  return allow.rules.some((r) => (r.kind === 'v4'
    ? ipInt !== null && ((ipInt & r.mask) >>> 0) === r.base
    : r.ip === addr.toLowerCase()));
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
  if (segs.some((s) => s.startsWith('.'))) throw new FilesError(404, 'not found', 'dotfile');
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
 * @param {string} [opts.allowIps]      逗號分隔 IP 白名單：單一 IP、10.1.129.*、10.1.129.0/24（空 = 不限）
 * @param {(line:string)=>void} [opts.log]  stderr 存取日誌輸出（預設 stderr）
 * @param {object} [opts.audit]         createFilesAudit() 實例（JSONL 稽核 + 即時狀態）；省略 = 只記記憶體
 * 設定為 off（未設或不合規）時全部回 404（/activity 回 { enabled:false }）。
 * 回傳的 router 帶 recordBadToken(req)：給 daemon 的 token middleware 在 /api/files 認證失敗時記稽核。
 */
function createFilesRouter({ root, roots, config, allowIps = '', log = (line) => console.error(line), audit } = {}) {
  const router = express.Router();
  const cfg = config || parseFilesConfig({ root, roots });

  if (cfg.mode === 'off') {
    router.recordBadToken = () => {};
    router.get('/activity', (req, res) => res.json({ enabled: false }));
    router.use((req, res) => res.status(404).json({ error: 'files service disabled' }));
    return router;
  }

  const auditor = audit || createFilesAudit({ logDir: null });

  const multi = cfg.mode === 'multi';
  const rootByName = new Map(cfg.roots.map((r) => [r.name, r]));
  const allow = parseAllowIps(allowIps);
  for (const bad of allow.invalid) log(`[files] 警告：KABBY_FILES_ALLOW_IPS 忽略不合法的項目「${bad}」`);
  if (allow.configured && !allow.rules.length) {
    log('[files] 錯誤：KABBY_FILES_ALLOW_IPS 沒有任何合法項目 — /api/files 一律拒絕（不限來源請留空）');
  }
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
    if (relInRoot.split('/').some((s) => s.startsWith('.'))) throw new FilesError(404, 'not found', 'dotfile');
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

  /** 串流計算 sha256；同一檔（key 相同）正在算時共用同一個 Promise。進度回報給 auditor */
  function computeSha256(real, key, info) {
    if (hashInflight.has(key)) return hashInflight.get(key);
    const tracker = auditor.startHash(info);
    const promise = new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(real, { highWaterMark: HASH_CHUNK });
      stream.on('data', (chunk) => { hash.update(chunk); tracker.progress(chunk.length); });
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    }).then((hex) => {
      hashCache.set(key, hex);
      return hex;
    }).finally(() => {
      tracker.end();
      hashInflight.delete(key);
    });
    hashInflight.set(key, promise);
    return promise;
  }

  /** stderr 一行存取日誌（只記 raw / hash，格式沿用 daemon 的 [tag]） */
  function stderrLine(ev) {
    const parts = [`[files] ${new Date().toISOString()}`, `ip=${ev.ip}`, ev.endpoint];
    for (const k of ['path', 'range', 'status', 'bytes', 'ms']) {
      const v = ev[k];
      if (v === undefined || v === null || v === '') continue;
      parts.push(`${k}=${v}`);
    }
    parts.push(ev.result);
    log(parts.join(' '));
  }

  /** 把 FilesError / 其他錯誤轉成 JSON 回應，並把 reason 記到稽核 context */
  function sendError(res, err) {
    const status = err instanceof FilesError ? err.status : 500;
    const message = err instanceof FilesError ? err.message : 'internal error';
    const ctx = res.locals.files;
    if (ctx && !ctx.reason) ctx.reason = err instanceof FilesError ? err.reason : 'internal';
    if (!res.headersSent) res.status(status).json({ error: message });
    return status;
  }

  /** 請求屬於哪個端點（稽核欄位 endpoint） */
  function endpointOf(req, reqPath) {
    const name = String(reqPath || '').replace(/^\/+/, '').split('/')[0];
    if (name === 'stat' && (req.query.hash === '1' || req.query.hash === 'true')) return 'hash';
    return ['list', 'stat', 'raw', 'activity'].includes(name) ? name : 'other';
  }

  /** 使用者傳的 path（稽核用，截長） */
  function rawPathOf(req) {
    return typeof req.query.path === 'string' ? req.query.path.slice(0, 512) : '';
  }

  /** daemon token middleware 在 /api/files/* 認證失敗時呼叫：只記 reason，絕不記 token 值 */
  router.recordBadToken = (req) => {
    const reqPath = String(req.path || '').replace(/^\/files/, '');
    auditor.record({
      ip: normalizeIp(req.socket.remoteAddress), method: req.method, endpoint: endpointOf(req, reqPath),
      path: rawPathOf(req), status: 401, ms: 0, result: 'denied', reason: 'bad_token',
    });
  };

  // 即時狀態：只需 token（daemon 已驗），不套代理 header / IP 白名單；輪詢請求不寫稽核日誌
  router.get('/activity', (req, res) => {
    res.json({
      enabled: true,
      ...auditor.snapshot(),
      config: {
        mode: cfg.mode,
        roots: cfg.roots.map((r) => r.name),
        allowIps: allow.rules.map((r) => r.text),
      },
    });
  });

  // 稽核 context：每個請求結束（含中途斷線）記一筆；raw / hash 另寫 stderr
  router.use((req, res, next) => {
    const ctx = {
      endpoint: endpointOf(req, req.path), path: rawPathOf(req), range: req.headers.range,
      bytes: 0, size: null, result: null, reason: null, started: Date.now(),
    };
    res.locals.files = ctx;
    res.once('close', () => {
      const status = res.statusCode;
      let result = ctx.result;
      if (!result) {
        if (status >= 400) result = DENIED_REASONS.has(ctx.reason) ? 'denied' : 'error';
        else result = res.writableFinished ? 'ok' : 'aborted';
      }
      if (status >= 400 && !ctx.reason) ctx.reason = status === 404 ? 'not_found' : status === 416 ? 'range_not_satisfiable' : 'error';
      const ev = {
        ip: normalizeIp(req.socket.remoteAddress), method: req.method, endpoint: ctx.endpoint,
        path: ctx.path, range: ctx.range, status, bytes: ctx.endpoint === 'raw' ? ctx.bytes : undefined,
        size: ctx.size, ms: Date.now() - ctx.started, result, reason: status >= 400 ? ctx.reason : undefined,
      };
      auditor.record(ev);
      if (ctx.endpoint === 'raw' || ctx.endpoint === 'hash') stderrLine(ev);
    });
    next();
  });

  // 關卡 1、2：代理 header、IP 白名單
  router.use((req, res, next) => {
    if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) {
      res.locals.files.reason = 'proxy_header';
      return res.status(403).json({ error: 'forbidden' });
    }
    if (!ipAllowed(allow, req.socket.remoteAddress)) {
      res.locals.files.reason = 'ip_not_allowed';
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
    const ctx = res.locals.files;
    try {
      const { real, rel, st } = await resolveUserPath(req.query.path, { required: true });
      ctx.path = rel;
      if (!st.isFile()) throw new FilesError(400, 'not a file');
      ctx.size = st.size;
      const key = `${real}|${st.size}|${st.mtimeMs}`;
      let sha256 = hashCache.get(key) || null;
      if (sha256 && wantHash) ctx.result = 'cached';
      if (!sha256 && wantHash) sha256 = await computeSha256(real, key, { path: rel, size: st.size });
      res.json({ path: rel, size: st.size, mtime: st.mtime.toISOString(), sha256 });
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /raw?path=<檔案>：交給 send 處理 Range / ETag / Last-Modified；斷線時 send 會關掉 read stream
  router.get('/raw', async (req, res) => {
    const ctx = res.locals.files;
    let tracker = null;
    // 計算實際傳出的 body bytes，同步回報給即時狀態
    const origWrite = res.write;
    res.write = function countingWrite(chunk, ...rest) {
      if (chunk) {
        const n = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        ctx.bytes += n;
        if (tracker) tracker.add(n);
      }
      return origWrite.call(this, chunk, ...rest);
    };
    res.once('close', () => { if (tracker) tracker.end(); });
    try {
      const { rootReal, relInRoot, rel, st } = await resolveUserPath(req.query.path, { required: true });
      ctx.path = rel;
      if (!st.isFile()) throw new FilesError(400, 'not a file');
      ctx.size = st.size;
      // 預估這次要傳的 bytes（Range 合法時為區段長度，否則整檔）
      const ranges = req.headers.range ? req.range(st.size) : null;
      const total = Array.isArray(ranges) ? ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0) : st.size;
      if (!res.destroyed) {
        tracker = auditor.startDownload({ ip: normalizeIp(req.socket.remoteAddress), path: rel, range: req.headers.range, total });
      }
      // 傳相對路徑 + root：dotfiles 檢查只看 root 以下的部分（root 本身路徑含點目錄也不受影響）
      res.sendFile(relInRoot, { root: rootReal, dotfiles: 'deny', acceptRanges: true, lastModified: true, etag: true }, (err) => {
        if (!err) return;
        if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET' || res.destroyed) return;   // 用戶端斷線
        if (!res.headersSent) {
          const status = err.status || err.statusCode || 500;
          ctx.reason = status === 404 ? 'not_found' : status === 416 ? 'range_not_satisfiable' : 'internal';
          res.status(status).json({ error: status === 404 ? 'not found' : status === 416 ? 'range not satisfiable' : 'internal error' });
        } else {
          ctx.result = 'error';
          res.destroy();
        }
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

module.exports = { createFilesRouter, parseFilesConfig, normalizeIp, splitUserPath, isInside, parseAllowIps, ipAllowed };
