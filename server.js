import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { fileURLToPath } from 'node:url';

const PORT = +process.env.PORT || 3000;
const PASSWORD = process.env.PASTE_PASSWORD;
if (!PASSWORD) { console.error('Set PASTE_PASSWORD'); process.exit(1); }
const DATA = path.resolve(process.env.DATA_DIR || './data');
const FILES = path.join(DATA, 'files');
const MAX_UPLOAD = (+process.env.MAX_UPLOAD_MB || 100) * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;
const MAX_DOC = 16 * 1024 * 1024;
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

fs.mkdirSync(FILES, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'pasteboard.db'));
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS items(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',          -- ",a,b," so instr(tags, ',a,') matches whole tags
    pinned INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    link_title TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL DEFAULT '',
    file_mime TEXT NOT NULL DEFAULT '',
    file_size INTEGER NOT NULL DEFAULT 0,
    file_path TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS doc(id INTEGER PRIMARY KEY CHECK(id=1), state BLOB NOT NULL); -- legacy single page, migrated below
  CREATE TABLE IF NOT EXISTS pages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '',
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    state BLOB NOT NULL,
    item_id INTEGER,                         -- page opened to edit an archived item
    seeded INTEGER NOT NULL DEFAULT 0,
    edited INTEGER NOT NULL DEFAULT 0        -- linked page changed since its item was last updated
  );
`);
const cols = db.prepare('PRAGMA table_info(items)').all().map(c => c.name);
const pageCols = db.prepare('PRAGMA table_info(pages)').all().map(c => c.name);
if (!pageCols.includes('edited')) db.exec('ALTER TABLE pages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0');
for (const c of ['rich', 'lines']) if (!cols.includes(c)) db.exec(`ALTER TABLE items ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);

// ---- helpers ----
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const send = (res, status, body) => {
  if (status === 204) return res.writeHead(204).end();
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};
const sha = s => crypto.createHash('sha256').update(s).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(String(a)), sha(String(b)));
const TOKEN = crypto.createHmac('sha256', PASSWORD).update('pasteboard-session').digest('hex');

const authed = req => {
  const cookie = /(?:^|;\s*)pb=([0-9a-f]+)/.exec(req.headers.cookie || '')?.[1];
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  return (cookie && safeEq(cookie, TOKEN)) || (bearer && safeEq(bearer, PASSWORD));
};

async function readBuffer(req, max) {
  let n = 0;
  const chunks = [];
  for await (const c of req) {
    if ((n += c.length) > max) throw httpErr(413, 'Too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  try { return JSON.parse((await readBuffer(req, MAX_JSON)).toString() || '{}'); }
  catch (e) { throw e.status ? e : httpErr(400, 'Bad JSON'); }
}

const normTags = v => [...new Set(
  (Array.isArray(v) ? v : String(v || '').split(','))
    .map(t => String(t).trim().toLowerCase().replace(/^#/, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 32))
    .filter(Boolean),
)].slice(0, 20);
const packTags = a => (a.length ? `,${a.join(',')},` : '');

const toItem = r => ({
  id: r.id,
  text: r.text,
  tags: r.tags.split(',').filter(Boolean),
  pinned: !!r.pinned,
  rich: !!r.rich,
  lines: !!r.lines,
  created: r.created,
  updated: r.updated,
  linkTitle: r.link_title,
  file: r.file_path ? { name: r.file_name, mime: r.file_mime, size: r.file_size, url: `/api/files/${r.id}?v=${r.file_path}` } : null,
});
const getRow = id => db.prepare('SELECT * FROM items WHERE id=?').get(id);
const getItem = id => { const r = getRow(id); return r && toItem(r); };
const rmFile = r => r?.file_path && fs.rmSync(path.join(FILES, r.file_path), { force: true });
// Inline images live in `blobs`; drop them with the item unless another item still references them.
function rmBlobsOf(row) {
  for (const [, bid] of row.text.matchAll(/\/api\/blobs\/([0-9a-f-]{36})/g)) {
    const used = db.prepare('SELECT 1 FROM items WHERE id!=? AND instr(text,?)>0 LIMIT 1').get(row.id, bid)
     ;
    if (used) continue;
    db.prepare('DELETE FROM blobs WHERE id=?').run(bid);
    fs.rmSync(path.join(FILES, bid), { force: true });
  }
}

function list(u) {
  const w = [], p = [];
  const before = +u.searchParams.get('before');
  if (before) { w.push('id<?'); p.push(before); }
  const pin = u.searchParams.get('pinned');
  if (pin === '0' || pin === '1') { w.push('pinned=?'); p.push(+pin); }
  const tag = normTags(u.searchParams.get('tag'))[0];
  if (tag) { w.push('instr(tags,?)>0'); p.push(`,${tag},`); }
  for (const t of (u.searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
    w.push("instr(lower(text||' '||link_title||' '||file_name||' '||tags),?)>0");
    p.push(t);
  }
  const limit = Math.min(+u.searchParams.get('limit') || 30, 100);
  const sql = `SELECT * FROM items ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...p, limit).map(toItem);
}

// ---- live pages (Yjs CRDT per page; clients push updates over POST, receive others' over SSE) ----
const emptyState = () => Y.encodeStateAsUpdate(new Y.Doc());
const newPage = (itemId = null) => {
  const now = Date.now();
  return Number(db.prepare('INSERT INTO pages(created,updated,state,item_id) VALUES(?,?,?,?)').run(now, now, emptyState(), itemId).lastInsertRowid);
};
if (!db.prepare('SELECT 1 FROM pages LIMIT 1').get()) {
  const old = db.prepare('SELECT state FROM doc WHERE id=1').get();
  const id = newPage();
  if (old) db.prepare('UPDATE pages SET state=?,seeded=1 WHERE id=?').run(old.state, id);
}
const ensurePage = () => { if (!db.prepare('SELECT 1 FROM pages LIMIT 1').get()) newPage(); };

// A page with no text/images/code is "empty": nothing to lose when it is closed.
const isEmpty = ydoc => {
  const x = ydoc.getXmlFragment('default').toString(); // Tiptap's Collaboration field
  return !/<(image|codeBlock|horizontalRule)\b/.test(x) && x.replace(/<[^>]*>/g, '').trim() === '';
};
const docs = new Map(); // id -> { ydoc, timer, empty }
function getDoc(id) {
  let d = docs.get(id);
  if (d) return d;
  const row = db.prepare('SELECT state FROM pages WHERE id=?').get(id);
  if (!row) return null;
  d = { ydoc: new Y.Doc(), timer: null, empty: true };
  Y.applyUpdate(d.ydoc, row.state);
  d.empty = isEmpty(d.ydoc);
  docs.set(id, d);
  return d;
}
function flushDoc(id) {
  const d = docs.get(id);
  if (!d) return;
  clearTimeout(d.timer);
  db.prepare('UPDATE pages SET state=?,updated=? WHERE id=?').run(Y.encodeStateAsUpdate(d.ydoc), Date.now(), id);
}
const persistDoc = id => { const d = docs.get(id); clearTimeout(d.timer); d.timer = setTimeout(() => flushDoc(id), 500); };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { for (const id of docs.keys()) if (db.prepare('SELECT 1 FROM pages WHERE id=?').get(id)) flushDoc(id); process.exit(0); });
const pageMeta = id => db.prepare('SELECT id,title,updated,item_id,seeded,edited FROM pages WHERE id=?').get(id);
const pageList = () => db.prepare('SELECT id,title,updated,item_id,edited FROM pages ORDER BY id').all().map(r => ({ ...r, empty: getDoc(r.id).empty }));

// ---- live sync (SSE) ----
const clients = new Set();
const broadcast = evt => { const d = `data: ${JSON.stringify(evt)}\n\n`; for (const c of clients) c.write(d); };
const emit = id => { const item = getItem(id); if (item) broadcast({ type: 'upsert', item }); };
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000).unref();

// ---- link preview ----
const decodeEntities = s => s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" })[e]);
async function fetchTitle(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'Mozilla/5.0 pasteboard', accept: 'text/html' } });
  if (!r.ok || !/html/.test(r.headers.get('content-type') || '')) return '';
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  while (buf.length < 262144) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    if (/<\/title>/i.test(buf)) break;
  }
  reader.cancel().catch(() => {});
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(buf);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}
async function preview(id) {
  const row = getRow(id);
  const text = row?.text.trim();
  if (!text || !/^https?:\/\/\S+$/.test(text)) return;
  try {
    const title = await fetchTitle(text);
    if (!title || getRow(id)?.text.trim() !== text) return;
    db.prepare('UPDATE items SET link_title=? WHERE id=?').run(title, id);
    emit(id);
  } catch { /* unreachable/slow site: no preview */ }
}

// ---- auth ----
const fails = new Map(); // ip -> timestamps of recent failures
async function login(req, res) {
  const ip = req.socket.remoteAddress;
  const recent = (fails.get(ip) || []).filter(t => Date.now() - t < 10 * 60 * 1000);
  if (recent.length >= 10) throw httpErr(429, 'Too many attempts, try later');
  const b = await readJson(req);
  if (!safeEq(b.password ?? '', PASSWORD)) {
    fails.set(ip, [...recent, Date.now()]);
    throw httpErr(401, 'Wrong password');
  }
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('set-cookie', `pb=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`);
  send(res, 200, { ok: true });
}

// ---- files ----
function serveFile(req, res, row, download) {
  const fp = path.join(FILES, row.file_path);
  if (!row.file_path || !fs.existsSync(fp)) throw httpErr(404, 'No file');
  const size = fs.statSync(fp).size;
  let start = 0, end = size - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = +m[1]; if (m[2]) end = Math.min(+m[2], end); }
    else start = Math.max(0, size - +m[2]);
    if (start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }).end(); return; }
    status = 206;
  }
  const inline = !download && /^(image|video|audio)\/|^application\/pdf$/.test(row.file_mime);
  const headers = {
    'content-type': row.file_mime,
    'content-length': end - start + 1,
    'accept-ranges': 'bytes',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
    'content-security-policy': 'sandbox', // uploaded SVG/HTML can't run script when opened directly
    'cache-control': 'private, max-age=31536000, immutable',
  };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  fs.createReadStream(fp, { start, end }).pipe(res);
}

async function saveStream(req) {
  const stored = crypto.randomUUID();
  const fp = path.join(FILES, stored);
  let size = 0;
  const limit = new Transform({
    transform(chunk, _, cb) { size += chunk.length; cb(size > MAX_UPLOAD ? httpErr(413, 'File too large') : null, chunk); },
  });
  try { await pipeline(req, limit, fs.createWriteStream(fp)); } catch (e) { fs.rmSync(fp, { force: true }); throw e; }
  const mime = (req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase().slice(0, 100);
  return { stored, size, mime };
}
const cleanName = name => path.basename(name || 'file').replace(/[\x00-\x1f]/g, '').slice(0, 200) || 'file';

async function putFile(req, res, id, name) {
  const row = getRow(id);
  if (!row) throw httpErr(404, 'Not found');
  const { stored, size, mime } = await saveStream(req);
  rmFile(row);
  db.prepare('UPDATE items SET file_name=?,file_mime=?,file_size=?,file_path=?,updated=? WHERE id=?').run(cleanName(name), mime, size, stored, Date.now(), id);
  emit(id);
  send(res, 200, getItem(id));
}

// ---- static ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
function serveStatic(res, pathname) {
  const fp = path.join(PUB, pathname === '/' ? 'index.html' : pathname.slice(1));
  if (!fp.startsWith(PUB + path.sep) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, {
    'content-type': MIME[path.extname(fp)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self'; style-src 'self'; frame-ancestors 'none'",
  });
  fs.createReadStream(fp).pipe(res);
}

// ---- router ----
async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname, method = req.method;
  res.setHeader('x-content-type-options', 'nosniff');
  if (!p.startsWith('/api/')) return serveStatic(res, p);

  if (method === 'POST' && p === '/api/login') return login(req, res);
  if (method === 'POST' && p === '/api/logout') {
    res.setHeader('set-cookie', 'pb=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return send(res, 200, { ok: true });
  }
  if (!authed(req)) return send(res, 401, { error: 'Login required' });

  if (method === 'GET' && p === '/api/items') return send(res, 200, list(u));

  if (method === 'GET' && p === '/api/tags') {
    const counts = new Map();
    for (const { tags } of db.prepare("SELECT tags FROM items WHERE tags!=''").all())
      for (const t of tags.split(',').filter(Boolean)) counts.set(t, (counts.get(t) || 0) + 1);
    return send(res, 200, [...counts].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)));
  }

  let m;
  if (method === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    res.write(': ok\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/pages') {
    if (method === 'GET') return send(res, 200, pageList());
    if (method === 'POST') {
      const b = await readJson(req);
      let id, created = false;
      if (b.itemId) { // edit-in-full-page for an archived item: reuse its page if one exists
        if (!getRow(+b.itemId)) throw httpErr(404, 'Item not found');
        id = db.prepare('SELECT id FROM pages WHERE item_id=?').get(+b.itemId)?.id;
      }
      if (!id) { id = newPage(b.itemId ? +b.itemId : null); created = true; }
      if (created) broadcast({ type: 'pages' });
      return send(res, 201, { id });
    }
  }

  m = /^\/api\/pages\/(\d+)(?:\/(doc|seed))?$/.exec(p);
  if (m) {
    const id = +m[1];
    if (!pageMeta(id)) throw httpErr(404, 'Page not found');
    if (!m[2] && method === 'GET') return send(res, 200, pageMeta(id));
    if (!m[2] && method === 'PATCH') {
      const b = await readJson(req);
      if ('title' in b) db.prepare('UPDATE pages SET title=? WHERE id=?').run(String(b.title ?? '').slice(0, 120), id);
      if ('edited' in b) db.prepare('UPDATE pages SET edited=? WHERE id=?').run(b.edited ? 1 : 0, id);
      broadcast({ type: 'pages' });
      return send(res, 204);
    }
    if (!m[2] && method === 'DELETE') {
      docs.delete(id);
      db.prepare('DELETE FROM pages WHERE id=?').run(id);
      ensurePage();
      broadcast({ type: 'page-deleted', id });
      broadcast({ type: 'pages' });
      return send(res, 204);
    }
    if (m[2] === 'doc' && method === 'GET') return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.from(Y.encodeStateAsUpdate(getDoc(id).ydoc)));
    if (m[2] === 'doc' && method === 'POST') {
      const update = new Uint8Array(await readBuffer(req, MAX_DOC));
      try { Y.applyUpdate(getDoc(id).ydoc, update); } catch { throw httpErr(400, 'Bad update'); }
      persistDoc(id);
      const pm = pageMeta(id), d = getDoc(id), emptyNow = isEmpty(d.ydoc);
      const newlyEdited = req.headers['x-pb-silent'] !== '1' && (!pm.item_id || pm.seeded) && !pm.edited; // edited = changed since last saved to the archive
      if (newlyEdited) db.prepare('UPDATE pages SET edited=1 WHERE id=?').run(id);
      if (newlyEdited || emptyNow !== d.empty) { d.empty = emptyNow; broadcast({ type: 'pages' }); }
      broadcast({ type: 'doc', page: id, u: Buffer.from(update).toString('base64'), src: u.searchParams.get('src') });
      return send(res, 204);
    }
    if (m[2] === 'seed' && method === 'POST') { // first caller wins the right to fill the page from its item
      const { changes } = db.prepare('UPDATE pages SET seeded=1 WHERE id=? AND seeded=0').run(id);
      return send(res, changes ? 204 : 409, { error: 'Already seeded' });
    }
  }

  if (method === 'POST' && p === '/api/blobs') {
    if (!(req.headers['content-type'] || '').startsWith('image/')) throw httpErr(415, 'Images only');
    const { stored, size, mime } = await saveStream(req);
    db.prepare('INSERT INTO blobs(id,name,mime,size) VALUES(?,?,?,?)').run(stored, cleanName(u.searchParams.get('name')), mime, size);
    return send(res, 201, { url: `/api/blobs/${stored}` });
  }
  m = /^\/api\/blobs\/([0-9a-f-]{36})$/.exec(p);
  if (m && method === 'GET') {
    const b = db.prepare('SELECT * FROM blobs WHERE id=?').get(m[1]);
    if (!b) throw httpErr(404, 'Not found');
    return serveFile(req, res, { file_path: b.id, file_mime: b.mime, file_name: b.name }, false);
  }

  if (method === 'POST' && p === '/api/items') {
    const b = await readJson(req);
    const text = String(b.text ?? '');
    if (!text.trim() && !b.file) throw httpErr(400, 'Empty');
    const now = Date.now();
    const { lastInsertRowid } = db.prepare('INSERT INTO items(text,tags,rich,lines,created,updated) VALUES(?,?,?,?,?,?)').run(text, packTags(normTags(b.tags)), b.rich ? 1 : 0, b.lines ? 1 : 0, now, now);
    const id = Number(lastInsertRowid);
    if (!b.file) { emit(id); preview(id); } // file items are announced once the upload lands
    return send(res, 201, getItem(id));
  }

  m = /^\/api\/files\/(\d+)$/.exec(p);
  if (m && method === 'GET') {
    const row = getRow(+m[1]);
    if (!row) throw httpErr(404, 'Not found');
    return serveFile(req, res, row, u.searchParams.get('dl') === '1');
  }

  m = /^\/api\/items\/(\d+)(\/file)?$/.exec(p);
  if (m) {
    const id = +m[1];
    if (!m[2] && method === 'GET') { const it = getItem(id); if (!it) throw httpErr(404, 'Not found'); return send(res, 200, it); }
    if (m[2] && method === 'PUT') return putFile(req, res, id, u.searchParams.get('name'));
    if (!m[2] && method === 'PATCH') {
      const row = getRow(id);
      if (!row) throw httpErr(404, 'Not found');
      const b = await readJson(req);
      const sets = [], vals = [];
      if ('text' in b) {
        const text = String(b.text);
        if (!text.trim() && !row.file_path) throw httpErr(400, 'Empty');
        sets.push('text=?', "link_title=''"); vals.push(text);
      }
      if ('tags' in b) { sets.push('tags=?'); vals.push(packTags(normTags(b.tags))); }
      if ('pinned' in b) { sets.push('pinned=?'); vals.push(b.pinned ? 1 : 0); }
      for (const k of ['rich', 'lines']) if (k in b) { sets.push(`${k}=?`); vals.push(b[k] ? 1 : 0); }
      if (sets.length) db.prepare(`UPDATE items SET ${sets.join(',')},updated=? WHERE id=?`).run(...vals, Date.now(), id);
      emit(id);
      if ('text' in b) preview(id);
      return send(res, 200, getItem(id));
    }
    if (!m[2] && method === 'DELETE') {
      const row = getRow(id);
      rmFile(row);
      db.prepare('DELETE FROM items WHERE id=?').run(id);
      db.prepare('UPDATE pages SET item_id=NULL WHERE item_id=?').run(id);
      if (row) rmBlobsOf(row);
      broadcast({ type: 'delete', id });
      return send(res, 204);
    }
  }
  send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    else res.end();
  });
});
server.requestTimeout = 0; // large uploads over slow links
server.listen(PORT, () => console.log(`Pasteboard on :${PORT}, data in ${DATA}`));
