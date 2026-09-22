/* kabby 語音輸入（🎙 按住說話）— room.js / app.js 共用
 *
 * 流程：按住按鈕 → AudioWorklet 取 PCM → 放開 → 重採樣 16kHz → 16-bit 單聲道 WAV
 *       → POST 到 daemon 代理（daemon 再轉給 Voicebox /transcribe）→ onText(text)
 * 不用 MediaRecorder/webm：STT 端解 webm 需要 ffmpeg，WAV 則零依賴。
 * 錄音寫法移植自已實測的 D:\Temp\mic_test\index.html。
 *
 * 用法：
 *   const voice = KabbyVoice.create({ statusUrl: () => url, transcribeUrl: () => url, headers: () => ({}), onToast });
 *   voice.bind(btn, { onText: (text) => ..., isAllowed: () => true, deniedTitle: '...' });
 *   voice.refresh();   // 權限或連線狀態變了 → 重算所有按鈕的可用狀態
 */
(() => {
  // 錄音用 AudioWorklet：把 PCM 幀轉發到主執行緒（Blob URL 內嵌，不需額外檔案）
  const WORKLET_SRC = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('kabby-capture', Capture);`;

  const TARGET_RATE = 16000;     // Whisper 原生取樣率
  const MIN_SECONDS = 0.3;       // 太短的錄音直接丟棄
  const SILENCE_PEAK = 0.02;     // 整段峰值低於此 → 視為沒錄到聲音（避免 Whisper 靜音幻覺）
  const STATUS_POLL_MS = 30 * 1000;
  // Whisper 在靜音 / 雜訊上常見的幻覺字幕；整段轉寫只剩這些 → 丟棄
  const HALLUCINATION_RE = /^[\s,.，。!！?？]*(字幕(志願者|志愿者|由).*|.*(優優|优优)獨播劇場.*|.*YoYo Television Series.*|請不吝點贊.*|请不吝点赞.*|謝謝(大家)?(收看|觀看)[。！!]*|谢谢(大家)?(收看|观看)[。！!]*|ご視聴ありがとうございました)[\s,.，。!！?？]*$/i;

  let styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const st = document.createElement('style');
    st.textContent = `
      .voice-btn { position: relative; overflow: hidden; touch-action: none; user-select: none; -webkit-user-select: none; }
      .voice-btn.voice-off { filter: grayscale(1); opacity: .45; }
      .voice-btn.recording { background: #c0392b !important; color: #fff !important; }
      .voice-btn.recording::after {
        content: ''; position: absolute; left: 0; bottom: 0; height: 3px;
        width: var(--voice-level, 0%); background: #7CFC9A; transition: width .05s;
      }
      .voice-btn.busy { cursor: progress; opacity: .7; }
    `;
    document.head.appendChild(st);
  }

  function concat(chunks) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out;
  }

  /** 線性插值重採樣到目標取樣率 */
  function resample(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const out = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const pos = i * ratio, idx = Math.floor(pos), frac = pos - idx;
      out[i] = input[idx] * (1 - frac) + (input[idx + 1] ?? input[idx]) * frac;
    }
    return out;
  }

  /** Float32 PCM → 16-bit 單聲道 WAV */
  function encodeWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buf);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeStr(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /** 麥克風錯誤 → 中文說明 */
  function micErrorText(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return '麥克風權限被拒絕（請在瀏覽器網址列允許麥克風）';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return '找不到麥克風裝置';
    if (name === 'NotReadableError') return '麥克風被其他程式佔用';
    return '無法開始錄音：' + ((err && err.message) || err);
  }

  function create(opts) {
    injectStyle();
    const { statusUrl, transcribeUrl, headers = () => ({}), onToast = () => {}, language = 'zh' } = opts;
    const bindings = [];           // { btn, cfg, baseTitle }
    let status = { available: false, error: '檢測語音服務中…' };
    let pollTimer = null;
    // 同一時間只錄一段（多顆按鈕共用麥克風）
    const rec = { active: null, ctx: null, stream: null, node: null, source: null, chunks: [], peak: 0, recording: false, ready: false };
    let busy = false;              // 上傳 / 轉寫中

    const secure = window.isSecureContext && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

    // 算出某顆按鈕目前能不能按、為什麼不能
    function evaluate(b) {
      if (!secure) return { ok: false, why: '瀏覽器只允許在 localhost 或 https 使用麥克風（目前是非安全連線）' };
      if (b.cfg.isAllowed && !b.cfg.isAllowed()) return { ok: false, why: b.cfg.deniedTitle || '目前沒有權限使用語音輸入' };
      if (!status.available) {
        // 伺服器給的訊息多半已是「語音服務未啟動（…）」，別再包一層
        const e = status.error || '';
        return { ok: false, why: e.startsWith('語音服務') ? e : '語音服務未啟動' + (e ? `（${e}）` : '') };
      }
      return { ok: true };
    }

    function paint() {
      for (const b of bindings) {
        const r = evaluate(b);
        if (b.cfg.hideWhenDenied) b.btn.style.display = (b.cfg.isAllowed && !b.cfg.isAllowed()) ? 'none' : '';
        const isRecordingThis = rec.active === b;
        b.btn.disabled = !r.ok && !isRecordingThis;
        b.btn.classList.toggle('voice-off', !r.ok);
        b.btn.classList.toggle('busy', busy && r.ok);
        b.btn.title = r.ok ? b.baseTitle : '🎙 ' + r.why;
      }
    }

    async function checkStatus() {
      const url = statusUrl();
      if (!url) { status = { available: false, error: '尚未連線' }; paint(); return; }
      try {
        const resp = await fetch(url, { headers: headers() });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(body.error || 'HTTP ' + resp.status);
        status = { available: !!body.available, error: body.error || '' };
      } catch (err) {
        status = { available: false, error: err.message };
      }
      paint();
    }

    function startPolling() {
      if (pollTimer) return;
      checkStatus();
      pollTimer = setInterval(checkStatus, STATUS_POLL_MS);
    }

    function setLevel(b, peak) {
      b.btn.style.setProperty('--voice-level', Math.min(100, peak * 140) + '%');
    }

    async function startRecording(b) {
      if (rec.recording || busy) return;
      if (!evaluate(b).ok) return;
      rec.recording = true;
      rec.active = b;
      rec.chunks = [];
      rec.peak = 0;
      b.btn.classList.add('recording');
      try {
        rec.stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        rec.ctx = new AudioContext();
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
        try { await rec.ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        rec.source = rec.ctx.createMediaStreamSource(rec.stream);
        rec.node = new AudioWorkletNode(rec.ctx, 'kabby-capture');
        rec.node.port.onmessage = (e) => {
          rec.chunks.push(e.data);
          let peak = 0;
          for (const v of e.data) peak = Math.max(peak, Math.abs(v));
          if (peak > rec.peak) rec.peak = peak;
          setLevel(b, peak);
        };
        rec.source.connect(rec.node);
        rec.ready = true;
        // 使用者可能在初始化完成前就已放開
        if (!rec.recording) stopRecording();
      } catch (err) {
        rec.recording = false;
        rec.ready = false;
        rec.active = null;
        if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
        if (rec.ctx) rec.ctx.close().catch(() => {});
        rec.ctx = null;
        rec.stream = null;
        b.btn.classList.remove('recording');
        onToast(micErrorText(err), 'warn');
        paint();
      }
    }

    async function stopRecording() {
      const b = rec.active;
      rec.recording = false;
      if (b) { b.btn.classList.remove('recording'); setLevel(b, 0); }
      if (!rec.ready) return;   // 仍在初始化，startRecording 完成後會再呼叫一次
      rec.ready = false;
      rec.active = null;

      const sampleRate = rec.ctx.sampleRate;
      try { rec.source.disconnect(); rec.node.disconnect(); } catch {}
      rec.stream.getTracks().forEach((t) => t.stop());
      await rec.ctx.close().catch(() => {});
      rec.ctx = null;
      rec.stream = null;

      const pcm = concat(rec.chunks);
      rec.chunks = [];
      paint();
      if (pcm.length / sampleRate < MIN_SECONDS) { onToast('錄音太短，已忽略（請按住按鈕說話）', 'warn'); return; }
      if (rec.peak < SILENCE_PEAK) { onToast('沒有錄到聲音，請檢查麥克風是否選對、音量是否太小', 'warn'); return; }
      const wav = encodeWav(resample(pcm, sampleRate, TARGET_RATE), TARGET_RATE);
      await upload(b, wav);
    }

    async function upload(b, wav) {
      const url = transcribeUrl();
      if (!url) { onToast('尚未連線，無法轉寫', 'warn'); return; }
      busy = true;
      paint();
      try {
        const form = new FormData();
        form.append('file', wav, 'mic.wav');
        if (language) form.append('language', language);
        const resp = await fetch(url, { method: 'POST', body: form, headers: headers() });
        const body = await resp.json().catch(() => ({}));
        if (resp.status === 202) { onToast('語音模型載入中，請稍候再試', 'warn'); return; }
        if (!resp.ok) {
          if (resp.status === 502) { status = { available: false, error: body.error || '' }; }
          throw new Error(body.error || 'HTTP ' + resp.status);
        }
        const text = String(body.text || '').trim();
        if (!text || HALLUCINATION_RE.test(text)) { onToast('沒有辨識到內容', 'warn'); return; }
        // 只在按鈕仍可用時交付（例如錄音期間被改成唯讀 → 丟棄）
        if (!evaluate(b).ok) { onToast('權限已變更，語音內容未送出', 'warn'); return; }
        b.cfg.onText(text);
      } catch (err) {
        onToast('語音轉寫失敗：' + err.message, 'warn');
      } finally {
        busy = false;
        paint();
      }
    }

    /** 把一顆按鈕綁成「按住說話」 */
    function bind(btn, cfg) {
      const b = { btn, cfg, baseTitle: cfg.title || btn.title || '🎙 按住說話，放開後轉成文字' };
      btn.classList.add('voice-btn');
      bindings.push(b);
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        try { btn.setPointerCapture(e.pointerId); } catch {}
        startRecording(b);
      });
      const release = () => { if (rec.active === b && rec.recording) stopRecording(); };
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, release));
      btn.addEventListener('contextmenu', (e) => e.preventDefault());   // 手機長按別跳選單
      startPolling();
      paint();
      return b;
    }

    return { bind, refresh: paint, recheck: checkStatus, get status() { return status; } };
  }

  /** 把轉寫文字追加到輸入框尾端（英數相鄰才補空格），游標移到最後並 focus */
  function appendToInput(inputEl, text) {
    const cur = inputEl.value;
    const sep = cur && /[A-Za-z0-9]$/.test(cur) && /^[A-Za-z0-9]/.test(text) ? ' ' : '';
    let next = cur + sep + text;
    if (inputEl.maxLength > 0) next = next.slice(0, inputEl.maxLength);
    inputEl.value = next;
    inputEl.focus();
    inputEl.setSelectionRange(next.length, next.length);
  }

  /** 終端用：換行一律改空格，避免轉寫文字裡的換行被 cc 當成 Enter 直接送出 */
  function toTerminalText(text) {
    return text.replace(/\s*[\r\n]+\s*/g, ' ');
  }

  window.KabbyVoice = { create, appendToInput, toTerminalText };
})();
