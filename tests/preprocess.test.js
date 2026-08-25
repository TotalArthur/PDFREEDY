#!/usr/bin/env node
/*
 * Tests preprocessForOcr() against a synthetic sheet that reproduces the
 * condition it exists for: a drawing with uneven illumination (scanned or
 * photographed), where no single global cutoff can separate stroke from paper
 * across the whole sheet.
 *
 *   node tests/preprocess.test.js
 */
import { preprocessForOcr, conditionForOcr, illuminationSpread, setCanvasFactory, UNEVEN_FLOOR }
  from '../src/lib/preprocess.js';

const W = 400, H = 300;
const out = {};
function mkCanvas(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  if (fill) fill(data, w, h);
  return {
    width: w, height: h, raw: data,
    getContext: () => ({
      // The real getImageData returns a copy; the stub must too, otherwise the
      // source canvas looks mutated in place and comparisons become meaningless.
      getImageData: () => ({ data: new Uint8ClampedArray(data), width: w, height: h }),
      putImageData: (img) => { out.data = img.data; },
    }),
  };
}
setCanvasFactory(() => mkCanvas(W, H));

// A strong left-to-right illumination gradient (paper 90 -> 240) with strokes
// that are always 60 units darker than their LOCAL background. Strokes on the
// bright side are lighter than paper on the dark side, so the two populations
// overlap and no global threshold can separate them.
const isStrokeAt = (x, y) => (x % 40 >= 18 && x % 40 <= 21) || (y % 50 >= 20 && y % 50 <= 23);
const src = mkCanvas(W, H, (d, w, h) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const bg = 90 + Math.round(150 * x / w);
    const v = isStrokeAt(x, y) ? Math.max(0, bg - 60) : bg;
    const i = (y * w + x) * 4;
    d[i] = d[i+1] = d[i+2] = v; d[i+3] = 255;
  }
});

preprocessForOcr(src);
const res = out.data;

let tp = 0, fp = 0, fn = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const stroke = isStrokeAt(x, y), black = res[(y * W + x) * 4] === 0;
  if (stroke && black) tp++; else if (!stroke && black) fp++; else if (stroke && !black) fn++;
}
const prec = tp / (tp + fp), rec = tp / (tp + fn);
const f1Adaptive = 2 * prec * rec / (prec + rec);
console.log(`adaptive : precision=${(prec*100).toFixed(1)}%  recall=${(rec*100).toFixed(1)}%  (tp=${tp} fp=${fp} fn=${fn})`);

// Baseline: the best global threshold that exists for this image — not a typical
// one, the optimal one, chosen with full knowledge of the ground truth.
const sd = src.raw;
let best = { f1: -1, t: -1, p: 0, r: 0 };
for (let t = 1; t < 255; t++) {
  let a = 0, b = 0, c = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const stroke = isStrokeAt(x, y), black = sd[(y * W + x) * 4] < t;
    if (stroke && black) a++; else if (!stroke && black) b++; else if (stroke && !black) c++;
  }
  if (a === 0) continue;
  const p = a / (a + b), r = a / (a + c), f1 = 2 * p * r / (p + r);
  if (f1 > best.f1) best = { f1, t, p, r };
}
console.log(`global   : precision=${(best.p*100).toFixed(1)}%  recall=${(best.r*100).toFixed(1)}%  (best possible threshold t=${best.t})`);
console.log(`\nF1 adaptive=${f1Adaptive.toFixed(3)}  vs  F1 best-global=${best.f1.toFixed(3)}`);

let fail = 0;

// ---------------------------------------------------------------------------
// Conditioning is chosen from the image, so the choice itself needs testing:
// the measured cost of conditioning an evenly lit page is around nine points of
// recall (bench/README.md), and this is what stops it happening.
const greyOf = (c) => {
  const d = c.raw, n = c.width * c.height, g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j]*77 + d[j+1]*151 + d[j+2]*28) >> 8;
  return g;
};
const flat = mkCanvas(W, H, (d, w, h) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = isStrokeAt(x, y) ? 40 : 235;
    const i = (y * w + x) * 4;
    d[i] = d[i+1] = d[i+2] = v; d[i+3] = 255;
  }
});
const flatSpread = illuminationSpread(greyOf(flat), W, H);
const litSpread = illuminationSpread(greyOf(src), W, H);
console.log(`\nillumination spread: evenly lit=${flatSpread.toFixed(3)}  gradient=${litSpread.toFixed(3)}  (cutoff ${UNEVEN_FLOOR})`);
if (!(flatSpread < UNEVEN_FLOOR)) { console.log('FAIL: an evenly lit sheet was judged uneven'); fail++; }
if (!(litSpread >= UNEVEN_FLOOR)) { console.log('FAIL: a gradient-lit sheet was judged even'); fail++; }
if (conditionForOcr(flat, 'auto') !== flat) { console.log('FAIL: an evenly lit sheet should be handed to OCR untouched'); fail++; }
if (conditionForOcr(src, 'auto') === src) { console.log('FAIL: a gradient-lit sheet should be conditioned'); fail++; }

if (!(prec > 0.95)) { console.log('FAIL: adaptive precision too low'); fail++; }
if (!(rec  > 0.95)) { console.log('FAIL: adaptive recall too low'); fail++; }
if (!(f1Adaptive > best.f1)) { console.log('FAIL: no improvement over a global threshold'); fail++; }
console.log(fail ? `\n${fail} failed` : '\nPASS: adaptive beats the best possible global threshold, and conditioning is applied only where it is needed');
process.exit(fail ? 1 : 0);
