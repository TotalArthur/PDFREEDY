import { levenshtein } from './text.js';
import { confusableIndexOf } from './confusion.js';

// Single entry point for "does this candidate window satisfy the query?".
// Tried in order of decreasing confidence: exact -> confusion -> fuzzy.
// Returns null, or { pos, len, confused, fuzzy } describing how it matched.
function matchWindow(norm, query) {
  if (!norm || !query.norm) return null;
  const q = query.norm;

  if (query.exact) {
    if (norm === q) return { pos: 0, len: norm.length, confused: false, fuzzy: false };
    if (norm.length === q.length) {
      const hit = confusableIndexOf(norm, q);
      if (hit) return { pos: 0, len: norm.length, confused: hit.subs > 0, fuzzy: false };
    }
    return null;
  }

  const exactPos = norm.indexOf(q);
  if (exactPos !== -1) return { pos: exactPos, len: q.length, confused: false, fuzzy: false };

  const hit = confusableIndexOf(norm, q);
  if (hit) return { pos: hit.pos, len: q.length, confused: true, fuzzy: false };

  if (query.fuzzy) {
    const maxDist = q.length <= 4 ? 1 : 2;
    if (Math.abs(norm.length - q.length) <= maxDist && levenshtein(norm, q) <= maxDist) {
      return { pos: 0, len: norm.length, confused: false, fuzzy: true };
    }
  }
  return null;
}

export { matchWindow };
