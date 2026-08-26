import { S } from './state.js';
import { findWindowMatches } from '../lib/windows.js';
import { conditionForOcr, rotateCanvas, stripLineArt, likelySidewaysText } from '../lib/preprocess.js';
import { mapBoxBack, readingAxis, boundsOfPoints } from '../lib/geometry.js';
import { OCR_SCALE, JOIN_GAP_FACTOR, MAX_WINDOW, ROTATIONS, SIDEWAYS_ROTATIONS, OCR_POOL_SIZE, TESSERACT_INIT, tesseractParams } from './config.js';
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
async function createOcrWorker() {
  // The 4th argument is the init config — see TESSERACT_INIT for why the
  // dictionary flags have to go there and not through setParameters.
  const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {}, TESSERACT_INIT);
  await worker.setParameters(tesseractParams(Tesseract.PSM));
  return worker;
}

// A scheduler with up to OCR_POOL_SIZE workers so independent recognize()
// calls — a page's separate rotation passes, or separate pages in the
// background queue — actually run on separate cores instead of queueing
// behind one worker.
//
// Only the first worker is awaited here; it costs exactly what the single
// shared worker used to cost, so a short document (the common case — most
// pages take one pass) starts its first recognize() no slower than before
// this pool existed. The rest of the pool spins up in the background and
// joins the scheduler as each worker finishes initializing (wasm compile +
// model load), so a document with enough work to actually benefit from more
// workers still gets them, without every document paying to cold-start
// OCR_POOL_SIZE workers up front for OCR it may only ever do one pass of.
async function ensureOcrScheduler() {
  if (!S.ocrScheduler) {
    const scheduler = Tesseract.createScheduler();
    S.ocrScheduler = scheduler;
    scheduler.addWorker(await createOcrWorker());
    for (let i = 1; i < OCR_POOL_SIZE; i++) {
      createOcrWorker().then(worker => {
        // A document loaded (or cleared) while this worker was still coming
        // up replaces S.ocrScheduler — joining the old, discarded one would
        // leak a worker nothing will ever terminate.
        if (S.ocrScheduler === scheduler) scheduler.addWorker(worker);
        else worker.terminate().catch(() => {});
      });
    }
  }
  return S.ocrScheduler;
}

async function runOcrForPage(pageNum, onProgress) {
  const epoch = S.docEpoch;
  const data = S.pageData.get(pageNum);

  // Landscape-only by default: a single pass at the page's native orientation
  // is ~4x faster. "Also scan rotated/vertical text" opts into the rest for
  // drawings with vertical line labels, at that time cost. Only the passes this
  // page hasn't already had are run, so ticking the box after a document has
  // been read costs the three missing rotations and not a re-read.
  const wanted = rotatedTextToggle.checked ? ROTATIONS : ROTATIONS.slice(0, 1);
  const alreadyRun = data.ocrRotations || [];
  let rotations = wanted.filter(deg => !alreadyRun.includes(deg));
  if (!rotations.length) return data;

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

  // Conditioning is chosen from the image, not applied blindly. A crisp vector
  // render thresholds well; a soft scan does not, and thresholding it destroys
  // the very strokes OCR needs. See bench/README.md.
  // Then the drawing's own strokes come off. A P&ID rings every instrument tag
  // with a circle, and Tesseract returns NOTHING for text inside one — see
  // lineart.js. Done once here rather than per rotation, since the strokes are
  // the same whichever way up the page is read.
  const ocrBase = stripLineArt(conditionForOcr(base));

  // Brute-forcing all four rotations is the safe default, not a free one —
  // 90/270 only earn their cost on the minority of pages that actually have
  // something drawn sideways. A quick read of this page's own glyphs (see
  // likelySidewaysText) decides whether they're worth it here; see
  // SIDEWAYS_ROTATIONS for why 0/180 are never gated by it.
  if (rotations.some(deg => SIDEWAYS_ROTATIONS.includes(deg)) && !likelySidewaysText(ocrBase)) {
    const before = rotations.length;
    rotations = rotations.filter(deg => !SIDEWAYS_ROTATIONS.includes(deg));
    console.debug('Skipping 90/270 OCR on page', pageNum,
      '— no sideways text detected (' + (before - rotations.length) + ' pass(es) skipped)');
  }
  if (!rotations.length) return data;

  const W = base.width, H = base.height;
  const allWords = [];   // flattened, coordinates already mapped back to C0 space
  const completed = [];  // rotations that actually finished, so a cancelled pass is retried

  // A cancel/skip/new-document that landed while this page was still waiting
  // its turn in the queue means don't even start — but once we do start, all
  // of this page's rotations are dispatched together (see below), so there is
  // no later "in-between passes" point to bail out at.
  if (S.processingCancelled || data.skipRequested || epoch !== S.docEpoch) return data;

  const scheduler = await ensureOcrScheduler();

  // Every rotation this page still needs is queued on the pool at once rather
  // than run one at a time on a single worker — with OCR_POOL_SIZE workers
  // available, a 4-pass "also scan rotated text" run costs roughly one pass'
  // wall time instead of four. Promise.all preserves input order regardless
  // of completion order, so `passes` still lines up with `rotations`.
  let finished = 0;
  onProgress(0, rotations.length);
  const passes = await Promise.all(rotations.map(async (deg) => {
    const rotated = deg === 0 ? ocrBase : rotateCanvas(ocrBase, deg);
    try {
      const result = await scheduler.addJob('recognize', rotated);
      return { deg, result };
    } catch (err) {
      console.warn('OCR pass failed', pageNum, deg, err);
      return null;
    } finally {
      finished++;
      onProgress(finished, rotations.length);
    }
  }));

  for (const pass of passes) {
    if (!pass) continue;
    const { deg, result } = pass;
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
    completed.push(deg);
  }

  // Appended, not replaced: a top-up run only holds the rotations that were
  // missing, and the words from the earlier pass are still good.
  // array of { rotation, words:[{text,bbox,confidence,rotation}] }
  data.ocrLines = (data.ocrLines || []).concat(allWords);
  data.ocrRotations = alreadyRun.concat(completed);
  return data;
}

function searchOcr(pageNum, query) {
  const data = S.pageData.get(pageNum);
  if (!data || !data.ocrLines) return [];
  const results = [];

  for (const line of data.ocrLines) {
    // Words read in a rotated pass are kept once found, but they are only
    // searched while the box that asked for them is ticked — otherwise
    // unticking it would leave results on screen that it can't explain.
    if (line.rotation !== 0 && !rotatedTextToggle.checked) continue;
    // rs/re/rh are already on each word from readingAxis(), so vertical and
    // upside-down passes join and order exactly like horizontal ones.
    // conf is what Tesseract reported for the word, 0..1. A word it read at 0%
    // is an admission, not an assertion, and the matcher prices it that way.
    const items = line.words.map((w, i) => ({
      key: i, text: w.text, rs: w.rs, re: w.re, rh: w.rh,
      conf: Math.max(0, Math.min(1, (w.confidence || 0) / 100)), word: w,
    }));

    for (const hit of findWindowMatches(items, query, {
      maxWindow: MAX_WINDOW, gapFactor: JOIN_GAP_FACTOR, join: ' ',
      transform: getCorrection,
    })) {
      const win = hit.items.map(it => it.word);
      const b = boundsOfPoints(win.flatMap(w => [[w.bbox.x0,w.bbox.y0],[w.bbox.x1,w.bbox.y1]]));
      const avgConf = win.reduce((s,w)=>s+w.confidence,0) / win.length;
      results.push({
        page: pageNum, source: 'ocr', text: hit.text, rawText: hit.rawText,
        corrected: hit.corrected,
        bbox: { x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY },
        confidence: avgConf,
        whole: hit.match.whole,
        fuzzy: hit.match.fuzzy, confused: hit.match.confused,
        matchPos: hit.match.pos, matchLen: hit.match.len,
        cost: hit.match.cost, subs: hit.match.subs, indels: hit.match.indels,
        unknowns: hit.match.unknowns,
        contextChars: hit.contextChars, contextConf: hit.contextConf,
        matchConf: hit.matchConf, delimited: hit.delimited
      });
    }
  }
  return results;
}

export {
  ensureOcrScheduler,
  runOcrForPage,
  searchOcr,
};
