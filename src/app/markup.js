import { S } from './state.js';
import { pdfPointFromCanvas } from '../lib/geometry.js';
import { getPageProxy } from './pdf.js';
import { drawHighlights, drawMarkups } from './viewer.js';
import {
  pencilBtn,
  markupToolSelect,
  markupColorInput,
  markupWidthInput,
  markupWidthLabel,
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
  overlayCtx.lineJoin = 'round';
  overlayCtx.lineCap = 'round';
  overlayCtx.beginPath();
  overlayCtx.moveTo(p0[0], p0[1]);
  overlayCtx.lineTo(p1[0], p1[1]);
  overlayCtx.stroke();
}

pencilBtn.addEventListener('click', () => {
  if (!S.pdfDoc) return;
  S.mode = S.mode === 'markup' ? 'view' : 'markup';
  syncMarkupModeUI();
});

markupToolSelect.addEventListener('change', () => {
  S.markupTool = markupToolSelect.value;
});
markupColorInput.addEventListener('input', () => {
  S.markupColor = markupColorInput.value;
});
markupWidthInput.addEventListener('input', () => {
  S.markupWidth = parseInt(markupWidthInput.value, 10) || 1;
  markupWidthLabel.textContent = S.markupWidth + 'px';
});

// ---- drawing gesture ----
let drawingActive = false;
let currentPoints = []; // canvas-space, while a stroke is in progress

overlayCanvas.addEventListener('mousedown', (e) => {
  if (S.mode !== 'markup' || !S.pdfDoc) return;
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

  const page = await getPageProxy(S.currentPage);
  const viewport = page.getViewport({ scale: S.scale });
  const pdfPoints = pts.map(([x, y]) => pdfPointFromCanvas(viewport, x, y));
  const stroke = {
    id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    tool: S.markupTool,
    color: S.markupColor,
    width: S.markupWidth,
    points: pdfPoints,
    createdAt: Date.now(),
  };
  if (!S.markups.has(S.currentPage)) S.markups.set(S.currentPage, []);
  S.markups.get(S.currentPage).push(stroke);

  await refreshOverlay();
  updateMarkupButtons();
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

export { syncMarkupModeUI, updateMarkupButtons };
