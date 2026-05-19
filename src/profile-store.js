const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const { normalizeCwd } = require('./cc-history');

const STORE_DIR = path.join(os.homedir(), '.kabby');
const STORE_FILE = path.join(STORE_DIR, 'profiles.json');

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(STORE_FILE)) return { profiles: [] };
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.profiles)) return { profiles: [] };
    // 兼容舊資料：load 時 normalize cwd（檔案上次寫入不一定有 normalize）
    for (const p of data.profiles) {
      if (p && typeof p.cwd === 'string') p.cwd = normalizeCwd(p.cwd);
    }
    return data;
  } catch (err) {
    console.error('[profile-store] corrupt profiles.json:', err.message);
    return { profiles: [] };
  }
}

function save(data) {
  ensureDir();
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_FILE);
}

function list() {
  return load().profiles;
}

function get(id) {
  return list().find((p) => p.id === id) || null;
}

function getByName(name) {
  return list().find((p) => p.name === name) || null;
}

function create({ name, cwd, cmd, args }) {
  if (!name || typeof name !== 'string') throw new Error('name is required');
  if (!cwd || typeof cwd !== 'string') throw new Error('cwd is required');
  const data = load();
  if (data.profiles.some((p) => p.name === name)) {
    throw new Error(`profile name already exists: ${name}`);
  }
  const now = new Date().toISOString();
  const profile = {
    id: randomUUID(),
    name,
    cwd,
    cmd: cmd || null,
    args: Array.isArray(args) ? args : null,
    createdAt: now,
    lastUsedAt: null,
    lastSessionId: null,
  };
  data.profiles.push(profile);
  save(data);
  return profile;
}

function update(id, patch) {
  const data = load();
  const idx = data.profiles.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const allowed = ['name', 'cwd', 'cmd', 'args', 'lastUsedAt', 'lastSessionId'];
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      data.profiles[idx][k] = patch[k];
    }
  }
  save(data);
  return data.profiles[idx];
}

function destroy(id) {
  const data = load();
  const idx = data.profiles.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  data.profiles.splice(idx, 1);
  save(data);
  return true;
}

module.exports = {
  STORE_FILE,
  list,
  get,
  getByName,
  create,
  update,
  destroy,
};
