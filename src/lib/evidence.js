/*
 * Why is this the right find?
 *
 * A search on a real sheet returned three results: the correct tag, and two
 * wrong ones. All three were in the same tier, wore the same badge, and were
 * listed in page order, so there was nothing to tell them apart. The user had
 * to open three crops and decide by eye.
 *
 * Anyone looking at those crops knows immediately which is right, and the
 * reasons are all things the tool already had in memory:
 *
 *   - four of five characters matched outright, and the one that didn't was
 *     reported by OCR at 0% confidence — an admission, not an assertion
 *   - it sits inside 18-6-MC-.....-1C3B1, where everything either side read
 *     cleanly, in its own field between separators
 *   - the wrong answers have none of that: one is a confident read that simply
 *     disagrees, the other is unreadable AND unlike the tag
 *
 * So this turns those into a score, and — more importantly — into a sentence.
 * The score decides the order; the sentence is what lets someone check the
 * tool's reasoning instead of taking its word for it.
 *
 * The weights are a judgement, not a measurement, and are deliberately few and
 * separable so the sentence and the number can never disagree.
 */

// How much corroborating context counts as "plenty". A tag sitting inside a
// full line number has this much text around it; beyond that, more adds nothing.
const CONTEXT_SATURATION = 8;

function scoreResult(res) {
  const len = res.matchLen || 1;
  const subs = res.subs || 0;
  const unknowns = res.unknowns || 0;
  const indels = res.indels || 0;
  const contextChars = res.contextChars || 0;
  const contextConf = typeof res.contextConf === 'number' ? res.contextConf : 1;

  // Of the characters the query matched, how many landed outright.
  const exactness = Math.max(0, (len - subs - indels) / len);
  // Corroboration: how much text sits around the match, and how well it read.
  const context = Math.min(1, contextChars / CONTEXT_SATURATION) * contextConf;

  const score =
      2.0 * exactness
    + 1.2 * context
    + 0.4 * (res.delimited ? 1 : 0)
    + 0.6 * (res.source === 'text' ? 1 : 0)   // a real text layer is not a guess
    + 0.8 * (res.corrected ? 1 : 0)           // the user has already confirmed this one
    - 1.0 * Math.min(1, (res.cost || 0))
    - 0.5 * indels
    - 0.3 * (res.fuzzy ? 1 : 0);

  return { score, reasons: reasonsFor(res, { exactness, contextChars, contextConf }) };
}

// The same facts, in words. Written so a reader can disagree with the tool.
function reasonsFor(res, d) {
  const out = [];
  const len = res.matchLen || 0;
  const differing = (res.subs || 0) + (res.indels || 0);

  if (res.corrected) {
    out.push('You confirmed this one earlier.');
  } else if (!differing) {
    out.push(res.source === 'text' ? 'Matched exactly, in the PDF’s own text.' : 'Matched exactly.');
  } else {
    out.push(`${len - differing} of ${len} characters matched exactly.`);
  }

  if (res.unknowns > 0) {
    const pct = Math.round((res.matchConf ?? 0) * 100);
    out.push(res.unknowns === 1
      ? `The one that differs was read at ${pct}% confidence — OCR could not make it out.`
      : `${res.unknowns} of them were unreadable (${pct}% confidence).`);
  } else if (differing > (res.indels || 0)) {
    out.push('The rest differ only by characters that render identically at drawing scale.');
  }

  if (res.indels > 0) {
    out.push(res.indels === 1
      ? 'One character appears to be missing from the read entirely.'
      : `${res.indels} characters appear to be missing from the read.`);
  }

  if (d.contextChars >= 3) {
    out.push(`Surrounded by ${d.contextChars} characters of text that read at ${Math.round(d.contextConf * 100)}% confidence.`);
  } else if (d.contextChars === 0) {
    out.push('Nothing around it corroborates it.');
  }

  if (res.delimited && d.contextChars >= 3) out.push('It occupies a whole field, between separators.');
  if (res.fuzzy) out.push('Found only by disregarding what OCR reported — treat with suspicion.');

  return out;
}

export { scoreResult, reasonsFor, CONTEXT_SATURATION };
