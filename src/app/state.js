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
  ocrWorker: null,             // lazily-created shared tesseract worker
  currentRenderTask: null,     // in-flight pdf.js render on the page canvas
  // Bumped every time a document is loaded/cleared. Background work captures the
  // epoch it started under and bails out once it's stale, so a queue belonging to
  // a previous PDF can't overwrite the new document's status, badge or ticker.
  docEpoch: 0,
  processingCancelled: false,
  skipCurrentPageRequested: false,
  isBackgroundRunning: false,
  currentQuery: { raw: '', norm: '', exact: false, fuzzy: false },
  tickerHandle: null,
};

export { S };
