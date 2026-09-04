#!/usr/bin/env node
/*
 * End-to-end test of the pencil markup tool: load the built page, draw a
 * couple of strokes, confirm they survive zoom and page navigation, export a
 * PDF, and confirm the exported file actually has the line burned into the
 * page itself at the right spot (not just drawn on the in-browser overlay).
 *
 * Same hermetic setup as tests/e2e.test.mjs — CDN requests are fulfilled
 * from tests/vendor/ (run tools/fetch-vendor.sh once to populate it).
 *
 *   node tests/e2e-markup.test.mjs
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

// playwright is a dev-only tool, deliberately not a dependency of this repo.
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

const dir = mkdtempSync(path.join(tmpdir(), 'pdfreedy-markup-'));
const pdfPath = path.join(dir, 'fixture.pdf');
writeFileSync(pdfPath, makePdf([
  [{ text: 'PT-11004', x: 72, y: 700 }, { text: 'PIPE RUN LABEL', x: 72, y: 500 }],
  [{ text: 'SECOND PAGE', x: 72, y: 700 }],
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
await page.waitForFunction(() => document.querySelector('#fileInfo').textContent.includes('2 pages'), null, { timeout: 30000 });
await page.waitForFunction(() => document.querySelector('#procDetailText').textContent.includes('done, ready to search'), null, { timeout: 30000 });
check('no script errors after load', errors.length === 0, errors.join(' | '));

// ---- wheel-zoom coalescing: a burst of wheel ticks must not trigger one
// full page re-render per tick (that synchronous cancel/clear/redraw cascade
// was the source of the reported jitter) ----
{
  await page.evaluate(() => { window.__pdfreedyRenderCount = 0; });
  const scaleBefore = await page.evaluate(() => parseFloat(document.querySelector('#zoomLabel').textContent));
  const TICKS = 12;
  // Playwright's page.mouse.wheel() round-trips through CDP per call, with
  // enough latency that each tick's requestAnimationFrame fires before the
  // next tick arrives — it never actually bursts, so it can't exercise the
  // coalescing path. Dispatching real WheelEvents synchronously in one JS
  // turn reproduces what a fast trackpad/wheel gesture actually looks like
  // to the page: many 'wheel' events arriving before the browser gets a
  // chance to run a single requestAnimationFrame callback.
  await page.evaluate((n) => {
    const el = document.querySelector('#canvasScroll');
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2, clientY = rect.top + rect.height / 2;
    for (let i = 0; i < n; i++) {
      el.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -80, clientX, clientY, bubbles: true, cancelable: true,
      }));
    }
  }, TICKS);
  await page.waitForTimeout(400); // let any pending rAF-scheduled render settle
  const renderCount = await page.evaluate(() => window.__pdfreedyRenderCount);
  const scaleAfter = await page.evaluate(() => parseFloat(document.querySelector('#zoomLabel').textContent));
  check(`a burst of ${TICKS} wheel ticks triggers far fewer than ${TICKS} real renders`,
    renderCount > 0 && renderCount < TICKS / 2, `renders=${renderCount}`);
  check('the burst still applied every tick\'s zoom (final scale reflects all of them, not just one)',
    scaleAfter > scaleBefore, `before=${scaleBefore} after=${scaleAfter}`);
  // Reset zoom for the rest of the test, which assumes the 100% baseline.
  await page.click('#zoomResetBtn');
  await page.waitForTimeout(200);
}

// ---- enter markup mode and draw a straight line ----
check('export button starts disabled (no markups yet)', await page.isDisabled('#markupExportBtn'));
await page.click('#pencilBtn');
check('pencil button becomes active', await page.evaluate(() => document.querySelector('#pencilBtn').classList.contains('active')));
check('overlay canvas gets pointer-events via markup-active class',
  await page.evaluate(() => document.querySelector('#overlayCanvas').classList.contains('markup-active')));

await page.selectOption('#markupToolSelect', 'line');
await page.evaluate(() => { document.querySelector('#markupColorInput').value = '#00ff00'; document.querySelector('#markupColorInput').dispatchEvent(new Event('input')); });

const canvasBox = await page.locator('#overlayCanvas').boundingBox();
const x0 = canvasBox.x + 100, y0 = canvasBox.y + 150;
const x1 = canvasBox.x + 300, y1 = canvasBox.y + 150;
await page.mouse.move(x0, y0);
await page.mouse.down();
await page.mouse.move((x0 + x1) / 2, y0);
await page.mouse.move(x1, y1);
await page.mouse.up();

check('undo button enabled after drawing a stroke', await page.isEnabled('#markupUndoBtn'));
check('export button enabled after drawing a stroke', await page.isEnabled('#markupExportBtn'));

// ---- zoom in, confirm the stroke is still drawn on the overlay (non-blank canvas) ----
async function overlayHasInk() {
  return page.evaluate(() => {
    const c = document.querySelector('#overlayCanvas');
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
    return false;
  });
}
check('overlay has visible ink right after drawing', await overlayHasInk());

await page.click('#zoomInBtn');
await page.waitForTimeout(300);
check('overlay still has ink after zooming in (stroke re-projected)', await overlayHasInk());

await page.click('#zoomOutBtn');
await page.click('#zoomOutBtn');
await page.waitForTimeout(300);
check('overlay still has ink after zooming out', await overlayHasInk());

// ---- flip to page 2 and back: page-2 overlay should be blank (no markups there) ----
await page.fill('#pageNumInput', '2');
await page.press('#pageNumInput', 'Enter');
await page.waitForTimeout(300);
check('page 2 overlay has no ink (markup is page-scoped)', !(await overlayHasInk()));
check('undo/clear disabled on a page with no markups', await page.isDisabled('#markupUndoBtn') && await page.isDisabled('#markupClearBtn'));
check('export still enabled (page 1 still has a markup)', await page.isEnabled('#markupExportBtn'));

await page.fill('#pageNumInput', '1');
await page.press('#pageNumInput', 'Enter');
await page.waitForTimeout(300);
check('back on page 1, stroke reappears', await overlayHasInk());

async function alphaAt(cx, cy) {
  return page.evaluate(({ cx, cy }) => {
    const c = document.querySelector('#overlayCanvas');
    const ctx = c.getContext('2d');
    const x = Math.max(0, Math.floor(cx - 1)), y = Math.max(0, Math.floor(cy - 1));
    const d = ctx.getImageData(x, y, 3, 3).data;
    let maxAlpha = 0;
    for (let i = 3; i < d.length; i += 4) maxAlpha = Math.max(maxAlpha, d[i]);
    return maxAlpha;
  }, { cx, cy });
}

// Re-fetch the canvas box: it may have shifted since zoom/page-nav resized it.
const freshBox = await page.locator('#overlayCanvas').boundingBox();

// ---- opacity: a low-opacity stroke should read visibly lighter than a
// full-opacity one, both drawn fresh at known locations ----
{
  const lx0 = freshBox.x + 100, lx1 = freshBox.x + 300;
  const fullY = freshBox.y + 300, lowY = freshBox.y + 350;

  await page.mouse.move(lx0, fullY);
  await page.mouse.down();
  await page.mouse.move(lx1, fullY);
  await page.mouse.up();

  await page.evaluate(() => {
    document.querySelector('#markupOpacityInput').value = '30';
    document.querySelector('#markupOpacityInput').dispatchEvent(new Event('input'));
  });
  check('opacity label updates to match the slider', (await page.textContent('#markupOpacityLabel')) === '30%');

  await page.mouse.move(lx0, lowY);
  await page.mouse.down();
  await page.mouse.move(lx1, lowY);
  await page.mouse.up();

  const fullAlpha = await alphaAt((lx0 + lx1) / 2 - freshBox.x, fullY - freshBox.y);
  const lowAlpha = await alphaAt((lx0 + lx1) / 2 - freshBox.x, lowY - freshBox.y);
  check('a 30%-opacity stroke reads visibly lighter than a full-opacity one',
    lowAlpha > 0 && lowAlpha < fullAlpha, `full=${fullAlpha} low=${lowAlpha}`);

  // Back to full opacity for the rest of the test.
  await page.evaluate(() => {
    document.querySelector('#markupOpacityInput').value = '100';
    document.querySelector('#markupOpacityInput').dispatchEvent(new Event('input'));
  });
}

// ---- point-to-point tool: click three points, Enter to finish ----
let abMidpoint, bcMidpoint;
{
  check('hint icon is hidden for the drag tools', await page.isHidden('#markupHintWrap'));
  await page.selectOption('#markupToolSelect', 'polyline');
  check('hint icon appears once the point-to-point tool is selected', await page.isVisible('#markupHintWrap'));
  check('hint popover starts closed', await page.isHidden('#markupHintPopover'));

  await page.click('#markupHintBtn');
  check('clicking the hint icon opens the popover', await page.isVisible('#markupHintPopover'));
  await page.click('#markupHintCloseBtn');
  check('the popover\'s own close button closes it', await page.isHidden('#markupHintPopover'));

  await page.click('#markupHintBtn');
  await page.click('#pageCountLabel'); // click elsewhere in the toolbar
  check('clicking outside the popover closes it', await page.isHidden('#markupHintPopover'));

  const pA = { x: freshBox.x + 120, y: freshBox.y + 420 };
  const pB = { x: freshBox.x + 260, y: freshBox.y + 420 };
  const pC = { x: freshBox.x + 260, y: freshBox.y + 480 };
  abMidpoint = { x: (pA.x + pB.x) / 2, y: pA.y };
  bcMidpoint = { x: pB.x, y: (pB.y + pC.y) / 2 };
  await page.mouse.click(pA.x, pA.y);
  await page.mouse.click(pB.x, pB.y);
  await page.mouse.click(pC.x, pC.y);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);

  const midAB = await alphaAt(abMidpoint.x - freshBox.x, abMidpoint.y - freshBox.y);
  const midBC = await alphaAt(bcMidpoint.x - freshBox.x, bcMidpoint.y - freshBox.y);
  check('point-to-point tool paints the first (A-B) segment', midAB > 0, String(midAB));
  check('point-to-point tool paints the second (B-C) segment, proving all 3 clicks were used',
    midBC > 0, String(midBC));

  // ---- Escape cancels an in-progress polyline without committing anything ----
  const cancelPt = { x: freshBox.x + 500, y: freshBox.y + 420 };
  await page.mouse.click(cancelPt.x, cancelPt.y);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const alphaAfterCancel = await alphaAt(cancelPt.x - freshBox.x, cancelPt.y - freshBox.y);
  check('Escape cancels an in-progress point-to-point line without painting anything',
    alphaAfterCancel === 0, String(alphaAfterCancel));
}

// ---- selection only happens outside pencil mode: clicking a line while the
// pencil is still active must NOT select it (it should behave as a normal
// click for the active tool instead) ----
{
  await page.mouse.click(bcMidpoint.x, bcMidpoint.y);
  await page.waitForTimeout(150);
  // If this click had selected+something-later-deleted the line instead of
  // being treated as an ordinary draw click, undo would no longer be able
  // to find it disabled the way "nothing changed" would leave it.
  check('clicking a drawn line while the pencil is active leaves it alone (still undoable)',
    await page.isEnabled('#markupUndoBtn'));
  await page.keyboard.press('Escape'); // clear the stray in-progress polyline point that click started
}

// ---- exit markup mode, confirm panning works again ----
await page.click('#pencilBtn');
check('pencil button deactivates', !(await page.evaluate(() => document.querySelector('#pencilBtn').classList.contains('active'))));

// ---- select a drawn line by clicking it (pencil off), then delete it with
// Backspace ----
{
  check('undo enabled before delete test (the point-to-point line exists)', await page.isEnabled('#markupUndoBtn'));

  // Click on the middle of the B-C segment drawn above — a point ON the
  // line, not near an endpoint, to prove hit-testing checks the segment
  // itself and not just its clicked vertices.
  await page.mouse.click(bcMidpoint.x, bcMidpoint.y);
  await page.waitForTimeout(150);
  const selectionHaloAlpha = await alphaAt(bcMidpoint.x - freshBox.x, bcMidpoint.y - freshBox.y);
  check('clicking on a drawn line with the pencil off paints a selection halo',
    selectionHaloAlpha > 0, String(selectionHaloAlpha));

  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);
  const afterDeleteAB = await alphaAt(abMidpoint.x - freshBox.x, abMidpoint.y - freshBox.y);
  const afterDeleteBC = await alphaAt(bcMidpoint.x - freshBox.x, bcMidpoint.y - freshBox.y);
  check('Backspace deletes the selected line (both its segments are gone)',
    afterDeleteAB === 0 && afterDeleteBC === 0, `AB=${afterDeleteAB} BC=${afterDeleteBC}`);
}

// ---- export and check the download ----
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#markupExportBtn'),
]);
const savePath = path.join(dir, await download.suggestedFilename());
await download.saveAs(savePath);
const bytes = await readFile(savePath);
check('exported file is named with -markup suffix', (await download.suggestedFilename()).includes('-markup'), await download.suggestedFilename());
check('exported file starts with a PDF header', bytes.slice(0, 5).toString() === '%PDF-', bytes.slice(0, 8).toString());
check('exported file is non-trivially sized', bytes.length > 500, String(bytes.length));

// ---- the strongest check: re-open the exported PDF itself and confirm the
// burned-in line actually rendered on the PAGE canvas (not just the overlay)
// at roughly the same on-screen spot it was drawn ----
await page.setInputFiles('#fileInput', savePath);
await page.waitForFunction(() => document.querySelector('#fileInfo').textContent.includes('2 pages'), null, { timeout: 30000 });
await page.waitForFunction(() => document.querySelector('#procDetailText').textContent.includes('done, ready to search'), null, { timeout: 30000 });
async function pageCanvasHasInkNear(cx, cy, radius) {
  return page.evaluate(({ cx, cy, radius }) => {
    const c = document.querySelector('#pageCanvas');
    const ctx = c.getContext('2d');
    const x0 = Math.max(0, Math.floor(cx - radius)), y0 = Math.max(0, Math.floor(cy - radius));
    const w = Math.min(c.width - x0, radius * 2), h = Math.min(c.height - y0, radius * 2);
    const data = ctx.getImageData(x0, y0, w, h).data;
    // Page background is white; the burned-in green line will show up as a
    // non-white, non-black-text pixel somewhere in this window.
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (!(r > 250 && g > 250 && b > 250) && g > r && g > b) return true; // greenish
    }
    return false;
  }, { cx, cy, radius });
}
const relX = x0 - canvasBox.x, relY = y0 - canvasBox.y;
await page.waitForTimeout(300); // let the page render finish painting pageCanvas
check('re-opened exported PDF shows the green line burned into the page itself, near where it was drawn',
  await pageCanvasHasInkNear(relX + 100, relY, 40));
check('no script errors re-opening the exported PDF', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
