import { S } from './state.js';
import { renderPage } from './viewer.js';
import { updateProcSummary, startBackgroundProcessing, hidePageProgressBanner } from './queue.js';
import {
  fileInput,
  fileInfo,
  dropOverlay,
  searchInput,
  searchBtn,
  searchSummary,
  procSpinner,
  procBarInner,
  skipPageBtn,
  cancelProcBtn,
  resultsCount,
  resultsList,
  exportCsvBtn,
  toolbar,
  pageNumInput,
  pageCountLabel,
  canvasStage,
  emptyViewer,
} from './dom.js';

// =======================================================================
// PDF loading
// =======================================================================
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await loadPdf(file);
});

// ---- Drag & drop anywhere in the window ----
// dragenter/dragleave fire for every child element the cursor crosses, so a
// simple depth counter keeps the overlay from flickering mid-drag.
let dragDepth = 0;
function eventHasFiles(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types) return Array.prototype.indexOf.call(dt.types, 'Files') !== -1;
  return false;
}
window.addEventListener('dragenter', (e) => {
  if (!eventHasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.add('active');
});
window.addEventListener('dragover', (e) => {
  if (!eventHasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!eventHasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.remove('active');
});
window.addEventListener('drop', async (e) => {
  if (!eventHasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('active');
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  const pdf = files.find(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!pdf) {
    fileInfo.textContent = 'That file isn’t a PDF — drop a .pdf drawing instead.';
    return;
  }
  await loadPdf(pdf);
});

async function loadPdf(file) {
  resetDocumentState();
  fileInfo.textContent = 'Loading ' + file.name + ' …';
  try {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    S.pdfDoc = await loadingTask.promise;
    S.numPages = S.pdfDoc.numPages;
    fileInfo.textContent = file.name + ' — ' + S.numPages + ' page' + (S.numPages===1?'':'s');

    for (let p=1; p<=S.numPages; p++) {
      S.pageData.set(p, {
        status: 'pending', source: null,
        textItems: null, lineGroups: null,
        ocrWords: null, ocrLines: null,
        thumbCanvas: null, thumbScale: null,
        rawLen: 0
      });
    }

    emptyViewer.style.display = 'none';
    canvasStage.style.display = '';
    toolbar.style.display = '';
    searchInput.disabled = false;
    searchBtn.disabled = false;
    cancelProcBtn.disabled = false;
    pageCountLabel.textContent = '/ ' + S.numPages;
    pageNumInput.value = '1';
    S.currentPage = 1;

    await renderPage(1);
    updateProcSummary();
    startBackgroundProcessing();
  } catch (err) {
    console.error(err);
    fileInfo.textContent = 'Failed to load PDF: ' + err.message;
  }
}

function resetDocumentState() {
  S.docEpoch++;   // invalidate any background work from the previous document
  S.pdfDoc = null; S.numPages = 0; S.currentPage = 1; S.scale = 1.5;
  S.pageProxyCache.clear(); S.pageData.clear();
  S.lastResults = []; S.activeResultIndex = -1;
  S.processingCancelled = true; S.skipCurrentPageRequested = false; S.isBackgroundRunning = false;
  if (S.currentRenderTask) {
    try { S.currentRenderTask.cancel(); } catch (err) { /* already finished */ }
    S.currentRenderTask = null;
  }
  if (S.tickerHandle) { clearInterval(S.tickerHandle); S.tickerHandle = null; }
  if (S.ocrWorker) { S.ocrWorker.terminate().catch(()=>{}); S.ocrWorker = null; }
  resultsList.innerHTML = '<div class="empty-note">Load a PDF and run a search to see matches here.</div>';
  resultsCount.textContent = 'Results';
  exportCsvBtn.disabled = true;
  searchSummary.textContent = '';
  searchInput.disabled = true; searchBtn.disabled = true;
  skipPageBtn.disabled = true; cancelProcBtn.disabled = true;
  toolbar.style.display = 'none';
  canvasStage.style.display = 'none';
  emptyViewer.style.display = '';
  hidePageProgressBanner();
  procBarInner.classList.remove('processing');
  procSpinner.classList.remove('active');
}

function getPageProxy(pageNum) {
  if (!S.pageProxyCache.has(pageNum)) {
    S.pageProxyCache.set(pageNum, S.pdfDoc.getPage(pageNum));
  }
  return S.pageProxyCache.get(pageNum);
}

export {
  dragDepth,
  eventHasFiles,
  getPageProxy,
  loadPdf,
  resetDocumentState,
};
