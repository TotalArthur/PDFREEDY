import { S } from './state.js';
import { normalize } from '../lib/text.js';
import { matchWindow } from '../lib/matching.js';
import { preprocessForOcr, rotateCanvas } from '../lib/preprocess.js';
import { mapBoxBack, readingAxis, boundsOfPoints } from '../lib/geometry.js';
import { OCR_SCALE, JOIN_GAP_FACTOR, MAX_WINDOW } from './config.js';
import { getPageProxy } from './pdf.js';
import { getCorrection } from './corrections.js';
import {
  rotatedTextToggle,
} from './dom.js';

// =======================================================================
// OCR fallback (4-rotation-pass) — coordinate remapping between rotated
// canvases and the "normal" (0deg) page canvas is done with plain pixel
// math since rotations are exact 90deg multiples.
// =======================================================================
async function ensureOcrWorker() {
  if (!S.ocrWorker) {
    S.ocrWorker = await Tesseract.createWorker('eng');
    await S.ocrWorker.setParameters({
      // P&ID sheets are mostly line art with sparse, scattered labels, not
      // paragraphs — SPARSE_TEXT skips Tesseract's column/block layout
      // analysis (the slow, and on a drawing often wrong, part of the
      // default "fully automatic" mode) and just hunts for text directly.
      tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
      // Narrowing the character set cuts down on stray-symbol noise (stuff
      // like "=", "©", "•" picked up from line art) and measurably helps
      // both accuracy and decoding speed for tag-style text.
      // Uppercase only. Every comparison in this tool runs through normalize(),
      // which upper-cases anyway, so a lowercase alphabet can never help a match
      // — it only gives the decoder extra ways to be wrong (picking 'l' over '1',
      // 'o' over '0'). Removing it strictly shrinks the error space.
      tessedit_char_whitelist:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/.,:()#&+ ",
      // Tag callouts are standalone strings, not prose — Tesseract's built-in
      // English dictionary can only drag a correct read toward a real word.
      load_system_dawg: '0',
      load_freq_dawg: '0',
    });
  }
  return S.ocrWorker;
}

async function runOcrForPage(pageNum, onProgress) {
  const epoch = S.docEpoch;
  const data = S.pageData.get(pageNum);
  const page = await getPageProxy(pageNum);
  const viewport = page.getViewport({ scale: OCR_SCALE });

  const base = document.createElement('canvas');
  base.width = Math.ceil(viewport.width);
  base.height = Math.ceil(viewport.height);
  const baseCtx = base.getContext('2d');
  await page.render({ canvasContext: baseCtx, viewport }).promise;

  // Thumbnails show the real drawing, so they keep the clean render; only the
  // copy handed to Tesseract is binarized.
  data.thumbCanvas = base;
  data.thumbScale = OCR_SCALE;

  const ocrBase = preprocessForOcr(base);

  const W = base.width, H = base.height;
  // Landscape-only by default: a single pass at the page's native orientation
  // is ~4x faster. "Also scan rotated/vertical text" opts back into the full
  // 4-pass sweep for drawings with vertical line labels, at that time cost.
  const rotations = rotatedTextToggle.checked ? [0, 90, 180, 270] : [0];
  const allWords = [];   // flattened, coordinates already mapped back to C0 space
  const worker = await ensureOcrWorker();

  for (let i = 0; i < rotations.length; i++) {
    if (S.processingCancelled || S.skipCurrentPageRequested || epoch !== S.docEpoch) break;
    const deg = rotations[i];
    onProgress(i+1, rotations.length);

    const rotated = deg === 0 ? ocrBase : rotateCanvas(ocrBase, deg);
    let result;
    try {
      result = await worker.recognize(rotated);
    } catch (err) {
      console.warn('OCR pass failed', pageNum, deg, err);
      continue;
    }
    const lines = (result.data && result.data.lines) || [];
    for (const line of lines) {
      const mappedWords = [];
      for (const w of (line.words || [])) {
        const text = (w.text || '').trim();
        if (!text) continue;
        const mapped = mapBoxBack(w.bbox, deg, W, H);
        mappedWords.push({
          text, bbox: mapped, confidence: w.confidence, rotation: deg,
          ...readingAxis(mapped, deg)
        });
      }
      if (mappedWords.length) {
        // Sort along the direction the text is READ, not along page-x. For the
        // 90/180/270 passes a word's reading order maps to a decreasing or
        // perpendicular axis once its box is projected back into page space, so
        // sorting by x0 (as a horizontal-only reader would) silently scrambles
        // the words of every rotated tag before they are ever joined.
        mappedWords.sort((a,b) => a.rs - b.rs);
        allWords.push({ rotation: deg, words: mappedWords });
      }
    }
  }

  data.ocrLines = allWords; // array of { rotation, words:[{text,bbox,confidence,rotation}] }
  return data;
}

function searchOcr(pageNum, query) {
  const data = S.pageData.get(pageNum);
  if (!data || !data.ocrLines) return [];
  const results = [];

  for (const line of data.ocrLines) {
    const words = line.words;
    const covered = new Set();
    for (let winSize = 1; winSize <= MAX_WINDOW; winSize++) {
      for (let start = 0; start + winSize <= words.length; start++) {
        const win = words.slice(start, start + winSize);
        const wIdxs = win.map((_,k) => start+k);
        if (wIdxs.some(i => covered.has(i))) continue;

        if (winSize > 1) {
          let tooFar = false;
          for (let k=0;k<win.length-1;k++) {
            const a = win[k], b = win[k+1];
            // Measured along the reading axis, so this is the true inter-word
            // gap for vertical and upside-down text as well as horizontal.
            const gap = b.rs - a.re;
            if (gap > a.rh * JOIN_GAP_FACTOR) { tooFar = true; break; }
          }
          if (tooFar) continue;
        }

        const rawText = win.map(w => w.text).join(win.length>1 ? ' ' : '');
        // A saved correction replaces what OCR *thought* it read, so this
        // window is matched (and displayed) as the tag it really is.
        const fixed = getCorrection(rawText);
        const text = fixed || rawText;
        const norm = normalize(text);
        if (!norm) continue;

        const m = matchWindow(norm, query);
        if (!m) continue;

        wIdxs.forEach(i => covered.add(i));
        const b = boundsOfPoints(win.flatMap(w => [[w.bbox.x0,w.bbox.y0],[w.bbox.x1,w.bbox.y1]]));
        const avgConf = win.reduce((s,w)=>s+w.confidence,0) / win.length;
        results.push({
          page: pageNum, source: 'ocr', text, rawText,
          corrected: !!fixed,
          bbox: { x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY },
          confidence: avgConf,
          fuzzy: m.fuzzy, confused: m.confused, matchPos: m.pos, matchLen: m.len
        });
      }
    }
  }
  return results;
}

export {
  ensureOcrWorker,
  runOcrForPage,
  searchOcr,
};
