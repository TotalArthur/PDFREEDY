import { clamp } from './text.js';

// Canvases are created through a factory so this module can be exercised
// outside a browser (the tests drive it with a plain typed-array stand-in).
let makeCanvas = () => document.createElement('canvas');
function setCanvasFactory(fn) { makeCanvas = fn; }

// =======================================================================
// Pre-OCR image conditioning
//
// A P&ID renders as thin dark strokes on white with almost no mid-tones, but
// antialiasing at render time turns every 1px CAD stroke into a soft grey
// smear. Tesseract's own global (Otsu) threshold then has to pick one cutoff
// for the whole sheet, which either thickens characters until counters fill
// in (8 -> B, 6 -> G) or thins them until strokes break (5 -> S).
//
// Local adaptive thresholding picks a cutoff per pixel from the mean of its
// neighbourhood, computed in O(1) per pixel from an integral image. Character
// strokes stay crisp regardless of what surrounds them, which is exactly the
// condition the confusion classes above arise from.
// =======================================================================
function preprocessForOcr(srcCanvas) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const ctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  let img;
  try {
    img = ctx.getImageData(0, 0, w, h);
  } catch (err) {
    console.warn('Preprocessing skipped (canvas read failed):', err);
    return srcCanvas;
  }
  const px = img.data;
  const n = w * h;

  // Luminance plane (integer weights ~ Rec.601).
  const grey = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    grey[i] = (px[j] * 77 + px[j+1] * 151 + px[j+2] * 28) >> 8;
  }

  // Window sized to a few character heights at OCR_SCALE, and bounded so the
  // cost stays predictable on very large sheets.
  const radius = clamp(Math.round(Math.min(w, h) / 90), 6, 60);
  // Bias below the local mean so the antialiasing halo around a stroke is
  // dropped rather than fattening the stroke it surrounds.
  const BIAS = 0.90;

  // The mean over a square window is separable: a horizontal box mean followed
  // by a vertical one. Done this way it costs two O(1)-per-pixel passes and two
  // byte-per-pixel buffers. (A full integral image would be simpler to write,
  // but needs a float per pixel — several hundred MB on an A1 sheet rendered
  // at OCR_SCALE, which is exactly the size of drawing this tool is for.)
  const hmean = new Uint8Array(n);
  const rowPrefix = new Uint32Array(w + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) rowPrefix[x+1] = rowPrefix[x] + grey[row + x];
    for (let x = 0; x < w; x++) {
      const x0 = x - radius < 0 ? 0 : x - radius;
      const x1 = x + radius >= w ? w - 1 : x + radius;
      hmean[row + x] = (rowPrefix[x1+1] - rowPrefix[x0]) / (x1 - x0 + 1);
    }
  }

  // Vertical pass as a sliding window over whole rows, so memory access stays
  // sequential (a per-column walk over a 50-megapixel buffer thrashes cache).
  const colSum = new Uint32Array(w);
  let top = 0, bottom = -1;
  const addRow = (y) => { const r = y * w; for (let x = 0; x < w; x++) colSum[x] += hmean[r + x]; };
  const subRow = (y) => { const r = y * w; for (let x = 0; x < w; x++) colSum[x] -= hmean[r + x]; };

  for (let y = 0; y < h; y++) {
    const wantTop = y - radius < 0 ? 0 : y - radius;
    const wantBottom = y + radius >= h ? h - 1 : y + radius;
    while (bottom < wantBottom) addRow(++bottom);
    while (top < wantTop) subRow(top++);
    const count = bottom - top + 1;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const v = grey[i] < (colSum[x] / count) * BIAS ? 0 : 255;
      const j = i * 4;
      px[j] = px[j+1] = px[j+2] = v;
      px[j+3] = 255;
    }
  }

  const out = makeCanvas();
  out.width = w; out.height = h;
  out.getContext('2d').putImageData(img, 0, 0);
  return out;
}

function rotateCanvas(srcCanvas, degrees) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const out = makeCanvas();
  const ctx = out.getContext('2d');
  if (degrees === 0) {
    out.width = w; out.height = h;
    ctx.drawImage(srcCanvas, 0, 0);
  } else if (degrees === 180) {
    out.width = w; out.height = h;
    ctx.translate(w, h); ctx.rotate(Math.PI);
    ctx.drawImage(srcCanvas, 0, 0);
  } else if (degrees === 90) {
    out.width = h; out.height = w;
    ctx.translate(h, 0); ctx.rotate(Math.PI/2);
    ctx.drawImage(srcCanvas, 0, 0);
  } else if (degrees === 270) {
    out.width = h; out.height = w;
    ctx.translate(0, w); ctx.rotate(-Math.PI/2);
    ctx.drawImage(srcCanvas, 0, 0);
  }
  return out;
}

// Map a point from a rotated (Cθ) canvas back into the original (C0) canvas.

export { preprocessForOcr, rotateCanvas, setCanvasFactory };
