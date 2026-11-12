const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WINDOWS = process.platform === 'win32';

const PROVIDERS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    defaultCmd: IS_WINDOWS ? 'claude.cmd' : 'claude',   // 找不到時的最後退路（實際用 resolveCmd 尋找）
    binName: 'claude',
    cmdEnv: 'KABBY_CLAUDE_CMD',
    defaultArgs: ['--dangerously-skip-permissions'],
    argChips: ['--dangerously-skip-permissions', '--verbose', '--enable-auto-mode', '--debug'],
    historySupported: true,
    resumeSupported: true,
    viewerSupported: true,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    defaultCmd: IS_WINDOWS ? 'codex.cmd' : 'codex',
    binName: 'codex',
    cmdEnv: 'KABBY_CODEX_CMD',
    // 0.142+ 拿掉 --full-auto；全自動免確認對齊 claude 的 --dangerously-skip-permissions。
    defaultArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    argChips: ['--dangerously-bypass-approvals-and-sandbox', '--search'],
    historySupported: true,
    resumeSupported: true,
    viewerSupported: false,
  },
};

function normalizeProvider(provider) {
  return PROVIDERS[provider] ? provider : 'claude';
}

function getProvider(provider) {
  return PROVIDERS[normalizeProvider(provider)];
}

function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({ ...p, defaultArgs: [...p.defaultArgs], argChips: [...p.argChips] }));
}

function defaultCmd(provider) {
  return getProvider(provider).defaultCmd;
}

// PATH 以外常見的安裝位置：官方安裝程式（~/.local/bin/claude.exe）、npm 全域（%APPDATA%\npm\claude.cmd）
function extraBinDirs() {
  const dirs = [path.join(os.homedir(), '.local', 'bin')];
  if (IS_WINDOWS && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  if (!IS_WINDOWS) dirs.push('/usr/local/bin', '/opt/homebrew/bin');
  return dirs;
}

// 會搜尋的目錄：PATH（順序同 shell）→ 常見安裝位置
function searchDirs() {
  const fromPath = (process.env.PATH || process.env.Path || '').split(path.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  return [...new Set([...fromPath, ...extraBinDirs()])];
}

/**
 * 把指令名找成實際執行檔路徑（node-pty 在 Windows 不會自己補副檔名、也不認 PATHEXT）。
 * - 含路徑（絕對 / 相對）→ 原樣回傳
 * - Windows 沒寫副檔名 → 依序試 .exe / .cmd / .bat；有寫就只找該檔名
 * 依目錄順序找（每個目錄內再依副檔名），結果與在終端打指令一致。找不到回 null。
 */
function resolveExecutable(cmd) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd) || /[\/]/.test(cmd)) return cmd;
  const names = IS_WINDOWS && !path.extname(cmd) ? ['.exe', '.cmd', '.bat'].map((ext) => cmd + ext) : [cmd];
  for (const dir of searchDirs()) {
    for (const name of names) {
      const full = path.join(dir, name);
      try { if (fs.statSync(full).isFile()) return full; } catch {}
    }
  }
  return null;
}

/**
 * 決定要 spawn 的指令。
 * - 使用者有填執行檔 → 盡量解析成完整路徑（例：填 claude 也能找到 claude.exe），找不到就原樣交給 spawn
 * - 沒填 → .env 的 KABBY_CLAUDE_CMD / KABBY_CODEX_CMD → 自動尋找 → 退回 defaultCmd
 */
function resolveCmd(provider, explicitCmd) {
  if (explicitCmd) return resolveExecutable(explicitCmd) || explicitCmd;
  const p = getProvider(provider);
  const fromEnv = (process.env[p.cmdEnv] || '').trim().replace(/^"(.*)"$/, '$1');
  if (fromEnv) return resolveExecutable(fromEnv) || fromEnv;
  return resolveExecutable(p.binName) || p.defaultCmd;
}

/** 找不到執行檔時給使用者看的提示（列出搜過的地方與設定方式） */
function cmdNotFoundHint(provider) {
  const p = getProvider(provider);
  const example = IS_WINDOWS ? `C:\\claude\\${p.binName}.exe` : `/home/<you>/.local/bin/${p.binName}`;
  return `已搜尋 PATH 與 ${extraBinDirs().join('、')}。` +
    `可在 .env 設 ${p.cmdEnv}=<完整路徑>（例 ${example}），或在「執行檔」欄填完整路徑。`;
}

function defaultArgs(provider) {
  return [...getProvider(provider).defaultArgs];
}

// `codex resume` 子命令的參數集比主命令窄很多：只收 -c/--config、-m/--model、
// --enable/--disable、-i/--image、--remote(-auth-token-env)（吃值），以及
// --last/--all/--include-non-interactive/--strict-config（布林）。
// 新開 session 用的便利旗標（--full-auto / --sandbox / -s / --ask-for-approval /
// -a / --dangerously-bypass-approvals-and-sandbox / --search / --oss …）對 resume
// 子命令無效，直接 pass 會「unexpected argument」報錯。沙箱/審批策略改由
// ~/.codex/config.toml 或 -c 覆寫決定，這裡把不相容的旗標濾掉。
const CODEX_RESUME_VALUE_FLAGS = new Set([
  '-c', '--config', '-m', '--model', '--enable', '--disable', '-i', '--image',
  '--remote', '--remote-auth-token-env',
]);
const CODEX_RESUME_BOOL_FLAGS = new Set([
  '--last', '--all', '--include-non-interactive', '--strict-config',
]);

function filterCodexResumeArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') continue;
    // --config=foo / -m=gpt 之類「旗標=值」單 token 形式
    if (/^(-c|--config|-m|--model|--enable|--disable)=/.test(a)) { out.push(a); continue; }
    if (CODEX_RESUME_VALUE_FLAGS.has(a)) {
      out.push(a);
      if (i + 1 < args.length && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('-')) {
        out.push(args[i + 1]);
        i++;
      }
      continue;
    }
    if (CODEX_RESUME_BOOL_FLAGS.has(a)) { out.push(a); continue; }
    // 其餘（--full-auto 等新開 session 旗標）→ 丟棄，避免 codex resume 報錯
  }
  return out;
}

function appendResumeArgs(provider, args, resumeSessionId) {
  const p = getProvider(provider);
  if (!resumeSessionId) return [...args];
  if (!p.resumeSupported) throw new Error(`${p.label} 尚未支援 history resume`);
  // Codex resume 是子命令：`codex resume [OPTIONS] <SESSION_ID>`（id 放最後），
  // 且只吃 resume 相容旗標。Claude 則是 flag：`claude [args] --resume <id>`。
  if (p.id === 'codex') return ['resume', ...filterCodexResumeArgs(args), resumeSessionId];
  return [...args, '--resume', resumeSessionId];
}

function extractResumeSessionId(provider, args) {
  const p = getProvider(provider);
  if (!p.resumeSupported || !Array.isArray(args)) return null;
  if (p.id === 'codex') {
    if (args[0] !== 'resume') return null;
    for (let i = args.length - 1; i >= 1; i--) {
      if (typeof args[i] === 'string' && !args[i].startsWith('-')) return args[i];
    }
    return null;
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume' || args[i] === '-r') return args[i + 1] || null;
    const m = /^--resume=(.+)$/.exec(args[i]);
    if (m) return m[1];
  }
  return null;
}

module.exports = {
  normalizeProvider,
  getProvider,
  listProviders,
  defaultCmd,
  resolveCmd,
  resolveExecutable,
  cmdNotFoundHint,
  defaultArgs,
  appendResumeArgs,
  extractResumeSessionId,
};

