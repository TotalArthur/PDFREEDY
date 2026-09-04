#!/usr/bin/env node
/*
 * Tests for the auto-trace line markup logic: extracting straight-line
 * vector segments from a synthetic pdf.js-shaped operator list, building a
 * connectivity graph out of them, anchoring a tag's bounding box to its
 * line, and tracing that line's full extent.
 *
 *   node tests/vectorlines.test.js
 */
import {
  segmentsFromOperatorList,
  buildLineGraph,
  anchorPointForTag,
  traceFromAnchor,
  simplifyCollinear,
  angleOffPipeGrid,
} from '../src/lib/vectorlines.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (title) => console.log('\n' + title);

// A minimal stand-in for pdfjsLib.OPS — only the names segmentsFromOperatorList
// actually reads need to exist, and each just needs a unique value.
const OPS = {
  save: 1, restore: 2, transform: 3, setLineWidth: 4, setDash: 5,
  moveTo: 6, lineTo: 7, curveTo: 8, curveTo2: 9, curveTo3: 10,
  rectangle: 11, closePath: 12, constructPath: 13,
  stroke: 14, closeStroke: 15, fill: 16, eoFill: 17,
  fillStroke: 18, eoFillStroke: 19, closeFillStroke: 20, closeEOFillStroke: 21,
  endPath: 22, clip: 23, eoClip: 24,
};

// Builds an operator list out of a batched constructPath (the common modern
// pdf.js shape) plus a paint op, mirroring how the evaluator emits one path
// per stroke/fill.
function opList(...ops) {
  const fnArray = [], argsArray = [];
  for (const [fn, args] of ops) { fnArray.push(fn); argsArray.push(args); }
  return { fnArray, argsArray };
}
function path(pathOps, coords) { return [OPS.constructPath, [pathOps, coords]]; }
function moveLine(pts) {
  // pts: [[x,y], ...] — first is a moveTo, rest are lineTo
  const ops = [OPS.moveTo, ...pts.slice(1).map(() => OPS.lineTo)];
  const coords = pts.flat();
  return path(ops, coords);
}

// ---------------------------------------------------------------------------
section('Extracting straight segments from an operator list');
{
  const ol = opList(
    moveLine([[0, 0], [100, 0], [100, 50]]),
    [OPS.stroke, []],
  );
  const { segments, filledShapes } = segmentsFromOperatorList(ol, OPS);
  check('two segments for a three-point stroked polyline', segments.length === 2);
  check('first segment runs (0,0)->(100,0)',
    segments[0].x0 === 0 && segments[0].y0 === 0 && segments[0].x1 === 100 && segments[0].y1 === 0);
  check('second segment runs (100,0)->(100,50)',
    segments[1].x0 === 100 && segments[1].y0 === 0 && segments[1].x1 === 100 && segments[1].y1 === 50);
  check('no filled shapes recorded for a stroke-only path', filledShapes.length === 0);
}

section('transform (cm) op is applied to path coordinates');
{
  const ol = opList(
    [OPS.save, []],
    [OPS.transform, [1, 0, 0, 1, 10, 20]], // translate by (10,20)
    moveLine([[0, 0], [5, 0]]),
    [OPS.stroke, []],
    [OPS.restore, []],
  );
  const { segments } = segmentsFromOperatorList(ol, OPS);
  check('translated segment start', segments[0].x0 === 10 && segments[0].y0 === 20,
    JSON.stringify(segments));
  check('translated segment end', segments[0].x1 === 15 && segments[0].y1 === 20);
}

section('restore pops the CTM back to what it was before save');
{
  const ol = opList(
    [OPS.transform, [1, 0, 0, 1, 100, 0]],
    [OPS.save, []],
    [OPS.transform, [1, 0, 0, 1, 0, 100]], // now offset (100,100)
    [OPS.restore, []],
    // back to offset (100,0)
    moveLine([[0, 0], [1, 0]]),
    [OPS.stroke, []],
  );
  const { segments } = segmentsFromOperatorList(ol, OPS);
  check('post-restore CTM excludes the popped transform', segments[0].x0 === 100 && segments[0].y0 === 0);
}

section('fill (not stroke) records a bounding box, not a segment');
{
  const ol = opList(
    moveLine([[0, 0], [20, 0], [20, 20], [0, 20]]),
    [OPS.closePath, []],
    [OPS.fill, []],
  );
  const { segments, filledShapes } = segmentsFromOperatorList(ol, OPS);
  check('a filled path contributes no line segments', segments.length === 0);
  check('a filled path contributes one bounding box', filledShapes.length === 1);
  check('the bounding box is correct', filledShapes[0].minX === 0 && filledShapes[0].maxX === 20
    && filledShapes[0].minY === 0 && filledShapes[0].maxY === 20);
}

section('a subpath containing a curve is dropped entirely (v1: curves unsupported)');
{
  const ol = opList(
    path([OPS.moveTo, OPS.curveTo, OPS.lineTo], [0, 0, 1, 1, 2, 2, 10, 10, 20, 20]),
    [OPS.stroke, []],
  );
  const { segments } = segmentsFromOperatorList(ol, OPS);
  check('no segments from a subpath that used a curve op', segments.length === 0);
}

section('rectangle op yields a closed 4-segment loop, excluded from the pipe graph');
{
  const ol = opList(
    path([OPS.rectangle], [0, 0, 10, 5]),
    [OPS.stroke, []],
  );
  const { segments } = segmentsFromOperatorList(ol, OPS);
  check('a stroked rectangle still emits 4 closed segments', segments.length === 4);
  check('every rectangle segment is marked closed', segments.every(s => s.closed));
}

// ---------------------------------------------------------------------------
section('Building a connectivity graph: coincident endpoints snap into one node');
{
  // An L-shaped pipe drawn as two separate segments sharing an endpoint.
  const segments = [
    { x0: 0, y0: 0, x1: 100, y1: 0, strokeWidth: 1, dash: null, closed: false },
    { x0: 100, y0: 0, x1: 100, y1: 100, strokeWidth: 1, dash: null, closed: false },
  ];
  const graph = buildLineGraph(segments, []);
  check('two segments produce three nodes (not four)', graph.nodes.length === 3);
  check('two edges', graph.edges.length === 2);
  const corner = graph.nodes.find(n => n.x === 100 && n.y === 0);
  check('the shared corner has degree 2', (graph.adjacency.get(corner.id) || []).length === 2);
}

section('near-coincident (not exact) endpoints still snap within tolerance');
{
  const segments = [
    { x0: 0, y0: 0, x1: 50, y1: 0, strokeWidth: 1, dash: null, closed: false },
    { x0: 50.4, y0: 0.3, x1: 50, y1: 60, strokeWidth: 1, dash: null, closed: false }, // slightly off endpoint
  ];
  const graph = buildLineGraph(segments, []);
  check('near-coincident endpoints merge into one node', graph.nodes.length === 3);
}

section('closed (rectangle) segments never become graph edges');
{
  const segments = [
    { x0: 0, y0: 0, x1: 10, y1: 0, strokeWidth: 1, dash: null, closed: true },
    { x0: 10, y0: 0, x1: 10, y1: 10, strokeWidth: 1, dash: null, closed: true },
  ];
  const graph = buildLineGraph(segments, []);
  check('closed segments are excluded from edges', graph.edges.length === 0);
}

section('a short, fully isolated stub is dropped; a short segment chained into a run survives');
{
  const isolatedStub = [
    { x0: 500, y0: 500, x1: 503, y1: 500, strokeWidth: 1, dash: null, closed: false }, // len 3, alone
  ];
  const g1 = buildLineGraph(isolatedStub, []);
  check('an isolated 3-unit stub is dropped', g1.edges.length === 0);

  const chained = [
    { x0: 0, y0: 0, x1: 3, y1: 0, strokeWidth: 1, dash: null, closed: false },   // short (len 3)
    { x0: 3, y0: 0, x1: 200, y1: 0, strokeWidth: 1, dash: null, closed: false }, // long, shares an endpoint
  ];
  const g2 = buildLineGraph(chained, []);
  check('a short segment chained into a longer run is kept', g2.edges.length === 2);
}

// ---------------------------------------------------------------------------
section('Anchoring a tag bbox to its nearby line');
{
  // A horizontal line at y=100 from x=0 to x=300; the tag label sits just above it.
  const segments = [{ x0: 0, y0: 100, x1: 300, y1: 100, strokeWidth: 1, dash: null, closed: false }];
  const graph = buildLineGraph(segments, []);
  const tagBbox = { minX: 90, maxX: 130, minY: 80, maxY: 95 }; // label above the line
  const anchor = anchorPointForTag(graph, tagBbox);
  check('anchor found', !!anchor);
  check('anchor point sits on the line (y=100)', Math.abs(anchor.point[1] - 100) < 1e-6);
  check('anchor point sits roughly under the label horizontally',
    anchor.point[0] > tagBbox.minX - 20 && anchor.point[0] < tagBbox.maxX + 20);
}

section('no anchor when nothing is within radius of the tag');
{
  const segments = [{ x0: 0, y0: 0, x1: 10, y1: 0, strokeWidth: 1, dash: null, closed: false }];
  const graph = buildLineGraph(segments, []);
  const farTagBbox = { minX: 10000, maxX: 10010, minY: 10000, maxY: 10005 };
  check('returns null when far from every line', anchorPointForTag(graph, farTagBbox) === null);
}

section('anchoring prefers the closer of two nearby lines');
{
  const segments = [
    { x0: 0, y0: 50, x1: 200, y1: 50, strokeWidth: 1, dash: null, closed: false },  // near
    { x0: 0, y0: 500, x1: 200, y1: 500, strokeWidth: 1, dash: null, closed: false }, // far
  ];
  const graph = buildLineGraph(segments, []);
  const tagBbox = { minX: 90, maxX: 110, minY: 40, maxY: 48 };
  const anchor = anchorPointForTag(graph, tagBbox);
  check('picks the nearer line', Math.abs(anchor.point[1] - 50) < 1e-6);
}

// ---------------------------------------------------------------------------
section('Tracing the full extent of a line from a mid-edge anchor');
{
  // A three-segment run: (0,0)-(100,0)-(100,100)-(200,100), anchored mid-first-segment.
  const segments = [
    { x0: 0, y0: 0, x1: 100, y1: 0, strokeWidth: 1, dash: null, closed: false },
    { x0: 100, y0: 0, x1: 100, y1: 100, strokeWidth: 1, dash: null, closed: false },
    { x0: 100, y0: 100, x1: 200, y1: 100, strokeWidth: 1, dash: null, closed: false },
  ];
  const graph = buildLineGraph(segments, []);
  const tagBbox = { minX: 45, maxX: 55, minY: -20, maxY: -5 }; // above the first segment
  const anchor = anchorPointForTag(graph, tagBbox);
  const traced = traceFromAnchor(graph, anchor);
  check('trace reaches both true endpoints',
    traced.some(([x, y]) => x === 0 && y === 0) && traced.some(([x, y]) => x === 200 && y === 100),
    JSON.stringify(traced));
  check('trace follows through the corner at (100,0) and (100,100)',
    traced.some(([x, y]) => x === 100 && y === 0));
}

section('tracing stops at a branch instead of guessing');
{
  // A T-junction: horizontal run (0,0)-(100,0)-(200,0), plus a stub down from (100,0).
  const segments = [
    { x0: 0, y0: 0, x1: 100, y1: 0, strokeWidth: 1, dash: null, closed: false },
    { x0: 100, y0: 0, x1: 200, y1: 0, strokeWidth: 1, dash: null, closed: false },
    { x0: 100, y0: 0, x1: 100, y1: -100, strokeWidth: 1, dash: null, closed: false },
  ];
  const graph = buildLineGraph(segments, []);
  const tagBbox = { minX: 20, maxX: 40, minY: -20, maxY: -5 };
  const anchor = anchorPointForTag(graph, tagBbox);
  const traced = traceFromAnchor(graph, anchor);
  check('trace reaches the branch node (100,0)', traced.some(([x, y]) => x === 100 && y === 0));
  check('trace does not continue past the branch onto either far arm',
    !traced.some(([x, y]) => x === 200 && y === 0) && !traced.some(([x, y]) => x === 100 && y === -100),
    JSON.stringify(traced));
}

section('tracing stops at a filled-shape "stop zone" (a symbol/arrow/connector)');
{
  const segments = [{ x0: 0, y0: 0, x1: 100, y1: 0, strokeWidth: 1, dash: null, closed: false }];
  const filledShapes = [{ minX: 95, minY: -5, maxX: 105, maxY: 5 }]; // a symbol sitting at the far end
  const graph = buildLineGraph(segments, filledShapes);
  const tagBbox = { minX: 20, maxX: 40, minY: -20, maxY: -5 };
  const anchor = anchorPointForTag(graph, tagBbox);
  const traced = traceFromAnchor(graph, anchor);
  check('trace reaches the endpoint that sits inside the symbol box',
    traced.some(([x, y]) => x === 100 && y === 0));
}

section('an unfilled (stroke-only) closed shape is still a stop zone');
{
  // A valve/instrument icon drawn as an outline-only triangle (stroked,
  // closed, never filled) — the common P&ID convention. Extraction alone
  // must record it as a stop zone even though nothing was ever filled.
  const ol = opList(
    path([OPS.moveTo, OPS.lineTo, OPS.lineTo], [95, -5, 105, -5, 100, 5]),
    [OPS.closePath, []],
    [OPS.stroke, []],
  );
  const { segments, filledShapes } = segmentsFromOperatorList(ol, OPS);
  check('the outline itself is excluded from pipe segments (closed)', segments.every(s => s.closed));
  check('an outline-only closed shape still yields a stop zone', filledShapes.length === 1);
}

section('a trace stops at an unfilled closed symbol instead of running through it');
{
  // The exact failure mode reported: a valve icon drawn outline-only sits at
  // the far end of a straight pipe run. Without recording it as a stop zone,
  // the trace has nothing to halt it and continues straight through.
  const segments = [{ x0: 0, y0: 0, x1: 100, y1: 0, strokeWidth: 1, dash: null, closed: false }];
  const filledShapes = [{ minX: 95, minY: -5, maxX: 105, maxY: 5 }]; // an unfilled valve outline, recorded as above
  const graph = buildLineGraph(segments, filledShapes);
  const tagBbox = { minX: 20, maxX: 40, minY: -20, maxY: -5 };
  const anchor = anchorPointForTag(graph, tagBbox);
  const traced = traceFromAnchor(graph, anchor);
  check('trace stops right at the symbol, not past it',
    traced[traced.length - 1][0] === 100 && traced[traced.length - 1][1] === 0, JSON.stringify(traced));
}

// ---------------------------------------------------------------------------
section('Off-grid angle: telling a pipe run from a diagonal leader/pointer line');
{
  check('a perfectly horizontal edge is on-grid', angleOffPipeGrid(0, 0, 100, 0) < 1e-9);
  check('a perfectly vertical edge is on-grid', angleOffPipeGrid(0, 0, 0, 100) < 1e-9);
  check('a 45-degree edge is on-grid', angleOffPipeGrid(0, 0, 100, 100) < 1e-9);
  check('a 22.5-degree edge is the worst case (off-grid)',
    Math.abs(angleOffPipeGrid(0, 0, 100, Math.tan(Math.PI / 8) * 100) - Math.PI / 8) < 1e-6);
}

section('anchoring prefers a farther axis-aligned pipe over a closer diagonal leader line');
{
  // A short diagonal leader stroke sits right against the label (as leader
  // lines do, by design) at distance ~7; the real pipe is horizontal,
  // further away at distance ~40. Anchoring by raw distance alone would
  // wrongly pick the leader — this is the reported bug.
  const segments = [
    { x0: 100, y0: -7, x1: 110, y1: -37, strokeWidth: 1, dash: null, closed: false }, // diagonal leader (~18° off-grid), close
    { x0: 0, y0: -50, x1: 300, y1: -50, strokeWidth: 1, dash: null, closed: false },  // horizontal pipe, farther
  ];
  const graph = buildLineGraph(segments, []);
  const tagBbox = { minX: 90, maxX: 130, minY: 0, maxY: 12 };
  const anchor = anchorPointForTag(graph, tagBbox);
  check('anchors to the horizontal pipe, not the closer diagonal leader',
    Math.abs(anchor.point[1] - (-50)) < 1e-6, JSON.stringify(anchor));
}

section('no on-grid line nearby at all: anchoring refuses the diagonal rather than using it');
{
  // Only a diagonal is in range — no real pipe anywhere close. Anchoring
  // onto it anyway would seed a trace starting from something that is
  // never actually a pipe, so this must report "nothing found" instead.
  const segments = [
    { x0: 100, y0: -7, x1: 110, y1: -37, strokeWidth: 1, dash: null, closed: false }, // diagonal leader, off-grid
  ];
  const graph = buildLineGraph(segments, []);
  const tagBbox = { minX: 90, maxX: 130, minY: 0, maxY: 12 };
  check('returns null rather than anchoring to the only (off-grid) candidate',
    anchorPointForTag(graph, tagBbox) === null);
}

section('walk refuses to continue onto an off-grid edge, even mid-trace');
{
  // A real pipe corner at (100,0), degree 2 by every other signal (not a
  // branch, not a stop zone) — but the "other" edge there is a stray
  // diagonal (a witness/leader line anchored exactly on the centerline,
  // say), not a further pipe segment. The walk must stop at that corner
  // rather than silently continuing onto the diagonal.
  const segments = [
    { x0: 0, y0: 0, x1: 100, y1: 0, strokeWidth: 1, dash: null, closed: false },     // real pipe leg
    { x0: 100, y0: 0, x1: 140, y1: 90, strokeWidth: 1, dash: null, closed: false },  // stray diagonal (~21° off-grid) touching the same point
  ];
  const graph = buildLineGraph(segments, []);
  const tagBbox = { minX: 20, maxX: 40, minY: -20, maxY: -5 };
  const anchor = anchorPointForTag(graph, tagBbox);
  const traced = traceFromAnchor(graph, anchor);
  check('trace reaches the corner', traced.some(([x, y]) => x === 100 && y === 0));
  check('trace does not follow the off-grid edge past the corner',
    !traced.some(([x, y]) => x === 140 && y === 90), JSON.stringify(traced));
}

// ---------------------------------------------------------------------------
section('Simplifying near-collinear points');
{
  const almostStraight = [[0, 0], [50, 0.01], [100, 0]]; // a hair off dead straight
  const simplified = simplifyCollinear(almostStraight);
  check('a near-straight run collapses to its two endpoints', simplified.length === 2);

  const realCorner = [[0, 0], [100, 0], [100, 100]];
  check('a genuine 90-degree corner is preserved', simplifyCollinear(realCorner).length === 3);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
