/**
 * CS2 Map Veto — сервер на чистом Node.js (без npm-зависимостей).
 * Запуск: node server.js  →  http://localhost:3000
 *
 * Схема:
 *  - ОРГАНИЗАТОР регистрируется/входит, создаёт матч: названия и логотипы
 *    обеих команд + формат (BO1/BO3/BO5).
 *  - Сервер выдаёт 3 ссылки: капитану команды 1, капитану команды 2
 *    и общую ссылку для наблюдателей.
 *  - Капитаны открывают свои ссылки (без регистрации) и проводят veto.
 *  - Наблюдатели смотрят в реальном времени.
 *
 * Google OAuth (для организатора): GOOGLE_CLIENT_ID в env или config.json.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------- Конфиг
let fileConfig = {};
try { fileConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) {}
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || fileConfig.googleClientId || '';

// ---------------------------------------------------------------- Карты CS2
const MAP_POOL = [
  { id: 'dust2',    name: 'Dust II'  },
  { id: 'mirage',   name: 'Mirage'   },
  { id: 'inferno',  name: 'Inferno'  },
  { id: 'nuke',     name: 'Nuke'     },
  { id: 'ancient',  name: 'Ancient'  },
  { id: 'overpass', name: 'Overpass' },
  { id: 'anubis',   name: 'Anubis'   },
  { id: 'cache',    name: 'Cache'    },
];

// Последовательности veto (пул из 8 карт). A — команда 1, B — команда 2.
// 'side' — выбор стороны на последней пикнутой карте противоположной командой.
// Сторона на decider — криптослучайная монетка.
const VETO_SEQUENCES = {
  BO1: [
    { team: 'A', type: 'ban' }, { team: 'B', type: 'ban' },
    { team: 'A', type: 'ban' }, { team: 'B', type: 'ban' },
    { team: 'A', type: 'ban' }, { team: 'B', type: 'ban' },
    { team: 'A', type: 'ban' },
  ],
  BO3: [
    { team: 'A', type: 'ban' },  { team: 'B', type: 'ban' },
    { team: 'A', type: 'pick' }, { team: 'B', type: 'side' },
    { team: 'B', type: 'pick' }, { team: 'A', type: 'side' },
    { team: 'A', type: 'ban' },  { team: 'B', type: 'ban' },
    { team: 'A', type: 'ban' },
  ],
  BO5: [
    { team: 'A', type: 'ban' },  { team: 'B', type: 'ban' }, { team: 'A', type: 'ban' },
    { team: 'B', type: 'pick' }, { team: 'A', type: 'side' },
    { team: 'A', type: 'pick' }, { team: 'B', type: 'side' },
    { team: 'B', type: 'pick' }, { team: 'A', type: 'side' },
    { team: 'A', type: 'pick' }, { team: 'B', type: 'side' },
  ],
};

// ---------------------------------------------------------------- Хранилище
let db = { users: [], sessions: {}, matches: [] };
if (fs.existsSync(DATA_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
}
function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Не удалось сохранить data.json:', e.message);
  }
}

// ---------------------------------------------------------------- Пароли
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

// ---------------------------------------------------------------- Сессии
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function getUser(req) {
  const token = parseCookies(req).token;
  const userId = token && db.sessions[token];
  return db.users.find(u => u.id === userId) || null;
}
function createSession(res, userId) {
  const token = id() + id();
  db.sessions[token] = userId;
  save();
  res.setHeader('Set-Cookie', `token=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
}

// ---------------------------------------------------------------- Утилиты
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
const id = () => crypto.randomBytes(8).toString('hex');
const captainToken = () => crypto.randomBytes(16).toString('hex'); // 128 бит — не подобрать

// Код наблюдателей: 10 символов, алфавит без похожих символов (нет 0/O, 1/I/L)
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function inviteCode() {
  let out = '';
  while (out.length < 10) {
    const b = crypto.randomBytes(1)[0];
    if (b < 31 * 8) out += CODE_ALPHABET[b % 31];
  }
  return out;
}

// Логотип команды — { url: data-URL (256×256, с прозрачностью), light: bool }
// light=true означает «логотип светлый, показывать на тёмной подложке».
function validLogo(v) {
  if (!v || typeof v !== 'object') return null;
  const url = v.url;
  if (typeof url !== 'string') return null;
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) return null;
  if (url.length > 250_000) return null;
  return { url, light: !!v.light };
}

function cleanCode(raw) {
  const cyr = { 'А':'A','В':'B','С':'C','Е':'E','Н':'H','К':'K','М':'M','Р':'P','Т':'T','У':'Y','Х':'X' };
  return (raw || '').toUpperCase().replace(/[\s-]/g, '').replace(/[АВСЕНКМРТУХ]/g, ch => cyr[ch]);
}

function uniqueUsername(base) {
  let name = (base || 'user').trim().slice(0, 24) || 'user';
  let candidate = name, i = 1;
  while (db.users.some(u => u.username.toLowerCase() === candidate.toLowerCase())) {
    candidate = `${name}${++i}`;
  }
  return candidate;
}

// ---------------------------------------------------------------- Матч → вид
function matchView(m, team /* 'A' | 'B' | null */) {
  const seq = VETO_SEQUENCES[m.format];
  const done = m.actions.length >= seq.length;
  const current = done ? null : seq[m.actions.length];

  // К какой карте относится текущий шаг 'side' — к последней пикнутой
  let sideForMap = null;
  if (current && current.type === 'side') {
    const lastPick = [...m.actions].reverse().find(a => a.type === 'pick');
    sideForMap = lastPick ? lastPick.map : null;
  }

  let finalMaps = null;
  if (done) {
    const used = new Set(m.actions.filter(a => a.type !== 'side').map(a => a.map));
    const decider = MAP_POOL.find(mp => !used.has(mp.id));
    finalMaps = m.actions.filter(a => a.type === 'pick').map(a => {
      const sideAct = m.actions.find(s => s.type === 'side' && s.map === a.map);
      return {
        map: a.map,
        pickedBy: a.team,
        sideTeam: sideAct ? sideAct.team : null,
        side: sideAct ? sideAct.side : null,
      };
    });
    if (decider) {
      finalMaps.push({
        map: decider.id,
        pickedBy: 'decider',
        sideTeam: m.coin ? m.coin.team : null,
        side: m.coin ? m.coin.side : null,
        coin: true,
      });
    }
  }

  return {
    id: m.id,
    format: m.format,
    code: m.code,
    teamA: { name: m.teamA.name, logo: m.teamA.logo },
    teamB: { name: m.teamB.name, logo: m.teamB.logo },
    spectators: (m.spectators || []).slice(-30),
    actions: m.actions,
    mapPool: MAP_POOL,
    status: done ? 'done' : 'veto',
    currentStep: current,
    stepIndex: m.actions.length,
    totalSteps: seq.length,
    sequence: seq, // полный план шагов — для таймлайна на фронте
    myTeam: team,
    yourTurn: !!(team && current && current.team === team),
    sideForMap,
    finalMaps,
    createdAt: m.createdAt,
  };
}

// ---------------------------------------------------------------- Роуты API
async function api(req, res, url) {
  const user = getUser(req);
  const p = url.pathname;

  // --- публичный конфиг
  if (p === '/api/config') {
    return json(res, 200, { googleClientId: GOOGLE_CLIENT_ID || null });
  }

  // --- регистрация (организатор)
  if (p === '/api/register' && req.method === 'POST') {
    const { username, password } = await readBody(req);
    if (!username || !password || username.length < 2 || password.length < 4)
      return json(res, 400, { error: 'Логин от 2 символов, пароль от 4' });
    if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase()))
      return json(res, 409, { error: 'Такой логин уже занят' });
    const u = { id: id(), username: username.trim(), password: hashPassword(password), avatar: Math.floor(Math.random() * 12) };
    db.users.push(u);
    createSession(res, u.id);
    return json(res, 200, { username: u.username, avatar: u.avatar });
  }

  // --- вход
  if (p === '/api/login' && req.method === 'POST') {
    const { username, password } = await readBody(req);
    const u = db.users.find(x => x.username.toLowerCase() === (username || '').toLowerCase());
    if (!u || !u.password || !verifyPassword(password || '', u.password))
      return json(res, 401, { error: 'Неверный логин или пароль' });
    createSession(res, u.id);
    return json(res, 200, { username: u.username, avatar: u.avatar || 0 });
  }

  // --- вход через Google
  if (p === '/api/auth/google' && req.method === 'POST') {
    if (!GOOGLE_CLIENT_ID)
      return json(res, 400, { error: 'Google OAuth не настроен на сервере (нет GOOGLE_CLIENT_ID)' });
    const { credential } = await readBody(req);
    if (!credential) return json(res, 400, { error: 'Нет credential' });
    let info;
    try {
      const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
      if (!r.ok) throw new Error('bad token');
      info = await r.json();
    } catch (e) {
      return json(res, 401, { error: 'Google-токен не прошёл проверку' });
    }
    if (info.aud !== GOOGLE_CLIENT_ID)
      return json(res, 401, { error: 'Токен выдан для другого приложения' });
    let u = db.users.find(x => x.googleId === info.sub);
    if (!u) {
      u = {
        id: id(),
        googleId: info.sub,
        email: info.email || null,
        username: uniqueUsername(info.name || (info.email || '').split('@')[0]),
        password: null,
        avatar: Math.floor(Math.random() * 12),
      };
      db.users.push(u);
    }
    createSession(res, u.id);
    return json(res, 200, { username: u.username, avatar: u.avatar || 0 });
  }

  // --- выход
  if (p === '/api/logout' && req.method === 'POST') {
    const token = parseCookies(req).token;
    delete db.sessions[token];
    save();
    res.setHeader('Set-Cookie', 'token=; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  // --- кто я
  if (p === '/api/me') {
    return json(res, 200, { user: user ? { username: user.username, avatar: user.avatar || 0 } : null });
  }

  // ============================================================
  // КАПИТАНЫ — доступ по секретному токену из ссылки, без логина
  // ============================================================
  const vetoMatch = p.match(/^\/api\/veto\/([a-f0-9]{32})(\/action)?$/);
  if (vetoMatch) {
    const token = vetoMatch[1];
    const m = db.matches.find(x => x.tokenA === token || x.tokenB === token);
    if (!m) return json(res, 404, { error: 'Ссылка недействительна — матч не найден' });
    const team = m.tokenA === token ? 'A' : 'B';

    if (!vetoMatch[2] && req.method === 'GET') {
      return json(res, 200, matchView(m, team));
    }

    if (vetoMatch[2] && req.method === 'POST') {
      const { map, side } = await readBody(req);
      const seq = VETO_SEQUENCES[m.format];
      const step = seq[m.actions.length];

      if (!step) return json(res, 400, { error: 'Veto уже завершён' });
      if (step.team !== team) return json(res, 403, { error: 'Сейчас ход другой команды' });

      if (step.type === 'side') {
        if (side !== 'CT' && side !== 'T') return json(res, 400, { error: 'Выберите сторону: CT или T' });
        const lastPick = [...m.actions].reverse().find(a => a.type === 'pick');
        if (!lastPick) return json(res, 400, { error: 'Нет карты для выбора стороны' });
        m.actions.push({ team, type: 'side', map: lastPick.map, side, at: Date.now() });
      } else {
        if (!MAP_POOL.some(mp => mp.id === map)) return json(res, 400, { error: 'Неизвестная карта' });
        if (m.actions.some(a => a.type !== 'side' && a.map === map))
          return json(res, 400, { error: 'Карта уже выбрана или забанена' });
        m.actions.push({ team, type: step.type, map, at: Date.now() });
      }

      // Монетка для decider после завершения
      if (m.actions.length >= seq.length && !m.coin) {
        const used = new Set(m.actions.filter(a => a.type !== 'side').map(a => a.map));
        if (MAP_POOL.some(mp => !used.has(mp.id))) {
          const bytes = crypto.randomBytes(2);
          m.coin = {
            team: bytes[0] % 2 === 0 ? 'A' : 'B',
            side: bytes[1] % 2 === 0 ? 'CT' : 'T',
          };
        }
      }

      save();
      return json(res, 200, matchView(m, team));
    }
  }

  // ============================================================
  // НАБЛЮДАТЕЛИ — по коду, без логина
  // ============================================================
  if (p === '/api/spectate' && req.method === 'GET') {
    const code = cleanCode(url.searchParams.get('code'));
    const m = db.matches.find(x => x.code === code);
    if (!m) return json(res, 404, { error: 'Матч не найден — проверьте ссылку/код' });
    const specName = (url.searchParams.get('name') || (user ? user.username : '') || 'Гость').slice(0, 24);
    m.spectators = m.spectators || [];
    if (specName && !m.spectators.includes(specName)) {
      m.spectators.push(specName);
      if (m.spectators.length > 50) m.spectators.shift();
      save();
    }
    return json(res, 200, matchView(m, null));
  }

  // ============================================================
  // ОРГАНИЗАТОР — всё ниже требует входа
  // ============================================================
  if (!user) return json(res, 401, { error: 'Требуется вход' });

  // --- сменить аватарку профиля
  if (p === '/api/avatar' && req.method === 'POST') {
    const { avatar } = await readBody(req);
    const n = Number(avatar);
    if (!Number.isInteger(n) || n < 0 || n > 11) return json(res, 400, { error: 'Неверная аватарка' });
    user.avatar = n;
    save();
    return json(res, 200, { username: user.username, avatar: n });
  }

  // --- создать матч (организатор задаёт обе команды)
  if (p === '/api/matches' && req.method === 'POST') {
    const { format, teamAName, teamALogo, teamBName, teamBLogo } = await readBody(req);
    if (!VETO_SEQUENCES[format]) return json(res, 400, { error: 'Формат: BO1, BO3 или BO5' });
    const nameA = String(teamAName || '').trim().slice(0, 24);
    const nameB = String(teamBName || '').trim().slice(0, 24);
    if (!nameA || !nameB) return json(res, 400, { error: 'Укажите названия обеих команд' });
    if (nameA.toLowerCase() === nameB.toLowerCase()) return json(res, 400, { error: 'Названия команд должны различаться' });

    const m = {
      id: id(),
      code: inviteCode(),
      tokenA: captainToken(),
      tokenB: captainToken(),
      format,
      teamA: { name: nameA, logo: validLogo(teamALogo) },
      teamB: { name: nameB, logo: validLogo(teamBLogo) },
      organizer: user.id,
      actions: [],
      spectators: [],
      createdAt: Date.now(),
    };
    db.matches.push(m);
    save();
    return json(res, 200, { ...matchView(m, null), tokenA: m.tokenA, tokenB: m.tokenB });
  }

  // --- мои матчи (организатора)
  if (p === '/api/matches' && req.method === 'GET') {
    const mine = db.matches
      .filter(m => m.organizer === user.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(m => ({ ...matchView(m, null), tokenA: m.tokenA, tokenB: m.tokenB }));
    return json(res, 200, mine);
  }

  // --- один матч организатора (с токенами для ссылок)
  const mMatch = p.match(/^\/api\/matches\/([a-f0-9]+)$/);
  if (mMatch && req.method === 'GET') {
    const m = db.matches.find(x => x.id === mMatch[1]);
    if (!m) return json(res, 404, { error: 'Матч не найден' });
    if (m.organizer !== user.id) return json(res, 403, { error: 'Это не ваш матч' });
    return json(res, 200, { ...matchView(m, null), tokenA: m.tokenA, tokenB: m.tokenB });
  }

  // --- удалить матч
  const mDel = p.match(/^\/api\/matches\/([a-f0-9]+)$/);
  if (mDel && req.method === 'DELETE') {
    const i = db.matches.findIndex(x => x.id === mDel[1] && x.organizer === user.id);
    if (i === -1) return json(res, 404, { error: 'Матч не найден' });
    db.matches.splice(i, 1);
    save();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------- Статика
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  const indexFile = path.join(PUBLIC_DIR, 'index.html');

  if (!fs.existsSync(indexFile)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(
      'Не найден файл public/index.html.\n\n' +
      'Рядом с server.js должна лежать папка public с файлом index.html:\n' +
      '  ваша-папка/\n' +
      '  ├── server.js\n' +
      '  └── public/\n' +
      '      └── index.html\n\n' +
      `Сервер ищет его здесь: ${indexFile}`
    );
  }

  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    // SPA fallback — /veto/<token> и /watch/<code> обслуживает index.html
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(indexFile));
  }
  res.writeHead(200, { 'Content-Type': (MIME[path.extname(full)] || 'application/octet-stream') + '; charset=utf-8' });
  res.end(fs.readFileSync(full));
}

// ---------------------------------------------------------------- Сервер
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      json(res, 500, { error: 'Server error' });
    } else {
      res.end();
    }
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`CS2 Veto запущен:`);
  console.log(`  На этом компьютере:  http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  С телефона (Wi-Fi):  http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(GOOGLE_CLIENT_ID ? 'Google OAuth: включён' : 'Google OAuth: выключен (нет GOOGLE_CLIENT_ID)');
});
