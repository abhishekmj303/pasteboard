import { icon } from './icons.js';
import { h, toast, copyText } from './util.js';

const $ = s => document.querySelector(s);
const feed = $('#feed'), older = $('#older'), pinned = $('#pinned'), trayList = $('#trayList');
const ta = $('#text'), tagin = $('#tagin'), stagedEl = $('#staged'), sendBtn = $('#send');
const PAGE = 30;
const state = { q: '', tag: '', cursor: 0, done: false, loading: false, gen: 0 };
let staged = [], es = null, opened = false;

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && url !== '/api/login') { $('#login').hidden = false; throw new Error('Login required'); }
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error || r.statusText);
  return data;
}

// ---- formatting ----
function ago(t) {
  const s = (Date.now() - t) / 1000, d = new Date(t);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 7 * 86400) return Math.floor(s / 86400) + 'd';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}
const fmtSize = n => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const INLINE_SRC = /!\[([^\]]*)\]\((\/api\/blobs\/[0-9a-f-]{36})\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>"]+/g;
// Images and bare links always render; the rest of the markdown only when `rich`.
function inline(text, rich) {
  const out = [];
  let last = 0, m;
  const re = new RegExp(INLINE_SRC); // per call: nested inline() would clobber a shared lastIndex
  while ((m = re.exec(text))) {
    out.push(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[2]) out.push(h('a', { href: m[2], target: '_blank' }, h('img', { class: 'inl', src: m[2], alt: m[1], loading: 'lazy' })));
    else if (m[0].startsWith('http')) {
      const url = m[0].replace(/[.,;:!?)\]]+$/, '');
      out.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
      last = re.lastIndex = m.index + url.length;
    } else if (!rich) out.push(m[0]);
    else if (m[3] != null) out.push(h('code', {}, m[3]));
    else if (m[4]) out.push(h('strong', {}, ...inline(m[4], true)));
    else if (m[5]) out.push(h('em', {}, ...inline(m[5], true)));
    else out.push(h('a', { href: m[7], target: '_blank', rel: 'noopener noreferrer' }, m[6]));
  }
  out.push(text.slice(last));
  return out;
}
const lineSpans = text => text.split('\n').map(l => h('span', { class: 'ln' }, ...inline(l, false), l ? '' : '​'));

function richBlocks(text, lines) {
  const out = [], ls = text.split('\n');
  let para = [], i = 0;
  const flush = () => { if (para.length) out.push(h('p', {}, ...para.flatMap((l, k) => [k ? h('br') : null, ...inline(l, true)]))); para = []; };
  const LI = /^\s*([-*]|\d+\.)\s+/;
  while (i < ls.length) {
    const l = ls[i];
    let m;
    if (/^```/.test(l)) {
      flush();
      const code = [];
      for (i++; i < ls.length && !/^```/.test(ls[i]); i++) code.push(ls[i]);
      i++;
      out.push(h('pre', { class: 'code' + (lines ? ' lines' : '') }, ...lineSpans(code.join('\n'))));
    } else if ((m = /^(#{1,4})\s+(.*)/.exec(l))) { flush(); out.push(h('h' + m[1].length, {}, ...inline(m[2], true))); i++; }
    else if ((m = LI.exec(l))) {
      flush();
      const items = [], ordered = /\d/.test(m[1]);
      for (; i < ls.length && LI.test(ls[i]); i++) items.push(h('li', {}, ...inline(ls[i].replace(LI, ''), true)));
      out.push(h(ordered ? 'ol' : 'ul', {}, ...items));
    } else if (/^>\s?/.test(l)) {
      flush();
      const q = [];
      for (; i < ls.length && /^>\s?/.test(ls[i]); i++) q.push(ls[i].replace(/^>\s?/, ''));
      out.push(h('blockquote', {}, ...q.flatMap((x, k) => [k ? h('br') : null, ...inline(x, true)])));
    } else if (!l.trim()) { flush(); i++; }
    else { para.push(l); i++; }
  }
  flush();
  return out;
}

function renderBody(text, { rich, lines }) {
  if (rich) return h('div', { class: 'body rich' }, ...richBlocks(text, lines));
  if (lines) return h('div', { class: 'body code lines' }, ...lineSpans(text));
  return h('div', { class: 'body' }, ...inline(text, false));
}
// ---- cards ----
const elOf = id => document.querySelector(`.card[data-id="${id}"]`);
const isFiltering = () => !!(state.q || state.tag);

function fileView(f) {
  if (!f) return null;
  if (f.mime.startsWith('image/')) return h('a', { class: 'img', href: f.url, target: '_blank' }, h('img', { src: f.url, loading: 'lazy', alt: f.name }));
  if (f.mime.startsWith('video/')) return h('video', { src: f.url, controls: true, preload: 'metadata' });
  return h('a', { class: 'file', href: f.url + '&dl=1', download: f.name }, icon('file', 16), ' ' + f.name + ' ', h('small', {}, fmtSize(f.size)));
}

function card(it, compact) {
  const act = (name, title, fn, on) => h('button', { class: 'ib sm' + (on ? ' on' : ''), title, 'aria-label': title, onclick: fn }, icon(name, 16));
  const body = it.text ? renderBody(it.text, it) : null;
  const more = h('button', { class: 'more', hidden: true, onclick: () => {
    el.classList.toggle('open');
    more.textContent = el.classList.contains('open') ? 'Show less' : 'Show more';
  } }, 'Show more');
  const el = h('article', { class: 'card' + (compact ? ' compact' : ''), 'data-id': it.id },
    fileView(it.file),
    it.linkTitle && h('div', { class: 'ltitle' }, it.linkTitle),
    body, more,
    h('div', { class: 'meta' },
      h('time', { 'data-t': it.created, title: new Date(it.created).toLocaleString() }, ago(it.created)),
      ...it.tags.map(t => h('button', { class: 'tag', onclick: () => setTag(t) }, '#' + t)),
      h('span', { class: 'sp' }),
      it.text && act('copy', 'Copy', () => copyText(it.text)),
      act(it.pinned ? 'unpin' : 'pin', it.pinned ? 'Unpin' : 'Pin', () => patch(it.id, { pinned: !it.pinned }), it.pinned),
      act('edit', 'Edit in full page', () => editItem(it.id)),
      act('trash', 'Delete', () => remove(it.id))));
  el._more = more;
  return el;
}

// Show the "Show more" toggle only when the clamped body actually overflows.
function measure(el) {
  requestAnimationFrame(() => {
    const body = el.querySelector('.body');
    if (!body || el.classList.contains('open')) return;
    const over = body.scrollHeight > body.clientHeight + 2;
    el.classList.toggle('clipped', over);
    el._more.hidden = !over;
  });
}

const patch = (id, body) => api('PATCH', `/api/items/${id}`, body).then(upsert).catch(e => toast(e.message));
async function remove(id) {
  if (!confirm('Delete this item?')) return;
  try { await api('DELETE', `/api/items/${id}`); drop(id); } catch (e) { toast(e.message); }
}
function drop(id) { state.items.delete(id); elOf(id)?.remove(); refreshTray(); }

// Editing opens the item as a full page in the editor (saving there updates the item).
async function editItem(id) {
  try {
    const { id: pid } = await api('POST', '/api/pages', { itemId: id });
    location.hash = '#p/' + pid;
  } catch (e) { toast(e.message); }
}

// ---- list state ----
state.items = new Map();

function matches(it) {
  if (state.tag && !it.tags.includes(state.tag)) return false;
  const hay = [it.text, it.linkTitle, it.file?.name, it.tags.join(',')].join(' ').toLowerCase();
  return state.q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t));
}

function insertSorted(parent, el, id) {
  for (const c of parent.children) if (c.dataset.id && +c.dataset.id < id) return parent.insertBefore(el, c);
  parent.insertBefore(el, parent === feed ? older : null);
}

function refreshTray() {
  const n = trayList.children.length;
  pinned.hidden = !n || isFiltering();
  pinned.querySelector('summary').replaceChildren(icon('pin', 14), ` Pinned (${n})`);
}

function upsert(it) {
  if (!it) return;
  state.items.set(it.id, it);
  const old = elOf(it.id);
  const inTray = it.pinned && !isFiltering();
  const target = inTray ? trayList : feed;
  // Items older than the loaded window arrive later via pagination.
  const beyondWindow = !inTray && !state.done && it.id < state.cursor;
  if (!matches(it) || beyondWindow) { old?.remove(); return refreshTray(); }
  const el = card(it, inTray);
  if (old?.parentElement === target) old.replaceWith(el);
  else { old?.remove(); insertSorted(target, el, it.id); }
  measure(el);
  refreshTray();
  loadTagsSoon();
}

async function load(reset) {
  if (state.loading && !reset) return;
  const gen = reset ? ++state.gen : state.gen;
  if (reset) {
    feed.querySelectorAll('.card').forEach(n => n.remove());
    trayList.replaceChildren();
    state.items.clear(); state.cursor = 0; state.done = false;
  }
  state.loading = true;
  older.textContent = 'Loading…';
  try {
    const f = isFiltering();
    const params = new URLSearchParams({ limit: PAGE });
    if (state.q) params.set('q', state.q);
    if (state.tag) params.set('tag', state.tag);
    if (state.cursor) params.set('before', state.cursor);
    if (!f) params.set('pinned', '0');
    const [items, pinsRes] = await Promise.all([
      api('GET', '/api/items?' + params),
      reset && !f ? api('GET', '/api/items?pinned=1&limit=100') : null,
    ]);
    if (gen !== state.gen) return;
    const pins = pinsRes || [];
    for (const it of items) {
      state.items.set(it.id, it);
      if (elOf(it.id)) continue; // already delivered by live sync
      const el = card(it, false);
      feed.insertBefore(el, older);
      measure(el);
    }
    if (items.length) state.cursor = items[items.length - 1].id;
    state.done = items.length < PAGE;
    pins.forEach(upsert);
    refreshTray();
  } finally {
    if (gen === state.gen) {
      state.loading = false;
      older.textContent = !state.done ? 'Loading…' : feed.querySelector('.card') || trayList.children.length ? '' : isFiltering() ? 'No matches' : 'Nothing here yet — paste something below';
      io.unobserve(older); io.observe(older); // re-check visibility so short pages keep filling
    }
  }
}
const io = new IntersectionObserver(e => { if (e[0].isIntersecting && !state.done) load(false).catch(() => {}); }, { root: feed, rootMargin: '300px' });

// ---- tags / search ----
async function loadTags() {
  const tags = await api('GET', '/api/tags');
  const bar = $('#tagbar');
  bar.replaceChildren(...tags.map(({ tag, n }) => h('button', { class: 'chip' + (state.tag === tag ? ' on' : ''), onclick: () => setTag(tag) }, '#' + tag + ' ', h('small', {}, n))));
  bar.hidden = !tags.length;
}
let tagsTimer;
const loadTagsSoon = () => { clearTimeout(tagsTimer); tagsTimer = setTimeout(() => loadTags().catch(() => {}), 300); };
function setTag(t) { state.tag = state.tag === t ? '' : t; loadTags().catch(() => {}); load(true).catch(e => toast(e.message)); }

let searchTimer;
$('#q').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); load(true).catch(err => toast(err.message)); }, 250);
});

// ---- composer (quick notes; the big editor is the live page) ----
function autosize() {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, innerHeight * 0.3) + 'px';
}
ta.addEventListener('input', autosize);
ta.addEventListener('keydown', e => {
  // Enter sends with a physical keyboard; on touch screens Enter is a newline (Ctrl/⌘+Enter always sends)
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (e.metaKey || e.ctrlKey || matchMedia('(pointer:fine)').matches)) { e.preventDefault(); send(); }
});
function addFiles(files) { stage(files); }

function stage(files) { staged.push(...files); renderStaged(); }
function renderStaged() {
  stagedEl.replaceChildren(...staged.map((f, i) => h('div', { class: 'st' },
    f.type.startsWith('image/') ? h('img', { src: (f._url ||= URL.createObjectURL(f)) }) : null,
    h('span', {}, f.name),
    h('button', { class: 'ib sm', title: 'Remove', onclick: () => { staged.splice(i, 1); renderStaged(); } }, icon('close', 14)))));
  stagedEl.hidden = !staged.length;
}
$('#attach').onclick = () => $('#file').click();
$('#file').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };

const inFeed = () => document.body.dataset.view === 'feed';
document.addEventListener('paste', e => {
  if (!inFeed()) return;
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length || e.clipboardData.getData('text/plain')) return; // plain text paste stays normal
  e.preventDefault();
  addFiles(files.map(f => f.name === 'image.png' || !f.name ? new File([f], `paste-${Date.now()}.${(f.type.split('/')[1] || 'bin').split('+')[0]}`, { type: f.type }) : f));
});
addEventListener('dragover', e => { if (inFeed() && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); document.body.classList.add('drag'); } });
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('drag'); });
addEventListener('drop', e => { document.body.classList.remove('drag'); if (inFeed() && e.dataTransfer?.files.length) { e.preventDefault(); addFiles([...e.dataTransfer.files]); } });

async function upload(id, f) {
  const r = await fetch(`/api/items/${id}/file?name=${encodeURIComponent(f.name)}`, { method: 'PUT', headers: { 'content-type': f.type || 'application/octet-stream' }, body: f });
  if (!r.ok) throw new Error(r.status === 413 ? 'File too large' : 'Upload failed');
}

async function send() {
  const text = ta.value.trim(), tags = tagin.value;
  if (!text && !staged.length) return;
  sendBtn.disabled = true;
  try {
    for (const [i, f] of (staged.length ? staged : [null]).entries()) {
      const it = await api('POST', '/api/items', { text: i === 0 ? text : '', tags, file: !!f });
      if (!f) { upsert(it); continue; }
      try { await upload(it.id, f); } catch (e) { await api('DELETE', `/api/items/${it.id}`).catch(() => {}); throw e; }
    }
    staged.forEach(f => f._url && URL.revokeObjectURL(f._url));
    staged = []; renderStaged();
    ta.value = ''; tagin.value = ''; autosize();
    feed.scrollTop = 0;
  } catch (e) { toast(e.message); }
  finally { sendBtn.disabled = false; ta.focus(); }
}
sendBtn.onclick = send;

// ---- live sync ----
function connect() {
  if (es) return;
  es = new EventSource('/api/events');
  es.onmessage = e => {
    const m = JSON.parse(e.data);
    document.dispatchEvent(new CustomEvent('pb:event', { detail: m }));
    if (m.type === 'upsert') upsert(m.item);
    else if (m.type === 'delete') { drop(m.id); loadTagsSoon(); }
  };
  es.onopen = () => { if (opened) { load(true).catch(() => {}); document.dispatchEvent(new Event('pb:resync')); } opened = true; }; // resync after reconnect
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) { es = null; setTimeout(connect, 5000); } };
}

// ---- auth / boot ----
$('#login form').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#login .err');
  try {
    await api('POST', '/api/login', { password: e.target.password.value });
    $('#login').hidden = true; err.hidden = true; e.target.reset();
    boot();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
});
for (const b of document.querySelectorAll('.logout')) b.onclick = async () => { await api('POST', '/api/logout'); location.reload(); };

// Two views: the live page (default) and search & chat (#feed).
function route() {
  const feedOn = location.hash === '#feed';
  document.body.dataset.view = feedOn ? 'feed' : 'doc';
  $('#tab-doc').classList.toggle('on', !feedOn);
  $('#tab-feed').classList.toggle('on', feedOn);
  $('#docview').hidden = feedOn;
  $('#feedview').hidden = !feedOn;
  if (feedOn) { feed.querySelectorAll('.card').forEach(measure); trayList.querySelectorAll('.card').forEach(measure); io.unobserve(older); io.observe(older); }
}
addEventListener('hashchange', route);
route();
pinned.addEventListener('toggle', () => pinned.open && trayList.querySelectorAll('.card').forEach(measure));
setInterval(() => document.querySelectorAll('time[data-t]').forEach(t => (t.textContent = ago(+t.dataset.t))), 60000);

async function boot() {
  try { await load(true); await loadTags(); connect(); window.pbReady = true; document.dispatchEvent(new Event('pb:ready')); } catch { /* 401 shows the login form */ }
}
autosize();
boot();
