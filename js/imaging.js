// Image processing: loading, perspective correction, filters, rotation, edge detection.
import { t } from './i18n.js';

export const FULL = Object.freeze([
  { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
]);

// ---------------------------------------------------------------- Canvas helpers

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// iOS has a tight canvas memory limit – release canvases that are no longer needed.
export function releaseCanvas(c) {
  if (c) { c.width = 0; c.height = 0; }
}

export function toBlob(c, type = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error(t('img.writeError')))), type, quality);
  });
}

export function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t('img.readError'))); };
    img.src = url;
  });
}

// Step-wise downscaling (halving) for clean results without aliasing.
function drawScaled(src, sw, sh, w, h) {
  let cur = src, cw = sw, ch = sh;
  const temps = [];
  while (cw > w * 2 && ch > h * 2) {
    const nw = Math.max(w, Math.round(cw / 2)), nh = Math.max(h, Math.round(ch / 2));
    const c = canvas(nw, nh);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, nw, nh);
    temps.push(c);
    cur = c; cw = nw; ch = nh;
  }
  const out = canvas(w, h);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  temps.forEach(releaseCanvas);
  return out;
}

// Normalize an imported photo: apply EXIF orientation (done by the browser when decoding),
// limit it to a sensible maximum size and store it as JPEG without metadata.
export async function normalizeImage(blob, maxSide = 3000) {
  const img = await loadImage(blob);
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const s = Math.min(1, maxSide / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * s)), h = Math.max(1, Math.round(ih * s));
  const c = drawScaled(img, iw, ih, w, h);
  const out = await toBlob(c, 'image/jpeg', 0.92);
  releaseCanvas(c);
  return { buffer: await out.arrayBuffer(), width: w, height: h };
}

// ---------------------------------------------------------------- Source image cache

const srcCache = new Map();
const CACHE_MAX = 6;

export async function getSource(page, maxSide, useCache = false) {
  const key = page.id + ':' + maxSide;
  if (useCache && srcCache.has(key)) {
    const v = srcCache.get(key);
    srcCache.delete(key); srcCache.set(key, v); // LRU
    return v;
  }
  const img = await loadImage(new Blob([page.original], { type: 'image/jpeg' }));
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const s = Math.min(1, maxSide / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * s)), h = Math.max(1, Math.round(ih * s));
  const c = drawScaled(img, iw, ih, w, h);
  const data = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
  releaseCanvas(c);
  if (useCache) {
    srcCache.set(key, data);
    while (srcCache.size > CACHE_MAX) srcCache.delete(srcCache.keys().next().value);
  }
  return data;
}

export function forgetSource(pageId) {
  for (const k of [...srcCache.keys()]) if (k.startsWith(pageId + ':')) srcCache.delete(k);
}

// ---------------------------------------------------------------- Geometry

export function isFull(corners) {
  return corners.every((p, i) => Math.abs(p.x - FULL[i].x) < 0.003 && Math.abs(p.y - FULL[i].y) < 0.003);
}

export function quadArea(p) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    a += p[i].x * p[j].y - p[j].x * p[i].y;
  }
  return Math.abs(a) / 2;
}

// Sort corners into the order top-left, top-right, bottom-right, bottom-left.
export function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const s = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let k = 0;
  for (let i = 1; i < 4; i++) if (s[i].x + s[i].y < s[k].x + s[k].y) k = i;
  return [0, 1, 2, 3].map((j) => ({ x: s[(k + j) % 4].x, y: s[(k + j) % 4].y }));
}

// Normalized coordinates original <-> display (for a clockwise rotation by rot degrees).
export function toDisplay(p, rot) {
  switch (rot) {
    case 90: return { x: 1 - p.y, y: p.x };
    case 180: return { x: 1 - p.x, y: 1 - p.y };
    case 270: return { x: p.y, y: 1 - p.x };
    default: return { x: p.x, y: p.y };
  }
}

export function fromDisplay(p, rot) {
  switch (rot) {
    case 90: return { x: p.y, y: 1 - p.x };
    case 180: return { x: 1 - p.x, y: 1 - p.y };
    case 270: return { x: 1 - p.y, y: p.x };
    default: return { x: p.x, y: p.y };
  }
}

// Draws src rotated into a rectangle of the (already rotated) size dw x dh.
export function drawRotated(ctx, src, rot, dw, dh) {
  ctx.save();
  switch (rot) {
    case 90: ctx.translate(dw, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(src, 0, 0, dh, dw); break;
    case 180: ctx.translate(dw, dh); ctx.rotate(Math.PI); ctx.drawImage(src, 0, 0, dw, dh); break;
    case 270: ctx.translate(0, dh); ctx.rotate(-Math.PI / 2); ctx.drawImage(src, 0, 0, dh, dw); break;
    default: ctx.drawImage(src, 0, 0, dw, dh);
  }
  ctx.restore();
}

function solve(A, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    const d = A[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / d;
      if (!f) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

// Homography mapping the points "from" onto "to".
export function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [X, Y] = to[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  return solve(A, b);
}

// Perspective correction: warp a quadrilateral of src onto a rectangle (bilinear interpolation).
export function warp(src, corners, maxOut) {
  const { width: sw, height: sh, data: sd } = src;
  const q = corners.map((p) => [p.x * sw, p.y * sh]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  let h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const s = Math.min(1, maxOut / Math.max(w, h));
  w = Math.max(1, Math.round(w * s));
  h = Math.max(1, Math.round(h * s));
  const H = homography([[0, 0], [w, 0], [w, h], [0, h]], q);
  const out = new ImageData(w, h);
  const od = out.data;
  const maxX = sw - 1, maxY = sh - 1;
  let o = 0;
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5;
    for (let x = 0; x < w; x++, o += 4) {
      const xc = x + 0.5;
      const d = H[6] * xc + H[7] * yc + 1;
      let fx = (H[0] * xc + H[1] * yc + H[2]) / d - 0.5;
      let fy = (H[3] * xc + H[4] * yc + H[5]) / d - 0.5;
      if (fx < 0) fx = 0; else if (fx > maxX) fx = maxX;
      if (fy < 0) fy = 0; else if (fy > maxY) fy = maxY;
      const x0 = fx | 0, y0 = fy | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
      const ax = fx - x0, ay = fy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * ax;
        const bot = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * ax;
        od[o + c] = top + (bot - top) * ay;
      }
      od[o + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------- Filter

// Estimate background (paper) brightness on a coarse grid. Dark text is removed by a
// maximum filter so that shadows and uneven lighting can be compensated.
function backgroundGrid(px, w, h, stride, ch) {
  const bs = Math.max(4, Math.ceil(Math.max(w, h) / 40));
  const gw = Math.ceil(w / bs), gh = Math.ceil(h / bs);
  const sum = new Float64Array(gw * gh * ch), cnt = new Float64Array(gw * gh);
  const colB = new Int32Array(w);
  for (let x = 0; x < w; x++) colB[x] = (x / bs) | 0;
  for (let y = 0; y < h; y++) {
    const rowBase = ((y / bs) | 0) * gw;
    let i = y * w * stride;
    for (let x = 0; x < w; x++, i += stride) {
      const g = rowBase + colB[x];
      cnt[g]++;
      const o = g * ch;
      for (let c = 0; c < ch; c++) sum[o + c] += px[i + c];
    }
  }
  let grid = new Float32Array(gw * gh * ch);
  for (let g = 0; g < gw * gh; g++) for (let c = 0; c < ch; c++) grid[g * ch + c] = sum[g * ch + c] / (cnt[g] || 1);
  for (let k = 0; k < 3; k++) grid = gridFilter(grid, gw, gh, ch, true);
  grid = gridFilter(grid, gw, gh, ch, false);
  return { grid, gw, gh, bs };
}

// Maximum filter (isMax) or mean filter on the grid. For color, the maximum takes the
// brightest neighbour (by luminance) as a whole, so no color fringes appear.
function gridFilter(g, gw, gh, ch, isMax) {
  const o = new Float32Array(g.length);
  const lum = (k) => (ch === 3 ? g[k] * 0.299 + g[k + 1] * 0.587 + g[k + 2] * 0.114 : g[k]);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (isMax) {
        let bestK = (y * gw + x) * ch, bestL = lum(bestK);
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= gh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= gw) continue;
            const k = (yy * gw + xx) * ch, l = lum(k);
            if (l > bestL) { bestL = l; bestK = k; }
          }
        }
        for (let c = 0; c < ch; c++) o[(y * gw + x) * ch + c] = g[bestK + c];
        continue;
      }
      for (let c = 0; c < ch; c++) {
        let m = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= gh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= gw) continue;
            m += g[(yy * gw + xx) * ch + c];
            n++;
          }
        }
        o[(y * gw + x) * ch + c] = m / n;
      }
    }
  }
  return o;
}

function gridXs(G, w) {
  const { gw, bs } = G;
  const x0 = new Int32Array(w), x1 = new Int32Array(w), wx = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let f = (x + 0.5) / bs - 0.5;
    if (f < 0) f = 0; else if (f > gw - 1) f = gw - 1;
    x0[x] = f | 0;
    x1[x] = Math.min(gw - 1, x0[x] + 1);
    wx[x] = f - x0[x];
  }
  return { x0, x1, wx };
}

function bgRow(G, xs, y, w, ch, out) {
  const { grid, gw, gh, bs } = G;
  let fy = (y + 0.5) / bs - 0.5;
  if (fy < 0) fy = 0; else if (fy > gh - 1) fy = gh - 1;
  const y0 = fy | 0, y1 = Math.min(gh - 1, y0 + 1), wy = fy - y0;
  const r0 = y0 * gw, r1 = y1 * gw;
  for (let x = 0; x < w; x++) {
    const a0 = (r0 + xs.x0[x]) * ch, a1 = (r0 + xs.x1[x]) * ch;
    const b0 = (r1 + xs.x0[x]) * ch, b1 = (r1 + xs.x1[x]) * ch;
    const wx = xs.wx[x];
    for (let c = 0; c < ch; c++) {
      const top = grid[a0 + c] + (grid[a1 + c] - grid[a0 + c]) * wx;
      const bot = grid[b0 + c] + (grid[b1 + c] - grid[b0 + c]) * wx;
      out[x * ch + c] = top + (bot - top) * wy;
    }
  }
}

export function applyFilter(imgData, { filter = 'original', brightness = 0, contrast = 0 } = {}) {
  const { width: w, height: h, data: d } = imgData;
  const N = w * h;

  if (filter === 'enhanced') {
    // "Magic color": even out lighting, white-balance on paper, boost contrast + saturation.
    const G = backgroundGrid(d, w, h, 4, 3);
    const xs = gridXs(G, w);
    const row = new Float32Array(w * 3);
    for (let y = 0; y < h; y++) {
      bgRow(G, xs, y, w, 3, row);
      let i = y * w * 4;
      for (let x = 0, k = 0; x < w; x++, i += 4, k += 3) {
        const r = 255 - (255 - (d[i] * 255) / Math.max(row[k], 24)) * 1.35;
        const g = 255 - (255 - (d[i + 1] * 255) / Math.max(row[k + 1], 24)) * 1.35;
        const b = 255 - (255 - (d[i + 2] * 255) / Math.max(row[k + 2], 24)) * 1.35;
        const l = (r + g + b) / 3;
        d[i] = l + (r - l) * 1.25;
        d[i + 1] = l + (g - l) * 1.25;
        d[i + 2] = l + (b - l) * 1.25;
      }
    }
  } else if (filter === 'gray') {
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  } else if (filter === 'bw') {
    // Black/white: even out lighting, then binarize with a threshold.
    const L = new Uint8ClampedArray(N);
    for (let p = 0, i = 0; p < N; p++, i += 4) L[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const G = backgroundGrid(L, w, h, 1, 1);
    const xs = gridXs(G, w);
    const row = new Float32Array(w);
    const T = 200 - brightness * 0.7;
    for (let y = 0; y < h; y++) {
      bgRow(G, xs, y, w, 1, row);
      for (let x = 0, p = y * w, i = p * 4; x < w; x++, p++, i += 4) {
        const v = (L[p] * 255) / Math.max(row[x], 24);
        d[i] = d[i + 1] = d[i + 2] = v < T ? 0 : 255;
      }
    }
    return imgData;
  }

  if (brightness || contrast) {
    const C = contrast * 1.28;
    const f = (259 * (C + 255)) / (255 * (259 - C));
    const B = brightness * 1.28;
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = f * (v - 128) + 128 + B;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
    }
  }
  return imgData;
}

// ---------------------------------------------------------------- Render page

// Komplette Pipeline: Quelle -> Entzerren -> Filter -> Drehen. Liefert ein Canvas.
export async function renderPage(page, outMax, { cache = false } = {}) {
  const corners = page.corners || FULL;
  const full = isFull(corners);
  const srcMax = full ? outMax : Math.min(4000, Math.round(outMax * 1.3));
  const src = await getSource(page, srcMax, cache);
  let img;
  if (full) img = cache ? new ImageData(new Uint8ClampedArray(src.data), src.width, src.height) : src;
  else img = warp(src, corners, outMax);
  applyFilter(img, page);

  const t = canvas(img.width, img.height);
  t.getContext('2d').putImageData(img, 0, 0);
  const rot = page.rotation || 0;
  if (!rot) return t;
  const rw = rot % 180 ? img.height : img.width;
  const rh = rot % 180 ? img.width : img.height;
  const c = canvas(rw, rh);
  drawRotated(c.getContext('2d'), t, rot, rw, rh);
  releaseCanvas(t);
  return c;
}

// ---------------------------------------------------------------- Edge detection

function blur(g, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w) { s += g[y * w + xx]; n++; }
      }
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; n++; }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

// Finds the largest bright area (paper on a darker background) and its four corners.
// Returns null if no plausible document was found.
export async function detectCorners(page) {
  const src = await getSource(page, 360, false);
  const { width: w, height: h, data: d } = src;
  const N = w * h;
  let g = new Uint8ClampedArray(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  g = blur(g, w, h, 2);

  // Otsu threshold
  const hist = new Uint32Array(256);
  for (let i = 0; i < N; i++) hist[g[i]]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = N - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }

  // Largest connected bright component
  const visited = new Uint8Array(N);
  const queue = new Int32Array(N);
  let comp = null;
  for (let s = 0; s < N; s++) {
    if (visited[s] || g[s] <= thr) continue;
    let head = 0, tail = 0, count = 0;
    let minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
    let tl = s, tr = s, br = s, bl = s;
    queue[tail++] = s; visited[s] = 1;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w, y = (p / w) | 0;
      count++;
      const sm = x + y, df = x - y;
      if (sm < minS) { minS = sm; tl = p; }
      if (sm > maxS) { maxS = sm; br = p; }
      if (df > maxD) { maxD = df; tr = p; }
      if (df < minD) { minD = df; bl = p; }
      if (x > 0) { const q = p - 1; if (!visited[q] && g[q] > thr) { visited[q] = 1; queue[tail++] = q; } }
      if (x < w - 1) { const q = p + 1; if (!visited[q] && g[q] > thr) { visited[q] = 1; queue[tail++] = q; } }
      if (y > 0) { const q = p - w; if (!visited[q] && g[q] > thr) { visited[q] = 1; queue[tail++] = q; } }
      if (y < h - 1) { const q = p + w; if (!visited[q] && g[q] > thr) { visited[q] = 1; queue[tail++] = q; } }
    }
    if (!comp || count > comp.count) comp = { count, tl, tr, br, bl };
  }
  if (!comp) return null;

  const pts = [comp.tl, comp.tr, comp.br, comp.bl].map((p) => ({
    x: Math.min(1, Math.max(0, ((p % w) + 0.5) / w)),
    y: Math.min(1, Math.max(0, (((p / w) | 0) + 0.5) / h)),
  }));
  const areaFrac = comp.count / N;
  const qa = quadArea(pts);
  if (areaFrac < 0.12 || areaFrac > 0.97) return null;
  if (qa < 0.12 || qa > 0.985) return null;
  if (areaFrac / qa < 0.85) return null; // area is not a quadrilateral
  if (isFull(pts)) return null;
  return orderCorners(pts);
}
