// StarryApa みんなで歩けるお店 (Render用スタンドアロン版)
// 依存ライブラリなし。Node.js 標準機能だけで動きます。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data.json');

// ---------- アカウント保存 (data.json) ----------
let accounts = new Map(); // loginId(小文字) -> account
function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const a of d.accounts || []) accounts.set(a.loginId.toLowerCase(), a);
  } catch (e) { /* 初回は無し */ }
}
let saveTimer = null;
function saveData() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify({ accounts: [...accounts.values()] })); } catch (e) {}
  }, 200);
}
loadData();

// ---------- 実行時状態 ----------
const sessions = new Map();  // token -> loginId(小文字)
const presence = new Map();  // loginId(小文字) -> {x, z, yaw, lastSeen}
let messages = [];           // {id, name, text, ts}
let nextMsgId = 1;

const AVATAR_TYPES = ['vera', 'girl', 'boy'];
const AVATAR_COLORS = ['violet', 'red', 'blue', 'green', 'yellow'];

function hashPw(pw, salt) {
  return crypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('hex');
}
function publicAccount(a) {
  return { loginId: a.loginId, displayName: a.displayName, avatarType: a.avatarType, avatarColor: a.avatarColor, isHost: a.isHost };
}
function authOf(body) {
  if (!body || !body.token) return null;
  const id = sessions.get(body.token);
  if (!id) return null;
  return accounts.get(id) || null;
}

// ---------- API ----------
function apiRegister(body, res) {
  const loginId = String(body.loginId || '').trim();
  const password = String(body.password || '');
  const displayName = String(body.displayName || 'ベラ').trim().slice(0, 20) || 'ベラ';
  const avatarType = AVATAR_TYPES.includes(body.avatarType) ? body.avatarType : 'vera';
  const avatarColor = AVATAR_COLORS.includes(body.avatarColor) ? body.avatarColor : 'violet';
  if (!loginId || loginId.length > 32) return sendJson(res, 400, { error: 'ログインIDを入力してください' });
  if (password.length < 4) return sendJson(res, 400, { error: 'パスワードは4文字以上にしてください' });
  const key = loginId.toLowerCase();
  if (accounts.has(key)) return sendJson(res, 409, { error: 'そのログインIDはすでに使われています' });
  const salt = crypto.randomBytes(16).toString('hex');
  const account = {
    loginId, salt, hash: hashPw(password, salt), displayName, avatarType, avatarColor,
    isHost: key === 'vera', createdAt: Date.now()
  };
  accounts.set(key, account);
  saveData();
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, key);
  return sendJson(res, 200, { token, account: publicAccount(account) });
}

function apiLogin(body, res) {
  const key = String(body.loginId || '').trim().toLowerCase();
  const password = String(body.password || '');
  const a = accounts.get(key);
  if (!a) return sendJson(res, 401, { error: 'IDかパスワードが違います' });
  const h = Buffer.from(hashPw(password, a.salt), 'hex');
  const stored = Buffer.from(a.hash, 'hex');
  if (h.length !== stored.length || !crypto.timingSafeEqual(h, stored)) {
    return sendJson(res, 401, { error: 'IDかパスワードが違います' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, key);
  return sendJson(res, 200, { token, account: publicAccount(a) });
}

function apiMe(body, res) {
  const a = authOf(body);
  return sendJson(res, 200, { account: a ? publicAccount(a) : null });
}

function apiLogout(body, res) {
  if (body && body.token) {
    const id = sessions.get(body.token);
    sessions.delete(body.token);
    if (id) presence.delete(id);
  }
  return sendJson(res, 200, { ok: true });
}

function apiHeartbeat(body, res) {
  const a = authOf(body);
  if (!a) return sendJson(res, 401, { authFailed: true });
  presence.set(a.loginId.toLowerCase(), {
    x: +body.x || 0, z: +body.z || 0, yaw: +body.yaw || 0, lastSeen: Date.now()
  });
  return sendJson(res, 200, { ok: true });
}

function apiPlayers(body, res) {
  const a = authOf(body);
  if (!a) return sendJson(res, 401, { authFailed: true });
  const meKey = a.loginId.toLowerCase();
  const now = Date.now();
  const list = [];
  for (const [key, p] of presence) {
    if (key === meKey) continue;
    if (now - p.lastSeen > 6000) continue;
    const acc = accounts.get(key);
    if (!acc) continue;
    list.push({ id: key, name: acc.displayName, avatarType: acc.avatarType, avatarColor: acc.avatarColor, isHost: acc.isHost, x: p.x, z: p.z, yaw: p.yaw });
  }
  return sendJson(res, 200, { players: list });
}

function apiSay(body, res) {
  const a = authOf(body);
  if (!a) return sendJson(res, 401, { authFailed: true });
  const text = String(body.text || '').trim().slice(0, 200);
  if (!text) return sendJson(res, 400, { error: 'empty' });
  messages.push({ id: nextMsgId++, from: a.loginId.toLowerCase(), name: a.displayName, text, ts: Date.now() });
  if (messages.length > 50) messages = messages.slice(-50);
  return sendJson(res, 200, { ok: true });
}

function apiMessages(body, res) {
  const a = authOf(body);
  if (!a) return sendJson(res, 401, { authFailed: true });
  const since = +body.sinceId || 0;
  return sendJson(res, 200, { messages: messages.filter(m => m.id > since) });
}

function apiLeave(body, res) {
  const a = authOf(body);
  if (a) presence.delete(a.loginId.toLowerCase());
  return sendJson(res, 200, { ok: true });
}

const API = {
  '/api/register': apiRegister,
  '/api/login': apiLogin,
  '/api/me': apiMe,
  '/api/logout': apiLogout,
  '/api/heartbeat': apiHeartbeat,
  '/api/players': apiPlayers,
  '/api/say': apiSay,
  '/api/messages': apiMessages,
  '/api/leave': apiLeave
};

// ---------- HTTP ----------
function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary'
};

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && API[u.pathname]) {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 100000) req.destroy(); });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }
      API[u.pathname](body, res);
    });
    return;
  }
  if (req.method === 'GET') return serveStatic(req, res, u.pathname);
  res.writeHead(405); res.end();
});

server.listen(PORT, () => console.log('StarryApa shop listening on port ' + PORT));
