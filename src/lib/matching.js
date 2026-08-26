import { compileConfusable, confusableMatch } from './confusion.js';

// When the user ticks "fuzzy", every character is treated as no more certain
// than this, which makes an unlisted substitution affordable even where OCR
// claimed to be sure. It is the same mechanism as an unreadable glyph, applied
// on purpose — a deliberate "I don't trust this read, show me anything close".
const FUZZY_CONFIDENCE_CAP = 0.45;

function describe(hit, fuzzy, normLen) {
  return {
    pos: hit.pos, len: hit.len,
    // The query covered the candidate end to end with nothing left over. The
    // results list ranks those above a hit buried inside a longer run.
    whole: hit.pos === 0 && hit.len === normLen,
    confused: hit.cost > 0, fuzzy,
    cost: hit.cost, subs: hit.subs, unknowns: hit.unknowns || 0, indels: hit.indels,
  };
}

function capConfidence(conf, len, cap) {
  const out = new Float64Array(len).fill(cap);
  if (conf) for (let i = 0; i < len && i < conf.length; i++) out[i] = Math.min(conf[i], cap);
  return out;
}

// Single entry point for "does this candidate window satisfy the query?".
// Tried in order of decreasing confidence: exact -> confusion -> fuzzy.
//
// opts.conf is per-character confidence for `norm`, 0..1. With it, a character
// the engine could not read becomes cheap to substitute and one it was sure
// about stays expensive — which is the difference between a genuine find and a
// confident disagreement, and was previously invisible here.
//
// query.allowIndels === false restricts the confusion tier to substitutions,
// which is around ten times cheaper. The search runs that first across the
// whole document and only escalates to the full alignment when it came back
// empty — so a search that works stays instant, and a search that fails is the
// one that pays for trying harder.
//
// Returns null, or { pos, len, whole, confused, fuzzy, cost, subs, unknowns,
// indels }. pos/len index the NORMALIZED candidate — a confusion match has no
// findable substring to search for afterwards, so the matcher has to say where
// it landed. The rest describe how much damage the match had to absorb, which
// is what lets the UI rank hits and say why rather than presenting them all
// alike.
function matchWindow(norm, query, opts) {
  if (!norm || !query.norm) return null;
  const q = query.norm;
  // The same query is run against every window on every page, so the needle is
  // compiled once and cached on the query object rather than per candidate.
  if (query._compiled !== q) { query._compiled = q; query._needle = compileConfusable(q); }
  const needle = query._needle;
  const conf = (opts && opts.conf) || null;

  if (query.exactOnly) {
    if (norm === q) {
      return { pos: 0, len: norm.length, whole: true, confused: false, fuzzy: false, cost: 0, subs: 0, unknowns: 0, indels: 0 };
    }
    // Exact mode still tolerates glyph confusion — "exact" is about the tag
    // being the whole string, not about trusting OCR's spelling of it — but the
    // alignment has to cover the candidate end to end.
    const hit = confusableMatch(norm, needle, { allowIndels: query.allowIndels, conf });
    if (hit && hit.pos === 0 && hit.len === norm.length) {
      return { ...describe(hit, false, norm.length), pos: 0, len: norm.length, whole: true };
    }
    return null;
  }

  const exactPos = norm.indexOf(q);
  if (exactPos !== -1) {
    return { pos: exactPos, len: q.length, whole: norm.length === q.length,
             confused: false, fuzzy: false, cost: 0, subs: 0, unknowns: 0, indels: 0 };
  }

  const hit = confusableMatch(norm, needle, { allowIndels: query.allowIndels, conf });
  if (hit) return describe(hit, false, norm.length);

  // Last resort, and only when asked for: assume nothing the engine reported is
  // reliable. Anything found this way is a guess by construction and is labelled
  // as one.
  if (query.fuzzy) {
    const loose = confusableMatch(norm, needle, {
      allowIndels: true, conf: capConfidence(conf, norm.length, FUZZY_CONFIDENCE_CAP),
    });
    if (loose) return describe(loose, true, norm.length);
  }
  return null;
}

export { matchWindow, FUZZY_CONFIDENCE_CAP };
