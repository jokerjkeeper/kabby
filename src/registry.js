const Session = require('./session');

class Registry {
  constructor() {
    this.sessions = new Map(); // id → Session
  }

  create(opts) {
    if (opts.name) {
      for (const s of this.sessions.values()) {
        if (s.name === opts.name && s.alive) {
          throw new Error(`session name already in use: ${opts.name}`);
        }
      }
    }
    const session = new Session(opts);
    this.sessions.set(session.id, session);
    session.on('exit', () => {
      // PTY 死掉後仍保留物件（讓 client 看到 exit code），但下次 list 過濾掉
      // v1：直接從 map 移除，簡單就好
      this.sessions.delete(session.id);
    });
    return session;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  getByName(name) {
    for (const s of this.sessions.values()) {
      if (s.name === name) return s;
    }
    return null;
  }

  list() {
    return Array.from(this.sessions.values()).map((s) => s.toJSON());
  }

  // 哪些 cc session id 正被運行中的 PTY 佔用
  busyCcSessionIds() {
    const ids = new Set();
    for (const s of this.sessions.values()) {
      if (s.alive && s.ccSessionId) ids.add(s.ccSessionId);
    }
    return ids;
  }

  destroy(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.kill();
    this.sessions.delete(id);
    return true;
  }
}

module.exports = new Registry();
