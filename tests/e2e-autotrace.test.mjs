#!/usr/bin/env node
/*
 * End-to-end test of the auto-trace "Mark up" button: search finds a tag on
 * a vector page, the button offers to trace the pipe/line drawn right next
 * to it (real vector geometry, parsed by the real pdf.js build via the
 * app's own getOperatorList() walk in src/lib/vectorlines.js — not a mock),
 * and clicking it seeds the manual polyline tool with the traced path so a
 * plain Enter commits a markup stroke that actually follows the line.
 *
 * Same hermetic setup as tests/e2e-markup.test.mjs.
 *
 *   node tests/e2e-autotrace.test.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePdf } from './lib/make-pdf.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(root, 'tests', 'vendor');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('SKIP: playwright not available (npm i -g playwright)');
  process.exit(0);
}
for (const f of ['pdf.min.js', 'pdf.worker.min.js', 'pdf-lib.min.js', 'tesseract.min.js']) {
  if (!existsSync(path.join(VENDOR, f))) {
    console.log(`SKIP: tests/vendor/${f} missing — run tools/fetch-vendor.sh`);
    process.exit(0);
  }
}

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  try {
    const body = await readFile(path.join(root, rel));
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const dir = mkdtempSync(path.join(tmpdir(), 'pdfreedy-autotrace-'));
const pdfPath = path.join(dir, 'fixture.pdf');

// A vector "pipe" bent once (an elbow), with the tag label sitting just
// above its first leg — the same layout convention real P&IDs use.
const LINE = { points: [[150, 685], [450, 685], [450, 600]], width: 2 };
// Same layout, but on a page that also carries a raster image — a real
// drawing's logo/watermark/legend, say — which forces that page through
// OCR (pageHasImage() sees it). The button used to be gated on "does the
// page have no image at all", which wrongly hid it here even though the
// pipe itself is still real, tracesable vector geometry sitting right next
// to a text-layer tag hit. Regression coverage for that.
const LINE2 = { points: [[150, 585], [450, 585], [450, 500]], width: 2 };

// Page 4: the exact reported failure. A short diagonal leader line sits
// right against the label (closer than the pipe itself — that's a leader's
// whole job), and the real pipe runs on through an unfilled valve icon
// (drawn as one continuous stroke, the valve overlaid on top rather than
// breaking it — a common CAD export convention) all the way to a distant,
// unrelated point. A wrong trace either grabs the leader, or runs straight
// through the valve to that distant point; a correct one follows the real
// pipe and stops right at the valve.
const LEADER = { points: [[210, 695], [225, 665]], width: 1 }; // diagonal, ~18° off-grid, very close to the label
const PIPE4 = { points: [[150, 650], [300, 650], [300, 400]], width: 2 }; // one continuous stroke, valve overlaid mid-run
const VALVE4 = { points: [[290, 640], [310, 640], [300, 662]], width: 1, closed: true }; // outline-only, unfilled

writeFileSync(pdfPath, makePdf([
  [{ text: 'MC-58067', x: 200, y: 700 }, { line: LINE }],
  // Enough text to clear TEXT_LEN_THRESHOLD (stay off the OCR path) but no
  // line item — this page is vector but has nothing nearby to anchor to.
  [{ text: 'SECOND PAGE WITH NO LINE ON IT AT ALL', x: 72, y: 700 }],
  [{ text: 'MC-99999', x: 200, y: 600 }, { line: LINE2 }, { image: { x: 10, y: 10, w: 20, h: 20 } }],
  [{ text: 'MC-88888', x: 200, y: 700 }, { line: LEADER }, { line: PIPE4 }, { line: VALVE4 }],
]));

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const MIME = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.gz': 'application/octet-stream' };
await page.route(/cdn\.jsdelivr\.net|tessdata\.projectnaptha\.com/, async (route) => {
  const name = path.basename(new URL(route.request().url()).pathname);
  const file = path.join(VENDOR, name);
  if (!existsSync(file)) { return route.abort(); }
  route.fulfill({ status: 200, contentType: MIME[path.extname(name)] || 'application/octet-stream', body: await readFile(file) });
});

await page.goto(base + 'index.html');
await page.waitForFunction(() => typeof window.pdfjsLib !== 'undefined');

await page.setInputFiles('#fileInput', pdfPath);
await page.waitForFunction(() => document.querySelector('#fileInfo').textContent.includes('4 pages'), null, { timeout: 30000 });
await page.waitForFunction(() => document.querySelector('#procDetailText').textContent.includes('done, ready to search'), null, { timeout: 30000 });
check('no script errors after load', errors.length === 0, errors.join(' | '));

await page.fill('#searchInput', 'MC-58067');
await page.click('#searchBtn');
await page.waitForSelector('#resultsList .result-item');

const traceBtn = page.locator('#resultsList .result-item .trace-btn').first();
await traceBtn.waitFor({ state: 'visible', timeout: 20000 });
check('the "Mark up" button appears on a vector-page text hit', await traceBtn.isVisible());

await traceBtn.click();
await page.waitForFunction(() => window.__pdfreedyState.mode === 'markup'
  && window.__pdfreedyState.markupTool === 'polyline', null, { timeout: 20000 });
check('clicking it switches into polyline markup mode', true);

const inkBefore = await page.evaluate(() => {
  const ctx = document.querySelector('#overlayCanvas').getContext('2d');
  const { width, height } = ctx.canvas;
  return ctx.getImageData(0, 0, width, height).data.some((v, i) => i % 4 === 3 && v > 0);
});
check('the seeded polyline is already painted on the overlay before any click', inkBefore);

// Finish the seeded polyline exactly as the manual tool would (Enter),
// committing it through the same unmodified commitStroke() path.
await page.keyboard.press('Enter');
await page.waitForFunction(() => {
  const s = window.__pdfreedyState;
  const strokes = s.markups.get(s.currentPage);
  return strokes && strokes.length === 1;
}, null, { timeout: 20000 });

const stroke = await page.evaluate(() => {
  const s = window.__pdfreedyState;
  return s.markups.get(s.currentPage)[0];
});
check('committing the seeded trace produces exactly one polyline stroke', stroke && stroke.tool === 'polyline');
check('the traced stroke has at least 3 points (both elbow corners)', stroke.points.length >= 3,
  JSON.stringify(stroke && stroke.points));

// The stroke's PDF-space points should land close to the fixture's actual
// line geometry — confirms the whole pipeline (real getOperatorList() parse
// -> graph -> anchor -> trace -> canvas seed -> commitStroke's PDF-space
// projection) round-trips correctly, not just that *something* got drawn.
function nearAny(pt, candidates, tol = 3) {
  return candidates.some(([x, y]) => Math.hypot(pt[0] - x, pt[1] - y) <= tol);
}
check('traced points land on the fixture line\'s actual corners',
  stroke.points.some(p => nearAny(p, [LINE.points[0]], 6))
  && stroke.points.some(p => nearAny(p, [LINE.points[1]], 6))
  && stroke.points.some(p => nearAny(p, [LINE.points[2]], 6)),
  JSON.stringify(stroke.points));

// Undo it so the export/undo controls return to their pre-trace state —
// same cleanup pattern as e2e-markup.test.mjs.
await page.click('#markupUndoBtn');

// ---- fallback: a page with no nearby vector line seeds a single point ----
await page.click('#nextPageBtn');
await page.fill('#searchInput', 'SECOND PAGE');
await page.click('#searchBtn');
const secondTraceBtn = page.locator('#resultsList .result-item .trace-btn').first();
const secondBtnVisible = await secondTraceBtn.isVisible().catch(() => false);
if (secondBtnVisible) {
  // Reset to a known 'view' state first — mode is left at 'markup' after the
  // previous trace's Undo (nothing resets it), so without this the very next
  // waitForFunction below could resolve on stale leftover state rather than
  // on this click's own effect.
  await page.evaluate(() => { window.__pdfreedyState.mode = 'view'; });
  await secondTraceBtn.click();
  await page.waitForFunction(() => window.__pdfreedyState.mode === 'markup', null, { timeout: 20000 });
  await page.keyboard.press('Escape'); // a lone seeded point with no line found — just cancel cleanly
  check('a page with no nearby line does not crash the auto-trace flow', true);
} else {
  check('a page with no vector line hides the Mark up button entirely (also a valid outcome)', true);
}

// ---- regression: a page with an embedded raster image (forces OCR too)
// but real vector pipe geometry still gets the button, and still traces ----
await page.click('#nextPageBtn');
await page.fill('#searchInput', 'MC-99999');
await page.click('#searchBtn');
const thirdTraceBtn = page.locator('#resultsList .result-item .trace-btn').first();
await thirdTraceBtn.waitFor({ state: 'visible', timeout: 20000 });
check('the "Mark up" button appears even on a page that also has a raster image',
  await thirdTraceBtn.isVisible());

await page.evaluate(() => { window.__pdfreedyState.mode = 'view'; }); // same reset as above
await thirdTraceBtn.click();
await page.waitForFunction(() => window.__pdfreedyState.mode === 'markup'
  && window.__pdfreedyState.markupTool === 'polyline', null, { timeout: 20000 });
await page.keyboard.press('Enter');
await page.waitForFunction(() => {
  const s = window.__pdfreedyState;
  const strokes = s.markups.get(s.currentPage);
  return strokes && strokes.length === 1;
}, null, { timeout: 20000 });
const stroke3 = await page.evaluate(() => {
  const s = window.__pdfreedyState;
  return s.markups.get(s.currentPage)[0];
});
check('it still traces the real line on that mixed page',
  stroke3.points.some(p => nearAny(p, [LINE2.points[0]], 6))
  && stroke3.points.some(p => nearAny(p, [LINE2.points[1]], 6))
  && stroke3.points.some(p => nearAny(p, [LINE2.points[2]], 6)),
  JSON.stringify(stroke3.points));

// ---- regression: the exact reported bug — a close diagonal leader line
// next to the label, and a valve icon straddling the real pipe further on ----
await page.click('#nextPageBtn');
await page.fill('#searchInput', 'MC-88888');
await page.click('#searchBtn');
const fourthTraceBtn = page.locator('#resultsList .result-item .trace-btn').first();
await fourthTraceBtn.waitFor({ state: 'visible', timeout: 20000 });

await page.evaluate(() => { window.__pdfreedyState.mode = 'view'; });
await fourthTraceBtn.click();
await page.waitForFunction(() => window.__pdfreedyState.mode === 'markup'
  && window.__pdfreedyState.markupTool === 'polyline', null, { timeout: 20000 });
await page.keyboard.press('Enter');
await page.waitForFunction(() => {
  const s = window.__pdfreedyState;
  const strokes = s.markups.get(s.currentPage);
  return strokes && strokes.length === 1;
}, null, { timeout: 20000 });
const stroke4 = await page.evaluate(() => {
  const s = window.__pdfreedyState;
  return s.markups.get(s.currentPage)[0];
});
check('it follows the real pipe, not the closer diagonal leader line',
  stroke4.points.some(p => nearAny(p, [PIPE4.points[0]], 6)), JSON.stringify(stroke4.points));
check('it stops at the valve icon instead of running through it to the distant point',
  !stroke4.points.some(p => nearAny(p, [PIPE4.points[2]], 6)), JSON.stringify(stroke4.points));

check('no script errors during the whole run', errors.length === 0, errors.join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
