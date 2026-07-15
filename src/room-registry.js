const { randomUUID, randomBytes } = require('crypto');

// 聊天室（房間）registry — 全部存記憶體，跟 session registry 一樣不跨 daemon 重啟。
// 一個房間綁一個 running session；訪客用 key 換 ticket，ticket 是 WS 連線的憑證。
// 訪客斷線（刷新頁面）ticket 仍有效，可重連；房間關閉或 daemon 重啟才失效。

const CHAT_LOG_MAX = 200;   // 每房保留的聊天訊息數（新訪客進房 replay 用）
const CHAT_IMG_KEEP = 20;   // 圖片訊息只保留最近 N 張（base64 存記憶體，控上限），舊的退化成佔位
const KEY_MIN_LEN = 4;

function genKey() {
  return randomBytes(6).toString('base64url'); // 8 字元，夠隨機又好唸給別人
}

class Room {
  constructor({ name, key, sessionId, sessionName, allowWrite = false }) {
    this.id = randomUUID();
    this.name = name;
    this.key = key;
    this.sessionId = sessionId;
    this.sessionName = sessionName;
    this.allowWrite = !!allowWrite;
    this.createdAt = new Date().toISOString();
    this.closed = false;
    this.guests = new Map();      // ticket → { nickname, joinedAt, ws|null }
    this.hostSockets = new Set(); // 房主聊天面板的 WS（/ws/room/:id）
    this.chatLog = [];            // { from:'host'|'guest'|'system', nickname, text, ts }
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

  // 訪客在線名單（房主面板 + 訪客頁共用）
  presence() {
    return Array.from(this.guests.values()).map((g) => ({
      nickname: g.nickname,
      joinedAt: g.joinedAt,
      online: !!(g.ws && g.ws.readyState === g.ws.OPEN),
    }));
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      key: this.key,
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      allowWrite: this.allowWrite,
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

  create({ name, key, sessionId, sessionName, allowWrite }) {
    if (!name || typeof name !== 'string') throw new Error('房間名稱必填');
    if (key != null && key !== '') {
      if (typeof key !== 'string' || key.trim().length < KEY_MIN_LEN) {
        throw new Error(`key 至少 ${KEY_MIN_LEN} 個字元（留空 = 自動產生）`);
      }
      key = key.trim();
      if (this.findByKey(key)) throw new Error('這個 key 已被另一個房間使用');
    } else {
      key = genKey();
    }
    const room = new Room({ name: name.trim(), key, sessionId, sessionName, allowWrite });
    this.rooms.set(room.id, room);
    return room;
  }

  get(id) {
    return this.rooms.get(id) || null;
  }

  list() {
    return Array.from(this.rooms.values()).map((r) => r.toJSON());
  }

  findByKey(key) {
    for (const r of this.rooms.values()) {
      if (r.key === key && !r.closed) return r;
    }
    return null;
  }

  // 訪客入房：key 換 ticket（之後 WS 帶 ticket 連線）
  join(key, nickname) {
    const room = this.findByKey(key);
    if (!room) return null;
    const ticket = randomBytes(16).toString('base64url');
    room.guests.set(ticket, {
      nickname,
      joinedAt: new Date().toISOString(),
      ws: null,
    });
    this.tickets.set(ticket, room.id);
    return { room, ticket };
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
