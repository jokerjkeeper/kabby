const pty = require('node-pty');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const RingBuffer = require('./ring-buffer');
const sensitive = require('./sensitive');
const { createInputFilter } = require('./input-filter');
const providers = require('./providers');

const INPUT_MATCHER_TTL = 3000; // 敏感詞 matcher 快取（避免每個 keystroke 都讀檔）

class Session extends EventEmitter {
  constructor({ name, cwd, cmd, args, cols = 220, rows = 50, profileId = null, provider = 'claude' }) {
    super();
    const providerInfo = providers.getProvider(provider);
    this.id = randomUUID();
    this.name = name;
    this.provider = providerInfo.id;
    this.cwd = cwd || process.cwd();
    this.createdAt = new Date().toISOString();
    this.cols = cols;
    this.rows = rows;
    this.scrollback = new RingBuffer();
    this.clients = new Set();
    this.alive = true;
    this.exitCode = null;
    this.profileId = profileId;

    // D 方案：輸入即時攔截（組行 + 敏感詞比對）。matcher 快取，每 3s 重讀設定。
    this._inputFilter = createInputFilter();
    this._inputMatcher = null;
    this._inputMatcherAt = 0;

    const spawnCmd = cmd || providers.defaultCmd(this.provider);
    const spawnArgs = Array.isArray(args) ? args : providers.defaultArgs(this.provider);

    // 若 args 含 provider 的 resume 參數，記下這個歷史 session id 供佔用偵測用
    this.resumeSessionId = providers.extractResumeSessionId(this.provider, spawnArgs);

    try {
      this.proc = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols, rows,
        cwd: this.cwd,
        env: process.env,
      });
    } catch (err) {
      const raw = err && err.message ? err.message : String(err);
      throw new Error(
        `無法啟動 "${spawnCmd}"：${raw}。` +
        ` 請確認執行檔存在於 PATH，或在「執行檔」欄填完整路徑（args 應在「啟動參數」欄）。`
      );
    }

    this.proc.onData((data) => {
      this.scrollback.append(data);
      this._broadcast({ type: 'output', data });
    });

    this.proc.onExit(({ exitCode, signal }) => {
      this.alive = false;
      this.exitCode = exitCode;
      this._broadcast({ type: 'exit', code: exitCode, signal });
      this.emit('exit', { exitCode, signal });
    });
  }

  attach(ws) {
    this.clients.add(ws);
    if (ws.readyState === ws.OPEN) {
      // 先告知目前 PTY 尺寸（訪客端要固定 resize 成這個大小才能正確渲染），再 replay scrollback
      ws.send(JSON.stringify({ type: 'termsize', cols: this.cols, rows: this.rows }));
      const replay = this.scrollback.dump();
      if (replay) ws.send(JSON.stringify({ type: 'output', data: replay }));
    }
  }

  detach(ws) {
    this.clients.delete(ws);
  }

  // 取（快取的）輸入攔截 matcher；blockInput 關閉時回 null
  _getInputMatcher() {
    const now = Date.now();
    if (now - this._inputMatcherAt > INPUT_MATCHER_TTL) {
      const cfg = sensitive.load();
      this._inputMatcher = cfg.blockInput ? sensitive.buildMatcher(cfg) : null;
      this._inputMatcherAt = now;
    }
    return this._inputMatcher;
  }

  // 回傳 { ok, blocked:[...] }。攔截命中時不送進 cc，並廣播 blocked 給 clients。
  write(data) {
    if (!this.alive) return { ok: false, blocked: [] };
    const matcher = this._getInputMatcher();
    if (!matcher) {
      this.proc.write(data);
      return { ok: true, blocked: [] };
    }
    const { forward, blockedWords } = this._inputFilter.feed(data, matcher);
    if (forward) this.proc.write(forward);
    if (blockedWords.length) {
      this._broadcast({ type: 'blocked', words: blockedWords, ts: new Date().toISOString() });
      return { ok: false, blocked: blockedWords };
    }
    return { ok: true, blocked: [] };
  }

  resize(cols, rows) {
    if (!this.alive) return;
    this.cols = cols;
    this.rows = rows;
    try { this.proc.resize(cols, rows); } catch {}
    // 通知所有 client 新尺寸（訪客端跟著 resize 自己的 xterm；host 端忽略此訊息）
    this._broadcast({ type: 'termsize', cols, rows });
  }

  kill() {
    if (!this.alive) return;
    try { this.proc.kill(); } catch {}
    this.alive = false;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      createdAt: this.createdAt,
      cols: this.cols,
      rows: this.rows,
      clientCount: this.clients.size,
      alive: this.alive,
      exitCode: this.exitCode,
      profileId: this.profileId,
      provider: this.provider,
      resumeSessionId: this.resumeSessionId,
      ccSessionId: this.provider === 'claude' ? this.resumeSessionId : null,
    };
  }

  _broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }
}

module.exports = Session;
