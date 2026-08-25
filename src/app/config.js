// Tuning constants for extraction and matching.

const OCR_SCALE = 3.5;               // render scale used for OCR passes (landscape-only by default, so there's headroom for a sharper single pass)
const TEXT_LEN_THRESHOLD = 20;       // page text length above which we skip OCR
const JOIN_GAP_FACTOR = 2.2;         // how close adjacent items/words must be to join into a window
const MAX_WINDOW = 6;                // max consecutive items/words joined when testing a match

export { OCR_SCALE, TEXT_LEN_THRESHOLD, JOIN_GAP_FACTOR, MAX_WINDOW };
