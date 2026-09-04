import { S } from './state.js';
import { clamp } from '../lib/text.js';
import { itemQuadCanvas, boundsOfPoints, applyMatrix } from '../lib/geometry.js';
import { getPageProxy } from './pdf.js';
import { updateProcSummary } from './queue.js';
import { renderResultsList } from './results.js';
import {
  updateMarkupButtons, canvasPointFromEvent, hitTestStroke, selectStroke, cancelPolyline, redrawActivePolyline,
} from './markup.js';
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
  // Test-only observability hook (see tests/e2e-markup.test.mjs): counts real
  // page renders so the wheel-zoom coalescing fix can be verified — a burst
  // of wheel events should produce far fewer renders than events.
  if (typeof window !== 'undefined') window.__pdfreedyRenderCount = (window.__pdfreedyRenderCount || 0) + 1;

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

  const newPage = clamp(pageNum, 1, S.numPages);
  // A stroke selected for deletion, and an in-progress point-to-point
  // polyline, both belong to the page they're drawn on — a real page change
  // (not a same-page re-render for zoom) leaves them behind rather than
  // reprojecting a page-N polyline onto page M's drawing.
  const pageChanged = newPage !== S.currentPage;
  if (pageChanged) { S.selectedMarkupId = null; cancelPolyline(); }
  S.currentPage = newPage;
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
  await drawMarkups();
  // Reproject any in-progress point-to-point polyline through this (possibly
  // just-changed) viewport too — otherwise a zoom mid-draw leaves the
  // preview pointing at stale canvas coordinates from the old scale/size.
  await redrawActivePolyline();
  updateMarkupButtons();

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

function clearOverlay() {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

// drawHighlights() and drawMarkups() share the one overlay canvas, so only
// the first of the two calls each render pass clears it — see renderPage()
// and jumpToResult(), which always call drawHighlights() immediately before
// drawMarkups().
//
// The active match also gets a slow pulse. Since drawHighlights() is called
// from many places (search, results list, queue, markup redraws) rather than
// one central spot, the pulse is self-scheduling: every real call checks
// whether an active result sits on the current page and, if so, arranges for
// exactly one more animation frame to redraw — see schedulePulse()/stopPulse().
let pulseHandle = null;

function activeResultOnThisPage() {
  const res = S.lastResults[S.activeResultIndex];
  return res && res.page === S.currentPage ? res : null;
}

function stopPulse() {
  if (pulseHandle) { cancelAnimationFrame(pulseHandle); pulseHandle = null; }
}

function schedulePulse() {
  if (pulseHandle) return; // a redraw is already pending
  pulseHandle = requestAnimationFrame(async () => {
    pulseHandle = null;
    await drawHighlights();
    await drawMarkups();
  });
}

async function drawHighlights() {
  clearOverlay();
  if (!S.lastResults.length) { stopPulse(); return; }
  const page = await getPageProxy(S.currentPage);
  const viewport = page.getViewport({ scale: S.scale });
  const data = S.pageData.get(S.currentPage);
  // A gentle breathing pulse, ~2.2s per cycle, applied only to the active box.
  const pulse = 0.72 + 0.28 * Math.sin(Date.now() / 350);

  S.lastResults.forEach((res, i) => {
    if (res.page !== S.currentPage) return;
    const isActive = i === S.activeResultIndex;
    overlayCtx.lineWidth = isActive ? 2.5 : 1.5;
    overlayCtx.strokeStyle = isActive ? '#ff5c7a' : 'rgba(94,169,255,0.85)';
    overlayCtx.fillStyle = isActive ? 'rgba(255,92,122,0.16)' : 'rgba(94,169,255,0.10)';
    overlayCtx.globalAlpha = isActive ? pulse : 1;
    overlayCtx.shadowColor = isActive ? 'rgba(255,92,122,0.65)' : 'transparent';
    overlayCtx.shadowBlur = isActive ? 10 : 0;

    if (res.source === 'text') {
      for (const idx of res.itemIndices) {
        const it = data.textItems[idx];
        strokePoly(padQuad(itemQuadCanvas(it, viewport), HIGHLIGHT_PAD));
      }
    } else {
      const ratio = S.scale / data.thumbScale;
      const x0 = res.bbox.x0*ratio, y0 = res.bbox.y0*ratio, x1 = res.bbox.x1*ratio, y1 = res.bbox.y1*ratio;
      strokePoly(padQuad([[x0,y0],[x1,y0],[x1,y1],[x0,y1]], HIGHLIGHT_PAD));
    }
    // Never let shadow/alpha state bleed into the next box or into the
    // markup strokes drawMarkups() paints right after this function returns.
    overlayCtx.globalAlpha = 1;
    overlayCtx.shadowBlur = 0;
    overlayCtx.shadowColor = 'transparent';
  });

  // Pulsing while actively drawing a markup would fight the live preview
  // (both redraw the same overlay), so it's paused for the duration.
  if (activeResultOnThisPage() && S.mode !== 'markup') schedulePulse();
  else stopPulse();
}

// A box drawn exactly glyph-tight hugs the text closely enough to obscure
// it rather than highlight it. Push every vertex outward from the quad's
// centroid by a fixed screen-pixel amount — this gives an even margin on
// all sides regardless of the quad's rotation, unlike padding x/y ranges
// independently (which only works for an axis-aligned box).
const HIGHLIGHT_PAD = 5;
function padQuad(pts, pad) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return pts.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [x + dx/len*pad, y + dy/len*pad];
  });
}

// Traces a soft-cornered version of an arbitrary (possibly rotated) quad —
// rounding a general polygon rather than assuming an axis-aligned rect,
// since rotated-text search hits produce a rotated quad, not a plain box.
function strokePoly(pts, radius = 4) {
  const n = pts.length;
  overlayCtx.beginPath();
  for (let i = 0; i < n; i++) {
    const curr = pts[i];
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const r = Math.min(radius, dist(curr, prev) / 2, dist(curr, next) / 2);
    const p1 = towards(curr, prev, r);
    const p2 = towards(curr, next, r);
    if (i === 0) overlayCtx.moveTo(p1[0], p1[1]); else overlayCtx.lineTo(p1[0], p1[1]);
    overlayCtx.quadraticCurveTo(curr[0], curr[1], p2[0], p2[1]);
  }
  overlayCtx.closePath();
  overlayCtx.fill();
  overlayCtx.stroke();
}

function dist(a, b) { return Math.hypot(b[0]-a[0], b[1]-a[1]); }
function towards(from, to, d) {
  const len = dist(from, to) || 1;
  return [from[0] + (to[0]-from[0])/len*d, from[1] + (to[1]-from[1])/len*d];
}

// Re-projects each stored (PDF-space, zoom-independent) stroke through the
// current viewport transform, so pencil markups stay pinned to the drawing
// across zoom/page changes — the same transform itemQuadCanvas() uses for
// search-hit boxes.
async function drawMarkups() {
  const strokes = S.markups.get(S.currentPage);
  if (!strokes || !strokes.length) return;
  const page = await getPageProxy(S.currentPage);
  const viewport = page.getViewport({ scale: S.scale });
  for (const s of strokes) {
    if (s.points.length < 2) continue;
    const canvasPts = s.points.map(([x,y]) => applyMatrix(viewport.transform, x, y));

    if (s.id === S.selectedMarkupId) {
      // A wider dashed halo under the stroke, so a selected line is
      // unambiguous at a glance — click-to-select needs visible feedback.
      overlayCtx.save();
      overlayCtx.strokeStyle = 'rgba(94,169,255,0.9)';
      overlayCtx.lineWidth = Math.max(1, s.width * S.scale) + 6;
      overlayCtx.lineJoin = 'round';
      overlayCtx.lineCap = 'round';
      overlayCtx.setLineDash([6, 4]);
      overlayCtx.beginPath();
      overlayCtx.moveTo(canvasPts[0][0], canvasPts[0][1]);
      for (let i = 1; i < canvasPts.length; i++) overlayCtx.lineTo(canvasPts[i][0], canvasPts[i][1]);
      overlayCtx.stroke();
      overlayCtx.restore();
    }

    overlayCtx.strokeStyle = s.color;
    overlayCtx.lineWidth = Math.max(1, s.width * S.scale);
    overlayCtx.globalAlpha = s.opacity == null ? 1 : s.opacity;
    overlayCtx.lineJoin = 'round';
    overlayCtx.lineCap = 'round';
    overlayCtx.beginPath();
    overlayCtx.moveTo(canvasPts[0][0], canvasPts[0][1]);
    for (let i = 1; i < canvasPts.length; i++) overlayCtx.lineTo(canvasPts[i][0], canvasPts[i][1]);
    overlayCtx.stroke();
    overlayCtx.globalAlpha = 1;
  }
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
  await drawMarkups();
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

// Captures where (clientX, clientY) sits in scrolled drawing-space, so that
// point can be kept fixed on screen across a zoom change — otherwise a big
// zoom change (zoom way in, then hit "100%") leaves the scroll offset
// pointing nowhere sane in the now-much-smaller content, and the view can
// end up scrolled past the page entirely. Shared by the zoom buttons
// (anchored at the viewport center) and the wheel handler (at the cursor).
function captureZoomAnchor(clientX, clientY) {
  const rect = canvasScroll.getBoundingClientRect();
  return {
    offsetX: clientX - rect.left + canvasScroll.scrollLeft,
    offsetY: clientY - rect.top + canvasScroll.scrollTop,
    clientX,
    clientY,
  };
}

// Re-scrolls so the point captureZoomAnchor() recorded is back under the
// same screen position, scaled by how much the zoom changed since then.
function restoreZoomAnchor(anchor, ratio) {
  const rect = canvasScroll.getBoundingClientRect();
  canvasScroll.scrollLeft = anchor.offsetX*ratio - (anchor.clientX-rect.left);
  canvasScroll.scrollTop = anchor.offsetY*ratio - (anchor.clientY-rect.top);
}

async function zoomAtViewportCenter(newScale) {
  const rect = canvasScroll.getBoundingClientRect();
  const anchor = captureZoomAnchor(rect.left + rect.width/2, rect.top + rect.height/2);
  const oldScale = S.scale;
  setZoom(newScale);
  await renderPage(S.currentPage);
  restoreZoomAnchor(anchor, S.scale / oldScale);
}

zoomInBtn.addEventListener('click', () => zoomAtViewportCenter(S.scale*1.25));
zoomOutBtn.addEventListener('click', () => zoomAtViewportCenter(S.scale/1.25));
zoomResetBtn.addEventListener('click', () => zoomAtViewportCenter(1.5));
fitWidthBtn.addEventListener('click', async () => {
  const page = await getPageProxy(S.currentPage);
  const vp1 = page.getViewport({ scale: 1 });
  const target = (canvasScroll.clientWidth - 48) / vp1.width;
  await zoomAtViewportCenter(target);
});
setZoom(1.5);

// A fast scroll-wheel/trackpad zoom gesture fires many `wheel` events per
// second. Awaiting a full renderPage() (cancel in-flight render, resize +
// clear the canvas, re-render) for every single one is what made zooming
// feel jittery — this coalesces a burst of ticks into one real render per
// animation frame (or per in-flight render, if that's slower than a frame),
// while still applying every tick's scale change so the total zoom amount
// is unaffected.
let zoomPending = false;
let zoomAnchor = null; // captureZoomAnchor() result, plus startScale
let zoomStartScale = 1;

async function processZoomFrame() {
  if (!zoomAnchor) { zoomPending = false; return; }
  const anchor = zoomAnchor;
  const startScale = zoomStartScale;
  zoomAnchor = null;
  await renderPage(S.currentPage);
  restoreZoomAnchor(anchor, S.scale / startScale);
  if (zoomAnchor) requestAnimationFrame(processZoomFrame); // more ticks arrived mid-render
  else zoomPending = false;
}

canvasScroll.addEventListener('wheel', (e) => {
  if (!S.pdfDoc) return;
  e.preventDefault();
  if (!zoomAnchor) {
    zoomAnchor = captureZoomAnchor(e.clientX, e.clientY);
    zoomStartScale = S.scale;
  }
  setZoom(S.scale * (e.deltaY < 0 ? 1.1 : 0.9));
  if (!zoomPending) {
    zoomPending = true;
    requestAnimationFrame(processZoomFrame);
  }
}, { passive: false });

// ---- drag to pan ----
// Left-drag (button 0) and middle-click-drag (button 1) both pan; anything
// else (right-click, side buttons) is left alone.
let dragging = false, dragButton = -1, dragStartX=0, dragStartY=0, dragScrollX=0, dragScrollY=0;
canvasScroll.addEventListener('mousedown', async (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  if (e.target.closest('.result-item')) return;
  if (S.mode === 'markup') return; // let markup.js's drawing handlers own the gesture
  if (e.button === 1) {
    // Stop the browser's own middle-click autoscroll (the floating four-way
    // icon) from kicking in — left unblocked, it fights our drag-to-pan for
    // the same scroll position every frame, which is what made this feel so
    // glitchy. Middle-click is pan-only, so it skips the stroke hit-test too:
    // there's nothing async to wait on before the drag can start.
    e.preventDefault();
  } else {
    // Selecting a drawn line (to delete it) only happens outside pencil mode,
    // so a left-click that lands on one selects it instead of starting a pan.
    const hit = S.pdfDoc ? await hitTestStroke(canvasPointFromEvent(e)) : null;
    if (hit) { selectStroke(hit.id); return; }
    if (S.selectedMarkupId) selectStroke(null);
  }
  dragging = true;
  dragButton = e.button;
  dragStartX = e.clientX; dragStartY = e.clientY;
  dragScrollX = canvasScroll.scrollLeft; dragScrollY = canvasScroll.scrollTop;
  canvasScroll.style.cursor = 'grabbing';
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  canvasScroll.scrollLeft = dragScrollX - (e.clientX - dragStartX);
  canvasScroll.scrollTop = dragScrollY - (e.clientY - dragStartY);
});
window.addEventListener('mouseup', (e) => {
  if (!dragging || e.button !== dragButton) return; // ignore an unrelated button releasing mid-drag
  dragging = false;
  dragButton = -1;
  canvasScroll.style.cursor = '';
});

export {
  centerOnResult,
  clearOverlay,
  dragging,
  drawHighlights,
  drawMarkups,
  jumpToResult,
  renderPage,
  setZoom,
  strokePoly,
  updatePageBadge,
};
