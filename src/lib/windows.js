import { normalize } from './text.js';
import { matchWindow } from './matching.js';

/*
 * Candidate-window matching.
 *
 * A tag is almost never one token. The text layer splits it wherever the PDF
 * producer felt like splitting it, and OCR splits it wherever the blur was
 * worst — so matching has to run against joined runs of consecutive items on a
 * line, not against single tokens.
 *
 * Both sources (pdf.js text items and Tesseract words) do the same thing here,
 * so they share this one implementation. Callers project their items onto a
 * common shape first:
 *
 *   { key, text, rs, re, rh }
 *
 * where rs/re are start/end along the direction the text is READ and rh is the
 * character height measured perpendicular to it. For horizontal text-layer runs
 * that is just x and font size; for OCR it comes from readingAxis(), which is
 * what keeps vertical and upside-down passes working (see geometry.js).
 */
function findWindowMatches(items, query, opts) {
  const { maxWindow, gapFactor, join = '', transform = null } = opts;
  const results = [];
  // Once a run of items has matched, its members can't also form a second,
  // overlapping match — otherwise one tag reports two or three times.
  const covered = new Set();

  for (let winSize = 1; winSize <= maxWindow; winSize++) {
    for (let start = 0; start + winSize <= items.length; start++) {
      const win = items.slice(start, start + winSize);
      if (win.some(it => covered.has(it.key))) continue;

      if (winSize > 1) {
        let tooFar = false;
        for (let k = 0; k < win.length - 1; k++) {
          // Measured along the reading axis, so this is the true inter-word gap
          // for vertical and upside-down text as well as horizontal.
          const gap = win[k + 1].rs - win[k].re;
          if (gap > win[k].rh * gapFactor) { tooFar = true; break; }
        }
        if (tooFar) continue;
      }

      const rawText = win.map(it => it.text).join(winSize > 1 ? join : '');
      // A saved correction replaces what OCR *thought* it read, so this window
      // is matched (and displayed) as the tag it really is.
      const fixed = transform ? transform(rawText) : null;
      const text = fixed || rawText;
      const norm = normalize(text);
      if (!norm) continue;

      const match = matchWindow(norm, query);
      if (!match) continue;

      win.forEach(it => covered.add(it.key));
      results.push({ items: win, text, rawText, corrected: !!fixed, match });
    }
  }
  return results;
}

export { findWindowMatches };
