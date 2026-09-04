import { S } from './state.js';
import { getPageProxy } from './pdf.js';
import { jumpToResult } from './viewer.js';
import { seedPolyline } from './markup.js';
import { itemQuadPdfSpace, boundsOfPoints, applyMatrix } from '../lib/geometry.js';
import {
  extractVectorSegments, excludeTextGlyphSegments, buildLineGraph, anchorPointForTag, traceFromAnchor,
} from '../lib/vectorlines.js';

// =======================================================================
// "Mark up" button on a search result: auto-trace the pipe/line associated
// with a matched tag using the PDF's own vector path geometry, then seed the
// manual polyline tool with it (see seedPolyline() in markup.js) so the user
// reviews/extends/commits it themselves rather than trusting a blind guess.
// =======================================================================

// Extracts (and caches, per page) the vector line graph. Deliberately not
// gated on pageHasImage()/pageIsVector() — a page can carry a raster logo or
// watermark (forcing OCR for that image) while the rest of the drawing is
// still real stroked vector linework, and that linework is exactly what
// this needs. So the graph is what actually decides "is there anything
// here to trace", not whether the page happens to contain any image at all.
async function getPageLineGraph(pageNum) {
  const data = S.pageData.get(pageNum);
  if (!data.vectorGraph) {
    const page = await getPageProxy(pageNum);
    const { segments, filledShapes } = await extractVectorSegments(page);
    // Some CAD exports draw every character twice: once as real (searchable)
    // text, and again as vector stroke artwork tracing the glyph outlines,
    // so the page renders correctly without depending on font embedding.
    // Those strokes are indistinguishable from real line segments to the
    // extractor and, sitting right next to every label, would otherwise win
    // anchoring/traversal over the actual pipe — so anywhere a real text
    // item already accounts for the ink, strip it before building the graph.
    const textBoxes = (data.textItems || []).map(it => boundsOfPoints(itemQuadPdfSpace(it)));
    const pipeSegments = excludeTextGlyphSegments(segments, textBoxes);
    data.vectorGraph = buildLineGraph(pipeSegments, filledShapes);
  }
  return data.vectorGraph;
}

// Whether a page has any traceable vector line at all — used to decide
// whether the "Mark up" button is worth offering on a given result.
async function pageHasVectorLines(pageNum) {
  const graph = await getPageLineGraph(pageNum);
  return graph.edges.length > 0;
}

async function startAutoTrace(i) {
  const res = S.lastResults[i];
  if (!res || res.source !== 'text') return;
  await jumpToResult(i);

  const page = await getPageProxy(res.page);
  const data = S.pageData.get(res.page);
  const graph = await getPageLineGraph(res.page);

  const pts = [];
  for (const idx of res.itemIndices) pts.push(...itemQuadPdfSpace(data.textItems[idx]));
  const tagBbox = boundsOfPoints(pts);

  const anchor = anchorPointForTag(graph, tagBbox);
  const tracedPdfPoints = anchor ? traceFromAnchor(graph, anchor) : null;

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

export { startAutoTrace, pageHasVectorLines };
