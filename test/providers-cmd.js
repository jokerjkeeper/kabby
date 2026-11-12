/**
 * 啟動指令解析測試（不需 daemon）：
 *   - 官方安裝（只有 claude.exe）、npm 安裝（只有 claude.cmd）都找得到
 *   - 依 PATH 目錄順序；同目錄內 .exe 優先
 *   - .env 的 KABBY_CLAUDE_CMD / KABBY_CODEX_CMD 優先（可帶引號）
 *   - 使用者填的執行檔：沒副檔名也能補、有路徑原樣、找不到原樣交給 spawn
 *   - 都找不到退回 defaultCmd
 *
 * 跑法：node test/providers-cmd.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const providers = require('../src/providers');

const IS_WINDOWS = process.platform === 'win32';
const EXE = IS_WINDOWS ? '.exe' : '';

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  if (!IS_WINDOWS) fs.chmodSync(file, 0o755);
}

function run() {
  const saved = { PATH: process.env.PATH, APPDATA: process.env.APPDATA,
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    KABBY_CLAUDE_CMD: process.env.KABBY_CLAUDE_CMD, KABBY_CODEX_CMD: process.env.KABBY_CODEX_CMD };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kabby-cmd-'));
  const home = path.join(tmp, 'home');
  // Windows 的 process.env 不分大小寫：只設 PATH（刪 Path 會連 PATH 一起刪）
  const setPath = (...dirs) => { process.env.PATH = dirs.join(path.delimiter); };
  try {
    // 隔離環境：HOME / APPDATA 指到空目錄，避免本機實際安裝影響結果
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.APPDATA = path.join(tmp, 'appdata');
    delete process.env.KABBY_CLAUDE_CMD;
    delete process.env.KABBY_CODEX_CMD;

    // 官方安裝：PATH 上只有 claude.exe（例 C:\claude\claude.exe）
    const native = path.join(tmp, 'claude-native');
    touch(path.join(native, 'claude' + EXE));
    setPath(path.join(tmp, 'empty'), native);
    assert.strictEqual(providers.resolveCmd('claude'), path.join(native, 'claude' + EXE));
    console.log('  ✓ 官方安裝（只有 claude.exe）找得到');

    if (IS_WINDOWS) {
      // npm 安裝：只有 claude.cmd
      const npm = path.join(tmp, 'npm-bin');
      touch(path.join(npm, 'claude.cmd'));
      setPath(npm);
      assert.strictEqual(providers.resolveCmd('claude'), path.join(npm, 'claude.cmd'));
      console.log('  ✓ npm 安裝（只有 claude.cmd）找得到');

      // PATH 順序：前面目錄的 .cmd 勝過後面目錄的 .exe；同目錄 .exe 優先
      setPath(npm, native);
      assert.strictEqual(providers.resolveCmd('claude'), path.join(npm, 'claude.cmd'));
      touch(path.join(npm, 'claude.exe'));
      assert.strictEqual(providers.resolveCmd('claude'), path.join(npm, 'claude.exe'));
      console.log('  ✓ 依 PATH 目錄順序；同目錄 .exe 優先於 .cmd');

      // PATH 沒有、但在 %APPDATA%\npm
      touch(path.join(process.env.APPDATA, 'npm', 'codex.cmd'));
      setPath(path.join(tmp, 'empty'));
      assert.strictEqual(providers.resolveCmd('codex'), path.join(process.env.APPDATA, 'npm', 'codex.cmd'));
      console.log('  ✓ PATH 沒有時找 %APPDATA%\\npm');
    }

    // PATH 沒有、但在 ~/.local/bin
    touch(path.join(home, '.local', 'bin', 'claude' + EXE));
    setPath(path.join(tmp, 'empty'));
    assert.strictEqual(providers.resolveCmd('claude'), path.join(home, '.local', 'bin', 'claude' + EXE));
    console.log('  ✓ PATH 沒有時找 ~/.local/bin');

    // .env 覆寫（可帶引號）
    const custom = path.join(tmp, 'my tools', 'claude' + EXE);
    touch(custom);
    process.env.KABBY_CLAUDE_CMD = `"${custom}"`;
    assert.strictEqual(providers.resolveCmd('claude'), custom);
    delete process.env.KABBY_CLAUDE_CMD;
    console.log('  ✓ KABBY_CLAUDE_CMD 優先（可帶引號、路徑含空白）');

    // 使用者填的執行檔
    setPath(native);
    assert.strictEqual(providers.resolveCmd('claude', 'claude'), path.join(native, 'claude' + EXE), '沒副檔名要補');
    assert.strictEqual(providers.resolveCmd('claude', custom), custom, '完整路徑原樣');
    assert.strictEqual(providers.resolveCmd('claude', 'no-such-tool-xyz'), 'no-such-tool-xyz', '找不到原樣交給 spawn');
    console.log('  ✓ 使用者填的執行檔：補副檔名 / 完整路徑原樣 / 找不到原樣');

    // 全都找不到 → defaultCmd；提示含設定方式
    fs.rmSync(path.join(home, '.local'), { recursive: true, force: true });
    setPath(path.join(tmp, 'empty'));
    assert.strictEqual(providers.resolveCmd('claude'), providers.defaultCmd('claude'));
    assert.ok(providers.cmdNotFoundHint('claude').includes('KABBY_CLAUDE_CMD'));
    console.log('  ✓ 都找不到退回 defaultCmd；錯誤提示含 KABBY_CLAUDE_CMD');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

run();
console.log('providers-cmd: all PASS');
