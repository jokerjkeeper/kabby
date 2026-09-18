const { randomUUID, randomBytes } = require('crypto');

// 聊天室（房間）registry — 全部存記憶體，跟 session registry 一樣不跨 daemon 重啟。
// 一個房間綁一個 running session（一 session 至多一房）；三組密碼決定進場角色：
//   主密碼 master → 房內全權（寫終端 + 房間管理）
//   協作密碼 collab → 可寫終端（受 frozen 管制）
//   訪客密碼 guest  → 只能看
// 訪客用密碼換 ticket（含 role），ticket 是 WS 連線的憑證。密碼全域唯一，
// 所以只憑密碼即可解析出「哪個房 + 哪個角色」。

const CHAT_LOG_MAX = 200;   // 每房保留的聊天訊息數（新訪客進房 replay 用）
const CHAT_IMG_KEEP = 20;   // 圖片訊息只保留最近 N 張（base64 存記憶體，控上限），舊的退化成佔位
const PASS_MIN_LEN = 4;

const ROLES = ['master', 'collab', 'guest'];

// 角色在指定 frozen 狀態下的「有效終端寫入權」
function effectiveWrite(role, frozen) {
  if (role === 'master') return true;          // 房主一律可寫（凍結是給協作者用的）
  if (role === 'collab') return !frozen;       // 協作者：非凍結才可寫
  return false;                                 // 訪客只能看
}

class Room {
  constructor({ name, masterPass, collabPass, guestPass, sessionId, sessionName, frozen = false }) {
    this.id = randomUUID();
    this.name = name;
    this.masterPass = masterPass || null;
    this.collabPass = collabPass || null;
    this.guestPass = guestPass || null;
    // 每個有設密碼的角色，配一個不透明邀請碼（放進分享連結，避免明文密碼出現在 URL）
    const mkInvite = () => randomBytes(12).toString('base64url');
    this.masterInvite = this.masterPass ? mkInvite() : null;
    this.collabInvite = this.collabPass ? mkInvite() : null;
    this.guestInvite = this.guestPass ? mkInvite() : null;
    this.sessionId = sessionId;
    this.sessionName = sessionName;
    this.frozen = !!frozen;
    this.createdAt = new Date().toISOString();
    this.closed = false;
    this.guests = new Map();      // ticket → { nickname, joinedAt, ws|null, role }
    this.hostSockets = new Set(); // 房主聊天面板的 WS（/ws/room/:id）
    this.chatLog = [];            // { from:'host'|'guest'|'system', nickname, text, ts }
    this.ccSessionId = null;      // 對話記錄定位到的 JSONL session id 快取
  }

  // 這個密碼對應的角色（null = 不符任何角色）
  roleForPassword(pw) {
    if (!pw) return null;
    if (this.masterPass && pw === this.masterPass) return 'master';
    if (this.collabPass && pw === this.collabPass) return 'collab';
    if (this.guestPass && pw === this.guestPass) return 'guest';
    return null;
  }

  // 這個邀請碼對應的角色（null = 不符）
  roleForInvite(token) {
    if (!token) return null;
    if (this.masterInvite && token === this.masterInvite) return 'master';
    if (this.collabInvite && token === this.collabInvite) return 'collab';
    if (this.guestInvite && token === this.guestInvite) return 'guest';
    return null;
  }

  // 這個房用到的所有（非空）密碼
  passwords() {
    return [this.masterPass, this.collabPass, this.guestPass].filter(Boolean);
  }

  addChat(entry) {
    this.chatLog.push(entry);
    if (this.chatLog.length > CHAT_LOG_MAX) {
      this.chatLog.splice(0, this.chatLog.length - CHAT_LOG_MAX);
    }
    // 圖片配額：由新到舊數，超過 CHAT_IMG_KEEP 的舊圖釋放記憶體、標記過期
    let imgCount = 0;
    for (let i = this.chatLog.length - 1; i >= 0; i--) {
      const m = this.chatLog[i];
      if (m.image) {
        imgCount += 1;
        if (imgCount > CHAT_IMG_KEEP) { m.image = null; m.imageExpired = true; }
      }
    }
    return entry;
  }

  // 廣播給房內所有成員（房主聊天面板 + 所有在線訪客）
  broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const ws of this.hostSockets) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
    for (const g of this.guests.values()) {
      if (g.ws && g.ws.readyState === g.ws.OPEN) g.ws.send(payload);
    }
  }

  // 訪客在線名單（房主面板 + 訪客頁共用），含角色與 ticket（房主踢人用）
  presence() {
    return Array.from(this.guests.entries()).map(([ticket, g]) => ({
      ticket,
      nickname: g.nickname,
      role: g.role,
      joinedAt: g.joinedAt,
      online: !!(g.ws && g.ws.readyState === g.ws.OPEN),
    }));
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      masterPass: this.masterPass,
      collabPass: this.collabPass,
      guestPass: this.guestPass,
      masterInvite: this.masterInvite,
      collabInvite: this.collabInvite,
      guestInvite: this.guestInvite,
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      frozen: this.frozen,
      createdAt: this.createdAt,
      guests: this.presence(),
    };
  }
}

class RoomRegistry {
  constructor() {
    this.rooms = new Map();   // roomId → Room
    this.tickets = new Map(); // ticket → roomId
  }

  create({ name, masterPass, collabPass, guestPass, sessionId, sessionName, frozen }) {
    if (!name || typeof name !== 'string') throw new Error('房間名稱必填');

    // 一 session 至多一房
    if (this.findBySessionId(sessionId)) {
      throw new Error('此 session 已有聊天室，請直接使用或先關閉');
    }

    // 整理三組密碼
    const trim = (v) => (typeof v === 'string' ? v.trim() : '');
    const passes = { master: trim(masterPass), collab: trim(collabPass), guest: trim(guestPass) };
    const nonEmpty = ROLES.filter((r) => passes[r]);
    if (!nonEmpty.length) throw new Error('至少要設定一組密碼（主 / 協作 / 訪客）');
    for (const r of nonEmpty) {
      if (passes[r].length < PASS_MIN_LEN) {
        throw new Error(`密碼至少 ${PASS_MIN_LEN} 個字元`);
      }
    }
    // 房內三組不可互相重複
    const seen = new Set();
    for (const r of nonEmpty) {
      if (seen.has(passes[r])) throw new Error('三組密碼不可相同');
      seen.add(passes[r]);
    }
    // 全域唯一（跨房、跨角色）
    for (const r of nonEmpty) {
      if (this.passwordInUse(passes[r])) throw new Error(`密碼「${passes[r]}」已被其他房間使用`);
    }

    const room = new Room({
      name: name.trim(),
      masterPass: passes.master || null,
      collabPass: passes.collab || null,
      guestPass: passes.guest || null,
      sessionId,
      sessionName,
      frozen,
    });
    this.rooms.set(room.id, room);
    return room;
  }

  get(id) {
    return this.rooms.get(id) || null;
  }

  list() {
    return Array.from(this.rooms.values()).map((r) => r.toJSON());
  }

  findBySessionId(sessionId) {
    for (const r of this.rooms.values()) {
      if (!r.closed && r.sessionId === sessionId) return r;
    }
    return null;
  }

  passwordInUse(pw) {
    for (const r of this.rooms.values()) {
      if (!r.closed && r.passwords().includes(pw)) return true;
    }
    return false;
  }

  // 密碼 → { room, role } | null（全域唯一，至多一個命中）
  findByPassword(pw) {
    if (!pw) return null;
    for (const r of this.rooms.values()) {
      if (r.closed) continue;
      const role = r.roleForPassword(pw);
      if (role) return { room: r, role };
    }
    return null;
  }

  // 邀請碼 → { room, role } | null
  resolveInvite(token) {
    if (!token) return null;
    for (const r of this.rooms.values()) {
      if (r.closed) continue;
      const role = r.roleForInvite(token);
      if (role) return { room: r, role };
    }
    return null;
  }

  // 發 ticket（帶 role），之後 WS 帶 ticket 連線
  _issueTicket(room, role, nickname) {
    const ticket = randomBytes(16).toString('base64url');
    room.guests.set(ticket, {
      nickname,
      joinedAt: new Date().toISOString(),
      ws: null,
      role,
    });
    this.tickets.set(ticket, room.id);
    return { room, ticket, role };
  }

  // 訪客入房：明文密碼換 ticket
  join(password, nickname) {
    const hit = this.findByPassword(typeof password === 'string' ? password.trim() : '');
    if (!hit) return null;
    return this._issueTicket(hit.room, hit.role, nickname);
  }

  // 訪客入房：邀請碼換 ticket（分享連結用，URL 不含明文密碼）
  joinByInvite(invite, nickname) {
    const hit = this.resolveInvite(typeof invite === 'string' ? invite.trim() : '');
    if (!hit) return null;
    return this._issueTicket(hit.room, hit.role, nickname);
  }

  // WS upgrade 時驗 ticket → { room, guest, ticket } | null
  resolveTicket(ticket) {
    const roomId = this.tickets.get(ticket);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    if (!room || room.closed) return null;
    const guest = room.guests.get(ticket);
    if (!guest) return null;
    return { room, guest, ticket };
  }

  // 踢掉某訪客（房主用）：斷線 + 回收 ticket
  kick(room, ticket) {
    const guest = room.guests.get(ticket);
    if (!guest) return false;
    this.tickets.delete(ticket);
    room.guests.delete(ticket);
    if (guest.ws) { try { guest.ws.close(4003, 'kicked'); } catch {} }
    return true;
  }

  // 關房：通知所有成員、斷開訪客 WS、回收 tickets
  destroy(id, reason) {
    const room = this.rooms.get(id);
    if (!room) return false;
    room.closed = true;
    room.broadcast({ type: 'room-closed', reason: reason || 'closed' });
    for (const [ticket, g] of room.guests) {
      this.tickets.delete(ticket);
      if (g.ws) { try { g.ws.close(); } catch {} }
    }
    for (const ws of room.hostSockets) { try { ws.close(); } catch {} }
    this.rooms.delete(id);
    return true;
  }

  // 綁定的 session 結束（exit / 被殺）→ 連帶關掉相關房間
  closeForSession(sessionId, reason) {
    for (const room of [...this.rooms.values()]) {
      if (room.sessionId === sessionId) this.destroy(room.id, reason || 'session-exit');
    }
  }
}

module.exports = new RoomRegistry();
module.exports.effectiveWrite = effectiveWrite;
