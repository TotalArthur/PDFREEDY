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

`node bench/eval.mjs`, 12 tags x 15 degradation conditions (180 samples per
pipeline), counting how often a user typing the tag would find it:

| condition | as shipped | dicts off | never condition | always flatten | ignore confidence | no indels | **current** |
|---|---|---|---|---|---|---|---|
| clean-28px  | 12/12 | 12/12 | 12/12 | 11/12 | 12/12 | 12/12 | 12/12 |
| soft-28px   | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| small-14px  | 11/12 | 12/12 | 12/12 | 12/12 | 12/12 | 11/12 | 12/12 |
| soft-14px   | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 11/12 | 12/12 |
| noisy-14px  | 10/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| bad-11px    |  3/12 |  6/12 |  9/12 | 11/12 |  9/12 |  6/12 |  9/12 |
| worse-11px  |  0/12 |  0/12 |  0/12 |  0/12 |  0/12 |  0/12 |  0/12 |
| awful-9px   |  0/12 |  0/12 |  0/12 |  0/12 |  0/12 |  0/12 |  0/12 |
| lit-28px    | 12/12 | 12/12 |  0/12 | 12/12 | 12/12 | 11/12 | 12/12 |
| lit-14px    | 11/12 | 12/12 |  0/12 | 12/12 | 12/12 | 11/12 | 12/12 |
| lit-soft-14 |  5/12 | 10/12 |  0/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| field-14    |  4/12 | 10/12 | 10/12 | 12/12 | 10/12 | 10/12 | 10/12 |
| field-soft-14 | 0/12 | 0/12 |  0/12 |  0/12 |  0/12 |  0/12 |  0/12 |
| field-11    |  0/12 |  3/12 |  9/12 |  9/12 |  6/12 |  9/12 |  9/12 |
| field-junk-16 | 2/12 | 3/12 |  6/12 |  7/12 |  4/12 |  5/12 |  6/12 |
| **overall** | **52%** | 64% | 52% | *74%* | 69% | 68% | **72%** |

**52% → 72%.** The contributions, each measured by holding everything else fixed:

- conditioning chosen from the image, rather than binarizing everything: the bulk
- letting the matcher absorb characters that blur erased: 68% → 72%
- pricing a substitution by how sure OCR was: 69% → 72%

### On the `field-*` conditions

These render a tag *inside a line number* — `18-6-MC-<tag>-1C3B1` — and smudge
only the tag's field, leaving everything either side legible. They exist because
of a real sheet where the tool returned the correct tag and two wrong ones,
all in the same tier, in page order, with nothing to tell them apart.

Adding them mattered more than expected. Every other condition here degrades the
whole string equally, so there is never any confident context for a doubtful read
to be judged against — and against that corpus, confidence-aware matching measured
as doing **nothing at all** (80% either way). The change is worth +3 points only
once the corpus contains a shape where some characters read well and others don't,
which is the shape almost all real drawings have.

Calibrating them took a sweep. Too gentle and OCR reads the tag perfectly, which
tests nothing; too harsh and it returns empty, which no matcher can fix. The
interesting band is narrow and is where the real sheet sat.

### One honest loose end

**Always flattening scores 74% against the current 72%**, winning on four of the
six hardest conditions and losing one tag on a pristine render. Two tags out of
180 is not much, but it has repeated across runs, so it is signal rather than
noise.

The likely mechanism is that flattening does two things — it removes an
illumination gradient *and* it boosts local contrast — and only the first is what
the current rule tests for. The right next experiment is to make the rule fire on
low contrast as well, which should collect flattening's gains without its cost on
clean pages, rather than flipping the default on a two-tag margin.

The default stays as it is for now: never make a clean page worse. That is a
judgement, not a measurement, and the measurement mildly disagrees with it.

### What is still missed

Almost entirely the two worst conditions, where recognition returns nothing
recoverable:

```
worse-11px   want PT-11004    read "P"
worse-11px   want PSV-2201B   read ""
worse-11px   want XV-3308     read ""
```

No amount of matching fixes a read with no signal in it. Those need the page
rendered so the glyphs land at a size the engine can work with — the next piece
of work, and what `field-soft-14` (0/12 for every pipeline) is holding a place for.

`field-junk-16` is a different and more interesting failure: OCR marks the
character it cannot read with a junk symbol, so `18-6-MC-58134-1C3B1` comes back
as `18-6-MC-5#134-1C3B1`. `normalize()` then **deletes** the `#`, which turns a
character that is *wrong* into a character that is *missing* — throwing away the
one piece of information that says something was there at all. Preserving those
marks as unknown characters, rather than dropping them, is the obvious next win.

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
