/**
 * D 方案：輸入側即時攔截（per-session 有狀態）。
 *
 * write() 收到的是 keystroke 流（不是乾淨的行），所以要自己「組行」：
 *   - 可見字元 / UTF-8 → 累進當前行緩衝 buf；同時照常轉發給 cc（讓 cc echo）
 *   - 退格 (\x7f/\x08) → buf 去尾一字
 *   - Ctrl+U (\x15) / Ctrl+C (\x03) → 清空 buf（整行取消）
 *   - Enter (\r/\n) → 提交：比對 buf 的敏感詞
 *       命中 → 攔下這個 Enter（不轉發）→ cc 收不到提交，打的字還留在輸入框；
 *              buf 保留（讓使用者改完重送會再檢查；改乾淨才放行）
 *       沒命中 → 放行 Enter、清空 buf
 *   - ESC 序列（方向鍵/Meta/SS3/CSI）→ 原樣轉發給 cc，不污染 buf；
 *       偵測 bracketed paste 標記 \x1b[200~ / \x1b[201~ 切換 paste 模式，
 *       paste 模式內所有字元（含換行）都進 buf、不當提交，等真正 Enter 才檢查。
 *
 * 限制（誠實說明）：游標中間插字/方向鍵編輯時，buf 是「近似」重建（keystroke
 * 流無法完美還原游標位置）。偏向寧可多擋（false positive），不會漏放（safe）。
 */

function createInputFilter() {
  let buf = '';
  let inEsc = false;
  let escSeq = '';
  let pasteMode = false;

  /**
   * 餵入一段 keystroke。matcher 為 null = 攔截停用（原樣放行）。
   * 回傳 { forward, blockedWords }：forward 是要實際送進 cc 的字串。
   */
  function feed(data, matcher) {
    if (!matcher) return { forward: data, blockedWords: [] };
    let forward = '';
    const blocked = new Set();

    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      const code = data.charCodeAt(i);

      if (inEsc) {
        // 累積整個 escape 序列、原樣轉發；判斷序列何時結束
        escSeq += ch;
        forward += ch;
        let ended = false;
        if (escSeq.length === 2) {
          // 第二個字決定型態：'[' = CSI、'O' = SS3（都還沒結束）；其他 = Meta（結束）
          if (ch !== '[' && ch !== 'O') ended = true;
        } else if (escSeq.length >= 3 && code >= 0x40 && code <= 0x7e) {
          ended = true; // final byte
        }
        if (ended) {
          if (escSeq === '\x1b[200~') pasteMode = true;
          else if (escSeq === '\x1b[201~') pasteMode = false;
          inEsc = false;
          escSeq = '';
        }
        continue;
      }

      if (ch === '\x1b') {
        inEsc = true;
        escSeq = '\x1b';
        forward += ch;
        continue;
      }

      // Enter（非 paste 模式才當提交）
      if (!pasteMode && (ch === '\r' || ch === '\n')) {
        const hits = matcher.scan(buf);
        if (hits.length) {
          hits.forEach((w) => blocked.add(w));
          // 攔下 Enter：不加入 forward；buf 保留供改後重送再檢查
        } else {
          forward += ch;
          buf = '';
        }
        continue;
      }

      // 其餘字元一律照常轉發給 cc
      forward += ch;
      if (ch === '\x7f' || ch === '\x08') buf = buf.slice(0, -1);
      else if (ch === '\x15' || ch === '\x03') buf = '';
      else if (pasteMode) buf += ch;          // paste 內容（含換行）進 buf
      else if (code >= 0x20) buf += ch;        // 可見字元 / UTF-8
      // 其他控制字元（方向以外）不進 buf
    }

    return { forward, blockedWords: [...blocked] };
  }

  // 供測試 inspect 內部狀態
  function peek() { return { buf, pasteMode, inEsc }; }

  return { feed, peek };
}

module.exports = { createInputFilter };
