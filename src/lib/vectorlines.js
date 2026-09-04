// Auto-trace: reads a vector-drawn PDF page's own line/pipe geometry (via
// pdf.js's getOperatorList) and follows it out from a matched tag to find
// the full run of the pipe the tag labels, so the polyline markup tool can
// be pre-seeded with it instead of the user clicking every corner by hand.
//
// Pure logic, no DOM/canvas dependency — mirrors how lib/windows.js and
// lib/matching.js are structured, so it's directly unit-testable. The only
// pdf.js-shaped input is an operator list ({fnArray, argsArray}) plus the
// OPS name->code map, both handed in by the caller (app/pdf.js side).
//
// Scope: vector pages only. A page with no real path geometry (a scanned
// image) simply won't have any segments to extract — callers should check
// that before offering this feature (see pageIsVector() in app/textlayer.js).

import { boundsOfPoints } from './geometry.js';

const NODE_SNAP_TOLERANCE = 1.5;      // PDF-space units: endpoints closer than this merge into one node
const MIN_PIPE_SEGMENT_LEN = 8;       // PDF-space units: shorter + isolated => treated as symbol ornamentation, not pipe
const COLLINEAR_ANGLE_TOL = 2 * Math.PI / 180; // radians, for simplifying a traced path down to real corners
const ANCHOR_RADIUS_FACTOR = 3;       // multiple of the tag bbox's larger dimension, for "nearby line" search

const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];

function applyCTM(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// Composes a new `cm` (transform op) onto the current CTM: the result maps a
// point the same way as applying `args` first, then the existing `ctm`.
function composeCTM(ctm, args) {
  const [a0, b0, c0, d0, e0, f0] = ctm;
  const [a1, b1, c1, d1, e1, f1] = args;
  return [
    a0 * a1 + c0 * b1,
    b0 * a1 + d0 * b1,
    a0 * c1 + c0 * d1,
    b0 * c1 + d0 * d1,
    a0 * e1 + c0 * f1 + e0,
    b0 * e1 + d0 * f1 + f0,
  ];
}

// Walks a page's operator list, tracking the CTM through save/restore/
// transform ops, and turns every *stroked* straight path into PDF-space line
// segments. Filled shapes (symbol bodies, arrowheads, instrument bubbles)
// are not emitted as segments — their bounding boxes are collected
// separately as "stop zones" a trace should end at. Any subpath containing a
// curve is dropped entirely (unsupported in v1 — mainly rounded symbol
// bodies, which aren't wanted as line segments anyway).
function segmentsFromOperatorList(opList, OPS) {
  const segments = [];
  const filledShapes = [];

  const ctmStack = [];
  let ctm = IDENTITY_MATRIX;
  let lineWidth = 1;
  let dash = null;

  let subpaths = [];
  let cur = null;

  function startSubpath(pt) {
    cur = { points: [pt], closed: false, hasCurve: false };
    subpaths.push(cur);
  }
  function ensureCur(pt) {
    if (!cur) startSubpath(pt);
  }
  function lineOrCurveTo(pt, isCurve) {
    ensureCur(pt);
    cur.points.push(pt);
    if (isCurve) cur.hasCurve = true;
  }

  function runPathOps(opsCodes, coords) {
    let o = 0;
    for (const opCode of opsCodes) {
      if (opCode === OPS.moveTo) {
        startSubpath(applyCTM(ctm, coords[o++], coords[o++]));
      } else if (opCode === OPS.lineTo) {
        lineOrCurveTo(applyCTM(ctm, coords[o++], coords[o++]), false);
      } else if (opCode === OPS.curveTo) {
        const pt = applyCTM(ctm, coords[o + 4], coords[o + 5]);
        o += 6;
        lineOrCurveTo(pt, true);
      } else if (opCode === OPS.curveTo2 || opCode === OPS.curveTo3) {
        const pt = applyCTM(ctm, coords[o + 2], coords[o + 3]);
        o += 4;
        lineOrCurveTo(pt, true);
      } else if (opCode === OPS.rectangle) {
        const x = coords[o++], y = coords[o++], w = coords[o++], h = coords[o++];
        const p0 = applyCTM(ctm, x, y), p1 = applyCTM(ctm, x + w, y);
        const p2 = applyCTM(ctm, x + w, y + h), p3 = applyCTM(ctm, x, y + h);
        cur = { points: [p0, p1, p2, p3, p0], closed: true, hasCurve: false };
        subpaths.push(cur);
      } else if (opCode === OPS.closePath) {
        if (cur && cur.points.length) {
          cur.closed = true;
          const first = cur.points[0], last = cur.points[cur.points.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) cur.points.push(first);
        }
        cur = null;
      }
      // Any other op code inside a batch (shouldn't occur) is ignored.
    }
  }

  function flushSubpaths(stroke, fill) {
    for (const sp of subpaths) {
      if (sp.hasCurve) continue; // curves unsupported — drop the whole subpath
      // A closed shape is a symbol (valve body, instrument bubble, junction
      // box) whether or not it's filled — a lot of P&ID valve/instrument
      // icons are drawn as outline-only (stroked, unfilled) bowties and
      // triangles, not solid shapes. Either way it's a stop zone, not a pipe
      // segment: only an actually-filled shape is excluded further down by
      // buildLineGraph's closed-segment filter, so an unfilled closed
      // outline still needs recording here or a trace would run straight
      // through the symbol with nothing to stop it.
      if (fill || (stroke && sp.closed)) filledShapes.push(boundsOfPoints(sp.points));
      if (stroke) {
        for (let j = 1; j < sp.points.length; j++) {
          const [x0, y0] = sp.points[j - 1];
          const [x1, y1] = sp.points[j];
          if (x0 === x1 && y0 === y1) continue;
          segments.push({ x0, y0, x1, y1, strokeWidth: lineWidth, dash, closed: sp.closed });
        }
      }
    }
    subpaths = [];
    cur = null;
  }

  const singlePathOps = new Set([
    OPS.moveTo, OPS.lineTo, OPS.curveTo, OPS.curveTo2, OPS.curveTo3, OPS.rectangle, OPS.closePath,
  ]);
  const strokeOnlyOps = new Set([OPS.stroke, OPS.closeStroke]);
  const strokeAndFillOps = new Set([OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const fillOnlyOps = new Set([OPS.fill, OPS.eoFill]);

  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) {
      ctmStack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = ctmStack.pop() || IDENTITY_MATRIX;
    } else if (fn === OPS.transform) {
      ctm = composeCTM(ctm, args);
    } else if (fn === OPS.setLineWidth) {
      lineWidth = args[0];
    } else if (fn === OPS.setDash) {
      dash = args[0] && args[0].length ? args[0] : null;
    } else if (fn === OPS.constructPath) {
      runPathOps(args[0], args[1]);
    } else if (singlePathOps.has(fn)) {
      runPathOps([fn], args || []);
    } else if (strokeOnlyOps.has(fn)) {
      flushSubpaths(true, false);
    } else if (strokeAndFillOps.has(fn)) {
      flushSubpaths(true, true);
    } else if (fillOnlyOps.has(fn)) {
      flushSubpaths(false, true);
    } else if (fn === OPS.endPath || fn === OPS.clip || fn === OPS.eoClip) {
      subpaths = [];
      cur = null;
    }
  }

  return { segments, filledShapes };
}

async function extractVectorSegments(page) {
  const opList = await page.getOperatorList();
  return segmentsFromOperatorList(opList, pdfjsLib.OPS);
}

const TEXT_MASK_PAD = 1; // PDF-space units of slack around a text glyph's own box

// Many CAD-exported P&IDs draw every character on the page twice: once as a
// real (searchable) text object, and again as vector stroke artwork tracing
// the glyph outlines, so the drawing renders identically without depending
// on font embedding. Those glyph strokes look exactly like real line
// segments to segmentsFromOperatorList() — dozens of tiny strokes per
// character, chained together by ordinary endpoint-snapping into what looks
// like a normal traceable run, and usually sitting far closer to a tag's own
// label than the actual pipe is. Left in, they don't just add noise: they
// actively win anchoring and traversal over the real line. This removes any
// segment that sits entirely inside a known text glyph's box (both
// endpoints, not just one — a real pipe that merely passes near or under a
// label keeps at least one endpoint well outside a single glyph's small box,
// so it survives). `textBoxes` are {minX,minY,maxX,maxY} in the same
// PDF-space the segments are in — see itemQuadPdfSpace()/boundsOfPoints() in
// lib/geometry.js for how a caller builds them from page text items.
function excludeTextGlyphSegments(segments, textBoxes) {
  if (!textBoxes || !textBoxes.length) return segments;

  const cellSize = 20;
  const boxIndex = new Map(); // "cx_cy" -> [boxIndex,...]
  textBoxes.forEach((b, i) => {
    const x0 = Math.floor(b.minX / cellSize), x1 = Math.floor(b.maxX / cellSize);
    const y0 = Math.floor(b.minY / cellSize), y1 = Math.floor(b.maxY / cellSize);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cx + '_' + cy;
        if (!boxIndex.has(key)) boxIndex.set(key, []);
        boxIndex.get(key).push(i);
      }
    }
  });

  function pointInsideAnyBox(x, y) {
    const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize);
    const ids = boxIndex.get(cx + '_' + cy);
    if (!ids) return false;
    for (const id of ids) {
      const b = textBoxes[id];
      if (x >= b.minX - TEXT_MASK_PAD && x <= b.maxX + TEXT_MASK_PAD
        && y >= b.minY - TEXT_MASK_PAD && y <= b.maxY + TEXT_MASK_PAD) return true;
    }
    return false;
  }

  return segments.filter(s =>
    !(pointInsideAnyBox(s.x0, s.y0) && pointInsideAnyBox(s.x1, s.y1)));
}

// Turns raw segments into a connectivity graph: coincident endpoints are
// snapped into shared nodes (this is what makes a bent pipe drawn as several
// separate stroke ops into one connected run), short isolated stubs are
// dropped as likely symbol ornamentation, and closed subpaths (rectangles/
// polygons — instrument boxes, valve bodies) are excluded as edges outright.
function buildLineGraph(segments, filledShapes = []) {
  const openSegments = segments.filter(s => !s.closed);

  const nodes = [];
  const nodeIndex = new Map(); // "bx_by" -> [nodeId,...]

  function findOrCreateNode(x, y) {
    const bx = Math.round(x / NODE_SNAP_TOLERANCE);
    const by = Math.round(y / NODE_SNAP_TOLERANCE);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const ids = nodeIndex.get((bx + dx) + '_' + (by + dy));
        if (!ids) continue;
        for (const id of ids) {
          const n = nodes[id];
          if (Math.hypot(n.x - x, n.y - y) <= NODE_SNAP_TOLERANCE) return id;
        }
      }
    }
    const id = nodes.length;
    nodes.push({ id, x, y });
    const key = bx + '_' + by;
    if (!nodeIndex.has(key)) nodeIndex.set(key, []);
    nodeIndex.get(key).push(id);
    return id;
  }

  const edges = [];
  for (const s of openSegments) {
    const a = findOrCreateNode(s.x0, s.y0);
    const b = findOrCreateNode(s.x1, s.y1);
    if (a === b) continue;
    const length = Math.hypot(nodes[b].x - nodes[a].x, nodes[b].y - nodes[a].y);
    edges.push({ id: edges.length, a, b, strokeWidth: s.strokeWidth, dash: s.dash, length });
  }

  const adjacency = new Map();
  for (const e of edges) {
    if (!adjacency.has(e.a)) adjacency.set(e.a, []);
    if (!adjacency.has(e.b)) adjacency.set(e.b, []);
    adjacency.get(e.a).push(e.id);
    adjacency.get(e.b).push(e.id);
  }

  // Drop short segments that are fully isolated (both ends degree 1) —
  // typically a valve/instrument glyph's edge rather than a pipe run. A
  // short segment that chains into a longer run (either end shared with
  // another edge) is kept.
  const keptIds = new Set(edges.map(e => e.id));
  for (const e of edges) {
    if (e.length >= MIN_PIPE_SEGMENT_LEN) continue;
    const degA = (adjacency.get(e.a) || []).length;
    const degB = (adjacency.get(e.b) || []).length;
    if (degA <= 1 && degB <= 1) keptIds.delete(e.id);
  }
  // Re-assigns .id to match each edge's position in the filtered array —
  // traceFromAnchor/anchorPointForTag look edges up by graph.edges[id], so a
  // stale id left over from the pre-filter array (which no longer matches
  // its new position once earlier edges have been dropped) would silently
  // resolve to a completely unrelated edge. That was a real bug here, not
  // hypothetical: it's what actually produced the wild, unrelated-looking
  // "diagonal jump" traces seen on real drawings — the walk was reading
  // whatever edge happened to occupy the stale id's array slot, not the
  // edge actually connected to the node it was standing on.
  const finalEdges = edges.filter(e => keptIds.has(e.id)).map((e, i) => ({ ...e, id: i }));

  const finalAdjacency = new Map();
  for (const e of finalEdges) {
    if (!finalAdjacency.has(e.a)) finalAdjacency.set(e.a, []);
    if (!finalAdjacency.has(e.b)) finalAdjacency.set(e.b, []);
    finalAdjacency.get(e.a).push(e.id);
    finalAdjacency.get(e.b).push(e.id);
  }

  return { nodes, edges: finalEdges, adjacency: finalAdjacency, filledShapes };
}

function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0;
  const cx = ax + t * dx, cy = ay + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), t, x: cx, y: cy };
}

// How far an edge's direction sits from the nearest "pipe-like" angle (0°,
// 45°, or 90°) — P&ID process lines are drawn on that grid essentially
// always. A short diagonal leader/pointer stroke from a label to its
// component is often the single closest vector to the label's own text
// (that's its whole job), which would otherwise win anchoring over the
// actual, slightly-farther pipe. Returns radians off the nearest grid angle,
// in [0, PI/8].
function angleOffPipeGrid(ax, ay, bx, by) {
  const angle = Math.atan2(by - ay, bx - ax);
  const folded = ((angle % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2); // fold into [0, 90°)
  const toAxis = Math.min(folded, Math.PI / 2 - folded); // distance to nearest 0°/90°
  const to45 = Math.abs(folded - Math.PI / 4);           // distance to 45°
  return Math.min(toAxis, to45);
}
const ON_GRID_TOL = Math.PI / 12; // 15° — how far off 0/45/90 an edge can be and still count as "pipe-like"

// Finds the line on the page most likely to be "this tag's line": the
// nearest edge within a radius scaled to the tag's own text size, with a
// soft bonus for a line sitting below the label (the common P&ID convention
// of a line number sitting directly above its line). Candidates running at
// a "pipe-like" angle (on/near the 0°/45°/90° grid real process lines are
// always drawn on) are strictly preferred over off-grid ones regardless of
// which is nearer — a short diagonal leader/pointer stroke from a label to
// its component is often the single closest vector to the label (that's its
// whole job), and picking it over a real, slightly farther pipe was the
// reported failure mode: a distance-only score can't be trusted to tell the
// two apart. Off-grid edges are never even considered — not just
// deprioritized — because anchoring onto one is never correct (a real pipe
// run is on-grid by definition), so it's better to report no line found at
// all than to seed a trace starting from a leader/witness/dimension line.
// Returns null if nothing suitable is close enough — callers fall back to
// manual markup.
function anchorPointForTag(graph, tagBbox) {
  const cx = (tagBbox.minX + tagBbox.maxX) / 2;
  const cy = (tagBbox.minY + tagBbox.maxY) / 2;
  const w = tagBbox.maxX - tagBbox.minX;
  const h = tagBbox.maxY - tagBbox.minY;
  const radius = Math.max(w, h, 1) * ANCHOR_RADIUS_FACTOR;

  const pool = [];
  for (const e of graph.edges) {
    const a = graph.nodes[e.a], b = graph.nodes[e.b];
    if (angleOffPipeGrid(a.x, a.y, b.x, b.y) > ON_GRID_TOL) continue;
    const hit = pointToSegmentDistance(cx, cy, a.x, a.y, b.x, b.y);
    if (hit.dist > radius) continue;
    const below = hit.y > tagBbox.maxY ? 1 : 0;
    const score = hit.dist - below * (h * 0.5);
    pool.push({ edge: e, point: [hit.x, hit.y], score });
  }
  if (!pool.length) return null;

  let best = null, bestScore = Infinity;
  for (const c of pool) {
    if (c.score < bestScore) { bestScore = c.score; best = c; }
  }
  return best;
}

function isNearFilledShape(graph, x, y, pad = 2) {
  for (const box of graph.filledShapes) {
    if (x >= box.minX - pad && x <= box.maxX + pad && y >= box.minY - pad && y <= box.maxY + pad) return true;
  }
  return false;
}

// Collapses runs of near-collinear consecutive points so a traced path looks
// like a human clicked one point per real corner, not one per raw vector node.
function simplifyCollinear(points) {
  if (points.length <= 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [ax, ay] = out[out.length - 1];
    const [bx, by] = points[i];
    const [cx, cy] = points[i + 1];
    const a1 = Math.atan2(by - ay, bx - ax);
    const a2 = Math.atan2(cy - by, cx - bx);
    let diff = Math.abs(a1 - a2);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    if (diff > COLLINEAR_ANGLE_TOL) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

// Walks outward from an anchor point (which may sit mid-edge) in both
// directions until each hits a natural stop: a symbol/arrow/off-page
// connector (a filled-shape "stop zone"), a dead end, a branch/junction, or
// an edge that isn't drawn like a pipe. Branches are never guessed through,
// matching the confirmed behavior of handing an ambiguous continuation back
// to the user rather than risking a silently wrong highlight.
//
// The off-grid check matters even though anchorPointForTag() already
// prefers an on-grid starting edge: a node the walk passes through can have
// exactly one edge in front of it (a normal "pass-through corner" by every
// other signal — not a branch, not a stop zone) that is in fact something
// else entirely touching the pipe at that exact point — a witness/leader
// line anchored right on the centerline, or other non-pipe geometry a real
// CAD export can carry. Without this, one such stray edge silently redirects
// the whole rest of the trace onto itself. So every step the walk is about
// to take, not just the first one, has to look like a pipe.
function traceFromAnchor(graph, anchor) {
  if (!anchor) return null;
  const { edge, point } = anchor;

  function walk(startNodeId, cameFromEdgeId) {
    const path = [];
    let currentNode = startNodeId;
    let prevEdge = cameFromEdgeId;
    while (true) {
      const n = graph.nodes[currentNode];
      path.push([n.x, n.y]);
      if (isNearFilledShape(graph, n.x, n.y)) break;
      const forward = (graph.adjacency.get(currentNode) || []).filter(id => id !== prevEdge);
      if (forward.length !== 1) break; // dead end (0) or branch (>=2) — stop, don't guess
      const nextEdge = graph.edges[forward[0]];
      const na = graph.nodes[nextEdge.a], nb = graph.nodes[nextEdge.b];
      if (angleOffPipeGrid(na.x, na.y, nb.x, nb.y) > ON_GRID_TOL) break; // not pipe-like — stop rather than follow it
      currentNode = nextEdge.a === currentNode ? nextEdge.b : nextEdge.a;
      prevEdge = forward[0];
    }
    return path;
  }

  const towardA = walk(edge.a, edge.id).reverse();
  const towardB = walk(edge.b, edge.id);
  const full = [...towardA, point, ...towardB];
  return simplifyCollinear(full);
}

export {
  segmentsFromOperatorList,
  extractVectorSegments,
  excludeTextGlyphSegments,
  buildLineGraph,
  anchorPointForTag,
  traceFromAnchor,
  simplifyCollinear,
  angleOffPipeGrid,
};
