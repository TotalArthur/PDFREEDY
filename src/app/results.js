import { S } from './state.js';
import { clamp, escapeHtml } from '../lib/text.js';
import { itemQuadCanvas, boundsOfPoints } from '../lib/geometry.js';
import { setCorrection } from './corrections.js';
import { getPageProxy } from './pdf.js';
import { runFullSearch } from './search.js';
import { jumpToResult } from './viewer.js';
import {
  resultsList,
  exportCsvBtn,
} from './dom.js';

// =======================================================================
// Results list rendering (with thumbnails)
// =======================================================================
function renderResultsList() {
  resultsList.innerHTML = '';
  if (!S.lastResults.length) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = S.currentQuery.norm ? 'No matches yet.' : 'Enter a tag number or string and press Search.';
    resultsList.appendChild(note);
    return;
  }
  S.lastResults.forEach((res, i) => {
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

    const topRow = document.createElement('div');
    topRow.className = 'result-top-row';
    topRow.innerHTML =
      '<span class="badge badge-page">Page ' + res.page + '</span>' +
      '<span class="badge ' + (res.source==='text' ? 'badge-text' : 'badge-ocr') + '">' + (res.source==='text'?'TEXT':'OCR') + '</span>' +
      (res.confused ? '<span class="badge badge-confused" title="Matched through characters OCR cannot reliably distinguish (0/O, 1/I, 5/S, 8/B, 6/G, 2/Z) — check the crop">GLYPH</span>' : '') +
      (res.fuzzy ? '<span class="badge badge-fuzzy">FUZZY</span>' : '') +
      (res.corrected ? '<span class="badge badge-fixed">CORRECTED</span>' : '');
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
    }
    meta.appendChild(topRow);

    const textEl = document.createElement('div');
    textEl.className = 'result-text';
    textEl.innerHTML = highlightMatch(res.text, res.matchPos, res.matchLen);
    meta.appendChild(textEl);

    if (res.source === 'ocr') {
      if (res.corrected) {
        const rawEl = document.createElement('div');
        rawEl.className = 'result-raw';
        rawEl.textContent = 'OCR read: ' + res.rawText;
        meta.appendChild(rawEl);
      }
      const conf = document.createElement('div');
      conf.className = 'result-conf';
      conf.textContent = res.corrected
        ? 'Confirmed by you (OCR read it at ' + Math.round(res.confidence) + '%)'
        : 'OCR confidence: ' + Math.round(res.confidence) + '% — low confidence doesn’t mean wrong; check the crop';
      meta.appendChild(conf);
    }

    el.appendChild(meta);
    el.addEventListener('click', () => jumpToResult(i));
    resultsList.appendChild(el);
  });
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

exportCsvBtn.addEventListener('click', exportCsv);
function exportCsv() {
  const rows = [['Page','Source','Confidence','Matched Text','Corrected','Raw OCR Text']];
  for (const r of S.lastResults) {
    rows.push([
      r.page, r.source,
      r.source==='ocr' ? Math.round(r.confidence)+'%' : '',
      r.text,
      r.corrected ? 'yes' : '',
      r.corrected ? r.rawText : ''
    ]);
  }
  const csv = rows.map(row => row.map(cell => {
    const s = String(cell ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  }).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'pid_tag_matches.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export {
  buildThumbnail,
  exportCsv,
  highlightMatch,
  openFixEditor,
  renderResultsList,
};
