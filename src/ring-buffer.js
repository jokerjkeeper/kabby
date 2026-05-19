/**
 * 固定大小 ring buffer，存 PTY 輸出片段。
 * 新 client attach 時 dump() 整段拼接回去，xterm 自己解 ANSI 重繪畫面。
 *
 * 為什麼存 chunk 而不是逐字節：PTY 輸出常含 ANSI escape 序列，逐字節切會破壞控制碼；
 * 整段 chunk 保留 + 按 bytes 計總大小，超量時整段丟最舊的，最差情況是畫面開頭幾百 bytes 不完整，
 * xterm 還是能重繪後續。
 */
class RingBuffer {
  constructor(maxBytes = 100 * 1024) {
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.size = 0;
  }

  append(chunk) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.chunks.push(buf);
    this.size += buf.length;
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.size -= dropped.length;
    }
  }

  dump() {
    return Buffer.concat(this.chunks, this.size).toString('utf8');
  }

  clear() {
    this.chunks = [];
    this.size = 0;
  }
}

module.exports = RingBuffer;
