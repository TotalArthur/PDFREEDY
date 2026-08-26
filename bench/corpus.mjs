/*
 * Synthetic evaluation corpus.
 *
 * Real drawings are confidential and can't live in this repo, so the harness
 * manufactures its own: real-shaped P&ID tags rendered small and then degraded
 * the way a bad scan degrades them — defocus blur, sensor noise, and the plain
 * fact that a callout on an A1 sheet is only a few pixels tall once it reaches
 * the OCR engine.
 *
 * This is not a substitute for a labelled set of the user's worst sheets. It
 * is a floor: a change that loses recall here has certainly lost recall there.
 */

// Tags in the shapes the tool is built for: instrument callouts, line numbers,
// and spec-heavy pipe tags. Deliberately full of the characters that blur into
// each other (0/O, 1/I/L, 5/S, 6/G, 8/B, 2/Z).
export const TAGS = [
  'PT-11004',
  'FIC-2015',
  'LT-11004',
  'TSHH-6802',
  'V-6801-15PW4',
  'V-68176-15PW11-600-R01',
  '18-8-GP-11026-4C3B1-HT',
  '6"-P-1052-A1A-HC',
  'PSV-2201B',
  'XV-3308',
  '2-CD-5502-B2G',
  'AE-9017',
];

// Graded degradation. `height` is the rendered cap height in pixels — the
// single most under-managed variable in the current pipeline, since OCR_SCALE
// is a fixed multiplier of PDF user units and takes no account of how big the
// glyphs actually end up.
export const CONDITIONS = [
  { name: 'clean-28px',   height: 28, blur: 0,   noise: 0  },
  { name: 'soft-28px',    height: 28, blur: 1.0, noise: 0  },
  { name: 'small-14px',   height: 14, blur: 0,   noise: 0  },
  { name: 'soft-14px',    height: 14, blur: 0.8, noise: 0  },
  { name: 'noisy-14px',   height: 14, blur: 0.8, noise: 30 },
  { name: 'bad-11px',     height: 11, blur: 0.7, noise: 30 },
  { name: 'worse-11px',   height: 11, blur: 1.2, noise: 45 },
  { name: 'awful-9px',    height:  9, blur: 0.9, noise: 45 },
  // Uneven illumination — the condition the adaptive binarizer was written for.
  // Without these the bench can only see what thresholding costs, never what it
  // buys, and would happily recommend deleting it.
  { name: 'lit-28px',     height: 28, blur: 0,   noise: 0,  uneven: 0.55 },
  { name: 'lit-14px',     height: 14, blur: 0.4, noise: 10, uneven: 0.55 },
  { name: 'lit-soft-14',  height: 14, blur: 1.0, noise: 20, uneven: 0.6  },

  // A tag inside a line number, with only the tag field smudged. This is the
  // shape of the failure that motivated confidence-aware matching: the field
  // comes back unreadable while everything either side reads cleanly, so the
  // question is not "what do these marks look like" but "how much should an
  // admission of ignorance count against a match". Every other condition here
  // degrades the whole string equally and cannot see that distinction.
  // Calibrated by sweeping the smudge until OCR lands in the interesting band:
  // hard enough to garble the field, not so hard that it returns nothing. Too
  // gentle and it reads the tag perfectly (which tests nothing); too harsh and
  // it returns empty (which no matcher can fix).
  { name: 'field-14',     height: 14, context: true, blur: 0.3, noise: 8,  fieldBlur: 1.0, fieldNoise: 35 },
  { name: 'field-soft-14',height: 14, context: true, blur: 0.5, noise: 12, fieldBlur: 1.4, fieldNoise: 45 },
  { name: 'field-11',     height: 11, context: true, blur: 0.3, noise: 8,  fieldBlur: 0.9, fieldNoise: 40 },
  // In this one OCR marks the character it can't read with a junk symbol —
  // 18-6-MC-58134-1C3B1 comes back as "18-6-MC-5#134-1C3B1" at 12% confidence.
  // Currently unfindable, and not for the reason it looks like: normalize()
  // deletes the '#', so the tag becomes one character SHORTER rather than one
  // character wrong. See bench/README.md.
  { name: 'field-junk-16',height: 16, context: true, blur: 0.3, noise: 8,  fieldBlur: 1.4, fieldNoise: 40 },
];
