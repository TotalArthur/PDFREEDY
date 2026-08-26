#!/usr/bin/env node
/*
 * Tests the line-art stripper against the condition it exists for: a tag drawn
 * inside an instrument bubble, which Tesseract reads as nothing at all.
 *
 * The measurement that matters is an OCR one and lives in the bench and the e2e
 * test (a six-bubble sheet reports 0 of 6 occurrences without this, 6 of 6 with
 * it). What is checked here is the part that has to be right for that to be
 * safe: the ring goes, and the characters — including the small, thin, hollow
 * ones a shape rule could plausibly mistake for a stroke — stay.
 *
 *   node tests/lineart.test.js
 */
import { stripLineArtPlane, isLineArt } from '../src/lib/lineart.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// ---------------------------------------------------------------------------
// The rule itself, on measurements taken from a sheet whose characters are 20px
// tall.
const GLYPH = 20;
const box = (w, h, count) => ({ minX: 0, minY: 0, maxX: w - 1, maxY: h - 1, count });

console.log('\nWhat counts as line art');
check('an instrument bubble: big and hollow',
  isLineArt(box(200, 200, 200 * 4), GLYPH));
check('a pipe run: long and narrow',
  isLineArt(box(1400, 3, 1400 * 3), GLYPH));
check('a sheet border', isLineArt(box(2000, 1400, (2000 + 1400) * 2 * 3), GLYPH));
check('a character is not, however hollow it is',
  !isLineArt(box(12, GLYPH, 40), GLYPH));
check('nor a tall bracket beside one',
  !isLineArt(box(4, GLYPH * 2, 100), GLYPH));
check('nor a hyphen, which is narrow and short',
  !isLineArt(box(9, 3, 27), GLYPH));
check('a large SOLID shape is left alone — only hollow ones are strokes',
  !isLineArt(box(200, 200, 200 * 200 * 0.8), GLYPH));

// ---------------------------------------------------------------------------
// End to end on a synthetic sheet: a ring with characters inside it.
console.log('\nA tag inside a bubble');
const W = 300, H = 200;
const grey = new Uint8Array(W * H).fill(255);
const px = new Uint8ClampedArray(W * H * 4).fill(255);
const ink = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  grey[y * W + x] = 0;
  const j = (y * W + x) * 4;
  px[j] = px[j+1] = px[j+2] = 0; px[j+3] = 255;
};

// The bubble: a ring of radius 70 around the middle of the sheet.
for (let a = 0; a < 3600; a++) {
  const t = a * Math.PI / 1800;
  for (let r = 70; r < 72; r++) ink(Math.round(150 + r * Math.cos(t)), Math.round(100 + r * Math.sin(t)));
}
// Five 20px-tall characters inside it, as solid blocks with a hole — close
// enough to a glyph's shape for the fill rule, and separate components.
const glyphPixels = [];
for (let g = 0; g < 5; g++) {
  const x0 = 115 + g * 14, y0 = 90;
  for (let y = y0; y < y0 + 20; y++) {
    for (let x = x0; x < x0 + 10; x++) {
      const edge = (x === x0 || x === x0 + 9 || y === y0 || y === y0 + 19);
      if (edge || (y - y0) === 10) { ink(x, y); glyphPixels.push(y * W + x); }
    }
  }
}
const ringPixels = [];
for (let i = 0; i < W * H; i++) if (grey[i] === 0 && !glyphPixels.includes(i)) ringPixels.push(i);

const removed = stripLineArtPlane(grey, px, W, H);
check('the stripper found something to remove', removed > 0, String(removed));
check('the bubble is gone', ringPixels.every(i => grey[i] === 255),
  ringPixels.filter(i => grey[i] !== 255).length + ' ring pixels left');
check('every character inside it survives', glyphPixels.every(i => grey[i] === 0),
  glyphPixels.filter(i => grey[i] !== 0).length + ' glyph pixels erased');
check('the RGBA plane was updated alongside the luminance plane',
  ringPixels.every(i => px[i * 4] === 255) && glyphPixels.every(i => px[i * 4] === 0));

// A page with nothing but text must come back untouched, so this can never be
// the reason a plain page reads worse.
console.log('\nA page with no line art on it');
const grey2 = new Uint8Array(W * H).fill(255);
const px2 = new Uint8ClampedArray(W * H * 4).fill(255);
for (const i of glyphPixels) {
  grey2[i] = 0;
  px2[i * 4] = px2[i * 4 + 1] = px2[i * 4 + 2] = 0; px2[i * 4 + 3] = 255;
}
const before = Uint8Array.from(grey2);
check('nothing is removed', stripLineArtPlane(grey2, px2, W, H) === 0);
check('and the image is unchanged', grey2.every((v, i) => v === before[i]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
