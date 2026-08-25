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

function escapeHtml(s) {
  return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

export { normalize, clamp, levenshtein, escapeHtml };
