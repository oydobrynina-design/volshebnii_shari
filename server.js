'use strict';

/**
 * Сервер «Волшебных шаров».
 * Хранит, какие шары уже заняты, и кто именно их забрал.
 * Состояние лежит в файле рядом с сервером, поэтому переживает перезапуск.
 *
 * Запуск:  node server.js  (или npm start)
 * Порт:    PORT (по умолчанию 3000)
 * Данные:  DATA_DIR, иначе /data (постоянный том), иначе ./data
 *
 * Railway: том монтируется в /data, платформа сама подставляет PORT.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
// Railway монтирует постоянный том в /data; локально данные лежат рядом с сервером
const VOLUME_DIR = '/data';
const DATA_DIR = process.env.DATA_DIR
  || (fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : path.join(ROOT, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const TOTAL = 5;

/* ---------------- хранилище ---------------- */
function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) writeStore({ picks: {} });
}

function readStore() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || typeof j.picks !== 'object' || j.picks === null) {
      return { picks: {} };
    }
    return j;
  } catch (e) {
    // повреждённый файл не должен ронять сайт
    return { picks: {} };
  }
}

function writeStore(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE); // атомарная замена
}

/** Один поток Node — операции над магазином сериализованы между собой. */
function takenList(store) {
  return Object.keys(store.picks).map(Number).sort((a, b) => a - b);
}

function mineOf(store, token) {
  if (!token) return null;
  const found = Object.keys(store.picks).find(k => store.picks[k] === token);
  return found ? Number(found) : null;
}

/* ---------------- ответы ---------------- */
function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

/* ---------------- статика ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Не найдено');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    };
    // просмотр карточек — служебная страница, поисковикам её не отдаём
    if (path.basename(filePath) === 'cards.html') {
      headers['X-Robots-Tag'] = 'noindex, nofollow';
    }
    res.writeHead(200, headers);
    res.end(buf);
  });
}

function safeJoin(root, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const target = path.normalize(path.join(root, clean));
  if (!target.startsWith(root)) return null;
  return target;
}

/* ---------------- сервер ---------------- */
ensureStore();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const route = u.pathname;

  // проверка живости для платформы: отвечает всегда, пока процесс поднят
  if (route === '/healthz') {
    const ok = fs.existsSync(DATA_FILE);
    return json(res, ok ? 200 : 500, {
      ok,
      uptime: Math.round(process.uptime()),
      data: DATA_FILE
    });
  }

  if (route === '/api/state' && req.method === 'GET') {
    const store = readStore();
    const token = u.searchParams.get('token') || '';
    return json(res, 200, {
      taken: takenList(store),
      mine: mineOf(store, token),
      total: TOTAL
    });
  }

  if (route === '/api/pick' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { ok: false, error: 'bad_request' });
    }

    const ball = Number(body.ball);
    const token = String(body.token || '').slice(0, 64);

    if (!Number.isInteger(ball) || ball < 1 || ball > TOTAL) {
      return json(res, 400, { ok: false, error: 'bad_ball' });
    }
    if (!token) {
      return json(res, 400, { ok: false, error: 'no_token' });
    }

    // всё чтение-изменение-запись идёт синхронно, без await внутри:
    // два одновременных запроса не могут занять один шар
    const store = readStore();
    const already = mineOf(store, token);

    if (already) {
      return json(res, 200, { ok: true, mine: already, taken: takenList(store) });
    }
    if (store.picks[ball]) {
      return json(res, 409, { ok: false, conflict: true, taken: takenList(store) });
    }

    const free = TOTAL - Object.keys(store.picks).length;
    if (free <= 0) {
      return json(res, 409, { ok: false, conflict: true, soldout: true, taken: takenList(store) });
    }

    store.picks[ball] = token;
    writeStore(store);
    return json(res, 200, { ok: true, mine: ball, taken: takenList(store) });
  }

  if (route === '/api/reset' && req.method === 'POST') {
    // ручной сброс перед праздником: /api/reset?key=СЕКРЕТ
    const key = process.env.RESET_KEY;
    if (!key || u.searchParams.get('key') !== key) {
      return json(res, 403, { ok: false, error: 'forbidden' });
    }
    writeStore({ picks: {} });
    return json(res, 200, { ok: true, taken: [] });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Метод не поддерживается');
  }

  // статика
  let rel = route === '/' ? '/index.html' : route;
  const filePath = safeJoin(ROOT, rel);
  if (!filePath) {
    res.writeHead(400);
    return res.end('Плохой путь');
  }
  if (rel === '/index.html') {
    return serveFile(res, path.join(ROOT, 'index.html'));
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      // для «красивых» адресов отдаём главную
      return serveFile(res, path.join(ROOT, 'index.html'));
    }
    serveFile(res, filePath);
  });
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('Порт ' + PORT + ' уже занят. Запустите с другим портом: PORT=3001 node server.js');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Волшебные шары: порт ' + PORT);
  console.log('Данные: ' + DATA_FILE);
});

// платформа останавливает контейнер сигналом — закрываемся без обрыва запросов
['SIGTERM', 'SIGINT'].forEach(sig => {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
});