/*
 * A minimal PDF writer — just enough to produce a one-or-more page document
 * with a real text layer, so the end-to-end test has something to open.
 * Drawings are confidential and .pdf is gitignored, so fixtures are generated,
 * never committed.
 */
function esc(s) { return s.replace(/([\\()])/g, '\\$1'); }

// pages: [[ {text, x, y, size?}, ... ], ...]
export function makePdf(pages, { width = 612, height = 792 } = {}) {
  const objs = [];      // 1-indexed object bodies
  const add = (body) => { objs.push(body); return objs.length; };

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];
  const pagesIdPlaceholder = objs.length + 1 + pages.length * 2; // filled below

  for (const items of pages) {
    const ops = items.map(it =>
      `BT /F1 ${it.size || 12} Tf ${it.x} ${it.y} Td (${esc(it.text)}) Tj ET`).join('\n');
    const streamId = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    pageIds.push(add(
      `<< /Type /Page /Parent ${pagesIdPlaceholder} 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamId} 0 R >>`));
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
