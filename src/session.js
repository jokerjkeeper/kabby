const pty = require('node-pty');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const RingBuffer = require('./ring-buffer');

const IS_WINDOWS = process.platform === 'win32';
// Windows 上 npm 全局 CLI 是 .cmd shim，沒 .exe。node-pty 能直接 spawn .cmd。
const DEFAULT_CMD = IS_WINDOWS ? 'claude.cmd' : 'claude';

class Session extends EventEmitter {
  constructor({ name, cwd, cmd, args, cols = 220, rows = 50, profileId = null }) {
    super();
    this.id = randomUUID();
    this.name = name;
    this.cwd = cwd || process.cwd();
    this.createdAt = new Date().toISOString();
    this.cols = cols;
    this.rows = rows;
    this.scrollback = new RingBuffer();
    this.clients = new Set();
    this.alive = true;
    this.exitCode = null;
    this.profileId = profileId;

    const spawnCmd = cmd || DEFAULT_CMD;
    const spawnArgs = args || ['--dangerously-skip-permissions'];

    // 若 args 含 --resume <id>，記下這個 cc session id 供佔用偵測用
    this.ccSessionId = extractResumeId(spawnArgs);

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
    // Replay scrollback so the new client sees the current screen
    const replay = this.scrollback.dump();
    if (replay && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data: replay }));
    }
  }

  detach(ws) {
    this.clients.delete(ws);
  }

  write(data) {
    if (!this.alive) return false;
    this.proc.write(data);
    return true;
  }

  resize(cols, rows) {
    if (!this.alive) return;
    this.cols = cols;
    this.rows = rows;
    try { this.proc.resize(cols, rows); } catch {}
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
      ccSessionId: this.ccSessionId,
    };
  }

  _broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }
}

function extractResumeId(args) {
  if (!Array.isArray(args)) return null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume' || args[i] === '-r') {
      return args[i + 1] || null;
    }
    // 也支援 --resume=<id>
    const m = /^--resume=(.+)$/.exec(args[i]);
    if (m) return m[1];
  }
  return null;
}

module.exports = Session;

