import { S } from './state.js';
import { pdfPointFromCanvas } from '../lib/geometry.js';
import { getPageProxy } from './pdf.js';
import { drawHighlights, drawMarkups } from './viewer.js';
import {
  pencilBtn,
  markupToolSelect,
  markupHint,
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
  if (S.mode !== 'markup') cancelPolyline();
  syncMarkupModeUI();
});

markupToolSelect.addEventListener('change', () => {
  cancelPolyline(); // switching tools mid-polyline abandons it
  S.markupTool = markupToolSelect.value;
  markupHint.hidden = S.markupTool !== 'polyline';
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
  drawingActive = true;
  currentPoints = [canvasPointFromEvent(e)];
  e.preventDefault();
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

overlayCanvas.addEventListener('click', (e) => {
  if (S.mode !== 'markup' || !S.pdfDoc || S.markupTool !== 'polyline') return;
  const pt = canvasPointFromEvent(e);
  if (!polylineActive()) {
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

// ---- undo / clear ----
markupUndoBtn.addEventListener('click', async () => {
  const strokes = S.markups.get(S.currentPage);
  if (!strokes || !strokes.length) return;
  strokes.pop();
  await refreshOverlay();
  updateMarkupButtons();
});

markupClearBtn.addEventListener('click', async () => {
  const strokes = S.markups.get(S.currentPage);
  if (!strokes || !strokes.length) return;
  S.markups.set(S.currentPage, []);
  await refreshOverlay();
  updateMarkupButtons();
});

export { syncMarkupModeUI, updateMarkupButtons, cancelPolyline };
