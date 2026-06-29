const providers = require('./providers');
const ccHistory = require('./cc-history');
const codexHistory = require('./codex-history');

function adapter(provider) {
  const id = providers.normalizeProvider(provider);
  return id === 'codex' ? codexHistory : ccHistory;
}

function listHistory(provider, cwd) {
  return adapter(provider).listHistory(cwd);
}

function projectDir(provider, cwd) {
  return adapter(provider).projectDir(cwd);
}

module.exports = {
  listHistory,
  projectDir,
};
