// =======================================================================
// Confusion-tolerant matching
//
// The dominant OCR failure mode on CAD drawings isn't "text not found", it's
// glyph confusion: the stroke-thin dot-matrix font used for tag callouts
// renders 0 and O, 1 and I/l, 5 and S, 8 and B, 6 and G, 2 and Z almost
// identically at drawing scale. A raw substring search therefore misses
// V-6801-15PW11 when Tesseract reported V-68O1-l5PW11 — even though every
// character it got "wrong" is one it cannot physically distinguish.
//
// Instead of blanket-folding both sides to a canonical form (which destroys
// specificity — GP and 6P would collide), we compare the query against the
// candidate position by position and permit a mismatch ONLY when the two
// characters belong to the same confusion class. A candidate must still match
// the query exactly everywhere else, so precision stays high while the
// known-ambiguous glyph pairs stop causing misses.
// =======================================================================
const CONFUSION_CLASSES = ['0OQD', '1IL', '2Z', '5S', '6G', '8B', '7T', '4A'];
const CONFUSION_OF = (() => {
  const m = new Map();
  CONFUSION_CLASSES.forEach((cls, i) => { for (const ch of cls) m.set(ch, i); });
  return m;
})();

// Same character, or two glyphs OCR genuinely cannot tell apart.
function charsConfusable(a, b) {
  if (a === b) return true;
  const ca = CONFUSION_OF.get(a);
  return ca !== undefined && ca === CONFUSION_OF.get(b);
}

// Substitution budget: generous enough for a badly-garbled read, tight enough
// that a short query can't match half the drawing. Exact matches cost nothing.
function confusionBudget(len) {
  if (len < 4) return 0;                        // too short to risk it
  return Math.max(1, Math.round(len * 0.34));
}

// Find `needle` inside `hay` allowing only confusion-class substitutions.
// Returns { pos, subs } for the best (fewest-substitutions) hit, or null.
function confusableIndexOf(hay, needle) {
  const n = needle.length, budget = confusionBudget(n);
  if (!n || n > hay.length || budget === 0) return null;
  let best = null;
  for (let start = 0; start + n <= hay.length; start++) {
    let subs = 0, ok = true;
    for (let k = 0; k < n; k++) {
      const a = hay[start + k], b = needle[k];
      if (a === b) continue;
      if (!charsConfusable(a, b) || ++subs > budget) { ok = false; break; }
    }
    if (ok && (!best || subs < best.subs)) {
      best = { pos: start, subs };
      if (subs === 0) break;
    }
  }
  return best;
}

export { CONFUSION_CLASSES, CONFUSION_OF, charsConfusable, confusionBudget, confusableIndexOf };
