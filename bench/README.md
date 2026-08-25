# Accuracy bench

The project had no accuracy measurement of any kind, which made every claim
about the OCR pipeline — including the ones written in the code comments —
impossible to check. This is that measurement.

```bash
node bench/eval.mjs            # all pipelines, full corpus (~5 min)
node bench/eval.mjs --quick    # first 4 tags
node bench/eval.mjs --pipeline=nodict_grey
```

It runs the **real** pipeline — the same `preprocessForOcr`, the same word
joining, the same matcher the app uses — over a synthetic corpus of P&ID-shaped
tags degraded the way bad scans degrade them (small glyphs, defocus blur,
sensor noise).

Two numbers are reported, and the difference between them matters:

- **exact read** — did OCR return the tag character-for-character?
- **tag found** — the user knows the tag, types it, does the tool surface it?

The second is the one that counts. A garbled read still counts as found if the
matcher bridges the garble, which is the entire point of the confusion tier;
measuring OCR string accuracy alone would be measuring the wrong thing.

## Caveat

Synthetic tags are not a labelled set of real sheets, and this is not a
substitute for one. It is a **floor**: a change that loses recall here has
certainly lost recall on real drawings. Treat the absolute numbers as
indicative and the deltas between pipelines as the finding.

## Results

`node bench/eval.mjs`, 12 tags × 8 degradation conditions, tags found:

| condition | baseline | dicts off | + fixed dpi | greyscale (no binarize) |
|---|---|---|---|---|
| clean-28px  | 12/12 | 12/12 | 12/12 | 12/12 |
| soft-28px   | 12/12 | 12/12 | 12/12 | 12/12 |
| small-14px  | 10/12 | 10/12 | 10/12 | **11/12** |
| soft-14px   | 12/12 | 12/12 | 12/12 | 11/12 |
| noisy-14px  |  9/12 |  8/12 |  9/12 | **10/12** |
| bad-11px    |  1/12 |  3/12 |  1/12 | **6/12** |
| worse-11px  |  0/12 |  0/12 |  0/12 | 0/12 |
| awful-9px   |  0/12 |  0/12 |  0/12 | 0/12 |
| **overall** | **58%** | **59%** | 58% | **65%** |

Three findings, all of which changed the code:

1. **The dictionary flags never took effect.** `load_system_dawg` and
   `load_freq_dawg` were passed through `setParameters`, which Tesseract rejects
   after initialization — it logs "Attempted to set parameters that can only be
   set during initialization" and carries on with the English dictionary loaded.
   So for the tool's whole life the decoder was being pulled toward real words,
   which is precisely what the code comment said must not happen. Moved to the
   init config. Worth +2 tags at `bad-11px` and it makes the code honest.

2. **Declaring `user_defined_dpi` from the render scale does not help.** It is a
   plausible-sounding fix and it measured flat-to-negative, so it isn't in the
   code. Render scale says how big the *page* is, not how big the *glyphs* are:
   a low-resolution raster pasted into a large page still has 9-pixel characters
   at 252 dpi. The value has to come from measuring glyph height.

3. **Adaptive binarization is destroying blurry text.** Handing Tesseract the
   greyscale render instead of the binarized one is worth +7 points overall and
   is *six times* better at `bad-11px` (6/12 vs 1/12). This is not an argument
   for deleting the binarizer — `tests/preprocess.test.js` shows it beating the
   best *possible* global threshold on unevenly-lit sheets, which is real and is
   why it exists. Both are true: thresholding a sharp stroke sharpens it, and
   thresholding a soft one erodes or merges it. The conditioning has to be
   chosen from the image rather than applied unconditionally.

## What the misses say

The remaining failures are not mostly "OCR saw nothing". They are dropped
characters:

```
want FIC-2015           read "FC2015"       <- dropped I
want XV-3308            read "X-3308"       <- dropped V
want TSHH-6802          read "TSH 6802"     <- dropped H
want 6"-P-1052-A1A-HC   read "-P-1052-A1A-HC"  <- dropped leading 6"
```

Every one of those is invisible to the current matcher, which compares position
by position at a fixed length and can only substitute. The read is *shorter*
than the query, so even a plain substring search fails. That is the case for
confusion-weighted edit distance with indels.
