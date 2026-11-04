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

// True if the quad (in order) is convex, i.e. a valid frame.
export function isConvex(p) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4], c = p[(i + 2) % 4];
    const cr = Math.sign((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x));
    if (!cr || (sign && cr !== sign)) return false;
    sign = cr;
  }
  return true;
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

// Estimates the real width/height ratio of a rectangle photographed in perspective
// (Zhang & He, "Whiteboard scanning and image enhancement"). q = [TL, TR, BR, BL] in pixels,
// W/H = size of the full (uncropped) photo, whose center is assumed to be the optical center.
export function estimateAspect(q, W, H) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const naive = (d(q[0], q[1]) + d(q[3], q[2])) / Math.max(1e-6, d(q[0], q[3]) + d(q[1], q[2]));
  const m1 = [q[0][0], q[0][1], 1], m2 = [q[1][0], q[1][1], 1];
  const m3 = [q[3][0], q[3][1], 1], m4 = [q[2][0], q[2][1], 1];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c14 = cross(m1, m4);
  const k2 = dot(c14, m3) / dot(cross(m2, m4), m3);
  const k3 = dot(c14, m2) / dot(cross(m3, m4), m2);
  if (!isFinite(k2) || !isFinite(k3)) return snapAspect(naive);
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const u0 = W / 2, v0 = H / 2, big = Math.max(W, H);

  // Focal length: phone main cameras have f ≈ 0.75–0.95 × the long image side. The value estimated
  // from the quad is very sensitive to corner errors, so it is only trusted within a plausible
  // range and averaged (geometrically) with that prior.
  const prior = 0.82 * big;
  let f = prior;
  const den = n2[2] * n3[2];
  if (Math.abs(den) > 1e-12) {
    const f2 = -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + den * u0 * u0) +
      (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + den * v0 * v0)) / den;
    const est = f2 > 0 ? Math.sqrt(f2) : 0;
    if (est > 0.6 * big && est < 1.2 * big) f = Math.sqrt(est * prior);
  }
  const len2 = (n) => {
    const a = (n[0] - u0 * n[2]) / f, b = (n[1] - v0 * n[2]) / f, c = n[2];
    return a * a + b * b + c * c;
  };
  const ratio = Math.sqrt(len2(n2) / len2(n3));
  if (!isFinite(ratio) || ratio / naive > 1.6 || naive / ratio > 1.6) return snapAspect(naive);
  return snapAspect(ratio);
}

// Snap to common paper formats (A4/A-series, US Letter) when very close.
function snapAspect(r) {
  for (const t of [Math.SQRT1_2, Math.SQRT2, 8.5 / 11, 11 / 8.5]) if (Math.abs(r / t - 1) < 0.035) return t;
  return Math.min(5, Math.max(0.2, r));
}

// Perspective correction: warp a quadrilateral of src onto a rectangle (bilinear interpolation).
export function warp(src, corners, maxOut) {
  const { width: sw, height: sh, data: sd } = src;
  const q = corners.map((p) => [p.x * sw, p.y * sh]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const top = dist(q[0], q[1]), bottom = dist(q[3], q[2]);
  const left = dist(q[0], q[3]), right = dist(q[1], q[2]);
  // Keep roughly the pixel area of the source, but use the real (perspective-corrected) aspect ratio.
  const area = Math.max(top, bottom) * Math.max(left, right);
  const ratio = estimateAspect(q, sw, sh);
  let w = Math.sqrt(area * ratio);
  let h = Math.sqrt(area / ratio);
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

// Mean brightness of the estimated paper background (0..255).
function paperLevel(G, ch) {
  let s = 0;
  const n = G.gw * G.gh;
  for (let g = 0; g < n; g++) {
    s += ch === 3 ? G.grid[g * 3] * 0.299 + G.grid[g * 3 + 1] * 0.587 + G.grid[g * 3 + 2] * 0.114 : G.grid[g];
  }
  return s / n;
}

// Separable box blur, in place, on `ch` channels of an interleaved buffer with the given stride.
function boxBlurInterleaved(px, w, h, stride, ch, r) {
  const tmp = new Float32Array(w * h * ch);
  const k = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < ch; c++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += px[(y * w + Math.min(w - 1, Math.max(0, x))) * stride + c];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * ch + c] = acc / k;
        const xo = Math.max(0, x - r), xi = Math.min(w - 1, x + r + 1);
        acc += px[(y * w + xi) * stride + c] - px[(y * w + xo) * stride + c];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < ch; c++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[(Math.min(h - 1, Math.max(0, y)) * w + x) * ch + c];
      for (let y = 0; y < h; y++) {
        px[(y * w + x) * stride + c] = acc / k;
        const yo = Math.max(0, y - r), yi = Math.min(h - 1, y + r + 1);
        acc += tmp[(yi * w + x) * ch + c] - tmp[(yo * w + x) * ch + c];
      }
    }
  }
}

export function applyFilter(imgData, { filter = 'original', brightness = 0, contrast = 0 } = {}) {
  const { width: w, height: h, data: d } = imgData;
  const N = w * h;

  if (filter === 'enhanced') {
    // "Magic color": even out lighting, white-balance on paper, boost contrast + saturation.
    let G = backgroundGrid(d, w, h, 4, 3);
    // In low light the paper is dark and the strong gain would amplify sensor noise: denoise first.
    if (paperLevel(G, 3) < 125) {
      boxBlurInterleaved(d, w, h, 4, 3, paperLevel(G, 3) < 80 ? 2 : 1);
      G = backgroundGrid(d, w, h, 4, 3);
    }
    const xs = gridXs(G, w);
    const row = new Float32Array(w * 3);
    for (let y = 0; y < h; y++) {
      bgRow(G, xs, y, w, 3, row);
      let i = y * w * 4;
      for (let x = 0, k = 0; x < w; x++, i += 4, k += 3) {
        const r = 255 - (255 - (d[i] * 255) / Math.max(row[k], 48)) * 1.35;
        const g = 255 - (255 - (d[i + 1] * 255) / Math.max(row[k + 1], 48)) * 1.35;
        const b = 255 - (255 - (d[i + 2] * 255) / Math.max(row[k + 2], 48)) * 1.35;
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
    let G = backgroundGrid(L, w, h, 1, 1);
    // Smoothing before thresholding avoids grainy output; stronger in low light.
    boxBlurInterleaved(L, w, h, 1, 1, paperLevel(G, 1) < 100 ? 2 : 1);
    G = backgroundGrid(L, w, h, 1, 1);
    const xs = gridXs(G, w);
    const row = new Float32Array(w);
    const T = 200 - brightness * 0.7;
    const B = new Uint8Array(N); // 1 = black
    for (let y = 0; y < h; y++) {
      bgRow(G, xs, y, w, 1, row);
      for (let x = 0, p = y * w; x < w; x++, p++) {
        B[p] = (L[p] * 255) / Math.max(row[x], 40) < T ? 1 : 0;
      }
    }
    // Remove isolated specks (black pixels with at most one black neighbour).
    for (let y = 0, p = 0; y < h; y++) {
      for (let x = 0; x < w; x++, p++) {
        let black = B[p];
        if (black && x > 0 && y > 0 && x < w - 1 && y < h - 1) {
          const n = B[p - 1] + B[p + 1] + B[p - w] + B[p + w] + B[p - w - 1] + B[p - w + 1] + B[p + w - 1] + B[p + w + 1];
          if (n <= 1) black = 0;
        }
        const i = p * 4;
        d[i] = d[i + 1] = d[i + 2] = black ? 0 : 255;
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
//
// Pipeline (works on a ~400 px preview):
//  1. Two feature images: luminance and "whiteness" (min of R,G,B – paper is bright AND grey,
//     while wooden/coloured tables are not). Both are denoised, more strongly in low light.
//  2. Otsu threshold -> morphological opening (removes noise and thin bridges) -> largest region.
//  3. Convex hull of the region outline -> simplified to the 4-gon with the largest area.
//  4. Each side is refined with a least-squares line fit through the outline pixels near it;
//     the corners are the intersections of these lines.
//  5. Plausibility checks (convex, sensible angles, region fills the quad, size).
// The candidate with the best score wins; null if nothing plausible is found.

function blur(g, w, h, r) {
  const out = Float32Array.from(g);
  boxBlurInterleaved(out, w, h, 1, 1, r);
  return out;
}

function otsu(g) {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[Math.max(0, Math.min(255, g[i] | 0))]++;
  const N = g.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = -1, thr = 127;
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
  return thr;
}

function morph(mask, w, h, dilate) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1;
      for (let dy = -1; dy <= 1 && v === (dilate ? 0 : 1); dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const m = mask[yy * w + xx];
          if (dilate ? m : !m) { v = dilate ? 1 : 0; break; }
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function largestRegion(mask, w, h) {
  const N = w * h;
  const label = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  let best = -1, bestCount = 0, id = 0;
  for (let s = 0; s < N; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    let head = 0, tail = 0;
    queue[tail++] = s; label[s] = id;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      if (x > 0 && mask[p - 1] && label[p - 1] < 0) { label[p - 1] = id; queue[tail++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && label[p + 1] < 0) { label[p + 1] = id; queue[tail++] = p + 1; }
      if (p >= w && mask[p - w] && label[p - w] < 0) { label[p - w] = id; queue[tail++] = p - w; }
      if (p < N - w && mask[p + w] && label[p + w] < 0) { label[p + w] = id; queue[tail++] = p + w; }
    }
    if (tail > bestCount) { bestCount = tail; best = id; }
    id++;
  }
  if (best < 0) return null;
  const xs = [], ys = [];
  for (let p = 0; p < N; p++) {
    if (label[p] !== best) continue;
    const x = p % w, y = (p / w) | 0;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
      label[p - 1] !== best || label[p + 1] !== best || label[p - w] !== best || label[p + w] !== best) {
      xs.push(x + 0.5); ys.push(y + 0.5);
    }
  }
  return { count: bestCount, xs, ys };
}

function convexHull(xs, ys) {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b] || ys[a] - ys[b]);
  const cr = (o, a, b) => (xs[a] - xs[o]) * (ys[b] - ys[o]) - (ys[a] - ys[o]) * (xs[b] - xs[o]);
  const lower = [], upper = [];
  for (const i of idx) {
    while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1)).map((i) => [xs[i], ys[i]]);
}

// Repeatedly drop the hull vertex whose removal loses the least area until 4 remain.
function hullToQuad(hull) {
  const pts = hull.slice();
  const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  while (pts.length > 4) {
    let mi = 0, ma = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = tri(pts[(i - 1 + pts.length) % pts.length], pts[i], pts[(i + 1) % pts.length]);
      if (a < ma) { ma = a; mi = i; }
    }
    pts.splice(mi, 1);
  }
  return pts.length === 4 ? pts : null;
}

// Fit a line through outline pixels close to each side and intersect neighbouring lines.
function refineQuad(quad, xs, ys, diag) {
  const tol = Math.max(2, diag * 0.02);
  const lines = quad.map((a, k) => {
    const b = quad[(k + 1) % 4];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L;
    let n = 0, mx = 0, my = 0;
    const sel = [];
    for (let i = 0; i < xs.length; i++) {
      const px = xs[i] - a[0], py = ys[i] - a[1];
      const t = px * ux + py * uy;
      if (t < L * 0.1 || t > L * 0.9) continue;
      if (Math.abs(px * uy - py * ux) > tol) continue;
      sel.push(i); mx += xs[i]; my += ys[i]; n++;
    }
    if (n < 8) return { px: a[0], py: a[1], dx: ux, dy: uy };
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const i of sel) {
      const ex = xs[i] - mx, ey = ys[i] - my;
      sxx += ex * ex; syy += ey * ey; sxy += ex * ey;
    }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { px: mx, py: my, dx: Math.cos(ang), dy: Math.sin(ang) };
  });
  return quad.map((orig, k) => {
    const l1 = lines[(k + 3) % 4], l2 = lines[k];
    const det = l1.dx * l2.dy - l1.dy * l2.dx;
    if (Math.abs(det) < 1e-6) return orig;
    const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / det;
    const p = [l1.px + t * l1.dx, l1.py + t * l1.dy];
    return Math.hypot(p[0] - orig[0], p[1] - orig[1]) > diag * 0.06 ? orig : p;
  });
}

function quadOk(q, w, h) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const sg = Math.sign(cr);
    if (!sg || (sign && sg !== sign)) return false;
    sign = sg;
    const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
    const deg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (deg < 40 || deg > 140) return false;
  }
  for (const p of q) if (p[0] < -0.02 * w || p[0] > 1.02 * w || p[1] < -0.02 * h || p[1] > 1.02 * h) return false;
  return true;
}

export function meanLuminance(img) {
  const d = img.data;
  let s = 0;
  for (let i = 0; i < d.length; i += 16) s += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  return s / (d.length / 16);
}

/**
 * Detects a document in an ImageData (ideally ~300–400 px).
 * @returns {{corners: {x:number,y:number}[], score: number} | null} normalized corners TL,TR,BR,BL
 */
export function detectQuad(img) {
  const { width: w, height: h, data: d } = img;
  const N = w * h, diag = Math.hypot(w, h);
  const lum = new Float32Array(N), white = new Float32Array(N);
  let mean = 0;
  for (let p = 0, i = 0; p < N; p++, i += 4) {
    lum[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    white[p] = Math.min(d[i], d[i + 1], d[i + 2]);
    mean += lum[p];
  }
  mean /= N;
  const r = mean < 70 ? 3 : 2; // stronger denoising in low light

  let best = null;
  for (const f of [blur(lum, w, h, r), blur(white, w, h, r)]) {
    const thr = otsu(f);
    let mask = new Uint8Array(N);
    let brightSum = 0, darkSum = 0, nb = 0;
    for (let p = 0; p < N; p++) {
      if (f[p] > thr) { mask[p] = 1; brightSum += f[p]; nb++; } else darkSum += f[p];
    }
    // Paper must be clearly brighter than its surroundings.
    if (!nb || nb === N || brightSum / nb - darkSum / (N - nb) < 18) continue;
    mask = morph(morph(mask, w, h, false), w, h, false);
    mask = morph(morph(mask, w, h, true), w, h, true);
    const reg = largestRegion(mask, w, h);
    if (!reg || reg.count < N * 0.08 || reg.xs.length < 20) continue;
    const hull = convexHull(reg.xs, reg.ys);
    let quad = hull.length >= 4 ? hullToQuad(hull) : null;
    if (!quad) continue;
    quad = refineQuad(quad, reg.xs, reg.ys, diag);
    if (!quadOk(quad, w, h)) continue;
    const qa = quadArea(quad.map((p) => ({ x: p[0], y: p[1] })));
    const fill = reg.count / qa;
    const areaFrac = qa / N;
    if (fill < 0.82 || fill > 1.2 || areaFrac < 0.08 || areaFrac > 0.985) continue;
    const score = (1 - Math.abs(1 - fill)) * (0.6 + 0.4 * Math.min(1, areaFrac / 0.5));
    if (!best || score > best.score) best = { quad, score };
  }
  if (!best) return null;
  const corners = orderCorners(best.quad.map((p) => ({
    x: Math.min(1, Math.max(0, p[0] / w)),
    y: Math.min(1, Math.max(0, p[1] / h)),
  })));
  if (isFull(corners)) return null;
  return { corners, score: best.score };
}

export async function detectCorners(page) {
  const src = await getSource(page, 400, false);
  return detectQuad(src)?.corners || null;
}
