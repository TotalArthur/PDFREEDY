import { S } from './state.js';
import { markupExportBtn } from './dom.js';

// =======================================================================
// Export: burn stored markups into a real copy of the loaded PDF using
// pdf-lib (global `PDFLib`, loaded via CDN script tag same as pdfjsLib).
//
// Strokes are already stored in PDF-space (see markup.js / geometry.js's
// pdfPointFromCanvas), which is the same coordinate system pdf-lib's
// page.drawLine() expects, so no rescaling is needed here — vector lines
// straight from the stored points, one page at a time.
// =======================================================================

function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 };
}

function deriveExportFilename() {
  const base = (S.fileName || 'drawing.pdf').replace(/\.pdf$/i, '');
  return base + '-markup.pdf';
}

function downloadBlob(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportMarkedUpPdf() {
  if (!S.rawFileBytes) return;
  const origLabel = markupExportBtn.textContent;
  markupExportBtn.disabled = true;
  markupExportBtn.textContent = 'Exporting…';
  try {
    const pdfDoc = await PDFLib.PDFDocument.load(S.rawFileBytes.slice(0));
    const pages = pdfDoc.getPages();
    for (const [pageNum, strokes] of S.markups) {
      if (!strokes.length) continue;
      const page = pages[pageNum - 1];
      if (!page) continue;
      for (const s of strokes) {
        const { r, g, b } = hexToRgb01(s.color);
        for (let i = 1; i < s.points.length; i++) {
          const [x0, y0] = s.points[i - 1];
          const [x1, y1] = s.points[i];
          page.drawLine({
            start: { x: x0, y: y0 },
            end: { x: x1, y: y1 },
            thickness: s.width,
            color: PDFLib.rgb(r, g, b),
            opacity: 1,
            lineCap: PDFLib.LineCapStyle.Round,
          });
        }
      }
    }
    const bytes = await pdfDoc.save();
    downloadBlob(bytes, deriveExportFilename());
  } catch (err) {
    console.error(err);
    alert('Failed to export marked-up PDF: ' + err.message);
  } finally {
    markupExportBtn.textContent = origLabel;
    markupExportBtn.disabled = false;
  }
}

markupExportBtn.addEventListener('click', exportMarkedUpPdf);

export { exportMarkedUpPdf };
