import { S } from './state.js';
import { pdfPointFromCanvas, applyMatrix } from '../lib/geometry.js';
import { getPageProxy } from './pdf.js';
import { drawHighlights, drawMarkups } from './viewer.js';
import {
  pencilBtn,
  markupDrawControls,
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
// A drag-drawn stroke (pen/line) is drawn live in canvas-space for
// zero-latency feedback, then converted to PDF-space (via
// pdfPointFromCanvas) and stored on commit. A point-to-point polyline is
// long-lived by comparison — built up over several separate clicks, maybe
// with a zoom in between — so it's kept in PDF-space the whole time it's in
// progress and only projected to canvas-space for drawing (see
// redrawActivePolyline()). Either way, see drawMarkups() in viewer.js for
// the reverse projection used to redraw a committed stroke at whatever
// zoom/page is current.
// =======================================================================

function syncMarkupModeUI() {
  const active = S.mode === 'markup';
  pencilBtn.classList.toggle('active', active);
  overlayCanvas.classList.toggle('markup-active', active);
  // The tool/color/width/opacity controls are only meaningful while
  // actually drawing — keeping them visible the rest of the time was clutter
  // with nothing to select. Undo/Clear/Export stay put: those apply to
  // markups already on the page, useful whether or not the pencil is active.
  markupDrawControls.hidden = !active;
  if (!active) closeHintPopover();
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
  if (S.mode === 'markup') selectStroke(null); // a view-mode selection is meaningless once drawing starts
  else cancelPolyline();
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

overlayCanvas.addEventListener('mousedown', (e) => {
  if (S.mode !== 'markup' || !S.pdfDoc || S.markupTool === 'polyline') return;
  e.preventDefault();
  drawingActive = true;
  currentPoints = [canvasPointFromEvent(e)];
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
//
// Points are kept in PDF-space (not canvas-space) for the whole time a
// polyline is in progress — the same representation a committed Stroke
// uses — precisely so it can be reprojected through whatever viewport is
// current and stay pinned to the drawing if the user zooms or changes page
// mid-polyline, instead of the preview drifting off to nowhere. See
// redrawActivePolyline(), called from viewer.js's renderPage().
let polylinePoints = []; // PDF-space, while a polyline is in progress

function polylineActive() {
  return polylinePoints.length > 0;
}

function cancelPolyline() {
  if (!polylineActive()) return;
  polylinePoints = [];
  refreshOverlay();
}

async function currentViewport() {
  const page = await getPageProxy(S.currentPage);
  return page.getViewport({ scale: S.scale });
}

// Redraws the in-progress polyline (if any) reprojected through whatever
// viewport is current — called after every render so a zoom/page-size
// change doesn't leave the preview pointing at stale canvas coordinates.
async function redrawActivePolyline() {
  if (!polylineActive()) return;
  const viewport = await currentViewport();
  drawPolyline(polylinePoints.map(([x, y]) => applyMatrix(viewport.transform, x, y)));
}

async function finishPolyline(pdfPts) {
  polylinePoints = [];
  if (pdfPts.length < 2) { await refreshOverlay(); return; }
  const viewport = await currentViewport();
  const canvasPts = pdfPts.map(([x, y]) => applyMatrix(viewport.transform, x, y));
  await commitStroke('polyline', canvasPts);
}

// Pre-fills the in-progress polyline (PDF-space points) from an auto-trace
// and drops the user into the same click-to-extend/Enter-to-commit flow as
// a manually-drawn one — see autotrace.js. Nothing is written to S.markups
// until the user finishes it themselves, so a wrong or incomplete
// auto-trace is always reviewed, never committed blind.
async function seedPolyline(pdfPts) {
  cancelPolyline();
  S.mode = 'markup';
  S.markupTool = 'polyline';
  markupToolSelect.value = 'polyline';
  syncMarkupModeUI();
  markupHintWrap.hidden = false;
  polylinePoints = pdfPts.slice();
  await refreshOverlay();
  await redrawActivePolyline();
}

overlayCanvas.addEventListener('click', async (e) => {
  if (S.mode !== 'markup' || !S.pdfDoc || S.markupTool !== 'polyline') return;
  const viewport = await currentViewport();
  const pdfPt = pdfPointFromCanvas(viewport, ...canvasPointFromEvent(e));
  polylinePoints.push(pdfPt);
  await refreshOverlay();
  await redrawActivePolyline();
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
  const pt = canvasPointFromEvent(e); // the live cursor point is canvas-space already
  const viewport = await currentViewport();
  const canvasPolyline = polylinePoints.map(([x, y]) => applyMatrix(viewport.transform, x, y));
  await refreshOverlay();
  drawPolyline([...canvasPolyline, pt]);
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
  // Selecting a line for deletion only happens while the pencil is off (see
  // the pan/click handler in viewer.js), so this only ever needs to act
  // outside markup mode too.
  if (S.mode === 'markup' || !S.selectedMarkupId) return;
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

export {
  syncMarkupModeUI,
  updateMarkupButtons,
  cancelPolyline,
  canvasPointFromEvent,
  hitTestStroke,
  selectStroke,
  seedPolyline,
  redrawActivePolyline,
};
