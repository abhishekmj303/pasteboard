import * as Y from 'yjs';
import { Editor, Extension, getMarkRange } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Image from '@tiptap/extension-image';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { icon } from './icons.js';
import { h, toast, copyText } from './util.js';

const $ = s => document.querySelector(s);
const cid = Math.random().toString(36).slice(2); // ignore our own SSE echoes
let editor;

// ---- transport: POST local updates, receive others' over the shared SSE stream ----
const fromB64 = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));
let syncState = 'ok';
const setStatus = (s, t) => {
  const el = $('#sync'); el.dataset.s = s; el.title = t;
  if (s !== syncState) { syncState = s; renderSidebar(); }
};
const needLogin = () => { $('#login').hidden = false; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pageId = null, ydoc = null, meta = null;
let pending = [], pendingSilent = [], pushing = false, pushTimer;
let mountedAt = 0, seeding = false; // updates right after mounting/seeding are normalisation, not user edits
const quiet = () => seeding || Date.now() - mountedAt < 500;
function watch(doc) {
  doc.on('update', (u, origin) => {
    if (origin === 'remote') return;
    pending.push(u); pendingSilent.push(quiet());
    setStatus('saving', 'Saving…');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 80);
  });
}
async function push() {
  if (pushing || !pending.length) return;
  pushing = true;
  const n = pending.length;
  try {
    const silent = pendingSilent.slice(0, n).every(Boolean); // don't flag the page as edited
    const r = await fetch(`/api/pages/${pageId}/doc?src=${cid}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...(silent && { 'x-pb-silent': '1' }) }, body: Y.mergeUpdates(pending.slice(0, n)) });
    if (r.status === 401) { needLogin(); throw 0; }
    if (!r.ok && r.status !== 404) throw 0; // 404: page deleted elsewhere; drop the edits
    pending.splice(0, n); pendingSilent.splice(0, n);
    pushing = false;
    if (pending.length) push(); else setStatus('ok', 'Synced');
  } catch {
    pushing = false;
    setStatus('offline', 'Offline — retrying');
    setTimeout(push, 3000);
  }
}
// Wait for unsent edits before leaving a page.
async function settle() {
  clearTimeout(pushTimer);
  push();
  for (let i = 0; i < 30 && (pending.length || pushing); i++) await sleep(100);
  return !pending.length;
}
async function pull() {
  const r = await fetch(`/api/pages/${pageId}/doc`);
  if (r.status === 401) { needLogin(); throw new Error('login'); }
  if (r.status === 404) throw Object.assign(new Error('Page not found'), { gone: true });
  Y.applyUpdate(ydoc, new Uint8Array(await r.arrayBuffer()), 'remote');
}
const jsonFetch = async (url, opts) => {
  const r = await fetch(url, opts);
  if (r.status === 401) { needLogin(); throw new Error('login'); }
  if (!r.ok) throw Object.assign(new Error(r.statusText), { status: r.status });
  return r.status === 204 ? null : r.json();
};

// ---- code blocks: syntax highlighting (lowlight), per-block language picker, line numbers, copy ----
const lowlight = createLowlight({ bash, css, diff, go, java, javascript, json, markdown, plaintext, python, rust, sql, typescript, xml, yaml });
const LANGS = [['', 'Auto'], ['plaintext', 'Plain text'], ['bash', 'Bash'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['json', 'JSON'],
  ['python', 'Python'], ['go', 'Go'], ['java', 'Java'], ['rust', 'Rust'], ['sql', 'SQL'], ['xml', 'HTML / XML'], ['css', 'CSS'], ['yaml', 'YAML'], ['markdown', 'Markdown'], ['diff', 'Diff']];

const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node: initial, editor, getPos }) => {
      let node = initial, shownLang;
      const code = h('code');
      const pre = h('pre', {}, code);
      const sel = h('select', { class: 'cb-lang', title: 'Language', 'aria-label': 'Language' });
      const setAttrs = a => {
        if (editor.isEditable) editor.view.dispatch(editor.state.tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, ...a }));
      };
      sel.onchange = () => setAttrs({ language: sel.value || null });
      const linesBtn = h('button', { class: 'ib sm cb-lines', title: 'Line numbers', onclick: () => setAttrs({ lines: !node.attrs.lines }) }, icon('lines', 15));
      const copyBtn = h('button', { class: 'ib sm', title: 'Copy code', onclick: () => copyText(node.textContent, 'Code copied') }, icon('copy', 15));
      const bar = h('div', { class: 'cb-bar', contenteditable: 'false' }, sel, linesBtn, copyBtn);
      const dom = h('div', { class: 'cb' }, bar, pre);
      const sync = () => {
        pre.toggleAttribute('data-lines', !!node.attrs.lines);
        linesBtn.classList.toggle('on', !!node.attrs.lines);
        const lang = node.attrs.language || '';
        if (lang === shownLang) return;
        shownLang = lang;
        const opts = LANGS.some(([v]) => v === lang) ? LANGS : [...LANGS, [lang, lang]]; // e.g. a ```js fence from pasted markdown
        sel.replaceChildren(...opts.map(([v, l]) => h('option', { value: v }, l)));
        sel.value = lang;
      };
      sync();
      return {
        dom,
        contentDOM: code,
        update(n) { if (n.type !== node.type) return false; node = n; sync(); return true; },
        stopEvent: e => bar.contains(e.target),
        ignoreMutation: m => !code.contains(m.target),
      };
    };
  },
}).configure({ lowlight });

// Line numbers are decorations, never part of the document.
const CodeLines = Extension.create({
  name: 'codeLines',
  addGlobalAttributes() {
    return [{ types: ['codeBlock'], attributes: { lines: {
      default: false,
      parseHTML: el => el.hasAttribute('data-lines'),
      renderHTML: a => (a.lines ? { 'data-lines': '' } : {}),
    } } }];
  },
  addProseMirrorPlugins() {
    return [new Plugin({ props: { decorations: ({ doc }) => {
      const decos = [];
      doc.descendants((node, pos) => {
        if (node.type.name !== 'codeBlock' || !node.attrs.lines) return;
        let offset = 0, n = 1;
        for (const line of node.textContent.split('\n')) {
          const num = n++;
          decos.push(Decoration.widget(pos + 1 + offset, () => {
            const s = document.createElement('span');
            s.className = 'ln'; s.textContent = num; s.contentEditable = 'false';
            return s;
          }, { side: -1, key: `ln${pos}:${num}` }));
          offset += line.length + 1;
        }
      });
      return DecorationSet.create(doc, decos);
    } } })];
  },
});

// ---- images: pasted/dropped files upload to /api/blobs and become inline image nodes ----
async function uploadImage(f) {
  const r = await fetch('/api/blobs?name=' + encodeURIComponent(f.name || 'image'), { method: 'POST', headers: { 'content-type': f.type }, body: f });
  if (!r.ok) throw new Error(r.status === 413 ? 'Image too large' : 'Upload failed');
  return (await r.json()).url;
}
async function insertImages(files, pos) {
  for (const f of files) {
    try {
      toast('Uploading image…');
      const node = { type: 'image', attrs: { src: await uploadImage(f), alt: (f.name || '').replace(/\.\w+$/, '') } };
      if (pos != null) { editor.chain().insertContentAt(pos, node).run(); pos = null; }
      else editor.chain().focus().insertContent(node).run();
    } catch (e) { toast(e.message); }
  }
}
const imageFiles = list => [...(list || [])].filter(f => f.type.startsWith('image/'));
const looksLikeMarkdown = t => /^(#{1,6} |\s*[-*+] |\s*\d+\. |> |```)|\*\*.+\*\*|\[[^\]]+\]\([^)]+\)/m.test(t);

// ---- link popover: click a link → open / copy / edit / unlink ----
const pop = $('#linkpop');
let popEditing = false;
const hidePop = () => { pop.hidden = true; popEditing = false; };
const pbtn = (name, title, fn) => h('button', { class: 'ib sm', title, 'aria-label': title, onclick: fn }, icon(name, 16));

function normalizeUrl(v) {
  v = v.trim();
  if (/^(https?:|mailto:|tel:)/i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null; // javascript:, data:, …
  return 'https://' + v;
}
function saveLink(raw) {
  const chain = editor.chain().focus().extendMarkRange('link');
  if (!raw.trim()) chain.unsetLink().run();
  else {
    const href = normalizeUrl(raw);
    if (!href) return toast('Unsupported link');
    chain.setLink({ href }).run();
  }
  hidePop();
}
function showPop(edit) {
  if (!editor.isEditable) return;
  const { state, view } = editor, sel = state.selection;
  const range = editor.isActive('link') ? getMarkRange(sel.$from, state.schema.marks.link) : null;
  if (!range && sel.empty) { if (edit) toast('Select some text first'); return hidePop(); }
  const href = editor.getAttributes('link').href || '';
  popEditing = edit || !range;
  if (popEditing) {
    const input = h('input', { value: href, placeholder: 'https://…', 'aria-label': 'Link URL', spellcheck: 'false', autocapitalize: 'off' });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); saveLink(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); hidePop(); editor.commands.focus(); }
    });
    pop.replaceChildren(input, pbtn('check', 'Save link', () => saveLink(input.value)), pbtn('close', 'Cancel', () => { hidePop(); editor.commands.focus(); }));
  } else {
    pop.replaceChildren(
      h('span', { class: 'url', title: href }, href.replace(/^https?:\/\//, '')),
      pbtn('open', 'Open link', () => window.open(href, '_blank', 'noopener')),
      pbtn('copy', 'Copy link', () => copyText(href, 'Link copied')),
      pbtn('edit', 'Edit link', () => showPop(true)),
      pbtn('unlink', 'Remove link', () => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); hidePop(); }),
    );
  }
  pop.hidden = false;
  const c = view.coordsAtPos(range ? range.from : sel.from);
  const w = pop.offsetWidth, ph = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(c.left, innerWidth - w - 8)) + 'px';
  pop.style.top = (c.bottom + ph + 12 > innerHeight ? c.top - ph - 6 : c.bottom + 6) + 'px';
  if (popEditing) pop.querySelector('input').focus();
}
pop.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); }); // keep the editor selection

// ---- toolbar ----
const inCode = () => editor.isActive('codeBlock');
const tools = [
  ['undo', 'Undo', c => c.undo()],
  ['redo', 'Redo', c => c.redo()],
  '|',
  ['bold', 'Bold (Ctrl+B)', c => c.toggleBold(), 'bold'],
  ['italic', 'Italic (Ctrl+I)', c => c.toggleItalic(), 'italic'],
  ['strike', 'Strikethrough', c => c.toggleStrike(), 'strike'],
  ['code', 'Inline code', c => c.toggleCode(), 'code'],
  '|',
  ['h1', 'Heading 1', c => c.toggleHeading({ level: 1 }), ['heading', { level: 1 }]],
  ['h2', 'Heading 2', c => c.toggleHeading({ level: 2 }), ['heading', { level: 2 }]],
  '|',
  ['bullets', 'Bullet list', c => c.toggleBulletList(), 'bulletList'],
  ['numbers', 'Numbered list', c => c.toggleOrderedList(), 'orderedList'],
  ['tasks', 'Task list', c => c.toggleTaskList(), 'taskList'],
  ['quote', 'Quote', c => c.toggleBlockquote(), 'blockquote'],
  '|',
  ['codeblock', 'Code block (code / logs)', c => c.toggleCodeBlock(), 'codeBlock'],
  ['lines', 'Line numbers on this code block', c => (inCode() ? c : c.toggleCodeBlock()).updateAttributes('codeBlock', { lines: inCode() ? !editor.getAttributes('codeBlock').lines : true }), ['codeBlock', { lines: true }]],
  ['divider', 'Divider', c => c.setHorizontalRule()],
  '|',
  ['link', 'Link (Ctrl+K)', () => { showPop(true); return null; }, 'link'],
  ['image', 'Insert image', () => { $('#imgpick').click(); return null; }],
];
let toolRefs = [];
const refreshToolbar = () => {
  for (const [b, a] of toolRefs) b.classList.toggle('on', !!a && (Array.isArray(a) ? editor.isActive(...a) : editor.isActive(a)));
};
function buildToolbar() {
  const bar = $('#toolbar');
  toolRefs = [];
  bar.replaceChildren(...tools.map(t => {
    if (t === '|') return h('span', { class: 'sep' });
    const [name, title, run, active] = t;
    const b = h('button', { class: 'ib', title, 'aria-label': title }, icon(name, 18));
    b.addEventListener('mousedown', e => e.preventDefault()); // keep editor focus/selection
    b.addEventListener('click', () => run(editor.chain().focus())?.run());
    toolRefs.push([b, active]);
    return b;
  }));
  $('#imgpick').onchange = e => { insertImages(imageFiles(e.target.files)); e.target.value = ''; };
}

// ---- modes: formatting toolbar (hidden by default) and view-only ----
let viewOnly = localStorage.pbView === '1';
function applyMode() {
  const toolsOn = localStorage.pbTools === '1';
  editor.setEditable(!viewOnly);
  document.body.classList.toggle('viewonly', viewOnly);
  $('#toolbar').hidden = viewOnly || !toolsOn;
  $('#toolsbtn').classList.toggle('on', toolsOn);
  const v = $('#viewbtn'), label = viewOnly ? 'Switch to editing' : 'View-only mode';
  v.classList.toggle('on', viewOnly);
  v.replaceChildren(icon(viewOnly ? 'edit' : 'view'));
  v.title = label; v.setAttribute('aria-label', label);
  hidePop();
}

// ---- save a snapshot (selection, else whole page) into the searchable archive; linked pages update their item ----
function snapshotMarkdown(whole) {
  const { empty } = editor.state.selection;
  if (empty || whole) return { md: editor.getMarkdown(), part: false };
  const json = { type: 'doc', content: editor.state.selection.content().content.toJSON() };
  return { md: editor.markdown.serialize(json), part: true };
}
async function openSave() {
  if (editor.isEmpty) return toast('Nothing to save');
  const linked = meta?.item_id;
  const { md, part } = snapshotMarkdown(!!linked);
  if (!md.trim()) return toast('Nothing to save');
  const dlg = $('#savedlg'), tagsEl = $('#savetags');
  dlg.dataset.mode = linked ? 'linked' : 'free';
  dlg.querySelector('.what').textContent = linked ? `Update archived item #${linked} with this page` : part ? 'Saving the selection' : 'Saving the whole page';
  tagsEl.value = '';
  if (linked) jsonFetch(`/api/items/${linked}`).then(it => { tagsEl.value = it.tags.join(', '); }).catch(() => {});
  dlg.returnValue = '';
  dlg.onclose = async () => {
    const act = dlg.returnValue;
    if (!['copy', 'clear', 'update', 'updateclose'].includes(act)) return;
    const json = { 'content-type': 'application/json' };
    try {
      if (linked) {
        await jsonFetch(`/api/items/${linked}`, { method: 'PATCH', headers: json, body: JSON.stringify({ text: md.trim(), tags: tagsEl.value, rich: true, lines: false }) });
        toast('Item updated');
        if (act === 'updateclose') {
          const id = pageId;
          await settle();
          suppressDeleteNav = id;
          await jsonFetch(`/api/pages/${id}`, { method: 'DELETE' });
          location.hash = '#feed';
          loadPages().catch(() => {});
        } else { await settle(); await setEdited(pageId, false); }
      } else {
        await jsonFetch('/api/items', { method: 'POST', headers: json, body: JSON.stringify({ text: md.trim(), tags: tagsEl.value, rich: true }) });
        if (act === 'clear') editor.commands.clearContent(true);
        toast('Saved to archive');
        await settle(); await setEdited(pageId, false);
      }
    } catch (e) { toast(e.status === 404 ? 'That item no longer exists' : 'Save failed'); }
  };
  dlg.showModal();
  tagsEl.focus();
}

// ---- pages: like editor tabs. Every page is "open"; closing one discards it (unless it was saved to the archive) ----
let pages = [];
let suppressDeleteNav = null; // page we deleted ourselves; don't let its SSE event navigate again
const mobile = matchMedia('(max-width:760px)');
const setSidebar = open => { document.body.classList.toggle('sb-open', open); };
const isDirty = p => !!p.edited && !p.empty; // changes not yet saved to the archive

function renderSidebar() {
  const syncTitle = { ok: 'Synced with server', saving: 'Syncing…', offline: 'Not synced — offline' };
  $('#pagelist').replaceChildren(...pages.map(p => {
    const sync = p.id === pageId ? syncState : 'ok';
    const dirty = isDirty(p);
    return h('a', { class: 'pg' + (p.id === pageId ? ' on' : '') + (dirty ? ' dirty' : ''), href: '#p/' + p.id, title: p.item_id ? `Editing archived item #${p.item_id}` : '' },
      h('i', { class: 'sdot s-' + sync, title: syncTitle[sync] }),
      h('span', { class: 't' }, p.title || 'Untitled'),
      h('button', { class: 'ib sm x', title: dirty ? 'Close — unsaved changes will be lost' : 'Close', 'aria-label': 'Close page', onclick: e => { e.preventDefault(); e.stopPropagation(); closePage(p.id); } },
        h('b', { class: 'dd' }), icon('close', 14)));
  }));
}
async function loadPages() {
  pages = await jsonFetch('/api/pages');
  renderSidebar();
}
// Close = discard the page. Anything not saved to the archive is lost, so ask first.
async function closePage(id) {
  const idx = pages.findIndex(p => p.id === id), p = pages[idx];
  if (!p) return;
  if (isDirty(p) && !confirm(`Close "${p.title || 'Untitled'}" without saving it to the archive? Its content will be lost.`)) return;
  suppressDeleteNav = id;
  try { await jsonFetch(`/api/pages/${id}`, { method: 'DELETE' }); } catch { return toast('Could not close page'); }
  await loadPages();
  if (id === pageId) location.hash = '#p/' + (pages[idx] ?? pages[idx - 1] ?? pages[0]).id;
}
async function newPage() {
  try {
    const { id } = await jsonFetch('/api/pages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await loadPages();
    location.hash = '#p/' + id;
  } catch { toast('Could not create page'); }
}

// First top-level block with text becomes the page title.
let titleTimer;
function scheduleTitle() {
  clearTimeout(titleTimer);
  titleTimer = setTimeout(async () => {
    let t = '';
    editor.state.doc.forEach(n => { if (!t && n.textContent.trim()) t = n.textContent.trim().slice(0, 80); });
    const cur = pages.find(p => p.id === pageId);
    if (!cur || cur.title === t) return;
    cur.title = t; renderSidebar();
    jsonFetch(`/api/pages/${pageId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: t }) }).catch(() => {});
  }, 700);
}

function seedFromItem(it) {
  if (it.rich) editor.commands.setContent(it.text, { contentType: 'markdown' });
  else if (it.lines) editor.commands.setContent({ type: 'doc', content: [{ type: 'codeBlock', attrs: { lines: true }, content: it.text ? [{ type: 'text', text: it.text }] : undefined }] });
  else editor.commands.setContent({ type: 'doc', content: it.text.split('\n').map(l => (l ? { type: 'paragraph', content: [{ type: 'text', text: l }] } : { type: 'paragraph' })) });
}

const setEdited = (id, edited) => jsonFetch(`/api/pages/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ edited }) }).catch(() => {});

let opening = Promise.resolve();
const openPage = id => (opening = opening.then(() => doOpen(id)).catch(() => {}));
async function doOpen(id) {
  if (id === pageId && editor) return;
  if (editor && !(await settle())) { toast('Still syncing — try again in a moment'); location.hash = '#p/' + pageId; return; }
  hidePop();
  editor?.destroy(); editor = null;
  ydoc?.destroy();
  pageId = id; ydoc = new Y.Doc(); watch(ydoc);
  try { meta = await jsonFetch(`/api/pages/${id}`); await pull(); }
  catch (e) { // deleted or unknown: fall back to the first page
    pageId = null; editor = null;
    await loadPages();
    if (pages[0] && pages[0].id !== id) location.hash = '#p/' + pages[0].id;
    return;
  }
  localStorage.pbPage = id;
  setStatus('ok', 'Synced');
  mountEditor();
  renderSidebar();
  if (mobile.matches) setSidebar(false);
  if (meta.item_id && !meta.seeded) { // page opened from an archived item: first opener fills it in
    try {
      await jsonFetch(`/api/pages/${id}/seed`, { method: 'POST' });
      seeding = true;
      seedFromItem(await jsonFetch(`/api/items/${meta.item_id}`));
      await settle();
      await setEdited(id, false);
      seeding = false;
    } catch { seeding = false; /* someone else seeded it */ }
  }
}
function routePage() {
  const m = /^#p\/(\d+)$/.exec(location.hash);
  const id = m ? +m[1] : +localStorage.pbPage || pages[0]?.id;
  if (id) openPage(id);
}

// ---- boot (after login) ----
function mountEditor() {
  mountedAt = Date.now();
  editor = new Editor({
    element: $('#editor'),
    editable: !viewOnly,
    injectCSS: false, // CSP forbids injected <style>; base rules live in style.css
    extensions: [
      StarterKit.configure({ undoRedo: false, codeBlock: false, link: { openOnClick: false, autolink: true } }),
      Collaboration.configure({ document: ydoc }),
      CodeBlock,
      CodeLines,
      Image,
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown,
      Placeholder.configure({ placeholder: 'Start writing… paste text or images. Markdown works: # heading, - list, [ ] task, ``` code' }),
    ],
    editorProps: {
      attributes: { spellcheck: 'true' },
      handlePaste(view, event) {
        const imgs = imageFiles(event.clipboardData?.files);
        if (imgs.length) { event.preventDefault(); insertImages(imgs); return true; }
        const text = event.clipboardData?.getData('text/plain') || '';
        // Plain-text markdown (no HTML flavour) renders as you paste, like Obsidian. Code blocks keep raw text.
        if (text && !event.clipboardData.getData('text/html') && !inCode() && looksLikeMarkdown(text)) {
          event.preventDefault();
          editor.commands.insertContent(text, { contentType: 'markdown' });
          return true;
        }
        return false;
      },
      handleDrop(view, event) {
        const imgs = imageFiles(event.dataTransfer?.files);
        if (!imgs.length) return false;
        event.preventDefault();
        insertImages(imgs, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
        return true;
      },
      handleDOMEvents: {
        click(view, e) { // view-only: links open directly; editing: Ctrl/⌘+click (plain click shows the popover)
          const a = e.target.closest?.('a[href]');
          if (a && (!editor.isEditable || e.metaKey || e.ctrlKey)) { window.open(a.href, '_blank', 'noopener'); return true; }
          return false;
        },
      },
    },
  });
  editor.on('transaction', refreshToolbar);
  editor.on('update', ({ transaction }) => {
    scheduleTitle();
    if (transaction.getMeta('y-sync$')?.isChangeOrigin) return; // applied from the server / another tab, not typed here
    const cp = pages.find(p => p.id === pageId), empty = editor.isEmpty;
    if (cp && !quiet() && (!cp.edited || cp.empty !== empty)) { cp.edited = true; cp.empty = empty; renderSidebar(); }
  });
  editor.on('selectionUpdate', () => {
    if (popEditing) return;
    if (editor.isEditable && editor.isActive('link') && editor.state.selection.empty) showPop(false); else hidePop();
  });
  applyMode();
  if (!viewOnly && !location.hash.startsWith('#feed')) editor.commands.focus('end');
}

let started = false;
async function start() {
  if (started) return;
  started = true;
  try { await loadPages(); } catch { started = false; return; }
  setSidebar(!mobile.matches);
  buildToolbar();

  document.addEventListener('mousedown', e => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest?.('.ProseMirror a')) hidePop(); });
  $('#editor').addEventListener('scroll', hidePop);
  $('#editor').addEventListener('mousedown', e => { if (e.target === $('#editor') && editor?.isEditable) { e.preventDefault(); editor.commands.focus('end'); } });
  $('#savebtn').onclick = () => editor && openSave();
  $('#newpage').onclick = newPage;
  $('#menubtn').onclick = () => setSidebar(!document.body.classList.contains('sb-open'));
  $('#sbback').onclick = () => setSidebar(false);
  $('#toolsbtn').onclick = () => { localStorage.pbTools = localStorage.pbTools === '1' ? '0' : '1'; if (editor) applyMode(); };
  $('#viewbtn').onclick = () => { viewOnly = !viewOnly; localStorage.pbView = viewOnly ? '1' : '0'; if (editor) applyMode(); };
  addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || $('#docview').hidden || !editor) return;
    if (e.key === 's') { e.preventDefault(); openSave(); }
    else if (e.key === 'k' && editor.isFocused) { e.preventDefault(); showPop(true); }
  });
  addEventListener('hashchange', () => { if (location.hash !== '#feed') routePage(); });
  routePage();
}

document.addEventListener('pb:event', e => {
  const m = e.detail;
  if (m.type === 'doc' && m.page === pageId && m.src !== cid && ydoc) Y.applyUpdate(ydoc, fromB64(m.u), 'remote');
  else if (m.type === 'pages' && started) loadPages().catch(() => {});
  else if (m.type === 'page-deleted' && m.id === pageId && suppressDeleteNav !== m.id) {
    loadPages().then(() => { location.hash = '#p/' + pages[pages.length - 1].id; }).catch(() => {});
  }
});
document.addEventListener('pb:resync', () => { if (ydoc) pull().then(push).catch(() => {}); loadPages().catch(() => {}); }); // SSE reconnected: catch up, then flush offline edits
document.addEventListener('pb:ready', start);
if (window.pbReady) start();
