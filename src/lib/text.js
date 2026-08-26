// Small pure string/number helpers shared across the tool.

// =======================================================================
// Utility
// =======================================================================
function normalize(s) {
  // Strip everything but letters/digits — real-world OCR output is full of stray
  // commas, brackets, quotes, dashes of various widths, etc. that aren't part of
  // the tag itself, and tag formatting conventions vary (11-004 vs 11004 vs 11 004).
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array(bl+1);
  for (let j=0;j<=bl;j++) prev[j]=j;
  for (let i=1;i<=al;i++) {
    const cur = [i];
    for (let j=1;j<=bl;j++) {
      const cost = a[i-1]===b[j-1] ? 0 : 1;
      cur[j] = Math.min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost);
    }
    prev = cur;
  }
  return prev[bl];
}

/*
 * Per-character confidence, aligned to normalize()'s output.
 *
 * The matcher works on the normalized string, so anything it is told about a
 * character has to be indexed the same way. Callers that only know one
 * confidence for a whole word (which is all Tesseract reports by default) use
 * this to spread it across the characters the word contributes.
 *
 * `conf` runs 0..1, where 0 means "OCR could not read this at all".
 */
function uniformConfidence(str, conf) {
  return new Float64Array(normalize(str).length).fill(conf);
}

/*
 * Map a span of the NORMALIZED string back onto the raw text it came from.
 *
 * The matcher works on the normalized string and reports where it landed there,
 * because a confusion match leaves no substring to go looking for afterwards.
 * Two things need the raw position back: highlighting the match for display,
 * and checking whether it sits in its own delimited field.
 */
function rawSpan(text, pos, len) {
  if (typeof pos !== 'number' || !len) return null;
  let start = -1, end = -1, kept = 0;
  for (let i = 0; i < text.length; i++) {
    // Must mirror normalize() exactly: it keeps A-Z0-9 and drops all else.
    if (!/[A-Za-z0-9]/.test(text[i])) continue;
    if (kept === pos) start = i;
    if (kept === pos + len - 1) { end = i + 1; break; }
    kept++;
  }
  if (start === -1) return null;
  return { start, end: end === -1 ? text.length : end };
}

function escapeHtml(s) {
  return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

export { normalize, clamp, levenshtein, uniformConfidence, rawSpan, escapeHtml };
