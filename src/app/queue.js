import { S } from './state.js';
import { extractTextLayer } from './textlayer.js';
import { runOcrForPage } from './ocr.js';
import { updatePageBadge, drawHighlights } from './viewer.js';
import { searchPage, mergeFreshResults, runFullSearch, setSearchEnabled, updateSearchSummary } from './search.js';
import { ROTATIONS, OCR_POOL_SIZE } from './config.js';
import {
  procDetailText,
  procSpinner,
  procBarInner,
  skipPageBtn,
  cancelProcBtn,
  rotatedTextToggle,
  viewerLoading,
  viewerLoadingText,
} from './dom.js';

// =======================================================================
// Background processing queue: current page first, then in page order —
// up to OCR_POOL_SIZE pages worked concurrently (see runQueue below).
// =======================================================================

function startBackgroundProcessing() {
  const epoch = S.docEpoch;
  S.isBackgroundRunning = true;
  S.processingCancelled = false;
  // A search run against a half-read document reports tags as absent when they
  // simply haven't been read yet, so the box stays shut until the queue drains.
  setSearchEnabled(false);
  cancelProcBtn.disabled = false;
  showViewerLoading('');
  if (!S.tickerHandle) S.tickerHandle = setInterval(updateProcSummary, 500);
  runQueue(epoch);
}

// Up to OCR_POOL_SIZE pages are worked at once — each processPage() call
// eventually hands its recognize() calls to the shared scheduler (see
// ocr.js), so running several pages concurrently is what actually keeps
// every worker in the pool fed. Any fewer and most of the pool sits idle
// while a single page's text extraction or image conditioning (both
// main-thread, pre-OCR steps) runs; any more just queues extra scheduler
// jobs behind the same OCR_POOL_SIZE workers for no benefit.
function nextPendingPage() {
  const cd = S.pageData.get(S.currentPage);
  if (cd && cd.status === 'pending') return S.currentPage;
  for (let p = 1; p <= S.numPages; p++) {
    const d = S.pageData.get(p);
    if (d && d.status === 'pending') return p;
  }
  return null;
}

async function runQueue(epoch) {
  const concurrency = Math.max(1, OCR_POOL_SIZE);
  const inFlight = new Set();

  while (!S.processingCancelled && epoch === S.docEpoch) {
    while (inFlight.size < concurrency) {
      const target = nextPendingPage();
      if (target === null) break;
      // processPage() flips the page's status off 'pending' synchronously,
      // before its first await — so the next nextPendingPage() call in this
      // same synchronous loop never re-claims the page it just handed out.
      const task = processPage(target, epoch);
      task.finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
    if (inFlight.size === 0) break; // nothing pending and nothing running
    await Promise.race(inFlight);
  }
  // Let whatever is already running finish before touching shared UI state —
  // cancelling stops new pages from starting, not the ones already mid-read.
  await Promise.allSettled(inFlight);
  // A queue from a superseded document must not touch the current one's UI.
  if (epoch !== S.docEpoch) return;
  S.isBackgroundRunning = false;
  if (S.tickerHandle) { clearInterval(S.tickerHandle); S.tickerHandle = null; }
  hideViewerLoading();
  updateProcSummary();
  cancelProcBtn.disabled = true;
  skipPageBtn.disabled = true;
  setSearchEnabled(S.numPages > 0);
  // Pages read while the queue was running may answer a query typed before it
  // started (a correction re-run, say), so refresh whatever is on screen.
  if (S.currentQuery.norm) updateSearchSummary();
}

async function processPage(pageNum, epoch) {
  const data = S.pageData.get(pageNum);
  if (!data) return;
  data.status = 'text-extracting';
  data.stepStartedAt = Date.now();
  updateProcSummary();
  if (pageNum === S.currentPage) updatePageBadge();

  let skipOcr = false;
  // A page back in the queue for extra rotation passes has already had its text
  // layer read, and that can't have changed — go straight to OCR.
  if (!data.textItems) {
    try {
      skipOcr = await extractTextLayer(pageNum);
    } catch (err) {
      console.warn('Text extraction failed on page', pageNum, err);
    }
  }
  if (epoch !== S.docEpoch) return;

  if (!skipOcr) {
    data.status = 'ocr-running';
    data.ocrPassNum = 0;
    data.stepStartedAt = Date.now();
    // Skip is tracked per page, not globally — several pages can be mid-OCR
    // at once, and clicking "skip" is only ever meant for the one on screen.
    data.skipRequested = false;
    if (pageNum === S.currentPage) { skipPageBtn.disabled = false; updatePageBadge(); }
    try {
      await runOcrForPage(pageNum, (pass, of) => {
        data.ocrProgressLabel = 'OCR pass ' + pass + ' of ' + of;
        data.ocrPassNum = pass;
        data.ocrPassOf = of;
        data.stepStartedAt = Date.now();
        updateProcSummary();
      });
      data.status = data.skipRequested ? 'skipped' : 'ocr-done';
    } catch (err) {
      console.error('OCR failed on page', pageNum, err);
      data.status = 'error';
    }
    if (epoch !== S.docEpoch) return;
    if (pageNum === S.currentPage) skipPageBtn.disabled = true;
  }

  updateProcSummary();
  if (pageNum === S.currentPage) {
    updatePageBadge();
    await drawHighlights();
  }
  // if there's an active query, incrementally search this page and merge results
  if (S.currentQuery.norm) {
    const fresh = searchPage(pageNum, S.currentQuery);
    await mergeFreshResults(pageNum, fresh);
  }
}

function updateProcSummary() {
  let done = 0, ocrCount = 0, progressCredit = 0;
  for (let p=1;p<=S.numPages;p++) {
    const d = S.pageData.get(p);
    if (!d) continue;
    const isDone = ['text-done','ocr-done','skipped','error'].includes(d.status);
    if (isDone) { done++; progressCredit += 1; }
    else if (d.status === 'ocr-running') progressCredit += Math.min(d.ocrPassNum || 0, 4) / 4;
    else if (d.status === 'text-extracting') progressCredit += 0.05;
    if (d.ocrLines) ocrCount++;
  }
  if (!S.numPages) {
    procDetailText.textContent = 'No document loaded.';
    procBarInner.style.width = '0%';
    procBarInner.classList.remove('processing', 'done');
    procSpinner.classList.remove('active');
    return;
  }
  const anyActive = S.isBackgroundRunning;
  const allDone = !anyActive && done === S.numPages;
  // A finished run shows a full bar even if a skipped or errored page never
  // earned its credit — the queue is done either way, and a bar frozen at 96%
  // reads as work still happening.
  const pct = allDone ? 100 : Math.min(100, Math.round(progressCredit/S.numPages*100));
  procBarInner.style.width = pct + '%';
  procBarInner.classList.toggle('processing', anyActive);
  procBarInner.classList.toggle('done', allDone);
  procSpinner.classList.toggle('active', anyActive);

  let label = 'Processed ' + done + ' / ' + S.numPages + ' pages' + (ocrCount ? ' (' + ocrCount + ' via OCR)' : '');
  const cd = S.pageData.get(S.currentPage);
  if (anyActive && cd && cd.status === 'ocr-running' && cd.ocrProgressLabel) {
    const elapsed = Math.round((Date.now() - (cd.stepStartedAt || Date.now())) / 1000);
    label += ' — page ' + S.currentPage + ': ' + cd.ocrProgressLabel + ' (running ' + elapsed + 's)';
    showViewerLoading('Page ' + S.currentPage + ' of ' + S.numPages + ': ' +
                      cd.ocrProgressLabel + ' — running ' + elapsed + 's');
  } else if (anyActive && cd && cd.status === 'text-extracting') {
    label += ' — page ' + S.currentPage + ': extracting text';
    showViewerLoading('Page ' + S.currentPage + ' of ' + S.numPages + ': extracting text');
  } else if (anyActive) {
    showViewerLoading('');
  }
  // Say it plainly when there is nothing left to wait for: "Processed 1 / 1"
  // on its own looks identical whether the last page is finished or still
  // being read.
  if (allDone) label += ' — done, ready to search';
  else if (!anyActive) label += ' — stopped';
  procDetailText.textContent = label;
}

// One loading state, laid over the drawing itself, so it is obvious that what
// you're looking at hasn't been read yet.
// The title stays put ("Reading the drawing…"); this line carries the detail,
// and is blank rather than repeating the title when there is none yet.
function showViewerLoading(detail) {
  viewerLoading.classList.add('visible');
  viewerLoadingText.textContent = detail;
}
function hideViewerLoading() {
  viewerLoading.classList.remove('visible');
}

skipPageBtn.addEventListener('click', () => {
  const d = S.pageData.get(S.currentPage);
  if (d) d.skipRequested = true;
});
cancelProcBtn.addEventListener('click', () => {
  S.processingCancelled = true;
  // Marks every page still in flight, not just the current one — several can
  // be mid-OCR at once with the pool, and cancel means all of them.
  for (const d of S.pageData.values()) {
    if (d.status === 'ocr-running') d.skipRequested = true;
  }
  cancelProcBtn.disabled = true;
});

/*
 * "Also scan rotated/vertical text" ticked after the fact.
 *
 * The rotated passes are extra work on top of what a page already has, not a
 * different way of reading it — so pages that were read landscape-only are put
 * back in the queue and each runs ONLY the rotations it is missing, appending
 * to the words it already has. Pages that came from a real text layer are left
 * alone: there is nothing for OCR to add to them.
 */
rotatedTextToggle.addEventListener('change', () => {
  if (!S.numPages) return;
  if (!rotatedTextToggle.checked) {
    // Unticking doesn't throw the rotated words away, it just stops searching
    // them — so re-ticking is free, and the result list matches the checkbox.
    if (S.currentQuery.norm) runFullSearch();
    return;
  }
  let queued = 0;
  for (let p = 1; p <= S.numPages; p++) {
    const d = S.pageData.get(p);
    if (!d || d.status !== 'ocr-done') continue;
    const seen = d.ocrRotations || [];
    if (ROTATIONS.every(deg => seen.includes(deg))) continue;
    d.status = 'pending';
    queued++;
  }
  if (!queued) {
    if (S.currentQuery.norm) runFullSearch();
    return;
  }
  updateProcSummary();
  if (!S.isBackgroundRunning) startBackgroundProcessing();
});

export {
  hideViewerLoading,
  processPage,
  runQueue,
  showViewerLoading,
  startBackgroundProcessing,
  updateProcSummary,
};
