// Minimal PDF writer: embeds JPEG images (DCTDecode) as pages. No dependencies.

const enc = new TextEncoder();

export const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

const num = (n) => (Math.round(n * 100) / 100).toString();

function pdfDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Text as UTF-16BE hex string (supports non-ASCII characters in the title).
function pdfText(s) {
  let hex = 'FEFF';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0');
      hex += (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else {
      hex += cp.toString(16).padStart(4, '0');
    }
  }
  return `<${hex.toUpperCase()}>`;
}

/**
 * @param {{data: Uint8Array, width: number, height: number}[]} images JPEG-Daten
 * @param {{pageSize?: 'a4'|'letter'|'fit', title?: string}} opts
 * @returns {Blob}
 */
export function buildPdf(images, { pageSize = 'a4', title = 'Scan' } = {}) {
  const parts = [];
  const offsets = [];
  let offset = 0;
  const push = (x) => {
    const u = typeof x === 'string' ? enc.encode(x) : x;
    parts.push(u);
    offset += u.length;
  };
  const obj = (n, body) => {
    offsets[n] = offset;
    push(`${n} 0 obj\n`);
    body();
    push('\nendobj\n');
  };

  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // %PDF-1.4 + binary marker

  const n = images.length;
  const pageObj = (i) => 4 + i * 3;
  const kids = images.map((_, i) => `${pageObj(i)} 0 R`).join(' ');

  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`));
  obj(3, () => push(`<< /Title ${pdfText(title)} /Producer (Scan-App PWA) /CreationDate (${pdfDate()}) >>`));

  images.forEach((img, i) => {
    const iw = img.width, ih = img.height;
    let pw, ph, dw, dh, x, y;
    if (pageSize === 'fit' || !PAGE_SIZES[pageSize]) {
      const s = 841.89 / Math.max(iw, ih);
      pw = dw = iw * s; ph = dh = ih * s; x = 0; y = 0;
    } else {
      [pw, ph] = PAGE_SIZES[pageSize];
      if (iw > ih) [pw, ph] = [ph, pw]; // landscape
      const s = Math.min(pw / iw, ph / ih);
      dw = iw * s; dh = ih * s;
      x = (pw - dw) / 2; y = (ph - dh) / 2;
    }
    const content = `q ${num(dw)} 0 0 ${num(dh)} ${num(x)} ${num(y)} cm /Im0 Do Q`;
    const p = pageObj(i);
    obj(p, () => push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pw)} ${num(ph)}] ` +
      `/Resources << /XObject << /Im0 ${p + 2} 0 R >> /ProcSet [/PDF /ImageC] >> /Contents ${p + 1} 0 R >>`,
    ));
    obj(p + 1, () => {
      push(`<< /Length ${enc.encode(content).length} >>\nstream\n`);
      push(content);
      push('\nendstream');
    });
    obj(p + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${img.data.length} >>\nstream\n`);
      push(img.data);
      push('\nendstream');
    });
  });

  const size = 4 + n * 3;
  const xref = offset;
  let xr = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) xr += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(xr);
  push(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return new Blob(parts, { type: 'application/pdf' });
}
