import { S } from './state.js';
import { scoreResult } from '../lib/evidence.js';
import { normalize } from '../lib/text.js';
import { itemQuadCanvas, boundsOfPoints } from '../lib/geometry.js';
import { searchTextLayer } from './textlayer.js';
import { searchOcr } from './ocr.js';
import { getPageProxy } from './pdf.js';
import { renderResultsList } from './results.js';
import { drawHighlights } from './viewer.js';
import {
  searchInput,
  searchBtn,
  exactToggle,
  fuzzyToggle,
  searchSummary,
  resultsCount,
} from './dom.js';

// =======================================================================
// Search
// =======================================================================
function searchPage(pageNum, query) {
  const d = S.pageData.get(pageNum);
  if (!d) return [];
  // A page can have both a (possibly sparse) real text layer and OCR data
  // (see pageHasImage) — search whichever of the two are present.
  let results = [];
  if (d.lineGroups) results = results.concat(searchTextLayer(pageNum, query));
  if (d.ocrLines) results = results.concat(searchOcr(pageNum, query));
  return results;
}

function searchablePages() {
  const pages = [];
  for (let p = 1; p <= S.numPages; p++) {
    const d = S.pageData.get(p);
    if (!d) continue;
    if (d.status === 'text-done' || d.status === 'ocr-done' || d.status === 'skipped') pages.push(p);
  }
  return pages;
}

/*
 * Order by how well each hit is evidenced, not by where it happens to sit in
 * the document.
 *
 * Page order put an 87%-confident wrong answer above a corroborated right one,
 * which is how a genuine find ended up looking like one guess among three.
 */
function rank(results) {
  for (const r of results) {
    const { score, reasons } = scoreResult(r);
    r.score = score;
    r.reasons = reasons;
  }
  return results.sort((a, b) => (b.score - a.score) || (a.page - b.page));
}

/*
 * A page can carry both a real text layer and OCR (pageHasImage forces OCR
 * even where some real text also exists — see textlayer.js), so the same
 * physical tag can legitimately be found twice: once via each method. That's
 * not two occurrences, it's one occurrence read two ways, so it should only
 * ever appear once in the results list. But a P&ID can also legitimately
 * stamp the same tag number in several different places on a page (an
 * instrument bubble and a line callout, say) — those ARE distinct
 * occurrences and must not be collapsed. The difference is position: only
 * drop a hit when it sits on top of another hit for the same tag, not
 * whenever the text matches.
 */
async function boxFor(pageNum, result, viewport) {
  const data = S.pageData.get(pageNum);
  if (result.source === 'text') {
    const pts = result.itemIndices.flatMap(idx => itemQuadCanvas(data.textItems[idx], viewport));
    return boundsOfPoints(pts);
  }
  const ratio = viewport.scale / data.thumbScale;
  return {
    minX: result.bbox.x0 * ratio, minY: result.bbox.y0 * ratio,
    maxX: result.bbox.x1 * ratio, maxY: result.bbox.y1 * ratio,
  };
}

function overlapFraction(a, b) {
  const ix = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const iy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  if (ix <= 0 || iy <= 0) return 0;
  const areaA = (a.maxX - a.minX) * (a.maxY - a.minY);
  const areaB = (b.maxX - b.minX) * (b.maxY - b.minY);
  return (ix * iy) / Math.max(1, Math.min(areaA, areaB));
}

// Only pages that produced hits from BOTH sources need checking, and only
// against each other — same-source duplicates aren't possible, the matcher
// doesn't return overlapping windows within one source.
async function dedupeAcrossSources(results) {
  const byPage = new Map();
  for (const r of results) {
    if (!byPage.has(r.page)) byPage.set(r.page, []);
    byPage.get(r.page).push(r);
  }
  const drop = new Set();
  for (const [pageNum, pageResults] of byPage) {
    const textHits = pageResults.filter(r => r.source === 'text');
    const ocrHits = pageResults.filter(r => r.source === 'ocr');
    if (!textHits.length || !ocrHits.length) continue;
    const page = await getPageProxy(pageNum);
    const viewport = page.getViewport({ scale: 1 }); // any fixed scale — used only for relative overlap
    const textBoxes = await Promise.all(textHits.map(r => boxFor(pageNum, r, viewport)));
    const ocrBoxes = await Promise.all(ocrHits.map(r => boxFor(pageNum, r, viewport)));
    ocrHits.forEach((ocrHit, i) => {
      // The text layer is authoritative where it exists, so an OCR hit that
      // sits on top of a text hit is the redundant one to drop.
      if (textBoxes.some(tb => overlapFraction(ocrBoxes[i], tb) > 0.3)) drop.add(ocrHit);
    });
  }
  return results.filter(r => !drop.has(r));
}

/*
 * The two toggles are tiers to include, not modes to choose between — which is
 * why both start ticked. "Exact" on its own is the one restrictive case: with
 * nothing else asked for, it means the tag has to BE the whole string. Ticked
 * alongside Fuzzy it can't mean that (the two would contradict), so the search
 * runs every tier and the results list ranks whole-tag exact hits to the top.
 */
async function runFullSearch() {
  const raw = searchInput.value.trim();
  const exactOn = exactToggle.checked;
  const fuzzyOn = fuzzyToggle.checked;
  S.currentQuery = {
    raw, norm: normalize(raw),
    exactOnly: exactOn && !fuzzyOn, fuzzy: fuzzyOn,
    // First pass allows only substitutions, which is roughly ten times cheaper
    // than the full alignment. See below for when that gets lifted.
    allowIndels: false,
  };
  if (!S.currentQuery.norm) {
    S.lastResults = [];
    renderResultsList();
    searchSummary.textContent = '';
    drawHighlights();
    return;
  }

  const pages = searchablePages();
  const collect = async () => {
    const out = [];
    for (const p of pages) out.push(...searchPage(p, S.currentQuery));
    return rank(await dedupeAcrossSources(out));
  };

  S.lastResults = await collect();

  // Nothing found. Before telling the user the tag isn't there, try harder:
  // allow the alignment to absorb characters that blur erased entirely, which
  // is the commonest way a real tag goes missing (a dropped I, V or leading
  // digit). Only a failed search pays for this.
  if (!S.lastResults.length) {
    S.currentQuery.allowIndels = true;
    S.lastResults = await collect();
    S.deepSearchUsed = S.lastResults.length > 0;
  } else {
    S.deepSearchUsed = false;
  }

  S.activeResultIndex = -1;
  renderResultsList();
  updateSearchSummary();
  drawHighlights();
}

async function mergeFreshResults(pageNum, fresh) {
  if (!fresh.length && !S.lastResults.some(r => r.page === pageNum)) return;
  const deduped = await dedupeAcrossSources(fresh);
  S.lastResults = S.lastResults.filter(r => r.page !== pageNum);
  S.lastResults.push(...rank(deduped));
  rank(S.lastResults);
  renderResultsList();
  updateSearchSummary();
  if (pageNum === S.currentPage) drawHighlights();
}

function updateSearchSummary() {
  const pagesUnprocessed = [];
  for (let p=1;p<=S.numPages;p++) {
    const d = S.pageData.get(p);
    if (!['text-done','ocr-done','skipped','error'].includes(d.status)) pagesUnprocessed.push(p);
  }
  // "so far" is a promise that more may arrive, so only say it while pages are
  // in fact still being read.
  let msg = S.lastResults.length + ' match' + (S.lastResults.length===1?'':'es') + ' found'
          + (pagesUnprocessed.length ? ' so far' : '');
  if (S.deepSearchUsed) msg += ' — nothing matched exactly, so these allow for characters OCR lost entirely. Check the crops.';
  if (pagesUnprocessed.length) msg += ' (' + pagesUnprocessed.length + ' page' + (pagesUnprocessed.length===1?'':'s') + ' still processing — results will keep appearing)';
  searchSummary.textContent = msg;
  resultsCount.textContent = S.lastResults.length + ' result' + (S.lastResults.length===1?'':'s');
}

// Searching a half-read document reports absences that aren't real, so the box
// is closed while pages are still being read and opened once they're all in.
function setSearchEnabled(enabled) {
  searchInput.disabled = !enabled;
  searchBtn.disabled = !enabled;
}

searchBtn.addEventListener('click', runFullSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') runFullSearch(); });
exactToggle.addEventListener('change', () => { if (S.currentQuery.norm) runFullSearch(); });
fuzzyToggle.addEventListener('change', () => { if (S.currentQuery.norm) runFullSearch(); });

export {
  mergeFreshResults,
  runFullSearch,
  searchPage,
  setSearchEnabled,
  updateSearchSummary,
};
