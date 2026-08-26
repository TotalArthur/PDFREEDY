import { levenshtein } from './text.js';
import { compileConfusable, confusableMatch } from './confusion.js';

// Single entry point for "does this candidate window satisfy the query?".
// Tried in order of decreasing confidence: exact -> confusion -> fuzzy.
//
// query.allowIndels === false restricts the confusion tier to substitutions,
// which is around ten times cheaper. The search runs that first across the
// whole document and only escalates to the full alignment when it came back
// empty — so a search that works stays instant, and a search that fails is the
// one that pays for trying harder.
//
// Returns null, or { pos, len, whole, confused, fuzzy, cost, subs, indels }.
// pos/len index the NORMALIZED candidate — a confusion match has no findable
// substring to search for afterwards, so the matcher has to say where it
// landed. cost/subs/indels describe how much damage the match had to absorb,
// which is what lets the UI say how sure it is rather than presenting every hit
// alike. `whole` says the query matched the candidate end to end with nothing
// left over, which is what the results list ranks to the very top.
function matchWindow(norm, query) {
  if (!norm || !query.norm) return null;
  const q = query.norm;
  // The same query is run against every window on every page, so the needle is
  // compiled once and cached on the query object rather than per candidate.
  if (query._compiled !== q) { query._compiled = q; query._needle = compileConfusable(q); }
  const needle = query._needle;

  if (query.exactOnly) {
    if (norm === q) return { pos: 0, len: norm.length, whole: true, confused: false, fuzzy: false, cost: 0, subs: 0, indels: 0 };
    // Exact mode still tolerates glyph confusion — "exact" is about the tag
    // being the whole string, not about trusting OCR's spelling of it — but the
    // alignment has to cover the candidate end to end.
    const hit = confusableMatch(norm, needle, query);
    if (hit && hit.pos === 0 && hit.len === norm.length) {
      return { pos: 0, len: norm.length, whole: true, confused: hit.cost > 0, fuzzy: false,
               cost: hit.cost, subs: hit.subs, indels: hit.indels };
    }
    return null;
  }

  const exactPos = norm.indexOf(q);
  if (exactPos !== -1) {
    return { pos: exactPos, len: q.length, whole: norm.length === q.length,
             confused: false, fuzzy: false, cost: 0, subs: 0, indels: 0 };
  }

  const hit = confusableMatch(norm, needle, query);
  if (hit) {
    return { pos: hit.pos, len: hit.len, whole: hit.pos === 0 && hit.len === norm.length,
             confused: true, fuzzy: false,
             cost: hit.cost, subs: hit.subs, indels: hit.indels };
  }

  if (query.fuzzy) {
    const maxDist = q.length <= 4 ? 1 : 2;
    if (Math.abs(norm.length - q.length) <= maxDist && levenshtein(norm, q) <= maxDist) {
      return { pos: 0, len: norm.length, whole: false, confused: false, fuzzy: true,
               cost: maxDist, subs: maxDist, indels: 0 };
    }
  }
  return null;
}

export { matchWindow };
