# PDFREEDY — P&ID Tag Finder

Search a PDF drawing for a tag number and see exactly where every match is.

Built for P&IDs (piping and instrumentation diagrams), where the same tag can appear
on several sheets, labels run vertically along pipe runs, and half the drawings are
scanned rather than native CAD exports.

For anyone using it, it is still a **single `index.html` file**: double-click it and it
runs. No install, no server, nothing to set up.

For anyone *changing* it, the source now lives in `src/` as ES modules and `index.html`
is built from them — see [Developing](#developing).

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
- **Glyph-confusion tolerant** — the big one. See below.
- **Dropped-character tolerant** — blur doesn't only turn characters into other
  characters, it erases them. `FIC-2015` comes back as `FC2015`, `XV-3308` as
  `X-3308`. See below.
- **Exact match** toggle for strict whole-string matching.
- **Confidence-aware** — a character OCR admitted it couldn't read is cheap to
  match across; one it was sure of is not. See below.
- **Fuzzy** toggle is the last resort: it treats *every* character as uncertain,
  not just the ones OCR flagged. Off by default, because guesses shouldn't look
  like certainties.

### "I couldn't read that" is not evidence against a match

OCR reports how sure it was of every word. That number used to be printed on the
result row and otherwise ignored — a character read at 0% cost exactly as much to
overlook as one read at 99%. Those are not the same claim at all. A 0% read is the
engine saying *I can't make this out*; an 87% read is a confident disagreement.

Now an unlisted substitution is allowed, priced inversely to how sure the engine
was: `0.5 / (1 − confidence)`. There is no threshold to tune — the cost simply
runs away as confidence rises, and at full confidence it is impossible.

| OCR was | replacing that character costs | |
|---|---|---|
| 0% sure | 0.50 | affordable for any tag |
| 50% sure | 1.00 | only for a long tag with a lot else corroborating |
| 87% sure | 3.85 | never |
| certain | — | impossible |

This is self-limiting: it can only ever be spent where the engine already admitted
defeat, which on a real sheet is a handful of places.

It is what makes this case work. A drawing reads `18-6-MC-58134-1C3B1`; OCR
returns `B81 34` at 0% confidence; a search for `58134` now finds it — while
`58116`, read confidently at 87%, correctly does not match.

Characters from a real PDF text layer count as certain, because they aren't a
guess: nobody read them off pixels.

### Results are ranked by evidence, and say why

Ordering used to be page number, so a confident wrong answer could outrank a
corroborated right one. Now each hit is scored on what can actually be known
about it — how much of the tag matched outright, how sure OCR was of the parts
that didn't, how much text around it corroborates it, and whether it occupies a
whole field between separators rather than sitting inside a longer string.

The reasoning goes on the row, in words, so you can disagree with it:

> 4 of 5 characters matched exactly.
> The one that differs was read at 0% confidence — OCR could not make it out.
> Surrounded by 10 characters of text that read at 93% confidence.
> It occupies a whole field, between separators.

versus

> 3 of 5 characters matched.
> Nothing around it corroborates it.

### Results are banded by how sure the tool is

The matcher will now bridge a fair amount of damage to find a tag, which makes showing
every hit the same way dishonest. Results are grouped:

| | |
|---|---|
| **Matches** | Matched exactly, or came from a real PDF text layer. |
| **Likely** | Everything that differed was a pair no engine can physically distinguish — `0`/`O`, `1`/`I`, `5`/`S`. |
| **Possible** | Needed a heavier substitution, or a character OCR lost entirely. Folded away when there's something better to look at, but never hidden. |

The line between Likely and Possible isn't a tuned threshold: a hit is Likely exactly when
every substitution it used was one of the physically-indistinguishable pairs. So five
`0`-for-`O` reads in a long tag stay Likely, while a single `1`-for-`4` — which needs a
soft image to explain at all — drops to Possible on its own.

Rows are still badged `TEXT` (real PDF text) or `OCR` (recognised from pixels, with its
confidence), plus `GLYPH`, `FUZZY` and `CORRECTED` where they apply.

### Glyph-confusion matching

The dominant reason a tag isn't found is not that OCR missed the text — it's that OCR
read it with characters it cannot physically distinguish. In the stroke-thin dot-matrix
font used for CAD callouts, at drawing scale, these pairs are near-identical:

| | | | | | | |
|---|---|---|---|---|---|---|
| `0` `O` `Q` `D` | `1` `I` `L` | `2` `Z` | `5` `S` | `6` `G` | `8` `B` | `7` `T` |

So `V-6801-15PW4/3-750-PP60-RE1` gets read as `V-68O1-l5PW4/3-75O-PPGO-RE1`, and a plain
substring search finds nothing — even though every "wrong" character is one no OCR engine
could have got right.

Rather than folding both sides to a canonical form (which would destroy precision — `GP`
and `6P` would collide), the query is *aligned* against the candidate, and a mismatch is
permitted **only** where the two characters are a known confusable pair. Everything else
must still match exactly. That hard wall, not the budget, is what keeps `PT-11005` from
matching `PT-11004`.

Pairs carry individual costs in three tiers — physically indistinguishable (`0`/`O`),
confusable once the image is soft (`P`/`R`, where blur loses a thin leg), and confusable
only under heavy degradation (`6`/`B`) — against a total budget that grows with query
length, because a longer tag carries more corroborating characters.

Queries shorter than 4 characters are never confusion-matched.

### Characters that vanish

Substitution isn't the only thing blur does. On the bench corpus the commonest remaining
failure was a character that disappeared outright:

```
want FIC-2015           read "FC2015"             lost the I
want XV-3308            read "X-3308"             lost the V
want 6"-P-1052-A1A-HC   read "-P-1052-A1A-HC"     lost the leading 6"
```

A fixed-length positional compare cannot see any of these — the read is *shorter* than
the query, which defeats plain substring search too. So the matcher can also delete and
insert, under a cap of one or two per tag.

That opens a hole worth naming: a deletion immediately followed by an insertion is just a
substitution wearing a hat, and would let `PT-21004` match `PT-11004` through the back
door. Two guards close it. The alignment may not follow a delete with an insert or vice
versa; and a deletion at either *end* of the tag is only allowed where there is no
unmatched text on that side to explain instead — otherwise dropping the final `4` and
ignoring a stray `5` would make every tag match its neighbour.

Deletions are not free at the ends, but they are permitted in the middle, and that does
cost some precision: `PT-1104` will now match a search for `PT-11004`. That is the price
of finding tags whose characters blur away, and it is why anything that needed damage to
match is badged rather than presented as fact.

### Two passes, so a working search stays instant

The alignment costs roughly ten times what a substitution-only scan does. So a search runs
the cheap pass across the whole document first, and only if it comes back **empty** does it
re-run allowing for erased characters — and says so when it does. A search that works pays
nothing; a search that fails is the one that tries harder.

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

### Before OCR runs: conditioning, but only where it helps

This used to say that every page was adaptively binarized before OCR, and explain at
length why that was right. Measuring it (`bench/eval.mjs`) showed it was costing recall on
exactly the drawings this tool struggles with: on soft, low-resolution scans, handing
Tesseract the *untouched* render instead was worth around nine points, and five times
better on the worst condition tested.

The reasoning behind the binarizer wasn't wrong, it was too narrow. Uneven illumination is
real, and a single global cutoff genuinely cannot handle it: on the synthetic sheet in
`tests/preprocess.test.js` the best threshold that *could exist* globally recovers 40% of
strokes where the adaptive pass recovers 100%. But a threshold is a decision, and a
decision made on a smeared stroke is made after the evidence is gone. Tesseract has a whole
page and a trained model to make that decision with; we have a box filter.

So the pipeline now does only the part we can do better, and only when there is something
to do:

- **Evenly lit page** — hand over the render untouched. Most pages.
- **Unevenly lit page** — subtract the local mean, which removes the gradient exactly as
  the adaptive threshold did, but keeps grey levels instead of collapsing them to two.

Unevenness is measured as the spread of block means across the sheet. (The first attempt
keyed on a variance-of-Laplacian sharpness measure instead, which is the standard defocus
metric and was quietly useless here — it scored the *worst* images highest, because sensor
noise generates far more Laplacian energy than a crisp edge does. Blur and noise arrive
together on real scans, so it would have chosen backwards every time.)

Thumbnails always keep the clean render; only the copy handed to Tesseract is conditioned.

### Rotated and vertical text

With **Also scan rotated/vertical text** on, each page is OCR'd at 0°/90°/180°/270° and
word boxes are mapped back into page space. Ordering and word-joining are then done along
the axis the text is *read*, not along page-x: for the 90/180/270 passes a word's reading
order maps onto a decreasing or perpendicular page axis, so sorting by page-x scrambles
the words of every rotated tag before they are ever joined. `tests/matching.test.js`
pins this down and keeps a regression guard proving page-x sorting is wrong.

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


---

## Developing

The app outgrew a single inline `<script>`. Source is now `src/`, and `index.html` at the
repo root is the **built artifact** — generated, committed, and still the only thing a
user needs.

```
src/lib/     pure logic: text, confusion, matching, geometry, preprocessing
src/app/     the application: dom, state, pdf, textlayer, ocr, queue, search, results, viewer
src/index.template.html   the page; the bundle is inlined at <!--BUNDLE-->
```

```bash
npm install        # esbuild + playwright, dev-only
npm run build      # regenerates index.html
npm test           # unit + end-to-end, and fails if index.html is stale
```

`index.html` is generated — edit `src/` and rebuild. `npm test` will tell you if you
forgot.

## Tests

```
node tests/matching.test.js     # confusion matching + rotated reading axis
node tests/preprocess.test.js   # adaptive binarization vs a global threshold
node tests/e2e.test.mjs         # real browser: open a PDF, search, click a result
node build.mjs --check          # index.html matches src/
```

The first two are pure-logic tests over `src/lib/`, with no dependencies. The third drives
the built page in headless Chromium against a generated PDF — it is what proves the module
split didn't break the wiring. It fetches nothing: run `tools/fetch-vendor.sh` once to
cache pdf.js and tesseract.js locally, and it skips itself if they're missing.

All exit non-zero on failure.
