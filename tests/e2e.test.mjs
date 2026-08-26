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
  [{ text: 'V-68O1-l5PW4/3-75O-PPGO-RE1', x: 60, y: 500 },
   { text: 'FC2015', x: 60, y: 440 }],
]));

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

// pdf.js, tesseract.js, its worker/core, and the language data all come from
// tests/vendor/ so a run needs no network at all.
const MIME = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.gz': 'application/octet-stream' };
await page.route(/cdn\.jsdelivr\.net|tessdata\.projectnaptha\.com/, async (route) => {
  const name = path.basename(new URL(route.request().url()).pathname);
  const file = path.join(VENDOR, name);
  if (!existsSync(file)) {
    console.log(`    (not vendored, aborting: ${name})`);
    return route.abort();
  }
  route.fulfill({
    status: 200,
    contentType: MIME[path.extname(name)] || 'application/octet-stream',
    body: await readFile(file),
  });
});

await page.goto(base + 'index.html');
await page.waitForFunction(() => typeof window.pdfjsLib !== 'undefined');

check('page loaded with no script errors', errors.length === 0, errors.join(' | '));
check('search box starts disabled', await page.isDisabled('#searchInput'));
check('both match tiers start ticked',
  await page.isChecked('#exactToggle') && await page.isChecked('#fuzzyToggle'));

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
check('the status line says the run is finished, not just how far it got',
  (await page.textContent('#procDetailText')).includes('done, ready to search'),
  await page.textContent('#procDetailText'));
check('the loading cover is off the drawing once reading is done',
  !(await page.isVisible('#viewerLoading')));
check('search opens once every page has been read', await page.isEnabled('#searchInput'));

// Both tiers ship ticked, which is what a search runs with unless a case says
// otherwise. Exact only *restricts* (the tag must be the whole string) when it
// is asked for on its own, i.e. with fuzzy off.
async function search(tag, { exact = true, fuzzy = true } = {}) {
  await page.setChecked('#exactToggle', exact);
  await page.setChecked('#fuzzyToggle', fuzzy);
  await page.fill('#searchInput', tag);
  await page.click('#searchBtn');
  await page.waitForTimeout(250);
  return page.$$eval('#resultsList .result-item', els => els.map(e => ({
    text: e.querySelector('.result-text')?.textContent || '',
    badges: [...e.querySelectorAll('.badge')].map(b => b.textContent),
  })));
}
const bandsShown = () => page.$$eval('#resultsList .band-head',
  els => els.map(e => e.className.split(' ').find(c => c.startsWith('band-') && c !== 'band-head')));

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
check('a different tag does not match (precision)',
  (await search('PT-11005', { fuzzy: false })).length === 0);
{
  // With the last-resort tier on by default a one-character-off tag can still
  // surface — it just must never be presented as a match.
  const r = await search('PT-11005');
  const bands = await bandsShown();
  check('a near-miss is only ever offered as a Possible',
    r.length === 0 || bands.every(b => b === 'band-possible'), JSON.stringify(bands));
}

// ---- confidence banding -------------------------------------------------
{
  await search('PT-11004');
  check('an exact hit sits under Matches', (await bandsShown()).includes('band-confirmed'),
    JSON.stringify(await bandsShown()));
}
{
  await search('V-6801-15PW4/3-750-PP60-RE1');
  check('a glyph-confused hit sits under Likely, not Matches',
    (await bandsShown()).includes('band-likely'), JSON.stringify(await bandsShown()));
}
{
  // The drawing says FC2015; the tag is FIC-2015. With the last-resort tier off
  // nothing matches on the cheap pass, so the search escalates to allow the
  // erased I — and says so.
  const r = await search('FIC-2015', { exact: false, fuzzy: false });
  check('a tag with a character erased is still found', r.length === 1, JSON.stringify(r));
  check('and is filed under Possible, not presented as a match',
    (await bandsShown()).includes('band-possible'), JSON.stringify(await bandsShown()));
  const summary = await page.textContent('#searchSummary');
  check('and the summary says the search had to try harder',
    /lost entirely/.test(summary), summary);
  // Under the shipped defaults the same tag is found by the fuzzy tier
  // instead — by a different route, but still never as a certainty.
  check('and under the default toggles it is still only a Possible',
    (await search('FIC-2015')).length === 1 &&
    (await bandsShown()).every(b => b === 'band-possible'), JSON.stringify(await bandsShown()));
}

// Clicking a result must navigate and highlight without throwing.
await search('V-6801-15PW4/3-750-PP60-RE1');
await page.click('#resultsList .result-item');
await page.waitForTimeout(500);
check('clicking a result jumps to its page',
  (await page.inputValue('#pageNumInput')) === '2', await page.inputValue('#pageNumInput'));

// ---- the OCR path -------------------------------------------------------
// A page with almost no text layer falls through to OCR (TEXT_LEN_THRESHOLD),
// so this exercises render -> binarize -> Tesseract -> word joining -> match
// on the built page, which the unit tests can't reach.
if (process.env.SKIP_OCR) {
  console.log('  skip OCR path (SKIP_OCR set)');
} else {
  const ocrPath = path.join(dir, 'ocr.pdf');
  writeFileSync(ocrPath, makePdf([[{ text: 'PT-9042', x: 20, y: 60, size: 24 }]],
    { width: 260, height: 120 }));
  await page.setInputFiles('#fileInput', ocrPath);
  // OCR is slow enough to observe the reading state itself: the drawing is
  // covered and the search box is shut while the page is being read.
  await page.waitForFunction(
    () => document.querySelector('#viewerLoading').classList.contains('visible'),
    null, { timeout: 30000 });
  check('the drawing is covered while it is being read', true);
  check('search is shut while the document is being read',
    await page.isDisabled('#searchInput'));

  await page.waitForFunction(
    () => document.querySelector('#procDetailText').textContent.includes('via OCR'),
    null, { timeout: 180000 });
  check('a page with no real text layer is routed to OCR', true);
  await page.waitForFunction(
    () => document.querySelector('#procDetailText').textContent.includes('done, ready to search'),
    null, { timeout: 180000 });

  // This page has a thin text layer AND was OCR'd, so both sources report it —
  // which is the intended behaviour (pageHasImage / TEXT_LEN_THRESHOLD), and
  // the OCR row is the one that proves the pixel path works end to end.
  const r = await search('PT-9042');
  check('OCR-read tag is found', r.length >= 1, JSON.stringify(r));
  check('an OCR row is present, not only the text-layer row',
    r.some(x => x.badges.includes('OCR')), JSON.stringify(r.map(x => x.badges)));

  // ---- asking for rotated text after the fact ---------------------------
  // Ticking the box mid-document has to put the page back to work rather than
  // silently applying to nothing.
  await page.check('#rotatedTextToggle');
  check('ticking rotated-text scanning starts reading again',
    await page.isDisabled('#searchInput') &&
    await page.evaluate(() => document.querySelector('#viewerLoading').classList.contains('visible')));
  await page.waitForFunction(
    () => document.querySelector('#procDetailText').textContent.includes('done, ready to search'),
    null, { timeout: 180000 });
  check('and finishes back in a searchable state', await page.isEnabled('#searchInput'));
  check('the tag is still found after the extra passes',
    (await search('PT-9042')).length >= 1);
}

check('no script errors during the whole run', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
