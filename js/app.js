import * as db from './db.js';
import * as im from './imaging.js';
import { buildPdf } from './pdf.js';
import { buildZip } from './zip.js';
import * as cam from './camera.js';
import { icon } from './icons.js';
import { t, tn, setLanguage, getLocale, applyTranslations, LANGUAGES } from './i18n.js';

const APP_VERSION = '1.4.0';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const FILTERS = ['original', 'enhanced', 'gray', 'bw'];

// Maximum edge length (px) and JPEG quality per export level.
const QUALITY = {
  high: { max: 3000, q: 0.9 },
  medium: { max: 2000, q: 0.8 },
  low: { max: 1400, q: 0.65 },
};

// ------------------------------------------------------------------ Settings

const DEFAULT_SETTINGS = {
  autoDetect: true,
  defaultFilter: 'enhanced',
  cameraMode: 'app',
  format: 'pdf',
  pageSize: 'a4',
  quality: 'medium',
  range: 'all',
  language: 'auto',
  autoTorch: true,
  reviewCrop: true,
  stabilize: true,
};
const settings = { ...DEFAULT_SETTINGS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('scan-settings') || '{}')); } catch { /* ignore */ }
function saveSettings() {
  try { localStorage.setItem('scan-settings', JSON.stringify(settings)); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ State

const state = {
  view: 'home',
  doc: null,        // current document
  pages: [],        // pages of the current document (in order)
  index: 0,         // current page in the editor
  sortMode: false,
  cropMode: false,
  crop: null,
  torch: false,
  torchSupported: false,
  review: null,     // 'app' | 'system' while reviewing a fresh capture
  exportFromEditor: false,
};

let importTarget = 'new';   // 'new' | 'current'
let captureTarget = 'new';

// ------------------------------------------------------------------ Helpers

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const pad = (n, l = 2) => String(n).padStart(l, '0');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function defaultName() {
  const d = new Date();
  return `Scan ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDate(ts) {
  return new Date(ts).toLocaleString(getLocale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return Math.round(b / 1024) + ' KB';
  return (b / 1048576).toLocaleString(getLocale(), { maximumFractionDigits: 1 }) + ' MB';
}
function safeName(s) {
  return (s || 'Scan').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Scan';
}

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });
}

let toastTimer;
function toast(msg, { action, onAction, duration = 3000 } = {}) {
  const el = $('#toast');
  el.replaceChildren();
  const span = document.createElement('span');
  span.textContent = msg;
  el.append(span);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action;
    b.onclick = () => { el.classList.remove('show'); onAction?.(); };
    el.append(b);
    duration = 10000;
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

function busy(text) {
  if (text === false) { $('#busy').hidden = true; return; }
  $('#busy-text').textContent = text || t('busy.wait');
  $('#busy').hidden = false;
}

function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  state.view = name;
  document.body.dataset.view = name;
  if (name === 'home' || name === 'doc') setTimeout(tryApplyUpdate, 300);
}

function openSheet(id) {
  const s = $('#' + id);
  s.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => s.classList.add('open')));
}
function closeSheet(id) {
  const s = $('#' + id);
  s.classList.remove('open');
  setTimeout(() => { if (!s.classList.contains('open')) s.hidden = true; }, 260);
  if (id === 'sheet-export') exportToken++;
  setTimeout(tryApplyUpdate, 400);
}

// Manage (and release) object URLs for thumbnails.
const thumbUrls = new Map();
function thumbUrl(key, buffer) {
  if (!buffer) return '';
  const e = thumbUrls.get(key);
  if (e && e.buf === buffer) return e.url;
  if (e) URL.revokeObjectURL(e.url);
  const url = URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' }));
  thumbUrls.set(key, { buf: buffer, url });
  return url;
}
function dropThumb(key) {
  const e = thumbUrls.get(key);
  if (e) { URL.revokeObjectURL(e.url); thumbUrls.delete(key); }
}

// Processing queue (avoids memory spikes during batch capture).
let queue = Promise.resolve();
function enqueue(fn) {
  const p = queue.then(fn).catch((err) => {
    console.error(err);
    toast(t('err.generic', { msg: err?.message || err }));
  });
  queue = p;
  return p;
}

// ------------------------------------------------------------------ Documents & pages

async function startNewDoc() {
  const now = Date.now();
  const doc = { id: uid(), name: defaultName(), created: now, updated: now, pageIds: [], thumb: null };
  await db.putDoc(doc);
  state.doc = doc;
  state.pages = [];
  return doc;
}

async function touchDoc() {
  const d = state.doc;
  if (!d) return;
  d.pageIds = state.pages.map((p) => p.id);
  d.updated = Date.now();
  d.thumb = state.pages[0]?.thumb || null;
  await db.putDoc(d);
}

async function makeThumb(page) {
  const c = await im.renderPage(page, 360);
  const blob = await im.toBlob(c, 'image/jpeg', 0.75);
  im.releaseCanvas(c);
  return blob.arrayBuffer();
}

let persistRequested = false;

// Process a new image and append it as a page to the current document.
async function addImage(blob, hintCorners = null) {
  const doc = state.doc;
  if (!doc) throw new Error(t('err.noDoc'));
  const norm = await im.normalizeImage(blob);
  const page = {
    id: uid(),
    docId: doc.id,
    original: norm.buffer,
    width: norm.width,
    height: norm.height,
    corners: im.FULL.map((p) => ({ ...p })),
    rotation: 0,
    filter: settings.defaultFilter,
    brightness: 0,
    contrast: 0,
    thumb: null,
    created: Date.now(),
  };
  if (settings.autoDetect) {
    try {
      // Prefer detection on the full photo; fall back to the live-preview frame.
      const c = (await im.detectCorners(page)) || hintCorners;
      if (c) page.corners = c.map((p) => ({ ...p }));
    } catch (e) { console.warn('Randerkennung fehlgeschlagen', e); }
  }
  page.thumb = await makeThumb(page);
  await db.putPage(page);
  if (state.doc !== doc) return page; // document was switched in the meantime
  state.pages.push(page);
  await touchDoc();
  if (state.view === 'doc') renderDoc();

  if (!persistRequested && navigator.storage?.persist) {
    persistRequested = true;
    navigator.storage.persist().catch(() => {});
  }
  return page;
}

async function importFiles(files) {
  const n = files.length;
  for (let i = 0; i < n; i++) {
    busy(n > 1 ? t('busy.processingN', { i: i + 1, n }) : t('busy.processing'));
    await enqueue(() => addImage(files[i]));
  }
  busy(false);
}

async function finishAddFlow() {
  if (!state.doc) return showHome();
  if (state.pages.length === 0) {
    await db.deleteDoc(state.doc);
    return showHome();
  }
  renderDoc();
  showView('doc');
}

// ------------------------------------------------------------------ Home view

async function showHome() {
  await flushSaves();
  state.doc = null;
  state.pages = [];
  state.sortMode = false;
  await renderHome();
  showView('home');
}

async function renderHome() {
  const docs = (await db.getAllDocs()).sort((a, b) => b.updated - a.updated);
  const list = $('#doc-list');
  list.replaceChildren();
  $('#home-empty').hidden = docs.length > 0;
  for (const d of docs) {
    const li = document.createElement('li');
    li.className = 'doc-item';
    const n = d.pageIds.length;
    li.innerHTML = `
      <div class="doc-thumb">${d.thumb ? `<img src="${thumbUrl('d:' + d.id, d.thumb)}" alt="">` : icon('file')}</div>
      <div class="doc-info"><div class="doc-name"></div><div class="doc-meta"></div></div>
      ${icon('chevronRight')}`;
    $('.doc-name', li).textContent = d.name;
    $('.doc-meta', li).textContent = `${tn('doc.pages', n)} · ${fmtDate(d.updated)}`;
    li.onclick = () => openDoc(d.id);
    list.append(li);
  }
}

async function openDoc(id) {
  const doc = await db.getDoc(id);
  if (!doc) return renderHome();
  state.doc = doc;
  state.pages = await db.getPages(doc.pageIds);
  state.sortMode = false;
  state.index = 0;
  renderDoc();
  showView('doc');
}

// ------------------------------------------------------------------ Document view

function renderDoc() {
  const doc = state.doc;
  if (!doc) return;
  $('#doc-name').textContent = doc.name;
  const grid = $('#page-grid');
  grid.classList.toggle('sorting', state.sortMode);
  $('#sort-hint').hidden = !state.sortMode;
  $('#doc-sort').classList.toggle('active', state.sortMode);
  $('#doc-sort-label').textContent = state.sortMode ? t('btn.done') : t('doc.sort');
  $('#doc-export').disabled = state.pages.length === 0;
  grid.replaceChildren();
  state.pages.forEach((p, i) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.i = i;
    tile.innerHTML = `
      <img alt="${t('page.alt', { n: i + 1 })}" src="${thumbUrl('p:' + p.id, p.thumb)}">
      <span class="num">${i + 1}</span>
      <div class="sort-ctrls">
        <button data-act="left" aria-label="${t('aria.moveLeft')}" ${i === 0 ? 'disabled' : ''}>${icon('chevronLeft')}</button>
        <button data-act="del" class="del" aria-label="${t('aria.delete')}">${icon('trash')}</button>
        <button data-act="right" aria-label="${t('aria.moveRight')}" ${i === state.pages.length - 1 ? 'disabled' : ''}>${icon('chevronRight')}</button>
      </div>`;
    grid.append(tile);
  });
  if (!state.sortMode) {
    const add = document.createElement('div');
    add.className = 'tile add';
    add.dataset.act = 'add';
    add.innerHTML = `${icon('plus')}<small>${t('doc.addPageTile')}</small>`;
    grid.append(add);
  }
}

async function onGridClick(e) {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  if (tile.dataset.act === 'add') return openCamera('current');
  const i = +tile.dataset.i;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (state.sortMode) {
    if (act === 'left' && i > 0) [state.pages[i - 1], state.pages[i]] = [state.pages[i], state.pages[i - 1]];
    else if (act === 'right' && i < state.pages.length - 1) [state.pages[i + 1], state.pages[i]] = [state.pages[i], state.pages[i + 1]];
    else if (act === 'del') { await deletePageAt(i); return; }
    else return;
    await touchDoc();
    renderDoc();
    return;
  }
  openEditor(i);
}

async function removePage(p) {
  const i = state.pages.indexOf(p);
  if (i < 0) return;
  clearTimeout(saveTimers.get(p.id));
  saveTimers.delete(p.id);
  state.pages.splice(i, 1);
  await db.deletePage(p.id);
  await touchDoc();
  im.forgetSource(p.id);
  dropThumb('p:' + p.id);
}

async function deletePageAt(i) {
  const p = state.pages[i];
  if (!p || !confirm(t('confirm.deletePage', { n: i + 1 }))) return false;
  await removePage(p);
  renderDoc();
  return true;
}

function renameDoc() {
  const doc = state.doc;
  if (!doc) return;
  const name = prompt(t('prompt.docName'), doc.name);
  if (name === null) return;
  doc.name = name.trim() || doc.name;
  db.putDoc(doc);
  renderDoc();
}

async function duplicateDoc() {
  const src = state.doc;
  if (!src) return;
  busy(t('busy.duplicating'));
  try {
    await flushSaves();
    const now = Date.now();
    const doc = { ...src, id: uid(), name: src.name + t('doc.copySuffix'), created: now, updated: now, pageIds: [] };
    for (const p of state.pages) {
      const np = { ...p, id: uid(), docId: doc.id, corners: p.corners.map((c) => ({ ...c })) };
      await db.putPage(np);
      doc.pageIds.push(np.id);
    }
    await db.putDoc(doc);
    await openDoc(doc.id);
    toast(t('toast.duplicated'));
  } finally {
    busy(false);
  }
}

async function deleteDoc() {
  if (!state.doc || !confirm(t('confirm.deleteDoc', { name: state.doc.name }))) return;
  saveTimers.forEach((timer) => clearTimeout(timer));
  saveTimers.clear();
  await db.deleteDoc(state.doc);
  dropThumb('d:' + state.doc.id);
  state.pages.forEach((p) => { dropThumb('p:' + p.id); im.forgetSource(p.id); });
  await showHome();
  toast(t('toast.deleted'));
}

// ------------------------------------------------------------------ Persisting changes

const saveTimers = new Map();
function schedulePersist(page) {
  clearTimeout(saveTimers.get(page.id));
  saveTimers.set(page.id, setTimeout(() => persistPage(page), 700));
}
async function persistPage(page) {
  saveTimers.delete(page.id);
  if (!state.pages.includes(page)) return;
  page.thumb = await makeThumb(page);
  await db.putPage(page);
  if (state.doc && state.doc.id === page.docId) await touchDoc();
}
async function flushSaves() {
  const ids = [...saveTimers.keys()];
  for (const id of ids) {
    clearTimeout(saveTimers.get(id));
    const p = state.pages.find((x) => x.id === id);
    if (p) await persistPage(p);
    else saveTimers.delete(id);
  }
}

// ------------------------------------------------------------------ Editor

const curPage = () => state.pages[state.index];
const previewMax = () => Math.min(2000, Math.round(Math.max(innerWidth, innerHeight) * Math.min(devicePixelRatio || 1, 2)));

function openEditor(i) {
  state.index = i;
  showView('editor');
  setPane('filter');
  onPageChanged();
}

async function closeEditor() {
  if (state.cropMode) exitCrop();
  renderDoc();
  showView('doc');
  await flushSaves();
  renderDoc();
}

function onPageChanged() {
  const n = state.pages.length;
  $('#ed-pos').textContent = `${state.index + 1} / ${n}`;
  $('#ed-prev').disabled = state.index === 0;
  $('#ed-next').disabled = state.index >= n - 1;
  syncAdjustUi();
  renderFilterThumbs();
  requestRender();
}

function navEditor(d) {
  const i = state.index + d;
  if (i < 0 || i >= state.pages.length || state.cropMode) return;
  state.index = i;
  onPageChanged();
}

function setPane(name) {
  $$('#ed-panel .panel-pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  $$('#ed-toolbar [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
}

let rendering = false;
let renderAgain = false;
async function requestRender() {
  if (rendering) { renderAgain = true; return; }
  rendering = true;
  const spin = setTimeout(() => { $('#ed-spinner').hidden = false; }, 200);
  try {
    do {
      renderAgain = false;
      const page = curPage();
      if (!page) break;
      const c = await im.renderPage(page, previewMax(), { cache: true });
      if (renderAgain) { im.releaseCanvas(c); continue; }
      c.className = 'preview';
      const old = $('#ed-stage canvas.preview');
      if (old) { old.replaceWith(c); im.releaseCanvas(old); } else $('#ed-stage').prepend(c);
    } while (renderAgain);
  } catch (e) {
    console.error(e);
    toast(t('err.processing'));
  } finally {
    clearTimeout(spin);
    $('#ed-spinner').hidden = true;
    rendering = false;
  }
}

function pageChanged(p) {
  schedulePersist(p);
  requestRender();
}

let filterThumbToken = 0;
async function renderFilterThumbs() {
  const page = curPage();
  if (!page) return;
  const token = ++filterThumbToken;
  const row = $('#filter-row');
  row.replaceChildren();
  const btns = FILTERS.map((f) => {
    const b = document.createElement('button');
    b.className = 'filter-btn' + (page.filter === f ? ' active' : '');
    b.dataset.f = f;
    b.innerHTML = `<div class="ft-img"></div><span>${t('filter.' + f)}</span>`;
    row.append(b);
    return b;
  });
  for (let i = 0; i < FILTERS.length; i++) {
    const c = await im.renderPage({ ...page, filter: FILTERS[i], brightness: 0, contrast: 0 }, 150, { cache: true });
    if (token !== filterThumbToken) { im.releaseCanvas(c); return; }
    $('.ft-img', btns[i]).replaceChildren(c);
  }
}

function syncAdjustUi() {
  const p = curPage();
  if (!p) return;
  $('#adj-brightness').value = p.brightness || 0;
  $('#out-brightness').textContent = p.brightness || 0;
  $('#adj-contrast').value = p.contrast || 0;
  $('#out-contrast').textContent = p.contrast || 0;
  $('#row-contrast').classList.toggle('disabled', p.filter === 'bw');
  $$('#filter-row .filter-btn').forEach((b) => b.classList.toggle('active', b.dataset.f === p.filter));
}

function rotate(deg) {
  const p = curPage();
  if (!p) return;
  p.rotation = (((p.rotation || 0) + deg) % 360 + 360) % 360;
  pageChanged(p);
  renderFilterThumbs();
}

async function deleteCurrentPage() {
  const ok = await deletePageAt(state.index);
  if (!ok) return;
  if (state.pages.length === 0) {
    renderDoc();
    showView('doc');
    return;
  }
  state.index = Math.min(state.index, state.pages.length - 1);
  onPageChanged();
}

// ------------------------------------------------------------------ Cropping
//
// Gestures on the crop canvas:
//  - drag a corner handle      -> move that corner
//  - drag an edge handle       -> move the whole edge
//  - drag anywhere else        -> draw a new rectangular frame

const CROP_M = 28; // margin around the image so handles are not clipped

async function enterCrop() {
  const page = curPage();
  if (!page) return;
  state.cropMode = true;
  state.crop = { corners: page.corners.map((p) => ({ ...p })), src: null, drag: null };
  $('#view-editor').classList.add('cropping');
  setPane('crop');
  const s = await im.getSource(page, 1600, true);
  if (!state.cropMode) return;
  const c = im.canvas(s.width, s.height);
  c.getContext('2d').putImageData(s, 0, 0);
  state.crop.src = c;
  $('#crop-canvas').hidden = false;
  layoutCrop();
  drawCrop();
}

function exitCrop() {
  state.cropMode = false;
  if (state.crop?.src) im.releaseCanvas(state.crop.src);
  state.crop = null;
  $('#view-editor').classList.remove('cropping');
  $('#crop-canvas').hidden = true;
  $('#loupe').hidden = true;
  setPane('filter');
}

function layoutCrop() {
  const cr = state.crop;
  if (!cr?.src) return;
  const stage = $('#ed-stage');
  const W = stage.clientWidth - 8, H = stage.clientHeight - 8;
  const rot = curPage().rotation || 0;
  const sw = cr.src.width, sh = cr.src.height;
  const rw = rot % 180 ? sh : sw, rh = rot % 180 ? sw : sh;
  const s = Math.min((W - 2 * CROP_M) / rw, (H - 2 * CROP_M) / rh);
  cr.dw = rw * s;
  cr.dh = rh * s;
  cr.dpr = Math.min(devicePixelRatio || 1, 3);
  const c = $('#crop-canvas');
  c.width = Math.round((cr.dw + 2 * CROP_M) * cr.dpr);
  c.height = Math.round((cr.dh + 2 * CROP_M) * cr.dpr);
  c.style.width = cr.dw + 2 * CROP_M + 'px';
  c.style.height = cr.dh + 2 * CROP_M + 'px';
}

function cropDisplayPts() {
  const cr = state.crop;
  const rot = curPage().rotation || 0;
  return cr.corners.map((p) => {
    const q = im.toDisplay(p, rot);
    return { x: q.x * cr.dw, y: q.y * cr.dh };
  });
}

function drawCrop() {
  const cr = state.crop;
  if (!cr?.src) return;
  const c = $('#crop-canvas');
  const ctx = c.getContext('2d');
  const rot = curPage().rotation || 0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.setTransform(cr.dpr, 0, 0, cr.dpr, CROP_M * cr.dpr, CROP_M * cr.dpr);
  im.drawRotated(ctx, cr.src, rot, cr.dw, cr.dh);

  const pts = cropDisplayPts();
  ctx.fillStyle = 'rgba(0,0,0,.5)';
  ctx.beginPath();
  ctx.rect(0, 0, cr.dw, cr.dh);
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fill('evenodd');

  const dr = cr.drag;
  ctx.lineJoin = 'round';
  for (let k = 0; k < 4; k++) {
    const a = pts[k], b = pts[(k + 1) % 4];
    const active = dr?.mode === 'edge' && dr.k === k;
    ctx.strokeStyle = active ? '#93c5fd' : '#3b82f6';
    ctx.lineWidth = active ? 3.5 : 2;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }

  // Edge handles (midpoints)
  for (let k = 0; k < 4; k++) {
    const a = pts[k], b = pts[(k + 1) % 4];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(-13, -4, 26, 8, 4) : ctx.rect(-13, -4, 26, 8);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
  }

  // Corner handles
  pts.forEach((p, i) => {
    const active = dr?.mode === 'corner' && dr.i === i;
    ctx.beginPath();
    ctx.arc(p.x, p.y, active ? 18 : 12, 0, Math.PI * 2);
    ctx.fillStyle = active ? 'rgba(59,130,246,0)' : 'rgba(59,130,246,.35)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  });
}

function cropPointer(e) {
  const r = $('#crop-canvas').getBoundingClientRect();
  return { x: e.clientX - r.left - CROP_M, y: e.clientY - r.top - CROP_M };
}

function setCropCorner(i, px, py) {
  const cr = state.crop;
  const rot = curPage().rotation || 0;
  cr.corners[i] = im.fromDisplay({ x: clamp(px, 0, cr.dw) / cr.dw, y: clamp(py, 0, cr.dh) / cr.dh }, rot);
}

function onCropDown(e) {
  const cr = state.crop;
  if (!cr?.src) return;
  e.preventDefault();
  const { x, y } = cropPointer(e);
  const pts = cropDisplayPts();
  $('#crop-canvas').setPointerCapture(e.pointerId);

  let best = -1, bd = 44;
  pts.forEach((p, i) => {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bd) { bd = d; best = i; }
  });
  if (best >= 0) {
    cr.drag = { mode: 'corner', i: best, off: { x: pts[best].x - x, y: pts[best].y - y } };
    onCropMove(e);
    return;
  }
  let edge = -1;
  bd = 36;
  for (let k = 0; k < 4; k++) {
    const a = pts[k], b = pts[(k + 1) % 4];
    const d = Math.hypot((a.x + b.x) / 2 - x, (a.y + b.y) / 2 - y);
    if (d < bd) { bd = d; edge = k; }
  }
  if (edge >= 0) {
    cr.drag = { mode: 'edge', k: edge, start: { x, y }, a: pts[edge], b: pts[(edge + 1) % 4] };
    drawCrop();
    return;
  }
  cr.drag = { mode: 'draw', anchor: { x: clamp(x, 0, cr.dw), y: clamp(y, 0, cr.dh) }, started: false };
}

function onCropMove(e) {
  const cr = state.crop;
  const dr = cr?.drag;
  if (!dr) return;
  e.preventDefault();
  const { x, y } = cropPointer(e);
  const rot = curPage().rotation || 0;

  if (dr.mode === 'corner') {
    const px = clamp(x + dr.off.x, 0, cr.dw), py = clamp(y + dr.off.y, 0, cr.dh);
    setCropCorner(dr.i, px, py);
    drawCrop();
    drawLoupe(px, py);
  } else if (dr.mode === 'edge') {
    const dx = clamp(x - dr.start.x, -Math.min(dr.a.x, dr.b.x), cr.dw - Math.max(dr.a.x, dr.b.x));
    const dy = clamp(y - dr.start.y, -Math.min(dr.a.y, dr.b.y), cr.dh - Math.max(dr.a.y, dr.b.y));
    setCropCorner(dr.k, dr.a.x + dx, dr.a.y + dy);
    setCropCorner((dr.k + 1) % 4, dr.b.x + dx, dr.b.y + dy);
    drawCrop();
    drawLoupe((dr.a.x + dr.b.x) / 2 + dx, (dr.a.y + dr.b.y) / 2 + dy);
  } else {
    const cx = clamp(x, 0, cr.dw), cy = clamp(y, 0, cr.dh);
    if (!dr.started && Math.hypot(cx - dr.anchor.x, cy - dr.anchor.y) < 12) return;
    dr.started = true;
    const x0 = Math.min(dr.anchor.x, cx), x1 = Math.max(dr.anchor.x, cx);
    const y0 = Math.min(dr.anchor.y, cy), y1 = Math.max(dr.anchor.y, cy);
    const disp = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    cr.corners = im.orderCorners(disp.map((p) => im.fromDisplay({ x: p.x / cr.dw, y: p.y / cr.dh }, rot)));
    drawCrop();
    drawLoupe(cx, cy);
  }
}

function onCropUp() {
  const cr = state.crop;
  if (!cr) return;
  cr.drag = null;
  $('#loupe').hidden = true;
  drawCrop();
}

// Loupe shows the area under the finger magnified.
function drawLoupe(px, py) {
  const cr = state.crop;
  const L = 110, Z = 2.2, dpr = cr.dpr;
  const lc = $('#loupe');
  lc.hidden = false;
  if (lc.width !== L * dpr) { lc.width = L * dpr; lc.height = L * dpr; }
  const ctx = lc.getContext('2d');
  const src = $('#crop-canvas');
  const sw = (L / Z) * dpr;
  const cx = (px + CROP_M) * dpr, cy = (py + CROP_M) * dpr;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, lc.width, lc.height);
  ctx.drawImage(src, cx - sw / 2, cy - sw / 2, sw, sw, 0, 0, L * dpr, L * dpr);
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2 * dpr;
  const m = (L * dpr) / 2;
  ctx.beginPath();
  ctx.moveTo(m - 12 * dpr, m); ctx.lineTo(m + 12 * dpr, m);
  ctx.moveTo(m, m - 12 * dpr); ctx.lineTo(m, m + 12 * dpr);
  ctx.stroke();

  const stage = $('#ed-stage').getBoundingClientRect();
  const cRect = src.getBoundingClientRect();
  // Always show the loupe on the side opposite the finger.
  const fingerX = cRect.left + CROP_M + px - stage.left;
  const leftSide = fingerX < stage.width / 2;
  lc.style.left = leftSide ? '' : '12px';
  lc.style.right = leftSide ? '12px' : '';
}

function croppedCornersOrToast() {
  const c = im.orderCorners(state.crop.corners);
  if (im.quadArea(c) < 0.01) { toast(t('crop.tooSmall')); return null; }
  if (!im.isConvex(c)) { toast(t('crop.invalid')); return null; }
  return c;
}

async function applyCrop() {
  const p = curPage();
  const c = croppedCornersOrToast();
  if (!c) return;
  p.corners = c;
  exitCrop();
  pageChanged(p);
  renderFilterThumbs();
}

async function autoCrop() {
  const page = curPage();
  const c = await im.detectCorners(page);
  if (!state.crop) return;
  if (!c) { toast(t('crop.notFound')); return; }
  state.crop.corners = c;
  drawCrop();
}

// ------------------------------------------------------------------ Review after capture
// After each photo the detected frame is shown for adjustment ("Keep" / "Retake").
// source: 'app' (in-app camera) or 'system' (iOS camera via file input).

async function openReview(page, source) {
  state.review = source;
  state.index = Math.max(0, state.pages.indexOf(page));
  stopLive();
  showView('editor');
  $('#view-editor').classList.add('reviewing');
  await enterCrop();
}

function endReview() {
  state.review = null;
  $('#view-editor').classList.remove('reviewing');
  exitCrop();
}

async function reviewKeep() {
  const p = curPage();
  const c = croppedCornersOrToast();
  if (!c) return;
  p.corners = c;
  const source = state.review;
  endReview();
  busy(t('busy.processing'));
  try { await persistPage(p); } finally { busy(false); }
  if (source === 'app') returnToCamera(p);
  else await finishAddFlow();
}

async function reviewRetake() {
  const source = state.review;
  const p = curPage();
  if (source === 'system') {
    // Must happen synchronously inside the click handler.
    captureTarget = 'current';
    $('#file-capture').click();
  }
  endReview();
  await removePage(p);
  if (source === 'app') {
    camCount = Math.max(0, camCount - 1);
    returnToCamera(camCount ? state.pages[state.pages.length - 1] : null);
  } else {
    renderDoc();
    showView('doc');
  }
}

function returnToCamera(lastPage) {
  showView('camera');
  updateCamUi(lastPage);
  $('#cam-video').play().catch(() => {});
  if (cam.isActive()) startLive();
  else startStream();
}

// ------------------------------------------------------------------ Camera

function openCamera(target) {
  // The system camera must be opened synchronously inside the click handler.
  if (settings.cameraMode === 'system' || !cam.isSupported()) {
    captureTarget = target;
    $('#file-capture').click();
    return;
  }
  startAppCamera(target);
}

let camCount = 0;
async function startAppCamera(target) {
  if (target === 'new') await startNewDoc();
  camCount = 0;
  updateCamUi(null);
  $('#cam-error').hidden = true;
  $('#cam-torch').hidden = true;
  state.torch = false;
  showView('camera');
  await startStream();
}

async function startStream() {
  try {
    const info = await cam.start($('#cam-video'));
    state.torchSupported = info.torch;
    $('#cam-torch').hidden = !info.torch;
    $('#cam-torch').classList.remove('on');
    state.torch = false;
    torchManual = false;
    lightHandled = false;
    darkCount = 0;
    $('#cam-hint').textContent = t('cam.hint');
    startLive();
  } catch (e) {
    console.error(e);
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    $('#cam-error-text').textContent = denied ? t('cam.denied') : t('cam.failed');
    $('#cam-error').hidden = false;
  }
}

function updateCamUi(page) {
  $('#cam-count').textContent = camCount;
  $('#cam-count').hidden = camCount === 0;
  const img = $('#cam-thumb-img');
  if (page?.thumb) {
    img.src = thumbUrl('p:' + page.id, page.thumb);
    img.hidden = false;
  } else if (!camCount) {
    img.hidden = true;
  }
}

// ---- Live document frame + light measurement (runs ~7×/s on a small copy of the video frame)

let liveTimer = null;
let liveQuad = null;
let liveMiss = 0;
const liveCanvas = document.createElement('canvas');

function startLive() {
  stopLive();
  liveTimer = setTimeout(liveTick, 250);
}

function stopLive() {
  clearTimeout(liveTimer);
  liveTimer = null;
  liveQuad = null;
  liveMiss = 0;
  drawOverlay();
}

function liveTick() {
  liveTimer = null;
  if (state.view !== 'camera' || !cam.isActive()) return;
  const v = $('#cam-video');
  const vw = v.videoWidth, vh = v.videoHeight;
  if (vw && vh) {
    const s = 320 / Math.max(vw, vh);
    const w = Math.round(vw * s), h = Math.round(vh * s);
    if (liveCanvas.width !== w || liveCanvas.height !== h) { liveCanvas.width = w; liveCanvas.height = h; }
    const ctx = liveCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    handleLight(im.meanLuminance(data));
    const res = im.detectQuad(data);
    if (res) {
      liveMiss = 0;
      // Smooth movement to avoid jitter.
      liveQuad = liveQuad
        ? liveQuad.map((p, i) => ({ x: p.x + (res.corners[i].x - p.x) * 0.5, y: p.y + (res.corners[i].y - p.y) * 0.5 }))
        : res.corners;
    } else if (++liveMiss > 3) {
      liveQuad = null;
    }
    drawOverlay();
  }
  liveTimer = setTimeout(liveTick, 140);
}

function drawOverlay() {
  const c = $('#cam-overlay');
  const v = $('#cam-video');
  const cw = c.clientWidth, ch = c.clientHeight;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) {
    c.width = Math.round(cw * dpr);
    c.height = Math.round(ch * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  if (!liveQuad || !v.videoWidth) return;
  // The video uses object-fit: contain – map frame coordinates into the displayed area.
  const s = Math.min(cw / v.videoWidth, ch / v.videoHeight);
  const dw = v.videoWidth * s, dh = v.videoHeight * s;
  const ox = (cw - dw) / 2, oy = (ch - dh) / 2;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pts = liveQuad.map((p) => [ox + p.x * dw, oy + p.y * dh]);
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(59,130,246,.18)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#3b82f6';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill(); }
}

// Automatic torch: if the picture stays dark for a moment, switch the torch on (once per session,
// and never after the user has toggled it manually). Without torch support, show a hint instead.
let darkCount = 0;
let torchManual = false;
let lightHandled = false;
const DARK_LUMINANCE = 75;

async function handleLight(lum) {
  if (lightHandled || torchManual || state.torch) return;
  darkCount = lum < DARK_LUMINANCE ? darkCount + 1 : 0;
  if (darkCount < 5) return;
  lightHandled = true;
  if (state.torchSupported && settings.autoTorch && await cam.setTorch(true)) {
    state.torch = true;
    $('#cam-torch').classList.add('on');
    toast(t('cam.torchAuto'));
    return;
  }
  $('#cam-hint').textContent = t('cam.lowLight');
}

// ---- Anti-shake capture
// Pressing the button shakes the phone. So after the press we wait a moment, then watch the
// video: each frame is rated for sharpness (variance of the Laplacian) and movement (difference
// to the previous frame). The sharpest frame is kept; as soon as the phone is steady, or after
// a maximum wait, that frame is used.

const STEADY = { minWait: 350, maxWait: 1600, motion: 3, steadyFrames: 3 };
const anaCanvas = document.createElement('canvas');
const fullCanvas = document.createElement('canvas');

function analyzeFrame(video) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = 360 / Math.max(vw, vh);
  const w = Math.round(vw * s), h = Math.round(vh * s);
  if (anaCanvas.width !== w || anaCanvas.height !== h) { anaCanvas.width = w; anaCanvas.height = h; }
  const ctx = anaCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let p = 0, i = 0; p < g.length; p++, i += 4) g[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  // Sharpness on the central 70 % of the frame
  let sum = 0, sum2 = 0, n = 0;
  const x0 = Math.round(w * 0.15), x1 = Math.round(w * 0.85), y0 = Math.round(h * 0.15), y1 = Math.round(h * 0.85);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = y * w + x;
      const l = 4 * g[p] - g[p - 1] - g[p + 1] - g[p - w] - g[p + w];
      sum += l; sum2 += l * l; n++;
    }
  }
  const sharp = sum2 / n - (sum / n) ** 2;
  // Coarse 48-px thumbnail for motion detection
  const tw = 48, th = Math.max(1, Math.round((48 * h) / w));
  const thumb = new Float32Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) thumb[ty * tw + tx] = g[Math.floor((ty + 0.5) * h / th) * w + Math.floor((tx + 0.5) * w / tw)];
  }
  return { sharp, thumb };
}

async function captureSteady(video) {
  const t0 = performance.now();
  let bestSharp = -1, prev = null, steady = 0, have = false;
  const keep = () => {
    if (fullCanvas.width !== video.videoWidth || fullCanvas.height !== video.videoHeight) {
      fullCanvas.width = video.videoWidth;
      fullCanvas.height = video.videoHeight;
    }
    fullCanvas.getContext('2d').drawImage(video, 0, 0);
    have = true;
  };
  await cam.shortenExposure();
  try {
    for (;;) {
      await cam.nextFrame(video);
      const el = performance.now() - t0;
      const { sharp, thumb } = analyzeFrame(video);
      let motion = Infinity;
      if (prev) {
        motion = 0;
        for (let i = 0; i < thumb.length; i++) motion += Math.abs(thumb[i] - prev[i]);
        motion /= thumb.length;
      }
      prev = thumb;
      if (el < STEADY.minWait) continue;
      if (sharp > bestSharp) { bestSharp = sharp; keep(); }
      steady = motion < STEADY.motion ? steady + 1 : 0;
      if (steady >= STEADY.steadyFrames || el > STEADY.maxWait) break;
    }
  } finally {
    cam.restoreExposure();
  }
  if (!have) keep();
  const blob = await im.toBlob(fullCanvas, 'image/jpeg', 0.92);
  return blob;
}

let capturing = false;
async function capture() {
  if (capturing) return;
  capturing = true;
  const shutter = $('#cam-shutter');
  const hint = liveQuad ? liveQuad.map((p) => ({ ...p })) : null;
  try {
    let blob;
    if (settings.stabilize) {
      shutter.classList.add('arming');
      $('#cam-hint').textContent = t('cam.holdStill');
      try { blob = await captureSteady($('#cam-video')); } finally {
        shutter.classList.remove('arming');
        $('#cam-hint').textContent = t('cam.hint');
      }
    } else {
      blob = await cam.grab($('#cam-video'));
    }
    const f = $('#cam-flash');
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
    camCount++;
    updateCamUi(null);
    if (settings.reviewCrop) {
      stopLive();
      busy(t('busy.processing'));
      const page = await enqueue(() => addImage(blob, hint));
      busy(false);
      if (page) await openReview(page, 'app');
      else { camCount--; updateCamUi(null); startLive(); }
    } else {
      enqueue(async () => {
        const page = await addImage(blob, hint);
        updateCamUi(page);
      });
    }
  } catch (e) {
    busy(false);
    toast(e.message || t('cam.captureFailed'));
  } finally {
    capturing = false;
  }
}

async function closeCamera() {
  stopLive();
  cam.stop();
  busy(t('busy.captures'));
  await queue;
  busy(false);
  await finishAddFlow();
}

// ------------------------------------------------------------------ Export

let exportFiles = null;
let exportToken = 0;

function exportPages() {
  if (state.exportFromEditor && settings.range === 'current') return [curPage()].filter(Boolean);
  return state.pages;
}

function openExport(fromEditor = false) {
  if (!state.pages.length) return;
  state.exportFromEditor = fromEditor;
  syncExportUi();
  openSheet('sheet-export');
  flushSaves();
  prepareExport();
}

function syncExportUi() {
  const isPdf = settings.format === 'pdf';
  $('#field-pagesize').hidden = !isPdf;
  $('#field-range').hidden = !state.exportFromEditor || state.pages.length < 2;
  $('#export-share-label').textContent = isPdf ? t('btn.share') : t('export.shareImages');
  $('#export-hint').innerHTML = isPdf ? t('export.hintPdf') : t('export.hintImg');
}

async function prepareExport() {
  const token = ++exportToken;
  exportFiles = null;
  $('#export-share').disabled = true;
  $('#export-download').disabled = true;
  const status = $('#export-status');
  const setStatus = (html) => { if (token === exportToken) status.innerHTML = html; };

  const pages = exportPages();
  const q = QUALITY[settings.quality] || QUALITY.medium;
  const base = safeName(state.doc?.name);
  const fmt = settings.format;
  const files = [];
  try {
    const images = [];
    for (let i = 0; i < pages.length; i++) {
      setStatus(`<div class="spinner"></div>${t('export.rendering', { i: i + 1, n: pages.length })}`);
      const c = await im.renderPage(pages[i], q.max);
      if (token !== exportToken) { im.releaseCanvas(c); return; }
      if (fmt === 'pdf') {
        const blob = await im.toBlob(c, 'image/jpeg', q.q);
        images.push({ data: new Uint8Array(await blob.arrayBuffer()), width: c.width, height: c.height });
      } else {
        const type = fmt === 'png' ? 'image/png' : 'image/jpeg';
        const blob = await im.toBlob(c, type, q.q);
        const suffix = pages.length > 1 ? `_${pad(i + 1)}` : '';
        files.push(new File([blob], `${base}${suffix}.${fmt === 'png' ? 'png' : 'jpg'}`, { type }));
      }
      im.releaseCanvas(c);
      if (token !== exportToken) return;
    }
    if (fmt === 'pdf') {
      const pdf = buildPdf(images, { pageSize: settings.pageSize, title: state.doc?.name || 'Scan' });
      files.push(new File([pdf], `${base}.pdf`, { type: 'application/pdf' }));
    }
  } catch (e) {
    console.error(e);
    setStatus(t('export.error', { msg: e.message || e }));
    return;
  }
  if (token !== exportToken) return;
  exportFiles = files;
  const total = files.reduce((s, f) => s + f.size, 0);
  setStatus(`${icon('check')} ${files.length === 1 ? files[0].name : t('export.files', { n: files.length })} · ${fmtBytes(total)}`);
  $('#export-share').disabled = false;
  $('#export-download').disabled = false;
}

async function shareExport() {
  if (!exportFiles) return;
  const data = { files: exportFiles };
  if (!navigator.share || (navigator.canShare && !navigator.canShare(data))) {
    toast(t('share.unsupported'));
    return;
  }
  try {
    await navigator.share(data);
  } catch (e) {
    if (e.name !== 'AbortError') toast(t('share.failed', { msg: e.message }));
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function downloadExport() {
  if (!exportFiles) return;
  if (exportFiles.length === 1) {
    downloadBlob(exportFiles[0], exportFiles[0].name);
    return;
  }
  const entries = await Promise.all(exportFiles.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
  downloadBlob(buildZip(entries), safeName(state.doc?.name) + '.zip');
}

// ------------------------------------------------------------------ Settings

function initSegs() {
  $$('.seg[data-setting]').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      settings[seg.dataset.setting] = b.dataset.v;
      saveSettings();
      syncSegs();
      seg.dispatchEvent(new CustomEvent('setting-change'));
    });
  });
  syncSegs();
}
function syncSegs() {
  $$('.seg[data-setting]').forEach((seg) => {
    $$('button', seg).forEach((b) => b.classList.toggle('active', b.dataset.v === settings[seg.dataset.setting]));
  });
}

async function openSettings() {
  $('#set-autodetect').checked = settings.autoDetect;
  $('#set-autotorch').checked = settings.autoTorch;
  $('#set-review').checked = settings.reviewCrop;
  $('#set-stabilize').checked = settings.stabilize;
  $('#app-version').textContent = APP_VERSION;
  $('#storage-info').textContent = '';
  openSheet('sheet-settings');
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) $('#storage-info').textContent = t('settings.storage', { size: fmtBytes(est.usage || 0) });
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ Events

function bindEvents() {
  // Home
  $('#home-scan').onclick = () => openCamera('new');
  $('#home-import').onclick = () => { importTarget = 'new'; $('#file-import').click(); };
  $('#btn-settings').onclick = openSettings;

  // Document
  $('#doc-back').onclick = () => showHome();
  $('#doc-title').onclick = renameDoc;
  $('#doc-menu').onclick = () => openSheet('sheet-docmenu');
  $('#doc-cam').onclick = () => openCamera('current');
  $('#doc-import').onclick = () => { importTarget = 'current'; $('#file-import').click(); };
  $('#doc-sort').onclick = () => { state.sortMode = !state.sortMode; renderDoc(); };
  $('#doc-export').onclick = () => openExport(false);
  $('#page-grid').addEventListener('click', onGridClick);
  $('#dm-rename').onclick = () => { closeSheet('sheet-docmenu'); setTimeout(renameDoc, 280); };
  $('#dm-duplicate').onclick = () => { closeSheet('sheet-docmenu'); duplicateDoc(); };
  $('#dm-delete').onclick = () => { closeSheet('sheet-docmenu'); setTimeout(deleteDoc, 280); };

  // File inputs
  $('#file-import').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    if (importTarget === 'new' || !state.doc) await startNewDoc();
    await importFiles(files);
    await finishAddFlow();
  });
  $('#file-capture').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    stopLive();
    cam.stop();
    if (captureTarget === 'new' || !state.doc) await startNewDoc();
    await importFiles(files);
    if (settings.reviewCrop && files.length === 1 && state.pages.length) {
      await openReview(state.pages[state.pages.length - 1], 'system');
    } else {
      await finishAddFlow();
    }
  });

  // Editor
  $('#ed-back').onclick = closeEditor;
  $('#ed-prev').onclick = () => navEditor(-1);
  $('#ed-next').onclick = () => navEditor(1);
  $('#ed-delete').onclick = deleteCurrentPage;
  $('#ed-toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (!b) return;
    const tool = b.dataset.tool;
    if (tool === 'rotl') rotate(-90);
    else if (tool === 'rotr') rotate(90);
    else if (tool === 'crop') enterCrop();
    else if (tool === 'export') openExport(true);
    else setPane(tool);
  });
  $('#filter-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    const p = curPage();
    if (!b || !p) return;
    p.filter = b.dataset.f;
    syncAdjustUi();
    pageChanged(p);
  });
  $('#filter-all').onclick = () => {
    const p = curPage();
    state.pages.forEach((q) => { if (q !== p && q.filter !== p.filter) { q.filter = p.filter; schedulePersist(q); } });
    toast(t('toast.filterAll', { name: t('filter.' + p.filter) }));
  };
  for (const key of ['brightness', 'contrast']) {
    $('#adj-' + key).addEventListener('input', (e) => {
      const p = curPage();
      p[key] = +e.target.value;
      $('#out-' + key).textContent = p[key];
      pageChanged(p);
    });
  }
  $('#adj-reset').onclick = () => {
    const p = curPage();
    p.brightness = 0; p.contrast = 0;
    syncAdjustUi();
    pageChanged(p);
  };
  $('#adj-all').onclick = () => {
    const p = curPage();
    state.pages.forEach((q) => { if (q !== p) { q.brightness = p.brightness; q.contrast = p.contrast; schedulePersist(q); } });
    toast(t('toast.adjAll'));
  };

  // Swipe between pages
  let sx = null, sy = 0;
  const stage = $('#ed-stage');
  stage.addEventListener('touchstart', (e) => {
    if (state.cropMode || e.touches.length > 1) { sx = null; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) navEditor(dx < 0 ? 1 : -1);
  }, { passive: true });

  // Cropping
  const cc = $('#crop-canvas');
  cc.addEventListener('pointerdown', onCropDown);
  cc.addEventListener('pointermove', onCropMove);
  cc.addEventListener('pointerup', onCropUp);
  cc.addEventListener('pointercancel', onCropUp);
  $('#crop-apply').onclick = applyCrop;
  $('#crop-cancel').onclick = exitCrop;
  $('#crop-auto').onclick = autoCrop;
  $('#review-keep').onclick = reviewKeep;
  $('#review-retake').onclick = reviewRetake;
  $('#crop-full').onclick = () => { state.crop.corners = im.FULL.map((p) => ({ ...p })); drawCrop(); };
  window.addEventListener('resize', () => {
    if (state.cropMode) { layoutCrop(); drawCrop(); }
    if (state.view === 'camera') drawOverlay();
  });

  // Camera
  $('#cam-shutter').onclick = capture;
  $('#cam-done').onclick = closeCamera;
  $('#cam-close').onclick = closeCamera;
  $('#cam-thumb').onclick = () => { if (camCount) closeCamera(); };
  $('#cam-system').onclick = () => { captureTarget = 'current'; $('#file-capture').click(); };
  $('#cam-torch').onclick = async () => {
    torchManual = true;
    state.torch = !state.torch;
    const ok = await cam.setTorch(state.torch);
    if (!ok) state.torch = false;
    $('#cam-torch').classList.toggle('on', state.torch);
  };
  document.addEventListener('visibilitychange', () => {
    if (state.view !== 'camera') return;
    if (document.hidden) { stopLive(); cam.stop(); } else if (!cam.isActive()) startStream();
  });

  // Sheets
  $$('.sheet-backdrop').forEach((b) => b.addEventListener('click', (e) => { if (e.target === b) closeSheet(b.id); }));
  $$('[data-close]').forEach((btn) => { btn.onclick = () => closeSheet(btn.dataset.close); });
  $$('#sheet-export .seg').forEach((s) => s.addEventListener('setting-change', () => { syncExportUi(); prepareExport(); }));
  $('#export-share').onclick = shareExport;
  $('#export-download').onclick = downloadExport;
  $('#set-autodetect').onchange = (e) => { settings.autoDetect = e.target.checked; saveSettings(); };
  $('#set-autotorch').onchange = (e) => { settings.autoTorch = e.target.checked; saveSettings(); };
  $('#set-review').onchange = (e) => { settings.reviewCrop = e.target.checked; saveSettings(); };
  $('#set-stabilize').onchange = (e) => { settings.stabilize = e.target.checked; saveSettings(); };
  $('#set-lang').onchange = (e) => { settings.language = e.target.value; saveSettings(); applyLanguage(); };
}

// ------------------------------------------------------------------ Service Worker

// New versions are installed in the background and activated automatically – but only at a
// safe moment (start/document view, no dialog open, nothing being processed), so a scan or an
// edit in progress is never interrupted. After the reload a short notice is shown.

let pendingWorker = null;
let reloading = false;

function safeToUpdate() {
  return (state.view === 'home' || state.view === 'doc') &&
    !$$('.sheet-backdrop').some((b) => !b.hidden) &&
    $('#busy').hidden && !capturing && !state.review;
}

async function tryApplyUpdate() {
  if (!pendingWorker || reloading || !safeToUpdate()) return;
  reloading = true;
  try { await flushSaves(); } catch { /* ignore */ }
  try { sessionStorage.setItem('app-updated', '1'); } catch { /* ignore */ }
  pendingWorker.postMessage('skipWaiting');
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
    const found = (w) => {
      if (!navigator.serviceWorker.controller) return; // first install – nothing to update
      pendingWorker = w;
      tryApplyUpdate();
    };
    if (reg.waiting) found(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed') found(w); });
    });
    const check = () => reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      check();
      tryApplyUpdate();
    });
    setInterval(check, 30 * 60 * 1000);
  }).catch((e) => console.warn('Service worker not registered', e));

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloading) return;
    location.reload();
  });
}

// ------------------------------------------------------------------ Install banner
// iOS has no API to trigger the "Add to Home Screen" dialog, so we show instructions there.
// Chromium browsers (Android, desktop) fire beforeinstallprompt, which gives us a real install button.

let installEvent = null;
let installMode = null; // 'ios' | 'prompt' | null
const INSTALL_SNOOZE_DAYS = 30;

const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function installSnoozed() {
  try {
    const ts = +localStorage.getItem('install-dismissed') || 0;
    return Date.now() - ts < INSTALL_SNOOZE_DAYS * 864e5;
  } catch { return false; }
}

function renderInstallBanner() {
  const banner = $('#install-banner');
  if (!installMode) {
    banner.hidden = true;
    $('#install-hint').hidden = isStandalone();
    return;
  }
  $('#install-text').innerHTML = installMode === 'ios'
    ? t('install.ios', { share: icon('share', 'inline') })
    : t('install.prompt');
  $('#install-btn').hidden = installMode !== 'prompt';
  banner.hidden = false;
  $('#install-hint').hidden = true;
}

function maybeShowInstall() {
  if (isStandalone() || installSnoozed()) return;
  if (isIOS()) installMode = 'ios'; // iOS browsers can only install via the share menu
  else if (installEvent) installMode = 'prompt';
  renderInstallBanner();
}

function hideInstall(snooze) {
  installMode = null;
  renderInstallBanner();
  if (snooze) { try { localStorage.setItem('install-dismissed', String(Date.now())); } catch { /* ignore */ } }
}

function initInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    maybeShowInstall();
  });
  window.addEventListener('appinstalled', () => { installEvent = null; hideInstall(false); });
  $('#install-close').onclick = () => hideInstall(true);
  $('#install-btn').onclick = async () => {
    if (!installEvent) return;
    installEvent.prompt();
    const choice = await installEvent.userChoice.catch(() => null);
    installEvent = null;
    hideInstall(choice?.outcome !== 'accepted');
  };
  setTimeout(maybeShowInstall, 1200);
}

// ------------------------------------------------------------------ Language

function fillLanguageSelect() {
  const sel = $('#set-lang');
  sel.replaceChildren();
  for (const l of [{ id: 'auto', name: t('settings.langAuto') }, ...LANGUAGES]) {
    const o = document.createElement('option');
    o.value = l.id;
    o.textContent = l.name;
    sel.append(o);
  }
  sel.value = settings.language;
}

function applyLanguage() {
  setLanguage(settings.language);
  applyTranslations();
  fillLanguageSelect();
  if (state.view === 'home') renderHome();
  if (state.doc) renderDoc();
  if (state.view === 'editor') renderFilterThumbs();
  syncExportUi();
  renderInstallBanner();
}

async function init() {
  setLanguage(settings.language);
  applyTranslations();
  fillLanguageSelect();
  hydrateIcons();
  initSegs();
  bindEvents();
  initInstall();
  document.body.dataset.view = state.view;
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  $('#install-hint').hidden = standalone;
  try {
    await renderHome();
  } catch (e) {
    console.error(e);
    toast(t('err.storage', { msg: e.message }), { duration: 8000 });
  }
  registerSW();
  try {
    if (sessionStorage.getItem('app-updated')) {
      sessionStorage.removeItem('app-updated');
      toast(t('update.done', { v: APP_VERSION }));
    }
  } catch { /* ignore */ }
}

init();
