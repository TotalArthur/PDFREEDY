import { S } from './state.js';
import { clamp } from '../lib/text.js';
import { itemQuadCanvas, boundsOfPoints } from '../lib/geometry.js';
import { getPageProxy } from './pdf.js';
import { updateProcSummary, hidePageProgressBanner } from './queue.js';
import { renderResultsList } from './results.js';
import {
  skipPageBtn,
  prevPageBtn,
  nextPageBtn,
  pageNumInput,
  currentPageBadge,
  zoomOutBtn,
  zoomInBtn,
  zoomLabel,
  fitWidthBtn,
  zoomResetBtn,
  canvasScroll,
  canvasStage,
  pageCanvas,
  overlayCanvas,
  pageCtx,
  overlayCtx,
} from './dom.js';

// =======================================================================
// Viewer: render page, zoom/pan, highlight overlay
// =======================================================================
async function renderPage(pageNum) {
  // Only one render may target the shared page canvas at a time. Zooming,
  // page-flipping or dropping a new PDF mid-render would otherwise hit
  // pdf.js's "same canvas during multiple render() operations" error, so
  // cancel any in-flight render and wait for it to unwind first.
  if (S.currentRenderTask) {
    try { S.currentRenderTask.cancel(); } catch (err) { /* already finished */ }
    try { await S.currentRenderTask.promise; } catch (err) { /* expected: cancelled */ }
    S.currentRenderTask = null;
  }
  if (!S.pdfDoc) return;

  S.currentPage = clamp(pageNum, 1, S.numPages);
  pageNumInput.value = S.currentPage;
  const page = await getPageProxy(S.currentPage);
  const viewport = page.getViewport({ scale: S.scale });
  pageCanvas.width = Math.ceil(viewport.width);
  pageCanvas.height = Math.ceil(viewport.height);
  overlayCanvas.width = pageCanvas.width;
  overlayCanvas.height = pageCanvas.height;
  canvasStage.style.width = pageCanvas.width + 'px';
  canvasStage.style.height = pageCanvas.height + 'px';

  const task = page.render({ canvasContext: pageCtx, viewport });
  S.currentRenderTask = task;
  try {
    await task.promise;
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    throw err;
  } finally {
    if (S.currentRenderTask === task) S.currentRenderTask = null;
  }
  updatePageBadge();
  updateProcSummary();
  await drawHighlights();

  const d = S.pageData.get(S.currentPage);
  skipPageBtn.disabled = !(d && d.status === 'ocr-running');
}

function updatePageBadge() {
  const d = S.pageData.get(S.currentPage);
  currentPageBadge.className = 'page-badge';
  if (!d) { currentPageBadge.textContent = '—'; return; }
  const map = {
    'pending': ['pending','Queued'],
    'text-extracting': ['running','Extracting text…'],
    'text-done': ['text','Text layer'],
    'ocr-running': ['running','OCR running…'],
    'ocr-done': ['ocr','OCR'],
    'skipped': ['pending','OCR skipped'],
    'error': ['error','Error']
  };
  const [cls, label] = map[d.status] || ['pending', d.status];
  currentPageBadge.classList.add(cls);
  currentPageBadge.textContent = label;
}

async function drawHighlights(activeOnly) {
  overlayCtx.clearRect(0,0,overlayCanvas.width, overlayCanvas.height);
  if (!S.lastResults.length) return;
  const page = await getPageProxy(S.currentPage);
  const viewport = page.getViewport({ scale: S.scale });
  const data = S.pageData.get(S.currentPage);

  S.lastResults.forEach((res, i) => {
    if (res.page !== S.currentPage) return;
    const isActive = i === S.activeResultIndex;
    overlayCtx.lineWidth = isActive ? 3 : 1.5;
    overlayCtx.strokeStyle = isActive ? '#ff5c5c' : 'rgba(79,157,255,0.85)';
    overlayCtx.fillStyle = isActive ? 'rgba(255,92,92,0.18)' : 'rgba(79,157,255,0.12)';

    if (res.source === 'text') {
      for (const idx of res.itemIndices) {
        const it = data.textItems[idx];
        strokePoly(itemQuadCanvas(it, viewport));
      }
    } else {
      const ratio = S.scale / data.thumbScale;
      const x0 = res.bbox.x0*ratio, y0 = res.bbox.y0*ratio, x1 = res.bbox.x1*ratio, y1 = res.bbox.y1*ratio;
      strokePoly([[x0,y0],[x1,y0],[x1,y1],[x0,y1]]);
    }
  });
}

function strokePoly(pts) {
  overlayCtx.beginPath();
  overlayCtx.moveTo(pts[0][0], pts[0][1]);
  for (let i=1;i<pts.length;i++) overlayCtx.lineTo(pts[i][0], pts[i][1]);
  overlayCtx.closePath();
  overlayCtx.fill();
  overlayCtx.stroke();
}

async function jumpToResult(i) {
  S.activeResultIndex = i;
  renderResultsList();
  const res = S.lastResults[i];
  if (S.scale < 2.5) S.scale = 2.5;
  if (res.page !== S.currentPage) {
    await renderPage(res.page);
  } else {
    await renderPage(S.currentPage); // re-render at (possibly) new S.scale
  }
  centerOnResult(res);
  await drawHighlights();
}

async function centerOnResult(res) {
  const page = await getPageProxy(res.page);
  const viewport = page.getViewport({ scale: S.scale });
  const data = S.pageData.get(res.page);
  let pts;
  if (res.source === 'text') {
    pts = [];
    for (const idx of res.itemIndices) {
      const it = data.textItems[idx];
      pts.push(...itemQuadCanvas(it, viewport));
    }
  } else {
    const ratio = S.scale / data.thumbScale;
    pts = [[res.bbox.x0*ratio,res.bbox.y0*ratio],[res.bbox.x1*ratio,res.bbox.y1*ratio]];
  }
  const b = boundsOfPoints(pts);
  const cx = (b.minX+b.maxX)/2, cy = (b.minY+b.maxY)/2;
  canvasScroll.scrollLeft = cx - canvasScroll.clientWidth/2;
  canvasScroll.scrollTop = cy - canvasScroll.clientHeight/2;
}

// ---- page navigation ----
prevPageBtn.addEventListener('click', () => renderPage(S.currentPage-1));
nextPageBtn.addEventListener('click', () => renderPage(S.currentPage+1));
pageNumInput.addEventListener('change', () => {
  const n = parseInt(pageNumInput.value, 10);
  if (!isNaN(n)) renderPage(n);
});

// ---- zoom ----
function setZoom(newScale) {
  S.scale = clamp(newScale, 0.25, 8);
  zoomLabel.textContent = Math.round(S.scale/1.5*100) + '%'; // 1.5 == "100%" baseline
}
zoomInBtn.addEventListener('click', async () => { setZoom(S.scale*1.25); await renderPage(S.currentPage); });
zoomOutBtn.addEventListener('click', async () => { setZoom(S.scale/1.25); await renderPage(S.currentPage); });
zoomResetBtn.addEventListener('click', async () => { setZoom(1.5); await renderPage(S.currentPage); });
fitWidthBtn.addEventListener('click', async () => {
  const page = await getPageProxy(S.currentPage);
  const vp1 = page.getViewport({ scale: 1 });
  const target = (canvasScroll.clientWidth - 48) / vp1.width;
  setZoom(target);
  await renderPage(S.currentPage);
});
setZoom(1.5);

canvasScroll.addEventListener('wheel', async (e) => {
  if (!S.pdfDoc) return;
  e.preventDefault();
  const rect = canvasScroll.getBoundingClientRect();
  const offsetX = e.clientX - rect.left + canvasScroll.scrollLeft;
  const offsetY = e.clientY - rect.top + canvasScroll.scrollTop;
  const oldScale = S.scale;
  setZoom(S.scale * (e.deltaY < 0 ? 1.1 : 0.9));
  const ratio = S.scale / oldScale;
  await renderPage(S.currentPage);
  canvasScroll.scrollLeft = offsetX*ratio - (e.clientX-rect.left);
  canvasScroll.scrollTop = offsetY*ratio - (e.clientY-rect.top);
}, { passive: false });

// ---- drag to pan ----
let dragging = false, dragStartX=0, dragStartY=0, dragScrollX=0, dragScrollY=0;
canvasScroll.addEventListener('mousedown', (e) => {
  if (e.target.closest('.result-item')) return;
  dragging = true;
  dragStartX = e.clientX; dragStartY = e.clientY;
  dragScrollX = canvasScroll.scrollLeft; dragScrollY = canvasScroll.scrollTop;
  canvasScroll.style.cursor = 'grabbing';
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  canvasScroll.scrollLeft = dragScrollX - (e.clientX - dragStartX);
  canvasScroll.scrollTop = dragScrollY - (e.clientY - dragStartY);
});
window.addEventListener('mouseup', () => { dragging = false; canvasScroll.style.cursor = ''; });

export {
  centerOnResult,
  dragging,
  drawHighlights,
  jumpToResult,
  renderPage,
  setZoom,
  strokePoly,
  updatePageBadge,
};
