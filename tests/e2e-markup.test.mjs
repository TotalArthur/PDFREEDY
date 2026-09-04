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

// ---- exit markup mode, confirm panning works again ----
await page.click('#pencilBtn');
check('pencil button deactivates', !(await page.evaluate(() => document.querySelector('#pencilBtn').classList.contains('active'))));

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
