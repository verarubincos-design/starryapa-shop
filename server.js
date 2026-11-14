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

// ---------- 店主アカウントの種まき (v3.3) ----------
// Renderの無料プランは再デプロイ/再起動で data.json が消えるため、
// 環境変数 HOST_PASSWORD が設定されていれば、起動のたびに店主アカウントが
// 無い場合だけ作り直す。既存のアカウントは上書きしない。
// パスワードはGitHubには置かず、Renderの Environment で設定する。
const HOST_LOGIN_ID = (process.env.HOST_LOGIN_ID || 'vera').trim().toLowerCase();
const HOST_DISPLAY_NAME = (process.env.HOST_DISPLAY_NAME || 'ベラ').trim() || 'ベラ';
function ensureHostAccount() {
  const pw = process.env.HOST_PASSWORD || '';
  if (!pw || pw.length < 4) return;
  if (accounts.has(HOST_LOGIN_ID)) return;
  const salt = crypto.randomBytes(16).toString('hex');
  accounts.set(HOST_LOGIN_ID, {
    loginId: HOST_LOGIN_ID, salt, hash: hashPw(pw, salt),
    displayName: HOST_DISPLAY_NAME, avatarType: 'vera', avatarColor: 'violet',
    isHost: HOST_LOGIN_ID === 'vera', createdAt: Date.now()
  });
  saveData();
}
ensureHostAccount();

// ---------- ログイン記憶 (v3.3) ----------
// SESSION_SECRET が設定されていれば、トークンは秘密鍵付きの署名トークンになり、
// サーバーの再起動・再デプロイをまたいで有効 (有効期限30日)。
// 未設定なら従来どおりのランダム・メモリ内トークン。
// 署名トークンのログアウトはブラウザ側のトークン削除のみ (サーバー側の無効化リストは無し)。
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
function makeToken(loginId) {
  if (!SESSION_SECRET) return crypto.randomBytes(24).toString('hex');
  const exp = Date.now() + TOKEN_TTL_MS;
  const body = loginId + '.' + exp;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('hex');
  return body + '.' + sig;
}
function tokenToLoginId(token) {
  if (!token) return null;
  if (SESSION_SECRET && token.split('.').length === 3) {
    const parts = token.split('.');
    const id = parts[0], exp = parts[1], sig = parts[2];
    if (!id || !exp || !sig) return null;
    if (Date.now() > Number(exp)) return null;
    const expect = crypto.createHmac('sha256', SESSION_SECRET).update(id + '.' + exp).digest('hex');
    let a, b;
    try { a = Buffer.from(sig, 'hex'); b = Buffer.from(expect, 'hex'); } catch (e) { return null; }
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return id.toLowerCase();
  }
  return sessions.get(token) || null;
}

// ---------- 実行時状態 ----------
const sessions = new Map();  // token -> loginId(小文字)
const presence = new Map();  // loginId(小文字) -> {x, z, yaw, lastSeen, joinedAt, emote, emoteAt}
// 在室判定 (v3.4): FRESH_MS 以内の heartbeat があれば「在室」として一覧に出す。
// 以前は6秒だったため、タブがスロットリングされた端末が点滅して見えた。
// KEEP_MS 以内なら同じ入室 (joinedAt 維持) とみなし、ドアベルの誤爆も防ぐ。
const PRESENCE_FRESH_MS = 30000;
const PRESENCE_KEEP_MS = 180000;
const EMOTES = ['raise', 'jump', 'bow'];
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
  const id = tokenToLoginId(body.token);
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
  const token = makeToken(key);
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
  const token = makeToken(key);
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
  const key = a.loginId.toLowerCase();
  const now = Date.now();
  const prev = presence.get(key);
  // KEEP_MS 以内の再開は「同じ入室」の続きとして joinedAt とエモート状態を引き継ぐ
  const sameVisit = !!prev && (now - prev.lastSeen <= PRESENCE_KEEP_MS);
  presence.set(key, {
    x: +body.x || 0, z: +body.z || 0, yaw: +body.yaw || 0, lastSeen: now,
    joinedAt: sameVisit ? prev.joinedAt : now,
    emote: sameVisit ? prev.emote : null,
    emoteAt: sameVisit ? prev.emoteAt : 0
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
    if (now - p.lastSeen > PRESENCE_KEEP_MS) { presence.delete(key); continue; }
    if (key === meKey) continue;
    if (now - p.lastSeen > PRESENCE_FRESH_MS) continue;
    const acc = accounts.get(key);
    if (!acc) continue;
    list.push({
      id: key, name: acc.displayName, avatarType: acc.avatarType, avatarColor: acc.avatarColor,
      isHost: acc.isHost, x: p.x, z: p.z, yaw: p.yaw,
      joinedAt: p.joinedAt, emote: p.emote, emoteAt: p.emoteAt
    });
  }
  return sendJson(res, 200, { players: list });
}

function apiEmote(body, res) {
  const a = authOf(body);
  if (!a) return sendJson(res, 401, { authFailed: true });
  const emote = String(body.emote || '');
  if (!EMOTES.includes(emote)) return sendJson(res, 400, { error: 'unknown emote' });
  const key = a.loginId.toLowerCase();
  const now = Date.now();
  const prev = presence.get(key);
  const sameVisit = !!prev && (now - prev.lastSeen <= PRESENCE_KEEP_MS);
  presence.set(key, {
    x: prev ? prev.x : (+body.x || 0),
    z: prev ? prev.z : (+body.z || 0),
    yaw: prev ? prev.yaw : (+body.yaw || 0),
    lastSeen: prev ? prev.lastSeen : now,
    joinedAt: sameVisit ? prev.joinedAt : now,
    emote, emoteAt: now
  });
  return sendJson(res, 200, { ok: true });
}

function apiSay(body, res) {
  const a = authOf(body);
  if (!a) return sendJson(res, 401, { authFailed: true });
  const text = String(body.text || '').trim().slice(0, 200);
  if (!text) return sendJson(res, 400, { error: 'empty' });
  const msg = { id: nextMsgId++, from: a.loginId.toLowerCase(), name: a.displayName, text, ts: Date.now() };
  messages.push(msg);
  if (messages.length > 50) messages = messages.slice(-50);
  // v3.4: 送信者に確定したメッセージ (id付き) を返す。クライアントの即時表示と重複排除に使う
  return sendJson(res, 200, { ok: true, message: msg });
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
  '/api/emote': apiEmote,
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
