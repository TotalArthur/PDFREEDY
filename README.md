# PDFREEDY — P&ID Tag Finder

Search a PDF drawing for a tag number and see exactly where every match is.

Built for P&IDs (piping and instrumentation diagrams), where the same tag can appear
on several sheets, labels run vertically along pipe runs, and half the drawings are
scanned rather than native CAD exports.

It is a **single `index.html` file**. Double-click it and it runs. No install, no build
step, no server, no npm.

---

## Privacy

The PDF you open is read in your browser via `FileReader` and never leaves your machine —
nothing is uploaded to any server, including when this page is hosted on GitHub Pages.
Only the two libraries (pdf.js and tesseract.js) are fetched from a public CDN.

> Private property of Arthur Dickson — not for use without express permission.

**Never commit drawings to this repo.** `.gitignore` blocks `*.pdf` and the usual
test-fixture patterns, but check `git status` before you commit anyway.

---

## Using it

1. Open `index.html` (double-click), or the GitHub Pages URL if published.
2. Click **Open PDF**, or drag a PDF anywhere onto the window.
3. Type a tag — `11004`, `PT-11004`, `11-004-PSV` — and hit **Search**.
4. Click a result to jump to that page and zoom to a highlight box drawn over the match.

### Search behaviour

- **Substring by default** — `11004` matches `PT-11004`, `11004-A`, and so on.
- **Formatting-insensitive** — spaces, dashes, slashes and case are ignored on both
  sides, so `11-004` finds `11004`.
- **Exact match** toggle for strict whole-string matching.
- **Fuzzy (OCR only)** toggle uses Levenshtein distance to surface near-misses when OCR
  has garbled a tag. Off by default, because guesses shouldn't look like certainties.

Matches are badged `TEXT` (real PDF text, reliable) or `OCR` (recognised from pixels,
verify it), with the OCR confidence shown.

---

## How pages are processed

Per page, on load:

1. **Text layer first.** `getTextContent()` gives both the text and a transform matrix
   per run, so rotated tags get correctly angled highlight boxes for free.
2. **OCR fallback.** A page is OCR'd if it has little real text *or* contains a raster
   image — scanned sheets often carry a sliver of real text (a title-block stamp) on top
   of an image of the actual drawing, and going by character count alone would skip OCR
   and silently miss every tag on the page.
3. **Lazy and cancellable.** The visible page is processed first, then the rest in the
   background, so you can search finished pages while later ones are still running.
   Per-page progress is live, with **Skip page** and **Cancel** controls.

Results are cached in memory for the session. Re-opening the same file re-runs OCR —
`file://` storage behaves inconsistently across browsers, so it isn't worth the
complexity for cached page data.

### Speed vs. coverage

OCR runs a **single pass in the page's native orientation** by default. A large scanned
sheet takes roughly 1–2 minutes.

Ticking **"Also scan rotated/vertical text"** runs four passes (0°/90°/180°/270°) and
merges them, mapping every box back into page coordinates. This catches vertical line
labels but takes about 4× as long. Off by default.

Tesseract runs in `SPARSE_TEXT` mode with a character whitelist — drawings are line art
with scattered labels, not paragraphs, and that combination measurably cut both noise and
runtime on real sheets.

---

## Correcting OCR mistakes

Scanned engineering fonts defeat OCR sometimes. When a result is wrong, click **Fix text**,
type what it actually says, and save.

This is a **memorised dictionary, not machine learning.** The correction is stored keyed
by the raw misread string, and from then on that misread resolves to the real tag
everywhere — every occurrence, every page, and in later sessions (saved to `localStorage`).
Corrected results are badged `CORRECTED` and still show what OCR originally read.

What it does **not** do:

- It does not generalise. Fixing one `O`→`0` teaches it nothing about `O`→`0` elsewhere.
- It matches the whole garbled string. If the same tag is mangled *differently* on
  another sheet, that's a second correction.
- Re-running OCR with different settings can produce a different garble that won't match
  a saved fix.
- Some browsers block `localStorage` on `file://` pages; corrections then last only for
  the session. The tool handles this gracefully rather than failing.

Use **Clear** to drop all saved corrections.

---

## Other features

- **Export CSV** — page, source, confidence, matched text, and the raw OCR text for
  anything you corrected.
- Zoom (buttons, scroll wheel), drag-to-pan, page navigation.

---

## Running it

Double-clicking the file works in most browsers: pdf.js and tesseract.js load their
workers from `https` CDN URLs, which is normally allowed even from a `file://` page.

Some locked-down Chrome/Edge policies block workers from `file://` entirely. If the page
hangs on load or the console complains about workers, serve the folder over HTTP instead:

```bash
python -m http.server
```

then open <http://localhost:8000>. Publishing to GitHub Pages solves this permanently and
also makes `localStorage` (and therefore saved corrections) reliable.

---

## Built with

- [pdf.js](https://mozilla.github.io/pdf.js/) — rendering and text extraction
- [tesseract.js](https://tesseract.projectnaptha.com/) — OCR

Both loaded from jsDelivr; there is nothing to install.
