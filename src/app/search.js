import { S } from './state.js';
import { scoreResult } from '../lib/evidence.js';
import { normalize } from '../lib/text.js';
import { searchTextLayer } from './textlayer.js';
import { searchOcr } from './ocr.js';
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
 * The two toggles are tiers to include, not modes to choose between — which is
 * why both start ticked. "Exact" on its own is the one restrictive case: with
 * nothing else asked for, it means the tag has to BE the whole string. Ticked
 * alongside Fuzzy it can't mean that (the two would contradict), so the search
 * runs every tier and the results list ranks whole-tag exact hits to the top.
 */
function runFullSearch() {
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
  const collect = () => {
    const out = [];
    for (const p of pages) out.push(...searchPage(p, S.currentQuery));
    return rank(out);
  };

  S.lastResults = collect();

  // Nothing found. Before telling the user the tag isn't there, try harder:
  // allow the alignment to absorb characters that blur erased entirely, which
  // is the commonest way a real tag goes missing (a dropped I, V or leading
  // digit). Only a failed search pays for this.
  if (!S.lastResults.length) {
    S.currentQuery.allowIndels = true;
    S.lastResults = collect();
    S.deepSearchUsed = S.lastResults.length > 0;
  } else {
    S.deepSearchUsed = false;
  }

  S.activeResultIndex = -1;
  renderResultsList();
  updateSearchSummary();
  drawHighlights();
}

function mergeFreshResults(pageNum, fresh) {
  if (!fresh.length && !S.lastResults.some(r => r.page === pageNum)) return;
  S.lastResults = S.lastResults.filter(r => r.page !== pageNum);
  S.lastResults.push(...rank(fresh));
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
