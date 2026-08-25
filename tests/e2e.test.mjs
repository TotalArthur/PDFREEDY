#!/usr/bin/env node
/*
 * End-to-end test of the built page: load index.html in a real browser, open a
 * generated PDF, run searches, and assert the right rows land in the results
 * list.
 *
 * This exists because the app was split out of one inline <script> into
 * modules. The unit tests cover the pure logic; nothing else proves the wiring
 * still works. It runs against the BUILT index.html — the artifact users open.
 *
 * CDN requests are fulfilled from tests/vendor/ so the run is hermetic.
 *
 *   node tests/e2e.test.mjs
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

// ---- static server for the repo root -------------------------------------
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

// ---- fixture: a two-page drawing, one clean tag and one garbled ----------
// The second tag is what an upstream-OCR'd text layer looks like: every wrong
// character is one no engine could physically have distinguished (0/O, 1/l, 6/G).
const dir = mkdtempSync(path.join(tmpdir(), 'pdfreedy-'));
const pdfPath = path.join(dir, 'fixture.pdf');
writeFileSync(pdfPath, makePdf([
  [{ text: 'PT-11004', x: 72, y: 700 },
   { text: 'DRAWING 12-A REV 3', x: 72, y: 660 },
   { text: 'PIPING AND INSTRUMENT DIAGRAM', x: 72, y: 620 }],
  [{ text: 'V-68O1-l5PW4/3-75O-PPGO-RE1', x: 60, y: 500 }],
]));

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.route('https://cdn.jsdelivr.net/**', async (route) => {
  const file = path.join(VENDOR, path.basename(new URL(route.request().url()).pathname));
  if (!existsSync(file)) return route.abort();
  route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(file) });
});

await page.goto(base + 'index.html');
await page.waitForFunction(() => typeof window.pdfjsLib !== 'undefined');

check('page loaded with no script errors', errors.length === 0, errors.join(' | '));
check('search box starts disabled', await page.isDisabled('#searchInput'));

await page.setInputFiles('#fileInput', pdfPath);
await page.waitForFunction(
  () => document.querySelector('#fileInfo').textContent.includes('2 pages'),
  null, { timeout: 30000 });
check('PDF loaded and page count reported', true);

// Both pages are pure text-layer, so processing finishes without OCR.
await page.waitForFunction(
  () => document.querySelector('#procDetailText').textContent.includes('Processed 2 / 2'),
  null, { timeout: 30000 });
check('both pages processed via the text layer', true);

async function search(tag, opts = {}) {
  if (opts.exact) await page.check('#exactToggle'); else await page.uncheck('#exactToggle');
  await page.fill('#searchInput', tag);
  await page.click('#searchBtn');
  await page.waitForTimeout(250);
  return page.$$eval('#resultsList .result-item', els => els.map(e => ({
    text: e.querySelector('.result-text')?.textContent || '',
    badges: [...e.querySelectorAll('.badge')].map(b => b.textContent),
  })));
}

{
  const r = await search('PT-11004');
  check('exact tag is found', r.length === 1 && r[0].text.includes('PT-11004'), JSON.stringify(r));
  check('found via the text layer, not OCR', r[0]?.badges.includes('TEXT'), JSON.stringify(r[0]?.badges));
}
check('substring search finds the tag', (await search('11004')).length === 1);
check('formatting-insensitive search finds the tag', (await search('11-004')).length === 1);
{
  // The headline case: the drawing says V-68O1-l5PW4/3-75O-PPGO-RE1 and the
  // user types the real tag. Only confusion matching bridges that.
  const r = await search('V-6801-15PW4/3-750-PP60-RE1');
  check('glyph-confused tag is found', r.length === 1, JSON.stringify(r));
  check('and is badged GLYPH so it reads as a guess', r[0]?.badges.includes('GLYPH'), JSON.stringify(r[0]?.badges));
}
check('a different tag does not match (precision)', (await search('PT-11005')).length === 0);

// Clicking a result must navigate and highlight without throwing.
await search('V-6801-15PW4/3-750-PP60-RE1');
await page.click('#resultsList .result-item');
await page.waitForTimeout(500);
check('clicking a result jumps to its page',
  (await page.inputValue('#pageNumInput')) === '2', await page.inputValue('#pageNumInput'));

check('no script errors during the whole run', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
