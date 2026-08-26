/*
 * Take the drawing's lines off the copy handed to OCR.
 *
 * A P&ID says what an instrument is by drawing a circle around its tag. That
 * circle costs the tool every tag inside it: Tesseract reads
 *
 *   SDZIO 35202  SDZIC 35202  SDV 35202  ...      -> every one of them
 *   (the same text, each inside a bubble)          -> nothing at all
 *
 * Not "reads them badly" — returns no words for that region whatsoever, so no
 * amount of confusion-tolerant matching downstream can recover them. A square
 * box around the same text is harmless (Tesseract's layout analysis knows about
 * rule lines); a circle or an arc is not, and a P&ID is made of circles. That
 * is how a tag stamped on a sheet eight times comes back with one match — the
 * one occurrence that happened to sit in a rectangle.
 *
 * Since the engine cannot be told to ignore the curve, the curve is removed
 * before it ever sees it. Line art and text separate cleanly by shape, not by
 * position: a stroke is large and hollow (a 200px ring encloses mostly paper),
 * a character is small and solid. So each connected run of ink is measured and
 * erased only if it is BOTH bigger than any character on the sheet AND too
 * sparse to be one.
 *
 * The sheet calibrates the rule itself — "bigger than any character" is
 * measured from the components actually present, because a glyph at OCR_SCALE
 * on an A1 sheet and one on a letter-size page are nothing like the same size
 * in pixels.
 */

// A component must exceed this multiple of the sheet's own character height
// before its size counts against it.
const SIZE_FACTOR = 3.5;
// ...and fill no more than this share of its own bounding box. A ring, an arc,
// a pipe and a border are all far below it; a solid glyph is far above.
const MAX_FILL = 0.34;
// Long and thin is line art whatever its size — a pipe run, a leader, a border.
const THIN_ASPECT = 8;
// Specks (JPEG grain, dotted-line dashes) are too small to say anything about
// character size, so they don't get a vote in the median.
const MIN_GLYPH_PIXELS = 12;
// If a page is mostly ink, this is not a line drawing and the shape rule has
// nothing to say about it. Leave it alone.
const MAX_INK_SHARE = 0.35;

/*
 * Ink mask, by Otsu's threshold over the luminance histogram.
 *
 * A global cutoff is the right tool here and a local one would be wrong: this
 * decides which pixels belong to the same STROKE, not which pixels are text.
 * An adaptive threshold breaks a long line into fragments wherever the local
 * background shifts, and a fragmented line is exactly what this must not see.
 */
function inkMask(grey, n) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[grey[i]]++;

  let total = 0;
  for (let v = 0; v < 256; v++) total += hist[v] * v;
  let sumB = 0, wB = 0, best = 0, cut = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB, mF = (total - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; cut = v; }
  }

  const mask = new Uint8Array(n);
  let ink = 0;
  for (let i = 0; i < n; i++) if (grey[i] <= cut) { mask[i] = 1; ink++; }
  return { mask, ink };
}

/*
 * Walk every connected run of ink once, reporting each to `visit` as
 * (bbox, pixelCount, pixels). `pixels` is a scratch buffer reused between
 * components — a caller that needs to keep it must copy it.
 *
 * Iterative on purpose: a single stroke on a large sheet is hundreds of
 * thousands of pixels, and the recursive form of this blows the stack long
 * before it finishes a border line.
 */
function eachComponent(mask, w, h, visit) {
  const n = w * h;
  let stack = new Int32Array(1024);
  let pixels = new Int32Array(1024);

  for (let seed = 0; seed < n; seed++) {
    if (mask[seed] !== 1) continue;
    let sp = 0, count = 0;
    stack[sp++] = seed;
    mask[seed] = 2;
    let minX = w, minY = h, maxX = -1, maxY = -1;

    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (count === pixels.length) {
        const grown = new Int32Array(pixels.length * 2);
        grown.set(pixels); pixels = grown;
      }
      pixels[count++] = i;

      // 8-connected: a diagonal CAD stroke is one line, not a dotted trail.
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (mask[j] !== 1) continue;
          mask[j] = 2;
          if (sp === stack.length) {
            const grown = new Int32Array(stack.length * 2);
            grown.set(stack); stack = grown;
          }
          stack[sp++] = j;
        }
      }
    }
    visit({ minX, minY, maxX, maxY, count, pixels });
  }
}

// The height of a typical character on this sheet, taken as the median height
// of everything that isn't a speck. Robust by construction: a drawing has far
// more glyph components than it has strokes, and the median doesn't care how
// extreme the strokes are.
function medianGlyphHeight(heights) {
  if (!heights.length) return 0;
  heights.sort((a, b) => a - b);
  return heights[heights.length >> 1];
}

function isLineArt(c, glyphHeight) {
  const w = c.maxX - c.minX + 1, h = c.maxY - c.minY + 1;
  const long = Math.max(w, h), short = Math.min(w, h);
  // Nothing character-sized is ever touched, whatever its shape. This is the
  // rule that keeps a hyphen, an I, or a bracket in a tag safe: they are small,
  // and small is never line art.
  if (long <= SIZE_FACTOR * glyphHeight) return false;
  // Long and narrow: a pipe run, a leader, a border, a rule under a title.
  if (long >= THIN_ASPECT * short) return true;
  // Big and hollow: a ring, an ESD diamond, an equipment outline. A glyph this
  // large would be solid.
  return c.count / (w * h) <= MAX_FILL;
}

/*
 * Erase the drawing's strokes from `grey`/`px` in place, leaving the text.
 * Returns how many components were removed, so callers can report that nothing
 * was found rather than implying work was done.
 */
function stripLineArtPlane(grey, px, w, h) {
  const n = w * h;
  const { mask, ink } = inkMask(grey, n);
  if (!ink || ink > n * MAX_INK_SHARE) return 0;

  // Pass one: measure the sheet. Only the shape of each component is kept, so
  // this costs a few numbers per component rather than a label per pixel — an
  // A1 sheet at OCR_SCALE has tens of millions of those.
  const heights = [];
  const boxes = [];
  eachComponent(mask, w, h, (c) => {
    boxes.push({ minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY, count: c.count });
    if (c.count >= MIN_GLYPH_PIXELS) heights.push(c.maxY - c.minY + 1);
  });
  const glyphHeight = medianGlyphHeight(heights);
  if (!glyphHeight) return 0;

  const doomed = new Set();
  for (let i = 0; i < boxes.length; i++) if (isLineArt(boxes[i], glyphHeight)) doomed.add(i);
  if (!doomed.size) return 0;

  // Pass two: walk the same components in the same order and white out the
  // ones that were condemned. The mask was consumed by the first pass, so it is
  // rebuilt — cheaper than having carried every component's pixels through.
  const { mask: mask2 } = inkMask(grey, n);
  let idx = 0;
  eachComponent(mask2, w, h, (c) => {
    if (doomed.has(idx++)) {
      for (let k = 0; k < c.count; k++) {
        const i = c.pixels[k];
        grey[i] = 255;
        const j = i * 4;
        px[j] = px[j+1] = px[j+2] = 255;
        px[j+3] = 255;
      }
    }
  });
  return doomed.size;
}

/*
 * Is there any text on this (already line-art-stripped) page that looks
 * drawn on its side?
 *
 * A rotated glyph is the same glyph with its bounding box's width and height
 * swapped, so a component that is wider than it is tall — where the sheet's
 * OTHER glyphs are not — is what a character looks like once the drawing
 * rotates it 90 degrees. That is a cheap, glyph-level read of the page's own
 * pixels, not a guess about the drawing: it needs the line art gone first (a
 * pipe run or a border is plenty "wide", for reasons that have nothing to do
 * with text), which is exactly what has already happened by the time OCR
 * calls this — see runOcrForPage.
 *
 * The threshold below is measured, not assumed: rendered on an actual sheet,
 * this font's upright glyphs came out at 1.03-1.54 (taller than wide, often
 * not by much), and the SAME glyphs rotated 90 degrees came out at 0.64-0.97
 * — the reciprocal range, not a dramatically different one. A cutoff much
 * below 1 (0.6 was tried first) missed most of that range and rarely fired
 * on real rotated text at all; 0.85 clears every upright ratio measured with
 * room to spare and still catches the rotated ones short of the one letter
 * that happened to land right at "square."
 *
 * Used to decide whether the 90/270 OCR passes are worth running at all, so
 * it is deliberately loose in the direction that keeps them running: one
 * wide component (a hyphen, a line-art fragment the shape rule let through)
 * proves nothing and doesn't count, but it takes very little genuine sideways
 * text to trip MIN_SIDEWAYS_COMPONENTS, and finding none is never treated as
 * proof there isn't any — only as "no evidence turned up."
 */
const SIDEWAYS_ASPECT = 0.85;       // height less than this x width -> on its side
const MIN_SIDEWAYS_COMPONENTS = 2;  // one wide component doesn't count; it's noise
// A punctuation mark (a hyphen, a colon) is wide regardless of which way the
// text around it runs, and a real P&ID tag is full of them — "PT-9042"
// stamped on six bubbles is twelve wide hyphens with no rotation involved.
// What tells a hyphen apart from a rotated character is size, not shape:
// rotating a glyph swaps its width and height but can't change how much ink
// it's made of, so a wide component has to hold at least this much of a
// typical glyph's own pixel count before it counts as evidence.
const MIN_SIDEWAYS_SIZE_FRACTION = 0.5;

function hasSidewaysGlyphs(grey, w, h) {
  const { mask, ink } = inkMask(grey, w * h);
  if (!ink) return false;

  const glyphs = [];
  eachComponent(mask, w, h, (c) => {
    if (c.count < MIN_GLYPH_PIXELS) return;
    glyphs.push({ w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1, count: c.count });
  });
  if (!glyphs.length) return false;
  const counts = glyphs.map(g => g.count).sort((a, b) => a - b);
  const sizeFloor = counts[counts.length >> 1] * MIN_SIDEWAYS_SIZE_FRACTION;

  let sideways = 0;
  for (const g of glyphs) {
    if (g.count < sizeFloor) continue;
    if (g.h / g.w < SIDEWAYS_ASPECT) sideways++;
  }
  return sideways >= MIN_SIDEWAYS_COMPONENTS;
}

export { stripLineArtPlane, isLineArt, inkMask, eachComponent, hasSidewaysGlyphs,
         SIZE_FACTOR, MAX_FILL, THIN_ASPECT, MAX_INK_SHARE,
         SIDEWAYS_ASPECT, MIN_SIDEWAYS_COMPONENTS };
