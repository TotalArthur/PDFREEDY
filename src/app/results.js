import { S } from './state.js';
import { BANDS, BAND_LABEL, BAND_NOTE, bandOf } from '../lib/bands.js';
import { clamp, escapeHtml } from '../lib/text.js';
import { itemQuadCanvas, boundsOfPoints } from '../lib/geometry.js';
import { confidencePercent } from '../lib/evidence.js';
import { setCorrection } from './corrections.js';
import { getPageProxy } from './pdf.js';
import { runFullSearch } from './search.js';
import { jumpToResult } from './viewer.js';
import { startAutoTrace, pageHasVectorLines } from './autotrace.js';
import {
  resultsList,
} from './dom.js';

// =======================================================================
// Results list rendering (with thumbnails)
// =======================================================================
// One row. Everything the reader needs to judge the hit without opening it:
// which page, where it came from, what it says, and — via the band it sits in —
// how much damage the matcher had to absorb to call it a match.
function buildResultElement(res, i) {
  const el = document.createElement('div');
  el.className = 'result-item' + (i === S.activeResultIndex ? ' active' : '');
  el.dataset.index = i;

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'result-thumb';
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = 120; thumbCanvas.height = 68;
  thumbWrap.appendChild(thumbCanvas);
  el.appendChild(thumbWrap);
  buildThumbnail(res, thumbCanvas);

  const meta = document.createElement('div');
  meta.className = 'result-meta';

  // A single percentage replaces the old per-row bullet list of reasons —
  // one number a reader can scan across a whole result list at a glance,
  // with the full explanation (still computed in evidence.js, still unit
  // tested) available as a hover tooltip for anyone who wants to check it.
  const pct = confidencePercent(res);
  const pctTier = pct >= 90 ? 'high' : pct >= 70 ? 'med' : 'low';
  const pctTitle = res.reasons && res.reasons.length ? res.reasons.join('\n') : '';

  const topRow = document.createElement('div');
  topRow.className = 'result-top-row';
  topRow.innerHTML =
    '<span class="badge badge-page">Page ' + res.page + '</span>' +
    '<span class="badge ' + (res.source==='text' ? 'badge-text' : 'badge-ocr') + '">' + (res.source==='text'?'TEXT':'OCR') + '</span>' +
    (res.confused ? '<span class="badge badge-confused" title="Matched through characters OCR cannot reliably distinguish (0/O, 1/I, 5/S, 8/B, 6/G, 2/Z) — check the crop">GLYPH</span>' : '') +
    (res.fuzzy ? '<span class="badge badge-fuzzy">FUZZY</span>' : '') +
    (res.corrected ? '<span class="badge badge-fixed">CORRECTED</span>' : '') +
    '<span class="badge badge-conf badge-conf-' + pctTier + '" title="' + escapeHtml(pctTitle) + '">' + pct + '%</span>';
  if (res.source === 'ocr') {
    const fixBtn = document.createElement('button');
    fixBtn.className = 'fix-btn';
    fixBtn.textContent = res.corrected ? 'Edit fix' : 'Fix text';
    fixBtn.title = 'Tell the tool what this actually says — it will remember and apply it everywhere';
    fixBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openFixEditor(el, meta, res);
    });
    topRow.appendChild(fixBtn);
  } else if (res.source === 'text') {
    // Only offered where the page actually has traceable vector line
    // geometry — checked async since it needs the operator list parsed
    // (cached per page after the first check), so the button starts hidden
    // and appears once that resolves. Not the same thing as "page has no
    // image": a drawing can carry a raster logo/watermark (forcing OCR for
    // that image) while still being full of real stroked pipe linework.
    const traceBtn = document.createElement('button');
    traceBtn.className = 'trace-btn';
    traceBtn.textContent = 'Mark up';
    traceBtn.title = 'Auto-trace the line associated with this tag';
    traceBtn.hidden = true;
    traceBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      startAutoTrace(i);
    });
    topRow.appendChild(traceBtn);
    pageHasVectorLines(res.page).then(hasLines => { traceBtn.hidden = !hasLines; });
  }
  meta.appendChild(topRow);

  const textEl = document.createElement('div');
  textEl.className = 'result-text';
  textEl.innerHTML = highlightMatch(res.text, res.matchPos, res.matchLen);
  meta.appendChild(textEl);

  if (res.source === 'ocr' && res.corrected) {
    const rawEl = document.createElement('div');
    rawEl.className = 'result-raw';
    rawEl.textContent = 'OCR read: ' + res.rawText;
    meta.appendChild(rawEl);
  }

  el.appendChild(meta);
  el.addEventListener('click', () => jumpToResult(i));
  return el;
}

// A text-layer hit has no confidence number attached, because there is no
// engine reading it — treat it as certain rather than as a zero.
const confidenceOf = res => (res.source === 'ocr' ? res.confidence : 100);

/*
 * Order within a band.
 *
 * Whole-tag hits first: if the string IS the tag, it is the one the user meant,
 * and it goes above the run of text that merely contains it. Fuzzy hits sink
 * below everything else in their band and are ordered by how confidently the
 * text they matched was read — a last-resort match on a crisp word is worth
 * looking at before one on a smudge. Anything still tied falls back to the
 * evidence score the search ranked on, and then to page order.
 */
function compareResults(a, b) {
  if (!!a.whole !== !!b.whole) return a.whole ? -1 : 1;
  if (a.fuzzy !== b.fuzzy) return a.fuzzy ? 1 : -1;
  if (a.fuzzy && b.fuzzy) {
    const byConf = confidenceOf(b) - confidenceOf(a);
    if (byConf) return byConf;
  }
  const byScore = (b.score || 0) - (a.score || 0);
  if (byScore) return byScore;
  return a.page - b.page;
}

function renderResultsList() {
  resultsList.innerHTML = '';
  if (!S.lastResults.length) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = S.currentQuery.norm
      ? 'No matches yet — including after allowing for characters OCR may have lost. If you can see the tag on the sheet, use Fix text on whatever OCR did read there.'
      : 'Enter a tag number or string and press Search.';
    resultsList.appendChild(note);
    return;
  }

  // Group by how sure the match is, rather than listing every hit alike, then
  // order within each band by compareResults.
  const grouped = new Map(BANDS.map(b => [b, []]));
  S.lastResults.forEach((res, i) => grouped.get(bandOf(res)).push([res, i]));
  for (const group of grouped.values()) group.sort((a, b) => compareResults(a[0], b[0]));
  const populated = BANDS.filter(b => grouped.get(b).length);

  for (const band of populated) {
    const group = grouped.get(band);

    const head = document.createElement('div');
    head.className = 'band-head band-' + band;
    head.innerHTML = '<span class="band-title"></span><span class="band-count"></span>';
    head.querySelector('.band-title').textContent = BAND_LABEL[band];
    head.querySelector('.band-count').textContent = group.length;

    const rows = document.createElement('div');
    for (const [res, i] of group) rows.appendChild(buildResultElement(res, i));

    // "Possible" hits are never hidden — a tag that is plainly on the drawing
    // must not be reported as absent — but they are folded away when there is
    // something better to look at first.
    if (band === 'possible' && populated.length > 1) {
      const box = document.createElement('details');
      box.className = 'band-collapse';
      const sum = document.createElement('summary');
      sum.appendChild(head);
      box.appendChild(sum);
      const note = document.createElement('div');
      note.className = 'band-note';
      note.textContent = BAND_NOTE[band];
      box.appendChild(note);
      box.appendChild(rows);
      resultsList.appendChild(box);
    } else {
      resultsList.appendChild(head);
      if (BAND_NOTE[band]) {
        const note = document.createElement('div');
        note.className = 'band-note';
        note.textContent = BAND_NOTE[band];
        resultsList.appendChild(note);
      }
      resultsList.appendChild(rows);
    }
  }
}

// Inline "what does this actually say?" editor. Saving stores a correction
// keyed by the raw OCR string, then re-runs the search so every other
// occurrence of the same misread picks the fix up immediately.
function openFixEditor(itemEl, metaEl, res) {
  if (metaEl.querySelector('.fix-row')) return;
  const row = document.createElement('div');
  row.className = 'fix-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = res.text;
  input.setAttribute('aria-label', 'Correct text for this match');

  const save = document.createElement('button');
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.className = 'cancel';
  cancel.textContent = 'Cancel';

  row.appendChild(input); row.appendChild(save); row.appendChild(cancel);
  metaEl.appendChild(row);
  input.focus();
  input.select();

  const stop = (ev) => ev.stopPropagation();
  row.addEventListener('click', stop);

  function commit() {
    setCorrection(res.rawText, input.value.trim());
    runFullSearch();
  }
  save.addEventListener('click', (ev) => { ev.stopPropagation(); commit(); });
  cancel.addEventListener('click', (ev) => { ev.stopPropagation(); row.remove(); });
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') commit();
    if (ev.key === 'Escape') row.remove();
  });
}

// The matcher already knows where in the NORMALIZED string it matched — which
// it has to, since a confusion match has no findable substring to search for.
// Walk the raw text counting only the characters normalize() keeps, to map
// that normalized span back onto the original text for display.
function highlightMatch(text, pos, len) {
  if (typeof pos !== 'number' || !len) return escapeHtml(text);
  let rawStart = -1, rawEnd = -1, keptCount = 0;
  for (let i=0;i<text.length;i++) {
    // Must mirror normalize() exactly: it keeps A-Z0-9 and drops all else.
    const isKept = /[A-Za-z0-9]/.test(text[i]);
    if (isKept) {
      if (keptCount === pos) rawStart = i;
      if (keptCount === pos + len - 1) { rawEnd = i+1; break; }
      keptCount++;
    }
  }
  if (rawStart === -1) return escapeHtml(text);
  if (rawEnd === -1) rawEnd = text.length;
  return escapeHtml(text.slice(0,rawStart)) + '<mark>' + escapeHtml(text.slice(rawStart,rawEnd)) + '</mark>' + escapeHtml(text.slice(rawEnd));
}

async function buildThumbnail(res, canvasEl) {
  const ctx = canvasEl.getContext('2d');
  const data = S.pageData.get(res.page);
  let src = data.thumbCanvas;
  let srcScale = data.thumbScale;

  if (!src) {
    // no OCR canvas cached (text-layer page) — render a modest-res canvas once and cache it
    const page = await getPageProxy(res.page);
    const vp = page.getViewport({ scale: 1.6 });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    data.thumbCanvas = c; data.thumbScale = 1.6;
    src = c; srcScale = 1.6;
  }

  let box;
  if (res.source === 'text') {
    const page = await getPageProxy(res.page);
    const vp = page.getViewport({ scale: srcScale });
    const pts = [];
    for (const idx of res.itemIndices) {
      const it = data.textItems[idx];
      pts.push(...itemQuadCanvas(it, vp));
    }
    box = boundsOfPoints(pts);
  } else {
    const ratio = srcScale / data.thumbScale; // both same S.scale normally
    box = { minX: res.bbox.x0*ratio, minY: res.bbox.y0*ratio, maxX: res.bbox.x1*ratio, maxY: res.bbox.y1*ratio };
  }

  const w = box.maxX - box.minX, h = box.maxY - box.minY;
  const padX = Math.max(w*0.6, 24), padY = Math.max(h*0.8, 16);
  let sx = box.minX - padX, sy = box.minY - padY;
  let sw = w + padX*2, sh = h + padY*2;
  sx = clamp(sx, 0, src.width); sy = clamp(sy, 0, src.height);
  sw = clamp(sw, 4, src.width - sx); sh = clamp(sh, 4, src.height - sy);

  ctx.fillStyle = '#fff';
  ctx.fillRect(0,0,canvasEl.width, canvasEl.height);
  // preserve aspect ratio, letterbox into the thumbnail
  const scaleFit = Math.min(canvasEl.width/sw, canvasEl.height/sh);
  const dw = sw*scaleFit, dh = sh*scaleFit;
  const dx = (canvasEl.width-dw)/2, dy = (canvasEl.height-dh)/2;
  ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
}

export {
  buildThumbnail,
  compareResults,
  highlightMatch,
  openFixEditor,
  renderResultsList,
};
