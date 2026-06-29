const IS_WINDOWS = process.platform === 'win32';

const PROVIDERS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    defaultCmd: IS_WINDOWS ? 'claude.cmd' : 'claude',
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
    defaultArgs: [],
    argChips: ['--full-auto'],
    historySupported: false,
    resumeSupported: false,
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

function defaultArgs(provider) {
  return [...getProvider(provider).defaultArgs];
}

function appendResumeArgs(provider, args, resumeSessionId) {
  const p = getProvider(provider);
  if (!resumeSessionId) return [...args];
  if (!p.resumeSupported) throw new Error(`${p.label} 尚未支援 history resume`);
  return [...args, '--resume', resumeSessionId];
}

function extractResumeSessionId(provider, args) {
  const p = getProvider(provider);
  if (!p.resumeSupported || !Array.isArray(args)) return null;
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
  defaultArgs,
  appendResumeArgs,
  extractResumeSessionId,
};

