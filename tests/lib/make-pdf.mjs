/*
 * A minimal PDF writer — just enough to produce a one-or-more page document
 * with a real text layer, so the end-to-end test has something to open.
 * Drawings are confidential and .pdf is gitignored, so fixtures are generated,
 * never committed.
 */
function esc(s) { return s.replace(/([\\()])/g, '\\$1'); }

// A stroked circle, as four Béziers — a P&ID's instrument bubble. Text drawn
// inside one used to be invisible to OCR (src/lib/lineart.js), so the fixtures
// need to be able to draw it.
const K = 0.5523;
function circleOps({ x, y, r, width = 1 }) {
  const k = r * K;
  return `${width} w\n` +
    `${x + r} ${y} m\n` +
    `${x + r} ${y + k} ${x + k} ${y + r} ${x} ${y + r} c\n` +
    `${x - k} ${y + r} ${x - r} ${y + k} ${x - r} ${y} c\n` +
    `${x - r} ${y - k} ${x - k} ${y - r} ${x} ${y - r} c\n` +
    `${x + k} ${y - r} ${x + r} ${y - k} ${x + r} ${y} c\nS`;
}

// A stroked polyline — the vector "pipe" a page's operator list exposes for
// the auto-trace feature (src/lib/vectorlines.js) to walk.
function lineOps({ points, width = 2 }) {
  const [first, ...rest] = points;
  return `${width} w\n${first[0]} ${first[1]} m\n` +
    rest.map(([x, y]) => `${x} ${y} l\n`).join('') + 'S';
}

// pages: [[ {text, x, y, size?} | {circle: {x, y, r, width?}} | {image: {x, y, w, h}} | {line: {points, width?}}, ... ], ...]
//
// The image is a single grey pixel stretched over a rectangle. It carries no
// information — its job is to make the page look like a scan, because a page
// holding any raster image is routed to OCR however much real text it also has
// (see pageHasImage). That is the only way a fixture can exercise the pixel
// path with more than a handful of characters on the page.
export function makePdf(pages, { width = 612, height = 792 } = {}) {
  const objs = [];      // 1-indexed object bodies
  const add = (body) => { objs.push(body); return objs.length; };

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const imageId = add('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 ' +
    '/ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\xf4\nendstream');
  const pageIds = [];
  const pagesIdPlaceholder = objs.length + 1 + pages.length * 2; // filled below

  for (const items of pages) {
    const ops = items.map(it => {
      if (it.circle) return circleOps(it.circle);
      if (it.line) return lineOps(it.line);
      if (it.image) return `q ${it.image.w} 0 0 ${it.image.h} ${it.image.x} ${it.image.y} cm /Im0 Do Q`;
      return `BT /F1 ${it.size || 12} Tf ${it.x} ${it.y} Td (${esc(it.text)}) Tj ET`;
    }).join('\n');
    const streamId = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    pageIds.push(add(
      `<< /Type /Page /Parent ${pagesIdPlaceholder} 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> /XObject << /Im0 ${imageId} 0 R >> >> ` +
      `/Contents ${streamId} 0 R >>`));
  }
  const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map(i => i + ' 0 R').join(' ')}] /Count ${pages.length} >>`);
  if (pagesId !== pagesIdPlaceholder) throw new Error('page tree id mismatch');
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
