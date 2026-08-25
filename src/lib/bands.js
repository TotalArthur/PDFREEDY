/*
 * How sure are we about this hit?
 *
 * The matcher will now bridge a fair amount of damage to find a tag — glyph
 * confusions, and characters that blur erased entirely. That is the point, but
 * it makes the old presentation dishonest: a hit that needed two substitutions
 * and a deletion to land was shown in the same list, the same way, as one that
 * matched exactly.
 *
 * So every result carries the cost the match had to absorb, and that cost picks
 * a band. The bands are ordered by how much the user has to check:
 *
 *   confirmed — matched exactly, or came from a real PDF text layer
 *   likely    — bridged only characters no engine can distinguish (0/O, 1/I)
 *   possible  — needed a heavier substitution, or a character that isn't there
 *
 * "possible" hits are still shown, always. Hiding them is how a tag that is
 * plainly on the drawing ends up reported as absent. But they are shown as what
 * they are, behind their own heading, with the crop to check against.
 */
const BANDS = ['confirmed', 'likely', 'possible'];

const BAND_LABEL = {
  confirmed: 'Matches',
  likely: 'Likely — glyphs OCR cannot distinguish',
  possible: 'Possible — check the crop',
};

const BAND_NOTE = {
  confirmed: '',
  likely: 'Matched through characters that render identically at drawing scale (0/O, 1/I, 5/S, 8/B, 6/G, 2/Z).',
  possible: 'Matched only by allowing heavier damage — a substitution that needs a soft image to explain, or a character OCR lost entirely. Verify against the crop before using these.',
};

// Tier-1 substitution cost, from the confusion table. A match whose total cost
// is no more than this per substitution used tier-1 pairs and nothing else.
const T1_COST = 0.12;

/*
 * The line between "likely" and "possible" is not a tuned constant, it's a
 * claim: did everything that differed come from a pair no engine can physically
 * distinguish?
 *
 * That is what `cost <= subs * T1_COST` says, exactly. Five 0-for-O
 * substitutions in a 21-character tag stay "likely" — that is the canonical
 * case this tool exists for — while a single 1-for-4, which needs a soft image
 * to explain at all, drops to "possible" on its own. A fixed cost ceiling got
 * this backwards: it filed the long, thoroughly-explained match as a guess and
 * would have passed the short, weakly-explained one.
 */
function bandOf(res) {
  if (res.fuzzy) return 'possible';
  if (res.indels > 0) return 'possible';
  if (!res.cost) return 'confirmed';
  // Missing evidence is not a reason to promote a hit. If a caller hasn't
  // carried the substitution count through, the honest answer is "check it".
  if (typeof res.subs !== 'number') return 'possible';
  return res.cost <= res.subs * T1_COST + 1e-9 ? 'likely' : 'possible';
}

export { BANDS, BAND_LABEL, BAND_NOTE, T1_COST, bandOf };
