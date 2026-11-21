// StarryApa みんなで歩けるお店 (Render用スタンドアロン版) v5.16
// v5.16: ポイント制 (ログイン/花火/クレーン/気球/怪鳥/メリーゴーラウンド/掲示板/入浴で加算、Neon保存、ランキングと店主一覧)。
// v4.6: メリーゴーラウンド乗車用に、heartbeat の ry (足元の高さオフセット) を中継する。
// v4.3: 山頂の発射ボタンで花火 (全員に /api/players 経由で放送、クールダウン10秒)。星空とウメハウスはクライアント/GLB側。
// v4.1: ベラ人形は店主専用に (登録時＋起動時に補正)。Bar AQUA の内装はクライアント/GLB側。
// v4.0: アカウントと掲示板を Neon Postgres に保存 (環境変数 DATABASE_URL)。
// DATABASE_URL が無い/接続できない場合は従来どおり data.json + メモリで動く。
// pg ライブラリが無い環境でも落ちないよう、読み込み失敗時はフォールバックする。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data.json');

// ---------- アカウントのメモリキャッシュ ----------
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

// ---------- データ保存層 (v4.0) ----------
// DATABASE_URL があれば Postgres (Neon) を使う。無ければ従来方式。
// 起動時にアカウントを全件メモリへ読み込み、登録時だけDBへ書き込む
// (読み取りはメモリキャッシュから行うので既存の同期コードはそのまま)。
const DATABASE_URL = process.env.DATABASE_URL || '';
let pool = null;
if (DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  } catch (e) {
    console.error('pg ライブラリを読み込めませんでした。メモリ保存にフォールバックします:', e.message);
    pool = null;
  }
}

let boardMem = [];      // フォールバック時の掲示板 (メモリ内)
let nextBoardId = 1;

async function storeInit() {
  if (!pool) { loadData(); return; }
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS accounts (
      login_id TEXT PRIMARY KEY,
      login_name TEXT NOT NULL,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_type TEXT NOT NULL,
      avatar_color TEXT NOT NULL,
      is_host BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS points (
      login_id TEXT PRIMARY KEY,
      pts INTEGER NOT NULL DEFAULT 0
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS points_daily (
      login_id TEXT NOT NULL,
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      cnt INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (login_id, day, kind)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS board_posts (
      id SERIAL PRIMARY KEY,
      login_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )`);
    const r = await pool.query('SELECT * FROM accounts');
    for (const row of r.rows) {
      accounts.set(row.login_id, {
        loginId: row.login_name, salt: row.salt, hash: row.hash,
        displayName: row.display_name, avatarType: row.avatar_type,
        avatarColor: row.avatar_color, isHost: row.is_host,
        createdAt: Number(row.created_at)
      });
    }
    console.log('DB接続OK: アカウント ' + r.rows.length + ' 件を読み込みました');
  } catch (e) {
    console.error('DB初期化に失敗しました。メモリ保存にフォールバックします:', e.message);
    pool = null;
    loadData();
  }
}

async function storeSaveAccount(a) {
  if (!pool) { saveData(); return; }
  await pool.query(
    `INSERT INTO accounts (login_id, login_name, salt, hash, display_name, avatar_type, avatar_color, is_host, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [a.loginId.toLowerCase(), a.loginId, a.salt, a.hash, a.displayName,
     a.avatarType, a.avatarColor, !!a.isHost, a.createdAt]
  );
}

function rowToPost(row) {
  return { id: row.id, from: row.login_id, name: row.display_name, text: row.text, ts: Number(row.created_at) };
}

async function boardList() {
  if (!pool) return boardMem.slice(-50).reverse();
  const r = await pool.query(
    'SELECT id, login_id, display_name, text, created_at FROM board_posts ORDER BY id DESC LIMIT 50'
  );
  return r.rows.map(rowToPost);
}

async function boardAdd(from, name, text) {
  const ts = Date.now();
  if (!pool) {
    const post = { id: nextBoardId++, from, name, text, ts };
    boardMem.push(post);
    if (boardMem.length > 200) boardMem = boardMem.slice(-200);
    return post;
  }
  const r = await pool.query(
    'INSERT INTO board_posts (login_id, display_name, text, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [from, name, text, ts]
  );
  return { id: r.rows[0].id, from, name, text, ts };
}

async function boardDelete(id) {
  if (!pool) {
    boardMem = boardMem.filter(p => p.id !== id);
    return;
  }
  await pool.query('DELETE FROM board_posts WHERE id = $1', [id]);
}

// ---------- ポイント (v5.16) ----------
// 1日の上限つきで加算する。上限に達していたら added=0 で返す。
const POINT_RULES = {
  login:     { pts: 10, cap: 1 },
  fireworks: { pts: 5,  cap: 10 },
  crane:     { pts: 3,  cap: 20 },
  crane_big: { pts: 30, cap: 3 },
  balloon:   { pts: 5,  cap: 5 },
  bird:      { pts: 5,  cap: 5 },
  carousel:  { pts: 3,  cap: 10 },
  board:     { pts: 3,  cap: 5 },
  bath:      { pts: 2,  cap: 3 }
};
const pointsMem = new Map();   // フォールバック用: loginId -> pts
const dailyMem = new Map();    // フォールバック用: loginId|day|kind -> cnt
function jstDay() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
async function pointsOf(key) {
  if (!pool) return pointsMem.get(key) || 0;
  const r = await pool.query('SELECT pts FROM points WHERE login_id = $1', [key]);
  return r.rows.length ? r.rows[0].pts : 0;
}
async function awardPoints(key, kind) {
  const rule = POINT_RULES[kind];
  if (!rule) return { added: 0, total: await pointsOf(key) };
  const day = jstDay();
  if (!pool) {
    const dk = key + '|' + day + '|' + kind;
    const cnt = dailyMem.get(dk) || 0;
    if (cnt >= rule.cap) return { added: 0, total: pointsMem.get(key) || 0 };
    dailyMem.set(dk, cnt + 1);
    const total = (pointsMem.get(key) || 0) + rule.pts;
    pointsMem.set(key, total);
    return { added: rule.pts, total };
  }
  const r = await pool.query('SELECT cnt FROM points_daily WHERE login_id = $1 AND day = $2 AND kind = $3', [key, day, kind]);
  const cnt = r.rows.length ? r.rows[0].cnt : 0;
  if (cnt >= rule.cap) return { added: 0, total: await pointsOf(key) };
  await pool.query(
    `INSERT INTO points_daily (login_id, day, kind, cnt) VALUES ($1, $2, $3, 1)
     ON CONFLICT (login_id, day, kind) DO UPDATE SET cnt = points_daily.cnt + 1`,
    [key, day, kind]);
  await pool.query(
    `INSERT INTO points (login_id, pts) VALUES ($1, $2)
     ON CONFLICT (login_id) DO UPDATE SET pts = points.pts + $2`,
    [key, rule.pts]);
  return { added: rule.pts, total: await pointsOf(key) };
}
async function pointsTop(n) {
  let rows;
  if (!pool) {
    rows = [...pointsMem.entries()].map(([login_id, pts]) => ({ login_id, pts }));
  } else {
    const r = await pool.query('SELECT login_id, pts FROM points ORDER BY pts DESC, login_id ASC LIMIT $1', [n]);
    rows = r.rows;
  }
  rows.sort((a, b) => b.pts - a.pts);
  return rows.slice(0, n).map(r => {
    const acc = accounts.get(r.login_id);
    return { name: acc ? acc.displayName : r.login_id, points: r.pts };
  });
}
async function pointsAll() {
  const totals = new Map();
  if (!pool) {
    for (const [k, v] of pointsMem) totals.set(k, v);
  } else {
    const r = await pool.query('SELECT login_id, pts FROM points');
    for (const row of r.rows) totals.set(row.login_id, row.pts);
  }
  const list = [];
  for (const [key, a] of accounts) list.push({ name: a.displayName, loginId: a.loginId, points: totals.get(key) || 0 });
  list.sort((a, b) => b.points - a.points);
  return list;
}

// ---------- 店主アカウントの種まき (v3.3) ----------
// 環境変数 HOST_PASSWORD が設定されていれば、起動のたびに店主アカウントが
// 無い場合だけ作り直す。既存のアカウントは上書きしない。
const HOST_LOGIN_ID = (process.env.HOST_LOGIN_ID || 'vera').trim().toLowerCase();
const HOST_DISPLAY_NAME = (process.env.HOST_DISPLAY_NAME || 'ベラ').trim() || 'ベラ';
async function ensureHostAccount() {
  const pw = process.env.HOST_PASSWORD || '';
  if (!pw || pw.length < 4) return;
  if (accounts.has(HOST_LOGIN_ID)) return;
  const salt = crypto.randomBytes(16).toString('hex');
  const account = {
    loginId: HOST_LOGIN_ID, salt, hash: hashPw(pw, salt),
    displayName: HOST_DISPLAY_NAME, avatarType: 'vera', avatarColor: 'violet',
    isHost: HOST_LOGIN_ID === 'vera', createdAt: Date.now()
  };
  accounts.set(HOST_LOGIN_ID, account);
  try { await storeSaveAccount(account); } catch (e) { console.error('店主アカウントの保存に失敗:', e.message); }
}

// ---------- ログイン記憶 (v3.3) ----------
// SESSION_SECRET が設定されていれば、トークンは秘密鍵付きの署名トークンになり、
// サーバーの再起動・再デプロイをまたいで有効 (有効期限30日)。
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
const PRESENCE_FRESH_MS = 30000;
const PRESENCE_KEEP_MS = 180000;
const EMOTES = ['raise', 'jump', 'bow', 'joy'];
let messages = [];           // {id, name, text, ts}
let nextMsgId = 1;
let fireworksAt = 0;         // v4.3: 花火が最後に発射された時刻 (全員への放送は /api/players の応答に載せる)
const FIREWORKS_COOLDOWN_MS = 10000;
let balloonAt = 0;           // v4.9: 気球が飛び立った時刻 (全員への放送は /api/players の応答に載せる)
let balloonBy = '';          // v4.9: 気球に乗っている人の loginId
const BALLOON_CYCLE_MS = 50000;   // v4.9: 上昇15s＋滞空14s＋下降15s＋着陸後の間隔6s
let birdsBy = ['', '', ''];  // v5.13: 怪鳥3羽に乗っている人の loginId ('' は空き)
let birdsAt = [0, 0, 0];     // v5.13: 怪鳥に乗り始めた時刻

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
async function apiRegister(body, res) {
  const loginId = String(body.loginId || '').trim();
  const password = String(body.password || '');
  const displayName = String(body.displayName || 'ベラ').trim().slice(0, 20) || 'ベラ';
  let avatarType = AVATAR_TYPES.includes(body.avatarType) ? body.avatarType : 'girl';
  const avatarColor = AVATAR_COLORS.includes(body.avatarColor) ? body.avatarColor : 'violet';
  if (!loginId || loginId.length > 32) return sendJson(res, 400, { error: 'ログインIDを入力してください' });
  if (password.length < 4) return sendJson(res, 400, { error: 'パスワードは4文字以上にしてください' });
  const key = loginId.toLowerCase();
  if (avatarType === 'vera' && key !== HOST_LOGIN_ID) avatarType = 'girl';   // ベラ人形は店主専用 (v4.1)
  if (accounts.has(key)) return sendJson(res, 409, { error: 'そのログインIDはすでに使われています' });
  const salt = crypto.randomBytes(16).toString('hex');
  const account = {
    loginId, salt, hash: hashPw(password, salt), displayName, avatarType, avatarColor,
    isHost: key === 'vera', createdAt: Date.now()
  };
  accounts.set(key, account);
  try {
    await storeSaveAccount(account);
  } catch (e) {
    console.error('アカウント保存に失敗:', e.message);
    accounts.delete(key);
    return sendJson(res, 500, { error: '保存に失敗しました。少し待ってから再度お試しください' });
  }
  const token = makeToken(key);
  sessions.set(token, key);
  const bonus = await awardPoints(key, 'login');
  return sendJson(res, 200, { token, account: publicAccount(account), points: bonus.total, bonus: bonus.added });
}

async function apiLogin(body, res) {
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
  const bonus = await awardPoints(key, 'login');
  return sendJson(res, 200, { token, account: publicAccount(a), points: bonus.total, bonus: bonus.added });
}

async function apiMe(body, res) {
  const a = authOf(body);
  if (!a) return sendJson(res, 200, { account: null });
  return sendJson(res, 200, { account: publicAccount(a), points: await pointsOf(a.loginId.toLowerCase()) });
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
  const sameVisit = !!prev && (now - prev.lastSeen <= PRESENCE_KEEP_MS);
  presence.set(key, {
    x: +body.x || 0, z: +body.z || 0, yaw: +body.yaw || 0, ry: +body.ry || 0, lastSeen: now,
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
      isHost: acc.isHost, x: p.x, z: p.z, yaw: p.yaw, ry: p.ry || 0,
      joinedAt: p.joinedAt, emote: p.emote, emoteAt: p.emoteAt
    });
  }
  // v5.13: 退出・タイムアウトした人の怪鳥は空きに戻す
  for (let i = 0; i < 3; i++) {
    if (birdsBy[i] && !presence.has(birdsBy[i].toLowerCase())) { birdsBy[i] = ''; birdsAt[i] = 0; }
  }
  return sendJson(res, 200, { players: list, fireworksAt, balloonAt, balloonBy, birdsBy, birdsAt });
}

// v4.9: 公園の気球。乗った本人には即時応答し、他の全員には /api/players 経由で伝わる (花火と同じ方式)
async function apiBalloon(body, res) {
  const a = authOf(body);
  if (!a) return sendJson(res, 401, { authFailed: true });
  const now = Date.now();
  if (now - balloonAt < BALLOON_CYCLE_MS) {
    return sendJson(res, 429, { error: 'cooldown', retryAfterMs: BALLOON_CYCLE_MS - (now - balloonAt) });
  }
  balloonAt = now;
  balloonBy = a.loginId;
  const pts = await awardPoints(a.loginId.toLowerCase(), 'balloon');
  return sendJson(res, 200, { ok: true, balloonAt, balloonBy, points: pts.total, added: pts.added });
}

// v5.13: 怪鳥の騎乗・降鳥。本人には即時応答し、他の全員には /api/players 経由で伝わる (気球と同じ方式)
async function apiBird(body, res) {
  const a = authOf(body);
  if (!a) return sendJson(res, 401, { authFailed: true });
  const i = +body.bird;
  if (!(i >= 0 && i < 3)) return sendJson(res, 400, { error: 'bad bird' });
  const now = Date.now();
  if (body.off) {
    if (birdsBy[i] === a.loginId) { birdsBy[i] = ''; birdsAt[i] = 0; }
    return sendJson(res, 200, { ok: true, birdsBy, birdsAt });
  }
  if (birdsBy[i] && birdsBy[i] !== a.loginId && presence.has(birdsBy[i].toLowerCase())) {
    return sendJson(res, 429, { error: 'taken' });
  }
  // 別の鳥に乗っていたら降りておく
  for (let j = 0; j < 3; j++) if (birdsBy[j] === a.loginId) { birdsBy[j] = ''; birdsAt[j] = 0; }
  birdsBy[i] = a.loginId;
  birdsAt[i] = now;
  const pts = await awardPoints(a.loginId.toLowerCase(), 'bird');
  return sendJson(res, 200, { ok: true, birdsBy, birdsAt, points: pts.total, added: pts.added });
}

// v4.3: 山頂の発射ボタン。押した本人には即時応答し、他の全員には /api/players 経由で伝わる
async function apiFireworks(body, res) {
  const a = authOf(body);
  if (!a) return sendJson(res, 401, { authFailed: true });
  const now = Date.now();
  if (now - fireworksAt < FIREWORKS_COOLDOWN_MS) {
    return sendJson(res, 429, { error: 'cooldown', retryAfterMs: FIREWORKS_COOLDOWN_MS - (now - fireworksAt) });
  }
  fireworksAt = now;
  const pts = await awardPoints(a.loginId.toLowerCase(), 'fireworks');
  return sendJson(res, 200, { ok: true, fireworksAt, points: pts.total, added: pts.added });
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

// ---------- 掲示板API (v4.0) ----------
async function apiBoardList(body, res) {
  const a = authOf(body);
  if (!a) return sendJson(res, 401, { authFailed: true });
  const posts = await boardList();
  return sendJson(res, 200, { posts, isHost: !!a.isHost });
}

async function apiBoardPost(body, res) {
  const a = authOf(body);
  if (!a) return sendJson(res, 401, { authFailed: true });
  const text = String(body.text || '').trim().slice(0, 200);
  if (!text) return sendJson(res, 400, { error: 'empty' });
  const post = await boardAdd(a.loginId.toLowerCase(), a.displayName, text);
  const pts = await awardPoints(a.loginId.toLowerCase(), 'board');
  return sendJson(res, 200, { ok: true, post, points: pts.total, added: pts.added });
}

async function apiBoardDelete(body, res) {
  const a = authOf(body);
  if (!a) return sendJson(res, 401, { authFailed: true });
  if (!a.isHost) return sendJson(res, 403, { error: '削除できるのは店主だけです' });
  const id = +body.id || 0;
  if (!id) return sendJson(res, 400, { error: 'bad id' });
  await boardDelete(id);
  return sendJson(res, 200, { ok: true });
}

// v5.16: クライアント側だけの遊び (クレーン/メリーゴーラウンド/入浴) の加算受付
const EARN_KINDS = ['crane', 'crane_big', 'carousel', 'bath'];
async function apiPointsEarn(body, res) {
  const a = authOf(body);
  if (!a) return sendJson(res, 401, { authFailed: true });
  const kind = String(body.kind || '');
  if (!EARN_KINDS.includes(kind)) return sendJson(res, 400, { error: 'bad kind' });
  const pts = await awardPoints(a.loginId.toLowerCase(), kind);
  return sendJson(res, 200, { ok: true, points: pts.total, added: pts.added });
}
async function apiPointsMe(body, res) {
  const a = authOf(body);
  if (!a) return sendJson(res, 401, { authFailed: true });
  const key = a.loginId.toLowerCase();
  const top = await pointsTop(3);
  const all = await pointsTop(1000);
  let rank = 0;
  const mine = await pointsOf(key);
  const sorted = all.map(t => t.points);
  rank = sorted.filter(p => p > mine).length + 1;
  return sendJson(res, 200, { points: mine, rank, top });
}
async function apiPointsAll(body, res) {
  const a = authOf(body);
  if (!a) return sendJson(res, 401, { authFailed: true });
  if (!a.isHost) return sendJson(res, 403, { error: '店主だけが見られます' });
  return sendJson(res, 200, { list: await pointsAll() });
}

const API = {
  '/api/register': apiRegister,
  '/api/login': apiLogin,
  '/api/me': apiMe,
  '/api/logout': apiLogout,
  '/api/heartbeat': apiHeartbeat,
  '/api/players': apiPlayers,
  '/api/emote': apiEmote,
  '/api/fireworks': apiFireworks,
  '/api/balloon': apiBalloon,
  '/api/bird': apiBird,
  '/api/say': apiSay,
  '/api/messages': apiMessages,
  '/api/leave': apiLeave,
  '/api/board/list': apiBoardList,
  '/api/board/post': apiBoardPost,
  '/api/board/delete': apiBoardDelete,
  '/api/points/earn': apiPointsEarn,
  '/api/points/me': apiPointsMe,
  '/api/points/all': apiPointsAll
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
  '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg'
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
      Promise.resolve(API[u.pathname](body, res)).catch(err => {
        console.error('APIエラー ' + u.pathname + ':', err.message);
        if (!res.headersSent) sendJson(res, 500, { error: 'server error' });
      });
    });
    return;
  }
  if (req.method === 'GET') return serveStatic(req, res, u.pathname);
  res.writeHead(405); res.end();
});

// ---------- ベラ人形は店主専用 (v4.1) ----------
// 店主以外のアカウントが avatarType 'vera' になっていたら 'girl' に直す。
// 起動時に既存アカウントを一括補正し、登録時にも強制する。
async function normalizeAvatars() {
  let fixed = 0;
  for (const [key, a] of accounts) {
    if (a.avatarType === 'vera' && key !== HOST_LOGIN_ID) {
      a.avatarType = 'girl';
      fixed++;
      if (pool) {
        try { await pool.query("UPDATE accounts SET avatar_type = 'girl' WHERE login_id = $1", [key]); }
        catch (e) { console.error('アバター補正のDB保存に失敗:', e.message); }
      }
    }
  }
  if (fixed > 0) {
    if (!pool) saveData();
    console.log('ベラ人形の店主専用化: ' + fixed + ' 件のアカウントを女の子に補正しました');
  }
}

// ---------- 起動 (DB初期化 → 店主の種まき → アバター補正 → 待ち受け) ----------
(async () => {
  await storeInit();
  await ensureHostAccount();
  await normalizeAvatars();
  server.listen(PORT, () => console.log('StarryApa shop listening on port ' + PORT + (pool ? ' (DB保存モード)' : ' (メモリ保存モード)')));
})();
