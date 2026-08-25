import { S } from './state.js';
import { extractTextLayer } from './textlayer.js';
import { runOcrForPage } from './ocr.js';
import { updatePageBadge, drawHighlights } from './viewer.js';
import { searchPage, mergeFreshResults } from './search.js';
import {
  procDetailText,
  procSpinner,
  procBarInner,
  skipPageBtn,
  cancelProcBtn,
  pageProgressBanner,
  pageProgressText,
  pageProgressSpinner,
} from './dom.js';

// =======================================================================
// Background processing queue: current page first, then in page order.
// =======================================================================

function startBackgroundProcessing() {
  const epoch = S.docEpoch;
  S.isBackgroundRunning = true;
  S.processingCancelled = false;
  if (!S.tickerHandle) S.tickerHandle = setInterval(updateProcSummary, 500);
  runQueue(epoch);
}

async function runQueue(epoch) {
  while (!S.processingCancelled && epoch === S.docEpoch) {
    let target = null;
    const cd = S.pageData.get(S.currentPage);
    if (cd && cd.status === 'pending') target = S.currentPage;
    if (target === null) {
      for (let p = 1; p <= S.numPages; p++) {
        const d = S.pageData.get(p);
        if (d && d.status === 'pending') { target = p; break; }
      }
    }
    if (target === null) break;
    await processPage(target, epoch);
    await new Promise(r => setTimeout(r, 0)); // yield to keep UI responsive
  }
  // A queue from a superseded document must not touch the current one's UI.
  if (epoch !== S.docEpoch) return;
  S.isBackgroundRunning = false;
  if (S.tickerHandle) { clearInterval(S.tickerHandle); S.tickerHandle = null; }
  updateProcSummary();
  cancelProcBtn.disabled = true;
  skipPageBtn.disabled = true;
}

async function processPage(pageNum, epoch) {
  const data = S.pageData.get(pageNum);
  if (!data) return;
  data.status = 'text-extracting';
  data.stepStartedAt = Date.now();
  updateProcSummary();
  if (pageNum === S.currentPage) updatePageBadge();

  let skipOcr = false;
  try {
    skipOcr = await extractTextLayer(pageNum);
  } catch (err) {
    console.warn('Text extraction failed on page', pageNum, err);
  }
  if (epoch !== S.docEpoch) return;

  if (!skipOcr) {
    data.status = 'ocr-running';
    data.ocrPassNum = 0;
    data.stepStartedAt = Date.now();
    S.skipCurrentPageRequested = false;
    if (pageNum === S.currentPage) { skipPageBtn.disabled = false; updatePageBadge(); }
    try {
      await runOcrForPage(pageNum, (pass, of) => {
        data.ocrProgressLabel = 'OCR pass ' + pass + ' of ' + of;
        data.ocrPassNum = pass;
        data.ocrPassOf = of;
        data.stepStartedAt = Date.now();
        updateProcSummary();
      });
      data.status = S.skipCurrentPageRequested ? 'skipped' : 'ocr-done';
    } catch (err) {
      console.error('OCR failed on page', pageNum, err);
      data.status = 'error';
    }
    S.skipCurrentPageRequested = false;
    if (epoch !== S.docEpoch) return;
    if (pageNum === S.currentPage) { skipPageBtn.disabled = true; hidePageProgressBanner(); }
  }

  updateProcSummary();
  if (pageNum === S.currentPage) {
    updatePageBadge();
    await drawHighlights();
  }
  // if there's an active query, incrementally search this page and merge results
  if (S.currentQuery.norm) {
    const fresh = searchPage(pageNum, S.currentQuery);
    mergeFreshResults(pageNum, fresh);
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
    procBarInner.classList.remove('processing');
    procSpinner.classList.remove('active');
    return;
  }
  const pct = Math.min(100, Math.round(progressCredit/S.numPages*100));
  procBarInner.style.width = pct + '%';
  const anyActive = S.isBackgroundRunning;
  procBarInner.classList.toggle('processing', anyActive);
  procSpinner.classList.toggle('active', anyActive);

  let label = 'Processed ' + done + ' / ' + S.numPages + ' pages' + (ocrCount ? ' (' + ocrCount + ' via OCR)' : '');
  const cd = S.pageData.get(S.currentPage);
  if (cd && cd.status === 'ocr-running' && cd.ocrProgressLabel) {
    const elapsed = Math.round((Date.now() - (cd.stepStartedAt || Date.now())) / 1000);
    label += ' — page ' + S.currentPage + ': ' + cd.ocrProgressLabel + ' (running ' + elapsed + 's)';
    showPageProgressBanner(S.currentPage, cd.ocrProgressLabel + ' — running ' + elapsed + 's');
  } else if (cd && cd.status === 'text-extracting') {
    label += ' — page ' + S.currentPage + ': extracting text';
  } else {
    hidePageProgressBanner();
  }
  procDetailText.textContent = label;
}

function showPageProgressBanner(pageNum, text) {
  pageProgressBanner.classList.add('visible');
  pageProgressSpinner.classList.add('active');
  pageProgressText.textContent = 'Page ' + pageNum + ' of ' + S.numPages + ': ' + text;
}
function hidePageProgressBanner() {
  pageProgressBanner.classList.remove('visible');
  pageProgressSpinner.classList.remove('active');
}

skipPageBtn.addEventListener('click', () => { S.skipCurrentPageRequested = true; });
cancelProcBtn.addEventListener('click', () => {
  S.processingCancelled = true;
  S.skipCurrentPageRequested = true;
  cancelProcBtn.disabled = true;
});

export {
  hidePageProgressBanner,
  processPage,
  runQueue,
  showPageProgressBanner,
  startBackgroundProcessing,
  updateProcSummary,
};
