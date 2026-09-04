import { S } from './state.js';
import { getPageProxy } from './pdf.js';
import { jumpToResult } from './viewer.js';
import { seedPolyline } from './markup.js';
import { itemQuadPdfSpace, boundsOfPoints, applyMatrix } from '../lib/geometry.js';
import { extractVectorSegments, buildLineGraph, anchorPointForTag, traceFromAnchor } from '../lib/vectorlines.js';

// =======================================================================
// "Mark up" button on a search result: auto-trace the pipe/line associated
// with a matched tag using the PDF's own vector path geometry, then seed the
// manual polyline tool with it (see seedPolyline() in markup.js) so the user
// reviews/extends/commits it themselves rather than trusting a blind guess.
// =======================================================================
async function startAutoTrace(i) {
  const res = S.lastResults[i];
  if (!res || res.source !== 'text') return;
  await jumpToResult(i);

  const page = await getPageProxy(res.page);
  const data = S.pageData.get(res.page);
  if (!data.vectorGraph) {
    const { segments, filledShapes } = await extractVectorSegments(page);
    data.vectorGraph = buildLineGraph(segments, filledShapes);
  }

  const pts = [];
  for (const idx of res.itemIndices) pts.push(...itemQuadPdfSpace(data.textItems[idx]));
  const tagBbox = boundsOfPoints(pts);

  const anchor = anchorPointForTag(data.vectorGraph, tagBbox);
  const tracedPdfPoints = anchor ? traceFromAnchor(data.vectorGraph, anchor) : null;

  const viewport = page.getViewport({ scale: S.scale });
  if (tracedPdfPoints && tracedPdfPoints.length >= 2) {
    seedPolyline(tracedPdfPoints.map(([x, y]) => applyMatrix(viewport.transform, x, y)));
  } else {
    // No nearby line found on the page's vector geometry — start the
    // manual polyline right at the tag so the user can draw it by hand.
    const cx = (tagBbox.minX + tagBbox.maxX) / 2;
    const cy = (tagBbox.minY + tagBbox.maxY) / 2;
    seedPolyline([applyMatrix(viewport.transform, cx, cy)]);
  }
}

export { startAutoTrace };
