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
// specificity — GP and 6P would collide), we align the query against the
// candidate and permit a mismatch ONLY where the two characters are a known
// confusable pair. A candidate must still match the query everywhere else, so
// precision stays high while the ambiguous glyph pairs stop causing misses.
//
// Two things changed once the pipeline was actually measured (bench/README.md):
//
//   1. Equivalence classes were too blunt. '0OQD' as one class charges D-for-Q
//      exactly what it charges 0-for-O, and those are not the same claim. Pairs
//      now carry individual costs, in three tiers.
//
//   2. Substitution alone cannot express what blur does. On the bench corpus
//      the commonest remaining failure is a character that vanished entirely —
//      FIC-2015 read as "FC2015", XV-3308 as "X-3308", 6"-P-1052-A1A-HC as
//      "-P-1052-A1A-HC". A fixed-length positional compare cannot see any of
//      those: the read is SHORTER than the query, so even a plain substring
//      search fails. So the matcher is now an edit distance that can delete and
//      insert, under a strict cost budget.
// =======================================================================

// Tier 1 — physically indistinguishable at drawing scale. These are the pairs
// the original confusion classes named, minus the transitive over-reach.
const NEAR_IDENTICAL = ['0O', '1I', '1L', 'IL', '2Z', '5S', '6G', '8B', '7T', '4A', 'OQ', '0Q', 'DO', 'D0'];

// Tier 2 — reliably confused once the image is soft: a thin stroke closes a
// counter, or a leg is lost. R is P with a leg; F is E with a bar; C is G
// without one.
const BLUR_CONFUSABLE = ['68', '38', '89', '56', 'CG', 'CO', 'C0', 'G0', 'EF', 'FP', 'PR',
                         'UV', 'VY', 'MW', 'MN', 'HN', 'IJ', 'J1', 'X K', 'KX', '39', 'S8', 'Z7'];

// Tier 3 — only under heavy degradation, but observed on the bench corpus:
// V-6801-15PW4 came back as "V-B80115PWA" (6 read as B) and LT-11004 as
// "LT-41004" (1 read as 4).
const HEAVY = ['6B', '14', '17', '49', '90', '5G', 'QD'];

const T1 = 0.12, T2 = 0.35, T3 = 0.55;

// Cost of substituting one character for another. Infinity means "these are
// different characters and no amount of blur makes them the same" — that hard
// wall, not the budget, is what stops PT-11005 matching PT-11004.
const SUB_COST = (() => {
  const m = new Map();
  const put = (pair, cost) => {
    const [a, b] = [pair[0], pair[pair.length - 1]];
    m.set(a + b, cost); m.set(b + a, cost);
  };
  for (const p of NEAR_IDENTICAL) put(p, T1);
  for (const p of BLUR_CONFUSABLE) put(p, T2);
  for (const p of HEAVY) put(p, T3);
  return m;
})();

function substitutionCost(a, b) {
  if (a === b) return 0;
  const c = SUB_COST.get(a + b);
  return c === undefined ? Infinity : c;
}

// normalize() leaves only A-Z0-9, so the whole alphabet is 36 symbols and the
// cost function is a small dense matrix. The alignment reads this millions of
// times per search; a Float64Array lookup on two small integers is worth a lot
// over building a two-character string and hashing it in a Map every time.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_OF = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) CODE_OF[ALPHABET.charCodeAt(i)] = i;
const A = ALPHABET.length;
const COST_TABLE = (() => {
  const t = new Float64Array(A * A).fill(Infinity);
  for (let i = 0; i < A; i++) {
    t[i * A + i] = 0;
    for (let j = 0; j < A; j++) {
      if (i === j) continue;
      const c = SUB_COST.get(ALPHABET[i] + ALPHABET[j]);
      if (c !== undefined) t[i * A + j] = c;
    }
  }
  return t;
})();

// Anything outside A-Z0-9 (which normalize() should already have removed) is
// given its own code so it can only ever match itself.
function encode(str) {
  const out = new Int16Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out[i] = c < 128 ? CODE_OF[c] : -1;
    if (out[i] < 0) out[i] = -1 - i;   // unique, matches nothing but itself
  }
  return out;
}
function costOf(a, b) {
  if (a === b) return 0;
  if (a < 0 || b < 0) return Infinity;
  return COST_TABLE[a * A + b];
}

// "Two glyphs OCR genuinely cannot tell apart" — tier 1 only. The wider tiers
// are a weaker claim (confusable *once degraded*), and conflating them would
// make this predicate mean less than it says.
function charsConfusable(a, b) {
  return substitutionCost(a, b) <= T1;
}

// A whole character lost or gained. Priced so that one dropped glyph in a
// realistic tag fits the budget and two do not, except in long tags where
// there is more evidence to go on.
const INDEL_COST = 0.8;

function indelAllowance(len) {
  if (len < 6) return 0;
  return len < 16 ? 1 : 2;
}

// Total cost budget. Grows with length because a longer tag carries more
// corroborating characters, so tolerating more damage stays safe.
function confusionBudget(len) {
  if (len < 4) return 0;                        // too short to risk it
  return 0.35 + 0.085 * len;
}


// Characters that tier 1 says are the same glyph, folded to one representative.
// Only used for the cheap admissibility test below — matching itself never
// folds, because folding is exactly what destroys specificity (GP vs 6P).
const T1_FOLD = (() => {
  const parent = new Map();
  const find = (c) => { while (parent.has(c)) c = parent.get(c); return c; };
  for (const pair of NEAR_IDENTICAL) {
    const a = find(pair[0]), b = find(pair[pair.length - 1]);
    if (a !== b) parent.set(b, a);
  }
  const m = new Map();
  for (const pair of NEAR_IDENTICAL) for (const ch of pair) m.set(ch, find(ch));
  return m;
})();
const fold = (c) => T1_FOLD.get(c) || c;

// The same folding as a table over the numeric alphabet, for the hot path.
const FOLD_CODE = (() => {
  const t = new Int8Array(A);
  for (let i = 0; i < A; i++) t[i] = CODE_OF[fold(ALPHABET[i]).charCodeAt(0)];
  return t;
})();

// The cheapest edit that isn't free: anything tier 1 can't explain costs at
// least a tier-2 substitution.
const MIN_REAL_EDIT = Math.min(T2, INDEL_COST);

/*
 * Everything about a needle that doesn't change from window to window.
 * A search runs this matcher over every candidate window on every page, so the
 * per-needle work is done once and the per-window work is kept as small as it
 * can be.
 */
function compileConfusable(needle) {
  const counts = new Map();
  const byCode = new Int32Array(A);
  for (const ch of needle) {
    const f = fold(ch);
    counts.set(f, (counts.get(f) || 0) + 1);
    const code = CODE_OF[ch.charCodeAt(0)];
    if (code >= 0) byCode[FOLD_CODE[code]]++;
  }
  // Flattened (foldedCode, count) pairs — the admissibility test walks this for
  // every candidate window on the sheet, so it must not touch a Map.
  const pairs = [];
  for (let i = 0; i < A; i++) if (byCode[i]) pairs.push(i, byCode[i]);
  const budget = confusionBudget(needle.length);
  return {
    needle,
    codes: encode(needle),
    budget,
    maxIndels: indelAllowance(needle.length),
    counts,
    foldPairs: Int32Array.from(pairs),
    // How many needle characters may be absent from the candidate entirely
    // before the cheapest possible explanation already exceeds the budget.
    maxMissing: Math.floor(budget / MIN_REAL_EDIT),
  };
}

// Cheap reject. Counts how many of the needle's characters (folded by tier 1)
// the candidate simply does not contain. Each one has to be paid for by a
// tier-2+ substitution or an indel, so if there are more of them than the
// budget can cover at the cheapest possible rate, no alignment can succeed and
// the alignment itself is never run.
const AVAIL = new Int32Array(A);
const AVAIL_STAMP = new Int32Array(A);
let availGen = 0;

function admissible(hayCodes, c) {
  // Stamped rather than cleared: zeroing 36 slots per window across tens of
  // thousands of windows is measurable, and this runs on every one of them.
  availGen++;
  for (let i = 0; i < hayCodes.length; i++) {
    const code = hayCodes[i];
    if (code < 0) continue;
    const f = FOLD_CODE[code];
    if (AVAIL_STAMP[f] !== availGen) { AVAIL_STAMP[f] = availGen; AVAIL[f] = 0; }
    AVAIL[f]++;
  }
  let missing = 0;
  const pairs = c.foldPairs;
  for (let i = 0; i < pairs.length; i += 2) {
    const f = pairs[i], want = pairs[i + 1];
    const have = AVAIL_STAMP[f] === availGen ? AVAIL[f] : 0;
    if (have < want) {
      missing += want - have;
      if (missing > c.maxMissing) return false;
    }
  }
  return true;
}

/*
 * Substitution-only scan — the original algorithm, kept as a fast path.
 *
 * The great majority of real matches need no insertions or deletions at all,
 * and this answers those in O(n*m) with an early abort, instead of paying for
 * the full alignment. The alignment below only runs when this finds nothing.
 */
function substitutionScan(hayCodes, c) {
  const n = c.codes.length, m = hayCodes.length;
  if (n > m) return null;
  let best = null;
  for (let start = 0; start + n <= m; start++) {
    let cost = 0, subs = 0, ok = true;
    for (let k = 0; k < n; k++) {
      const a = hayCodes[start + k], b = c.codes[k];
      if (a === b) continue;
      cost += costOf(a, b); subs++;
      if (cost > c.budget) { ok = false; break; }
    }
    if (ok && (!best || cost < best.cost)) {
      best = { pos: start, len: n, cost, subs, indels: 0 };
      if (cost === 0) break;
    }
  }
  return best;
}

// Two reusable DP rows, grown on demand and never shrunk. Single-threaded and
// never re-entered mid-alignment, so one set is enough.
const SCRATCH = { cap: 0 };
function rowScratch(size) {
  if (SCRATCH.cap < size) {
    const cap = Math.max(size, SCRATCH.cap * 2, 256);
    SCRATCH.cap = cap;
    SCRATCH.a = new Float64Array(cap); SCRATCH.aStart = new Int32Array(cap); SCRATCH.aSubs = new Int32Array(cap);
    SCRATCH.b = new Float64Array(cap); SCRATCH.bStart = new Int32Array(cap); SCRATCH.bSubs = new Int32Array(cap);
  }
  return SCRATCH;
}

/*
 * Find `needle` inside `hay`, allowing confusable substitutions and a capped
 * number of insertions/deletions, under a total cost budget.
 *
 * This is a semi-global (glocal) alignment: the needle must be consumed
 * completely, but the hay may have unmatched text before and after it at no
 * cost — that is what makes it a substring search rather than a whole-string
 * comparison.
 *
 * The DP carries two extra pieces of state beyond position:
 *
 *   indels  — how many have been spent, capped by indelAllowance()
 *   lastOp  — whether the previous step was a delete or an insert
 *
 * Deletions at the two ends of the needle need one more guard. A trailing
 * delete plus the free suffix would let PT-11004 "match" PT-11005 by dropping
 * the 4 and leaving the 5 unread; a leading delete plus the free prefix would
 * let it match XT-11004. So an edge delete is only allowed where the hay has
 * nothing on that side to explain instead: a leading delete requires the match
 * to start at hay position 0, a trailing delete requires it to run to the end
 * of the hay. That still admits the case this was built for — 6"-P-1052-A1A-HC
 * read as "-P-1052-A1A-HC", where the 6 is simply gone.
 *
 * lastOp exists to close a different loophole. A forbidden substitution costs Infinity,
 * but a delete immediately followed by an insert achieves the same thing for
 * 2 x INDEL_COST — which would let PT-21004 match PT-11004 through the back
 * door. Forbidding an insert straight after a delete (and vice versa) removes
 * that path structurally, rather than relying on the budget to be tuned finely
 * enough to exclude it.
 *
 * Returns { pos, len, cost, subs, indels } for the best alignment, or null.
 * pos/len describe the matched span in `hay`.
 */
function confusableMatch(hay, needle, opts) {
  const allowIndels = !opts || opts.allowIndels !== false;
  const c = typeof needle === 'string' ? compileConfusable(needle) : needle;
  const n = c.needle.length, m = hay.length;
  const { budget, maxIndels } = c;
  if (!n || budget === 0) return null;
  if (n > m + maxIndels) return null;

  const hayCodes = encode(hay);
  const quick = substitutionScan(hayCodes, c);
  if (quick) return quick;
  // The alignment costs roughly ten times what the scan above does. A search
  // that is already finding things doesn't need it, so callers can ask for the
  // cheap answer first and escalate only when nothing turned up.
  if (!allowIndels || maxIndels === 0) return null;
  if (!admissible(hayCodes, c)) return null;
  const needleCodes = c.codes;

  const K = maxIndels + 1;          // indel counts 0..maxIndels
  const S = 3;                      // 0 = sub/match, 1 = just deleted, 2 = just inserted
  const size = (m + 1) * K * S;
  const at = (j, k, s) => (j * K + k) * S + s;

  // The DP rows are scratch. This runs once per candidate window and there are
  // tens of thousands of those per sheet, so allocating six typed arrays per
  // row would spend more time in the garbage collector than in the alignment.
  const scratch = rowScratch(size);
  let prev = scratch.a, prevStart = scratch.aStart, prevSubs = scratch.aSubs;
  let cur = scratch.b, curStart = scratch.bStart, curSubs = scratch.bSubs;
  prev.fill(Infinity, 0, size);
  prevStart.fill(-1, 0, size);

  // Row 0: nothing of the needle consumed yet. Free to start anywhere in hay.
  for (let j = 0; j <= m; j++) {
    prev[at(j, 0, 0)] = 0;
    prevStart[at(j, 0, 0)] = j;
  }

  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity, 0, size);
    curStart.fill(-1, 0, size);
    const nc = needleCodes[i - 1];

    for (let j = 0; j <= m; j++) {
      for (let k = 0; k < K; k++) {
        for (let s = 0; s < S; s++) {
          // Substitute / match: consumes one of each. The previous op doesn't
          // constrain a substitution, so only the cheapest predecessor matters.
          if (j > 0 && s === 0) {
            let bestPs = -1, bestFrom = Infinity;
            for (let ps = 0; ps < S; ps++) {
              const from = prev[at(j - 1, k, ps)];
              if (from < bestFrom) { bestFrom = from; bestPs = ps; }
            }
            if (bestFrom !== Infinity) {
              const cost = bestFrom + costOf(hayCodes[j - 1], nc);
              const dst = at(j, k, 0);
              if (cost <= budget && cost < cur[dst]) {
                cur[dst] = cost;
                curStart[dst] = prevStart[at(j - 1, k, bestPs)];
                curSubs[dst] = prevSubs[at(j - 1, k, bestPs)] + (hayCodes[j - 1] === nc ? 0 : 1);
              }
            }
          }
          // Delete: the needle has a character the hay lost. Not allowed
          // straight after an insert (see the loophole note above), and not at
          // the leading edge unless the match starts at hay position 0.
          if (k + 1 < K && !(i === 1 && j !== 0)) {
            const from = prev[at(j, k, s)];
            if (from !== Infinity && s !== 2) {
              const cost = from + INDEL_COST;
              const dst = at(j, k + 1, 1);
              if (cost <= budget && cost < cur[dst]) {
                cur[dst] = cost;
                curStart[dst] = prevStart[at(j, k, s)];
                curSubs[dst] = prevSubs[at(j, k, s)];
              }
            }
          }
        }
      }
    }

    // Insert: the hay has an extra character the needle doesn't. Same row, so
    // it has to be a second sweep over j once the row exists.
    for (let j = 1; j <= m; j++) {
      for (let k = 0; k + 1 < K; k++) {
        for (let s = 0; s < S; s++) {
          if (s === 1) continue;               // no insert straight after a delete
          const from = cur[at(j - 1, k, s)];
          if (from === Infinity) continue;
          const cost = from + INDEL_COST;
          const dst = at(j, k + 1, 2);
          if (cost <= budget && cost < cur[dst]) {
            cur[dst] = cost;
            curStart[dst] = curStart[at(j - 1, k, s)];
            curSubs[dst] = curSubs[at(j - 1, k, s)];
          }
        }
      }
    }

    let t;
    t = prev; prev = cur; cur = t;
    t = prevStart; prevStart = curStart; curStart = t;
    t = prevSubs; prevSubs = curSubs; curSubs = t;
  }

  // Best alignment: needle fully consumed, ending anywhere in hay.
  let best = null;
  for (let j = 0; j <= m; j++) {
    for (let k = 0; k < K; k++) {
      for (let s = 0; s < S; s++) {
        const c = prev[at(j, k, s)];
        if (c === Infinity || c > budget) continue;
        // Trailing delete only counts if there is no unread hay after it.
        if (s === 1 && j !== m) continue;
        const start = prevStart[at(j, k, s)];
        if (start < 0) continue;
        if (!best || c < best.cost) {
          best = { pos: start, len: j - start, cost: c, subs: prevSubs[at(j, k, s)], indels: k };
        }
      }
    }
  }
  return best;
}

// Kept for callers that only want the classic substitution-only behaviour.
function confusableIndexOf(hay, needle) {
  const hit = confusableMatch(hay, needle);
  return hit && hit.indels === 0 ? { pos: hit.pos, subs: hit.subs } : null;
}

export { NEAR_IDENTICAL, BLUR_CONFUSABLE, HEAVY, SUB_COST, INDEL_COST,
         substitutionCost, charsConfusable, confusionBudget, indelAllowance,
         compileConfusable, confusableMatch, confusableIndexOf };
