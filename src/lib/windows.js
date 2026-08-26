import { normalize, rawSpan } from './text.js';
import { matchWindow } from './matching.js';

/*
 * Spread each item's confidence across the characters it contributes to the
 * joined window, indexed the way the matcher sees them (i.e. after normalize()
 * has dropped the punctuation). Separators between items contribute nothing,
 * because normalize() removes them too.
 *
 * Items with no `conf` count as fully trusted. That is the right default for a
 * real PDF text layer: those characters were not read off pixels, so "the
 * engine wasn't sure" cannot apply to them.
 */
function windowConfidence(win) {
  const out = [];
  for (const it of win) {
    const c = typeof it.conf === 'number' ? it.conf : 1;
    for (const ch of it.text) if (/[A-Za-z0-9]/.test(ch)) out.push(c);
  }
  return Float64Array.from(out);
}

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
 *   { key, text, rs, re, rh, conf }
 *
 * where `conf` is 0..1 — how sure the engine was of this item, or omitted when
 * the text didn't come from OCR at all.
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

      // A correction is the user's own text, so it carries no OCR uncertainty.
      const confidence = fixed ? new Float64Array(norm.length).fill(1) : windowConfidence(win);
      const match = matchWindow(norm, query, { conf: fixed ? null : confidence });
      if (!match) continue;

      // What surrounds the match is evidence about it. A tag found inside
      // 18-6-MC-.....-1C3B1, where everything either side read cleanly, is a
      // far stronger claim than the same characters found floating on their
      // own — and that difference is exactly what a person uses to tell a real
      // find from a coincidence.
      //
      // The window itself is the SMALLEST run of items that contains the tag,
      // so most of that context is in the neighbouring items rather than in the
      // window: reach outwards along the line for as long as the items are
      // still close enough to belong together.
      const span = rawSpan(text, match.pos, match.len);
      const isAlnum = (ch) => ch !== undefined && /[A-Za-z0-9]/.test(ch);

      let ctxChars = 0, ctxConfSum = 0;
      const addContext = (str, c) => {
        for (const ch of str) if (/[A-Za-z0-9]/.test(ch)) { ctxChars++; ctxConfSum += c; }
      };
      // Characters inside the window but outside the matched span.
      let matchConfSum = 0, matchChars = 0;
      for (let i = 0; i < confidence.length; i++) {
        if (i >= match.pos && i < match.pos + match.len) { matchConfSum += confidence[i]; matchChars++; }
        else { ctxChars++; ctxConfSum += confidence[i]; }
      }
      // Neighbouring items on the same line, while they stay within joining distance.
      for (let i = start - 1; i >= 0; i--) {
        const gap = items[i + 1].rs - items[i].re;
        if (gap > items[i].rh * gapFactor) break;
        addContext(items[i].text, typeof items[i].conf === 'number' ? items[i].conf : 1);
      }
      for (let i = start + winSize; i < items.length; i++) {
        const gap = items[i].rs - items[i - 1].re;
        if (gap > items[i - 1].rh * gapFactor) break;
        addContext(items[i].text, typeof items[i].conf === 'number' ? items[i].conf : 1);
      }

      win.forEach(it => covered.add(it.key));
      results.push({
        items: win, text, rawText, corrected: !!fixed, match,
        contextChars: ctxChars,
        contextConf: ctxChars ? ctxConfSum / ctxChars : 1,
        matchConf: matchChars ? matchConfSum / matchChars : 1,
        // True when the match occupies a whole field rather than part of one —
        // -58134- reads as a tag; the 58134 inside 158134X does not.
        delimited: !!span && !isAlnum(text[span.start - 1]) && !isAlnum(text[span.end]),
      });
    }
  }
  return results;
}

export { findWindowMatches };
