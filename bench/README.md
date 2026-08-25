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

## Reproducibility

Noise is seeded from the tag and the condition. The first version used
`Math.random()` and the *same* pipeline scored 68% and 74% on consecutive runs —
a six-point swing, larger than most of the changes being measured. Every number
was partly reporting the seed. Two runs now produce identical output and two
pipelines see pixel-identical input.

## Results

`node bench/eval.mjs`, 12 tags x 11 degradation conditions (132 samples per
pipeline), counting how often a user typing the tag would find it:

| condition | as shipped | dicts off | never condition | always flatten | conditioning only | **current** |
|---|---|---|---|---|---|---|
| clean-28px  | 12/12 | 12/12 | 12/12 |  10/12 | 12/12 | 12/12 |
| soft-28px   | 12/12 | 12/12 | 12/12 |  12/12 | 12/12 | 12/12 |
| small-14px  | 11/12 | 12/12 | 12/12 |  12/12 | 11/12 | 12/12 |
| soft-14px   | 12/12 | 12/12 | 12/12 |  12/12 | 11/12 | 12/12 |
| noisy-14px  | 10/12 | 10/12 | 12/12 |  12/12 | 11/12 | 12/12 |
| bad-11px    |  3/12 |  4/12 |  9/12 |  11/12 |  6/12 |  9/12 |
| worse-11px  |  0/12 |  0/12 |  0/12 |   0/12 |  0/12 |  0/12 |
| awful-9px   |  0/12 |  0/12 |  0/12 |   0/12 |  0/12 |  0/12 |
| lit-28px    | 12/12 | 12/12 |  0/12 |  12/12 | 11/12 | 12/12 |
| lit-14px    | 11/12 | 12/12 |  0/12 |  12/12 | 11/12 | 12/12 |
| lit-soft-14 |  5/12 |  5/12 |  0/12 |  12/12 | 12/12 | 12/12 |
| **overall** | **67%** | 69% | 52% | 80% | 73% | **80%** |

**67% → 80%**, split roughly evenly between the two changes: conditioning
accounts for 67→73 (matching held constant), and letting the matcher absorb
erased characters accounts for 73→80.

### What each column is

- **as shipped** — always binarize, dictionary flags that never took effect,
  substitution-only matching.
- **dicts off** — the dictionary fix alone. Worth about two points, and within
  the corpus's noise; the reason to do it is that the code claimed to be doing
  it and wasn't.
- **never condition** — greyscale straight to Tesseract. Best of all on evenly
  lit pages and catastrophic on unevenly lit ones (0/12, three times over).
- **always flatten** — ties the current default overall, and is worse on clean
  pages (10/12 vs 12/12).
- **conditioning only** — the current conditioning with the old substitution-only
  matching, to separate the two contributions.
- **current** — conditioning chosen from the image, dictionaries off, erased
  characters allowed.

### Three findings, all of which changed the code

1. **The dictionary flags never took effect.** `load_system_dawg` and
   `load_freq_dawg` were passed through `setParameters`, which Tesseract rejects
   after initialization — it logs "Attempted to set parameters that can only be
   set during initialization" and carries on with the English dictionary loaded.
   So for the tool's whole life the decoder was being pulled toward real words,
   which is precisely what the code comment said must not happen: a degraded
   `V-6801-15PW4` read as `VOL ASP` with it on and `15PW` with it off. Moved to
   the init config.

2. **Declaring `user_defined_dpi` from the render scale does not help.** It is a
   plausible-sounding fix and it measured flat-to-negative, so it isn't in the
   code. Render scale says how big the *page* is, not how big the *glyphs* are: a
   low-resolution raster pasted into a large page still has 9-pixel characters at
   252 dpi. That value has to come from measuring glyph height.

3. **Conditioning every page was costing recall.** Thresholding a soft image
   throws away the evidence the decision needed. But the `lit-*` rows show the
   opposite just as sharply: with no conditioning at all, an unevenly lit sheet
   goes to **zero**. Both are true, so the pipeline now removes an illumination
   gradient (which we can do, because we can look at the neighbourhood) and does
   nothing else (because Tesseract thresholds better than we do).

   Those `lit-*` rows were added *after* the first conclusion. Without them the
   bench happily recommended deleting the binarizer, which would have been a
   disaster on exactly the scans this tool exists for. A corpus that can only see
   one failure mode will confidently optimise into the other.

### One idea that measured negative

An unsharp mask before thresholding — restore the stroke edge, then threshold
it. Reasonable, and it made things worse (63% against 65%). It was written,
measured, and deleted rather than kept because the story was good.

The first attempt at choosing conditioning keyed on a variance-of-Laplacian
sharpness measure, the standard defocus metric. On this corpus it scored the
*worst* images highest, because sensor noise generates far more Laplacian energy
than a crisp edge does — and blur and noise arrive together on real scans, so it
would have chosen backwards every time. Illumination spread separates the corpus
cleanly (evenly lit 0.10–0.26, unevenly lit 0.49–0.54) and is what the rule uses.

## What the misses say

The remaining failures are not mostly "OCR saw nothing". They are dropped
characters:

```
want FIC-2015           read "FC2015"          <- dropped I
want XV-3308            read "X-3308"          <- dropped V
want TSHH-6802          read "TSH 6802"        <- dropped H
want 6"-P-1052-A1A-HC   read "-P-1052-A1A-HC"  <- dropped leading 6"
```

Every one of those was invisible to the old matcher, which compared position by
position at a fixed length and could only substitute. The read is *shorter* than
the query, so even a plain substring search fails. That is what the alignment
with capped insertions and deletions was built for, and it is where the second
half of the improvement comes from.

The failures that remain are the two worst conditions, `worse-11px` and
`awful-9px`, where recognition returns nothing recoverable at all (`""`, `"E"`,
`"TN"`). No amount of matching fixes a read with no signal in it. Those need the
image to be better before it reaches the engine — rendering the page so glyphs
land at a size the engine can work with, which is the next piece of work and the
one this corpus is now set up to measure.
