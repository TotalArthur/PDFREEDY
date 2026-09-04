import { S } from './state.js';
import { pdfPointFromCanvas, applyMatrix } from '../lib/geometry.js';
import { getPageProxy } from './pdf.js';
import { drawHighlights, drawMarkups } from './viewer.js';
import {
  pencilBtn,
  markupToolSelect,
  markupHintWrap,
  markupHintBtn,
  markupHintPopover,
  markupHintCloseBtn,
  markupColorInput,
  markupWidthInput,
  markupWidthLabel,
  markupOpacityInput,
  markupOpacityLabel,
  markupUndoBtn,
  markupClearBtn,
  markupExportBtn,
  overlayCanvas,
  overlayCtx,
} from './dom.js';

// =======================================================================
// Markup ("pencil") tool: draw, store, undo/clear per page.
//
// Strokes are drawn live in canvas-space for zero-latency feedback, then
// converted to PDF-space (via pdfPointFromCanvas) and stored on commit —
// see drawMarkups() in viewer.js for the reverse projection used to redraw
// them at whatever zoom/page is current.
// =======================================================================

function syncMarkupModeUI() {
  const active = S.mode === 'markup';
  pencilBtn.classList.toggle('active', active);
  overlayCanvas.classList.toggle('markup-active', active);
}

function selectStroke(id) {
  if (S.selectedMarkupId === id) return;
  S.selectedMarkupId = id;
  refreshOverlay();
}

function closeHintPopover() {
  markupHintPopover.hidden = true;
}

function updateMarkupButtons() {
  const strokes = S.markups.get(S.currentPage);
  const hasOnPage = !!(strokes && strokes.length);
  markupUndoBtn.disabled = !hasOnPage;
  markupClearBtn.disabled = !hasOnPage;
  let anyMarkups = false;
  for (const arr of S.markups.values()) {
    if (arr.length) { anyMarkups = true; break; }
  }
  markupExportBtn.disabled = !anyMarkups;
}

async function refreshOverlay() {
  await drawHighlights();
  await drawMarkups();
}

function canvasPointFromEvent(e) {
  const rect = overlayCanvas.getBoundingClientRect();
  const scaleX = overlayCanvas.width / rect.width;
  const scaleY = overlayCanvas.height / rect.height;
  return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
}

function distToSegment(p, a, b) {
  const dx = b[0]-a[0], dy = b[1]-a[1];
  const lenSq = dx*dx + dy*dy;
  const t = lenSq ? Math.max(0, Math.min(1, ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / lenSq)) : 0;
  return Math.hypot(p[0] - (a[0]+t*dx), p[1] - (a[1]+t*dy));
}

// Finds the topmost (most recently drawn) stroke on the current page whose
// line passes near `pt` (canvas-space), so a click can select a specific
// markup for deletion instead of always starting a new one.
async function hitTestStroke(pt) {
  const strokes = S.markups.get(S.currentPage);
  if (!strokes || !strokes.length) return null;
  const page = await getPageProxy(S.currentPage);
  const viewport = page.getViewport({ scale: S.scale });
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    const canvasPts = s.points.map(([x, y]) => applyMatrix(viewport.transform, x, y));
    const tolerance = Math.max(6, s.width * S.scale / 2 + 4);
    for (let j = 1; j < canvasPts.length; j++) {
      if (distToSegment(pt, canvasPts[j-1], canvasPts[j]) <= tolerance) return s;
    }
  }
  return null;
}

function drawSegment(p0, p1) {
  overlayCtx.strokeStyle = S.markupColor;
  overlayCtx.lineWidth = Math.max(1, S.markupWidth * S.scale);
  overlayCtx.globalAlpha = S.markupOpacity;
  overlayCtx.lineJoin = 'round';
  overlayCtx.lineCap = 'round';
  overlayCtx.beginPath();
  overlayCtx.moveTo(p0[0], p0[1]);
  overlayCtx.lineTo(p1[0], p1[1]);
  overlayCtx.stroke();
  overlayCtx.globalAlpha = 1;
}

function drawPolyline(pts) {
  for (let i = 1; i < pts.length; i++) drawSegment(pts[i - 1], pts[i]);
}

function commitStroke(tool, canvasPts) {
  return (async () => {
    const page = await getPageProxy(S.currentPage);
    const viewport = page.getViewport({ scale: S.scale });
    const pdfPoints = canvasPts.map(([x, y]) => pdfPointFromCanvas(viewport, x, y));
    const stroke = {
      id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      tool,
      color: S.markupColor,
      width: S.markupWidth,
      opacity: S.markupOpacity,
      points: pdfPoints,
      createdAt: Date.now(),
    };
    if (!S.markups.has(S.currentPage)) S.markups.set(S.currentPage, []);
    S.markups.get(S.currentPage).push(stroke);
    await refreshOverlay();
    updateMarkupButtons();
  })();
}

pencilBtn.addEventListener('click', () => {
  if (!S.pdfDoc) return;
  S.mode = S.mode === 'markup' ? 'view' : 'markup';
  if (S.mode !== 'markup') { cancelPolyline(); selectStroke(null); }
  syncMarkupModeUI();
});

markupToolSelect.addEventListener('change', () => {
  cancelPolyline(); // switching tools mid-polyline abandons it
  selectStroke(null);
  S.markupTool = markupToolSelect.value;
  markupHintWrap.hidden = S.markupTool !== 'polyline';
  if (markupHintWrap.hidden) closeHintPopover();
});
markupHintBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  markupHintPopover.hidden = !markupHintPopover.hidden;
});
markupHintCloseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  closeHintPopover();
});
document.addEventListener('click', (e) => {
  if (!markupHintPopover.hidden && !markupHintWrap.contains(e.target)) closeHintPopover();
});
markupColorInput.addEventListener('input', () => {
  S.markupColor = markupColorInput.value;
});
markupWidthInput.addEventListener('input', () => {
  S.markupWidth = parseInt(markupWidthInput.value, 10) || 1;
  markupWidthLabel.textContent = S.markupWidth + 'px';
});
markupOpacityInput.addEventListener('input', () => {
  S.markupOpacity = (parseInt(markupOpacityInput.value, 10) || 100) / 100;
  markupOpacityLabel.textContent = Math.round(S.markupOpacity * 100) + '%';
});

// ---- drag gesture: freehand ('pen') and drag-to-draw ('line') ----
let drawingActive = false;
let currentPoints = []; // canvas-space, while a stroke is in progress

overlayCanvas.addEventListener('mousedown', async (e) => {
  if (S.mode !== 'markup' || !S.pdfDoc || S.markupTool === 'polyline') return;
  e.preventDefault();
  const pt = canvasPointFromEvent(e);
  const hit = await hitTestStroke(pt);
  if (hit) { selectStroke(hit.id); return; }
  if (S.selectedMarkupId) selectStroke(null);
  drawingActive = true;
  currentPoints = [pt];
});

window.addEventListener('mousemove', async (e) => {
  if (!drawingActive) return;
  const pt = canvasPointFromEvent(e);
  if (S.markupTool === 'line') {
    // The whole line changes shape every move, so redraw from scratch.
    currentPoints = [currentPoints[0], pt];
    await refreshOverlay();
    drawSegment(currentPoints[0], currentPoints[1]);
  } else {
    currentPoints.push(pt);
    drawSegment(currentPoints[currentPoints.length - 2], pt);
  }
});

window.addEventListener('mouseup', async () => {
  if (!drawingActive) return;
  drawingActive = false;
  const pts = currentPoints;
  currentPoints = [];
  if (pts.length < 2) return;
  await commitStroke(S.markupTool, pts);
});

// ---- click-chain gesture: 'polyline' (point to point) ----
// Click adds a point (and paints the newly committed segment); double-click
// or Enter finishes the line; Escape discards it. A double-click fires two
// ordinary click events first, so the finishing handler below drops the
// trailing duplicate point before committing.
let polylinePoints = []; // canvas-space, while a polyline is in progress

function polylineActive() {
  return polylinePoints.length > 0;
}

function cancelPolyline() {
  if (!polylineActive()) return;
  polylinePoints = [];
  refreshOverlay();
}

async function finishPolyline(pts) {
  polylinePoints = [];
  if (pts.length < 2) { await refreshOverlay(); return; }
  await commitStroke('polyline', pts);
}

overlayCanvas.addEventListener('click', async (e) => {
  if (S.mode !== 'markup' || !S.pdfDoc || S.markupTool !== 'polyline') return;
  const pt = canvasPointFromEvent(e);
  if (!polylineActive()) {
    // Only the click that starts a fresh polyline can select instead of
    // draw — once points are being chained, every click adds the next one.
    const hit = await hitTestStroke(pt);
    if (hit) { selectStroke(hit.id); return; }
    if (S.selectedMarkupId) selectStroke(null);
    polylinePoints = [pt];
    return;
  }
  drawSegment(polylinePoints[polylinePoints.length - 1], pt);
  polylinePoints.push(pt);
});

overlayCanvas.addEventListener('dblclick', async (e) => {
  if (S.mode !== 'markup' || !S.pdfDoc || S.markupTool !== 'polyline' || !polylineActive()) return;
  e.preventDefault();
  // Drop the duplicate point the second click of the double-click just added.
  const pts = polylinePoints.slice(0, -1);
  await finishPolyline(pts);
});

window.addEventListener('keydown', async (e) => {
  if (S.mode !== 'markup' || S.markupTool !== 'polyline' || !polylineActive()) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    await finishPolyline(polylinePoints);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelPolyline();
  }
});

window.addEventListener('mousemove', async (e) => {
  if (S.mode !== 'markup' || S.markupTool !== 'polyline' || !polylineActive()) return;
  const pt = canvasPointFromEvent(e);
  await refreshOverlay();
  drawPolyline([...polylinePoints, pt]);
});

// ---- select-to-delete: click a drawn line (above), then Delete/Backspace ----
async function deleteSelectedStroke() {
  const strokes = S.markups.get(S.currentPage);
  const idx = strokes ? strokes.findIndex(s => s.id === S.selectedMarkupId) : -1;
  if (idx === -1) return;
  strokes.splice(idx, 1);
  S.selectedMarkupId = null;
  await refreshOverlay();
  updateMarkupButtons();
}

window.addEventListener('keydown', async (e) => {
  if (S.mode !== 'markup' || !S.selectedMarkupId) return;
  // Don't hijack Backspace/Delete/Escape while the user is typing elsewhere
  // (search box, page-number field, color/width inputs, ...).
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    await deleteSelectedStroke();
  } else if (e.key === 'Escape') {
    selectStroke(null);
  }
});

// ---- undo / clear ----
markupUndoBtn.addEventListener('click', async () => {
  const strokes = S.markups.get(S.currentPage);
  if (!strokes || !strokes.length) return;
  const removed = strokes.pop();
  if (S.selectedMarkupId === removed.id) S.selectedMarkupId = null;
  await refreshOverlay();
  updateMarkupButtons();
});

markupClearBtn.addEventListener('click', async () => {
  const strokes = S.markups.get(S.currentPage);
  if (!strokes || !strokes.length) return;
  S.markups.set(S.currentPage, []);
  S.selectedMarkupId = null;
  await refreshOverlay();
  updateMarkupButtons();
});

export { syncMarkupModeUI, updateMarkupButtons, cancelPolyline };
