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
};

export { S };
