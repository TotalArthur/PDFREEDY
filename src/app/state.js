// Shared mutable document state.
//
// This was a set of closure variables in the original single-file build. As a
// module it has to be one object: ES module `let` exports are read-only for
// importers, and nearly every module here assigns to this state.
const S = {
  pdfDoc: null,
  numPages: 0,
  currentPage: 1,
  scale: 1.5,
  pageProxyCache: new Map(),   // pageNum -> pdf.js page proxy promise
  pageData: new Map(),         // pageNum -> { status, source, textItems, lineGroups, ocrWords, ocrLines, thumbCanvas, thumbScale, rawLen }
  lastResults: [],             // current search result set
  activeResultIndex: -1,
  ocrScheduler: null,          // lazily-created tesseract worker pool (Tesseract.createScheduler)
  currentRenderTask: null,     // in-flight pdf.js render on the page canvas
  // Bumped every time a document is loaded/cleared. Background work captures the
  // epoch it started under and bails out once it's stale, so a queue belonging to
  // a previous PDF can't overwrite the new document's status, badge or ticker.
  docEpoch: 0,
  processingCancelled: false,
  isBackgroundRunning: false,
  currentQuery: { raw: '', norm: '', exactOnly: false, fuzzy: false },
  tickerHandle: null,
  // Set when a search found nothing on the cheap pass and only turned results
  // up once the matcher was allowed to absorb dropped characters. Those hits
  // are worth surfacing but not worth presenting as certainties.
  deepSearchUsed: false,

  // Pencil markup tool.
  mode: 'view',                // 'view' | 'markup'
  markupTool: 'pen',           // 'pen' | 'line' | 'polyline'
  markupColor: '#ff3b30',
  markupWidth: 3,               // PDF-space points (not canvas pixels)
  markupOpacity: 1,             // 0..1
  markups: new Map(),          // pageNum -> Stroke[]
  // Cloned copy of the loaded file's bytes, kept around because pdf.js can
  // detach/transfer the ArrayBuffer it's handed. Needed at export time to
  // load the original PDF into pdf-lib for burning in markups.
  rawFileBytes: null,
  fileName: '',
};

// Test-only observability hook (see tests/e2e.test.mjs, tests/e2e-markup.test.mjs):
// lets a test inspect raw per-source extraction (e.g. OCR word data) directly,
// independent of what the deduped/merged results list ends up showing.
if (typeof window !== 'undefined') window.__pdfreedyState = S;

export { S };
