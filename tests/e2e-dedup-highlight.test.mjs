#!/usr/bin/env node
/*
 * End-to-end test for two reported issues in the search-match UI:
 *  1. A page with both a real text layer and OCR (pageHasImage forces OCR
 *     even where real text also exists) could show the SAME occurrence
 *     twice — once per source — which read as a confusing "duplicate".
 *  2. The on-canvas highlight box was drawn glyph-tight, hard to see against
 *     the text it's supposed to be calling out.
 *
 * Same hermetic setup as tests/e2e.test.mjs.
 *   node tests/e2e-dedup-highlight.test.mjs
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
for (const f of ['pdf.min.js', 'pdf.worker.min.js', 'tesseract.min.js']) {
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

const dir = mkdtempSync(path.join(tmpdir(), 'pdfreedy-dedup-'));
const pdfPath = path.join(dir, 'mixed.pdf');
// A single tag, real vector text, plus an image forcing OCR over the same
// page — the exact shape of the user's screenshot (one tag, one location,
// found via both text-layer and OCR).
writeFileSync(pdfPath, makePdf([[
  { image: { x: 0, y: 0, w: 612, h: 792 } },
  { text: '18-4-OC-11014-4C6B1-HC', x: 120, y: 500, size: 16 },
]]));

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const MIME = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.gz': 'application/octet-stream' };
await page.route(/cdn\.jsdelivr\.net|tessdata\.projectnaptha\.com/, async (route) => {
  const name = path.basename(new URL(route.request().url()).pathname);
  const file = path.join(VENDOR, name);
  if (!existsSync(file)) return route.abort();
  route.fulfill({ status: 200, contentType: MIME[path.extname(name)] || 'application/octet-stream', body: await readFile(file) });
});

await page.goto(base + 'index.html');
await page.waitForFunction(() => typeof window.pdfjsLib !== 'undefined');
await page.setInputFiles('#fileInput', pdfPath);
await page.waitForFunction(() => document.querySelector('#procDetailText').textContent.includes('done, ready to search'), null, { timeout: 180000 });
check('no script errors after load', errors.length === 0, errors.join(' | '));

await page.fill('#searchInput', '11014');
await page.click('#searchBtn');
await page.waitForTimeout(300);
const rows = await page.$$eval('#resultsList .result-item', els => els.map(e => ({
  text: e.querySelector('.result-text')?.textContent || '',
  badges: [...e.querySelectorAll('.badge')].map(b => b.textContent),
})));
check('the same on-page occurrence appears exactly once, not once per source',
  rows.length === 1, JSON.stringify(rows));
check('the surviving row is the text-layer one (authoritative over a same-position OCR read)',
  rows[0] && rows[0].badges.includes('TEXT'), JSON.stringify(rows));

// ---- highlight box padding: the drawn box must sit outside the glyphs'
// own bounding box, not hug them tight ----
await page.click('#resultsList .result-item');
await page.waitForTimeout(400);
const geometry = await page.evaluate(() => {
  const S = window.__pdfreedyState;
  const res = S.lastResults[S.activeResultIndex];
  const data = S.pageData.get(res.page);
  // The raw (unpadded) glyph width in canvas pixels — item.width is in
  // PDF-space points, and this fixture's text is unrotated, so scaling by
  // the current viewport scale approximates it directly.
  const it = data.textItems[res.itemIndices[0]];
  const rawWidthCanvas = it.width * S.scale;

  const c = document.querySelector('#overlayCanvas');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let minX = Infinity, maxX = -Infinity;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  return { rawWidthCanvas, inkWidth: maxX - minX };
});
check('the drawn highlight box is padded wider than the raw glyph box, not glyph-tight',
  geometry.inkWidth > geometry.rawWidthCanvas,
  `raw=${geometry.rawWidthCanvas.toFixed(1)} drawn=${geometry.inkWidth}`);

await browser.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
