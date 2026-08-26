import { clamp } from './text.js';
import { stripLineArtPlane, hasSidewaysGlyphs } from './lineart.js';

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

/*
 * How unevenly lit is this image?
 *
 * Block means across the sheet, reported as the 10th-to-90th percentile spread
 * relative to the bright end. A flat scan lands near zero; a photographed or
 * curled page, or one lit from one side, lands high. Percentiles rather than
 * min/max so a black title block or a blank margin doesn't decide it.
 *
 * This replaced a variance-of-Laplacian sharpness measure, which was the
 * obvious thing to reach for and turned out to measure the wrong quantity:
 * on the bench corpus the *worst* images scored highest, because sensor noise
 * produces far more Laplacian energy than a crisp edge does. Blur and noise
 * arrive together on real scans, so that metric would have chosen exactly
 * backwards. Illumination spread separates the corpus cleanly — evenly lit
 * conditions 0.10-0.26, unevenly lit ones 0.49-0.54 — which is what a rule can
 * actually be built on.
 */
function illuminationSpread(grey, w, h) {
  const BX = 8, BY = 4, means = [];
  for (let by = 0; by < BY; by++) {
    for (let bx = 0; bx < BX; bx++) {
      const x0 = Math.floor(bx * w / BX), x1 = Math.floor((bx + 1) * w / BX);
      const y0 = Math.floor(by * h / BY), y1 = Math.floor((by + 1) * h / BY);
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += grey[y * w + x]; n++; }
      if (n) means.push(sum / n);
    }
  }
  if (means.length < 4) return 0;
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(means.length * 0.1)];
  const hi = means[Math.floor(means.length * 0.9)];
  return hi <= 1 ? 0 : (hi - lo) / hi;
}

// Above this the page needs its illumination dealt with; below it, conditioning
// only costs. Calibrated on the bench corpus, where the two populations sit far
// enough apart that the exact cutoff isn't delicate.
const UNEVEN_FLOOR = 0.35;

// Luminance plane (integer weights ~ Rec.601), plus the ImageData it came from
// so a caller can write its result back without reading the canvas twice.
function greyPlane(srcCanvas) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const ctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  let img;
  try {
    img = ctx.getImageData(0, 0, w, h);
  } catch (err) {
    console.warn('Preprocessing skipped (canvas read failed):', err);
    return null;
  }
  const px = img.data;
  const n = w * h;
  const data = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    data[i] = (px[j] * 77 + px[j+1] * 151 + px[j+2] * 28) >> 8;
  }
  return { data, w, h, img };
}

/*
 * Walk the image against the mean of each pixel's own neighbourhood, and let
 * the caller decide what to do with the pair.
 *
 * Both conditioning modes need exactly this and nothing else — binarization
 * compares against the mean, flattening subtracts it — so the expensive part is
 * written once. The mean over a square window is separable: a horizontal box
 * mean followed by a vertical one, two O(1)-per-pixel passes and two
 * byte-per-pixel buffers. (A full integral image would be simpler to write, but
 * needs a float per pixel — several hundred MB on an A1 sheet rendered at
 * OCR_SCALE, which is exactly the size of drawing this tool is for.)
 */
function localMeanFilter(srcCanvas, decide) {
  const plane = greyPlane(srcCanvas);
  if (!plane) return srcCanvas;
  const { data: grey, w, h, img } = plane;
  const px = img.data;
  const n = w * h;

  // Window sized to a few character heights at OCR_SCALE, and bounded so the
  // cost stays predictable on very large sheets.
  const radius = clamp(Math.round(Math.min(w, h) / 90), 6, 60);

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
      const v = decide(grey[i], colSum[x] / count);
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

// Bias below the local mean so the antialiasing halo around a stroke is
// dropped rather than fattening the stroke it surrounds.
const BIAS = 0.90;

function preprocessForOcr(srcCanvas) {
  return localMeanFilter(srcCanvas, (v, mean) => (v < mean * BIAS ? 0 : 255));
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

/*
 * Illumination flattening — the non-destructive alternative to thresholding.
 *
 * Binarization exists to deal with uneven lighting, and it does: it beats the
 * best threshold that could possibly exist globally (tests/preprocess.test.js).
 * But on a soft image it also destroys the text, badly — the bench measures
 * handing Tesseract the raw greyscale as worth +8 points overall and five times
 * better on the worst condition (bench/README.md).
 *
 * Both problems have the same source and only one of them needs a threshold.
 * Subtracting the local mean removes the illumination gradient exactly as the
 * adaptive threshold does, but keeps grey levels instead of collapsing them to
 * two — so Tesseract still has the evidence it needs to decide where a soft
 * stroke ends, which is precisely what it is better at than we are.
 */
function flattenIllumination(srcCanvas, gain = 1.6) {
  return localMeanFilter(srcCanvas, (v, mean) => {
    const out = 128 + (v - mean) * gain;
    return out < 0 ? 0 : out > 255 ? 255 : out;
  });
}

/*
 * Pick conditioning from the image rather than applying one recipe to
 * everything.
 *
 * The measured position (bench/README.md) is blunt: on an evenly lit page,
 * every kind of conditioning we can do makes recognition worse, and handing
 * Tesseract the render untouched is worth around nine points of recall. The
 * engine's own thresholding has the whole page and a trained model behind it;
 * ours has a box filter.
 *
 * What we can do that it can't is remove an illumination gradient, because we
 * are allowed to look at the neighbourhood. So that is all this does, and only
 * when there is a gradient to remove.
 */
/*
 * Remove the drawing's own lines from the copy handed to OCR.
 *
 * See lineart.js for why this is not cosmetic: a circle drawn around a tag
 * costs the engine that tag entirely, and a P&ID draws a circle around every
 * instrument on the sheet.
 */
function stripLineArt(srcCanvas) {
  const plane = greyPlane(srcCanvas);
  if (!plane) return srcCanvas;
  const { data: grey, w, h, img } = plane;
  const removed = stripLineArtPlane(grey, img.data, w, h);
  if (!removed) return srcCanvas;
  const out = makeCanvas();
  out.width = w; out.height = h;
  out.getContext('2d').putImageData(img, 0, 0);
  return out;
}

/*
 * Quick pre-check: is it worth running the 90/270 OCR passes on this page at
 * all? See hasSidewaysGlyphs in lineart.js for the reasoning and the
 * conservative bias — this only ever says "found no evidence," never "there
 * is definitely nothing here," and a canvas that can't be read at all is
 * treated the same as "can't rule it out."
 *
 * Takes the already-conditioned, already-line-art-stripped copy handed to
 * OCR (see runOcrForPage) rather than the raw render, so line art doesn't
 * have to be filtered out twice.
 */
function likelySidewaysText(srcCanvas) {
  const plane = greyPlane(srcCanvas);
  if (!plane) return true;
  return hasSidewaysGlyphs(plane.data, plane.w, plane.h);
}

function conditionForOcr(srcCanvas, mode = 'auto') {
  if (mode === 'off') return srcCanvas;
  if (mode === 'binarize') return preprocessForOcr(srcCanvas);
  if (mode === 'flatten') return flattenIllumination(srcCanvas);
  const grey = greyPlane(srcCanvas);
  if (!grey) return srcCanvas;
  if (illuminationSpread(grey.data, grey.w, grey.h) < UNEVEN_FLOOR) return srcCanvas;
  return flattenIllumination(srcCanvas);
}

export { preprocessForOcr, flattenIllumination, conditionForOcr, rotateCanvas,
         stripLineArt, likelySidewaysText, setCanvasFactory, illuminationSpread, UNEVEN_FLOOR };
