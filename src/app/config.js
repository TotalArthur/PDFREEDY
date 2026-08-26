// Tuning constants for extraction and matching.

const OCR_SCALE = 3.5;               // render scale used for OCR passes (landscape-only by default, so there's headroom for a sharper single pass)
const TEXT_LEN_THRESHOLD = 20;       // page text length above which we skip OCR
const JOIN_GAP_FACTOR = 2.2;         // how close adjacent items/words must be to join into a window
const MAX_WINDOW = 6;                // max consecutive items/words joined when testing a match
// Every orientation OCR can read a page in. Only the first is run by default;
// the rest are opt-in ("Also scan rotated/vertical text") and are added to a
// page's existing words rather than replacing them.
const ROTATIONS = [0, 90, 180, 270];
// The two passes a quick pixel check can justify skipping — see
// likelySidewaysText in preprocess.js. An upside-down glyph has the same
// bounding-box shape as an upright one, so that check can't tell 0 from 180
// apart; those two always run when the toggle is on. Only 90/270 are gated.
const SIDEWAYS_ROTATIONS = [90, 270];

// Tesseract workers in the pool. One core is left for the UI thread (canvas
// rendering, DOM updates) so OCR throughput doesn't come at the cost of a
// stuttering interface. Clamped to [1, 8]: hardwareConcurrency can be 1 (a
// throttled VM) or absent (older browsers report undefined) on the low end,
// and unbounded on the high end where more workers just means more idle
// wasm instances fighting over the same disk-cached model.
const OCR_POOL_SIZE = Math.max(1, Math.min(8,
  (typeof navigator !== 'undefined' && navigator.hardwareConcurrency || 4) - 1));

// =======================================================================
// Tesseract configuration
//
// Dictionary flags CANNOT be applied with setParameters. Tesseract rejects
// them after initialization ("Attempted to set parameters that can only be set
// during initialization") and tesseract.js only logs it — so the tool passed
// them that way for its whole life and the English dictionary was on the
// entire time, doing exactly what the code comment said it must not: dragging
// tag reads toward real words. On a degraded `V-6801-15PW4` that is the
// difference between reading "VOL ASP" and reading "15PW", i.e. between a tag
// the matcher can never recover and one it can.
//
// They belong in the 4th argument of createWorker(), which is the init config.
// =======================================================================
const TESSERACT_INIT = {
  load_system_dawg: '0',
  load_freq_dawg: '0',
  load_punc_dawg: '0',
  load_number_dawg: '0',
  load_unambig_dawg: '0',
  load_bigram_dawg: '0',
};

// The PSM enum comes from whichever Tesseract build is calling (a global in the
// browser, an import in the bench harness), so it is passed in rather than
// reached for here.
function tesseractParams(PSM) {
  return {
    // P&ID sheets are mostly line art with sparse, scattered labels, not
    // paragraphs — SPARSE_TEXT skips Tesseract's column/block layout analysis
    // (the slow, and on a drawing often wrong, part of the default "fully
    // automatic" mode) and just hunts for text directly.
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    // Narrowing the character set cuts down on stray-symbol noise (stuff like
    // "=", "©", "•" picked up from line art) and measurably helps both accuracy
    // and decoding speed for tag-style text.
    // Uppercase only. Every comparison in this tool runs through normalize(),
    // which upper-cases anyway, so a lowercase alphabet can never help a match
    // — it only gives the decoder extra ways to be wrong (picking 'l' over '1',
    // 'o' over '0'). Removing it strictly shrinks the error space.
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/.,:()#&+ ",
    // NOTE: user_defined_dpi is deliberately NOT set here.
    //
    // Left unset, Tesseract guesses the resolution per image and guesses
    // differently for the same source at different scales, which is unsatisfying
    // — but declaring 72 * OCR_SCALE measured WORSE on the bench corpus
    // (`node bench/eval.mjs`, pipeline nodict_dpi), and for a good reason: the
    // render scale says how big the page is, not how big the glyphs are. A
    // low-resolution raster pasted into a large page renders at 252 dpi and
    // still has 9-pixel characters. The right value comes from measuring glyph
    // height on the binary plane; until that measurement exists, an unset value
    // beats a confidently wrong one.
  };
}

export { OCR_SCALE, TEXT_LEN_THRESHOLD, JOIN_GAP_FACTOR, MAX_WINDOW, ROTATIONS,
         SIDEWAYS_ROTATIONS, OCR_POOL_SIZE, TESSERACT_INIT, tesseractParams };
