import { S } from './state.js';
import { normalize } from '../lib/text.js';
import { matchWindow } from '../lib/matching.js';
import { TEXT_LEN_THRESHOLD, JOIN_GAP_FACTOR, MAX_WINDOW } from './config.js';
import { getPageProxy } from './pdf.js';

// =======================================================================
// Text-layer extraction + line grouping (handles rotated text via transforms)
// =======================================================================
// Scanned P&IDs sometimes carry a *little* real text (title block fields,
// a drawing number stamped in by whatever produced the PDF) sitting on top
// of a raster image of the actual drawing. If we only looked at character
// count we'd mistake that sliver of real text for a full text layer and
// skip OCR entirely — silently missing every tag that only exists as
// pixels. So: any embedded raster image on the page means "this needs
// OCR too", regardless of how much real text also happens to be present.
async function pageHasImage(page) {
  try {
    const opList = await page.getOperatorList();
    const OPS = pdfjsLib.OPS;
    for (const fn of opList.fnArray) {
      if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintImageXObjectRepeat) {
        return true;
      }
    }
  } catch (err) {
    console.warn('operator list scan failed on page', err);
  }
  return false;
}

// Returns true if the page has enough of a real text layer that OCR can be
// skipped entirely (fast path for native CAD/vector exports).
async function extractTextLayer(pageNum) {
  const page = await getPageProxy(pageNum);
  const textContent = await page.getTextContent();
  const items = textContent.items.filter(it => it.str && it.str.trim().length > 0);

  let rawLen = 0;
  for (const it of items) rawLen += it.str.length;

  const data = S.pageData.get(pageNum);
  data.textItems = items;
  data.rawLen = rawLen;
  if (items.length) {
    data.lineGroups = groupItemsIntoLines(items);
  }

  const hasImage = await pageHasImage(page);
  const confidentTextLayer = rawLen > TEXT_LEN_THRESHOLD && !hasImage;
  if (confidentTextLayer) {
    data.status = 'text-done';
  }
  return confidentTextLayer;
}

function groupItemsIntoLines(items) {
  // Each item has .transform [a,b,c,d,e,f]. Rotation angle + baseline point
  // let us cluster items that sit on the same (possibly rotated) line.
  const enriched = items.map((it, idx) => {
    const t = it.transform;
    const angle = Math.atan2(t[1], t[0]);
    const bx = t[4], by = t[5];
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const parallel = bx*cos + by*sin;
    const perp = -bx*sin + by*cos;
    const fontSize = Math.hypot(t[0], t[1]) || 1;
    return { idx, item: it, angle, parallel, perp, fontSize };
  });

  const buckets = new Map();
  const angleStep = Math.PI / 180; // 1 degree buckets
  for (const e of enriched) {
    const angleKey = Math.round(e.angle / angleStep);
    // perp bucket size scaled to font size so lines of small/large text both cluster sensibly
    const perpKey = Math.round(e.perp / Math.max(2, e.fontSize * 0.5));
    const key = angleKey + '_' + perpKey;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }

  const lines = [];
  for (const bucket of buckets.values()) {
    bucket.sort((a,b) => a.parallel - b.parallel);
    lines.push(bucket);
  }
  return lines;
}

// Build match "windows" (size 1..3 consecutive items on a line) and test against query.
function searchTextLayer(pageNum, query) {
  const data = S.pageData.get(pageNum);
  if (!data || !data.lineGroups) return [];
  const results = [];

  for (const line of data.lineGroups) {
    const covered = new Set();
    for (let winSize = 1; winSize <= MAX_WINDOW; winSize++) {
      for (let start = 0; start + winSize <= line.length; start++) {
        const windowEntries = line.slice(start, start + winSize);
        const idxs = windowEntries.map(e => e.idx);
        if (idxs.some(i => covered.has(i))) continue;

        if (winSize > 1) {
          // require entries to be reasonably close together to justify joining
          let tooFar = false;
          for (let k=0;k<windowEntries.length-1;k++) {
            const a = windowEntries[k], b = windowEntries[k+1];
            const gap = b.parallel - (a.parallel + a.item.width);
            if (gap > a.fontSize * JOIN_GAP_FACTOR) { tooFar = true; break; }
          }
          if (tooFar) continue;
        }

        const text = windowEntries.map(e => e.item.str).join('');
        const norm = normalize(text);
        if (!norm) continue;

        // A PDF text layer is not automatically trustworthy: drawings that were
        // scanned and re-OCR'd upstream carry a text layer with exactly the same
        // glyph confusions as our own OCR, so it gets the same matcher.
        const m = matchWindow(norm, query);
        if (!m) continue;

        idxs.forEach(i => covered.add(i));
        results.push({
          page: pageNum, source: 'text', text: text,
          itemIndices: idxs, confidence: null,
          fuzzy: m.fuzzy, confused: m.confused, matchPos: m.pos, matchLen: m.len
        });
      }
    }
  }
  return results;
}

export {
  extractTextLayer,
  groupItemsIntoLines,
  pageHasImage,
  searchTextLayer,
};
