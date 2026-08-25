// Every element the app touches, resolved once. The bundle therefore has to
// stay at the end of <body>, exactly where the original inline script was.

const $ = id => document.getElementById(id);
const fileInput = $('fileInput');
const fileInfo = $('fileInfo');
const dropOverlay = $('dropOverlay');
const correctionsBar = $('correctionsBar');
const correctionsCount = $('correctionsCount');
const clearCorrectionsBtn = $('clearCorrectionsBtn');
const searchInput = $('searchInput');
const searchBtn = $('searchBtn');
const exactToggle = $('exactToggle');
const fuzzyToggle = $('fuzzyToggle');
const searchSummary = $('searchSummary');
const procDetail = $('procDetail');
const procDetailText = $('procDetailText');
const procSpinner = $('procSpinner');
const procBarInner = $('procBarInner');
const skipPageBtn = $('skipPageBtn');
const cancelProcBtn = $('cancelProcBtn');
const resultsCount = $('resultsCount');
const resultsList = $('resultsList');
const exportCsvBtn = $('exportCsvBtn');
const toolbar = $('toolbar');
const prevPageBtn = $('prevPageBtn');
const nextPageBtn = $('nextPageBtn');
const pageNumInput = $('pageNumInput');
const pageCountLabel = $('pageCountLabel');
const currentPageBadge = $('currentPageBadge');
const zoomOutBtn = $('zoomOutBtn');
const zoomInBtn = $('zoomInBtn');
const zoomLabel = $('zoomLabel');
const fitWidthBtn = $('fitWidthBtn');
const zoomResetBtn = $('zoomResetBtn');
const canvasScroll = $('canvasScroll');
const canvasStage = $('canvasStage');
const pageCanvas = $('pageCanvas');
const overlayCanvas = $('overlayCanvas');
const rotatedTextToggle = $('rotatedTextToggle');
const emptyViewer = $('emptyViewer');
const pageProgressBanner = $('pageProgressBanner');
const pageProgressText = $('pageProgressText');
const pageProgressSpinner = $('pageProgressSpinner');

const pageCtx = pageCanvas.getContext('2d');
const overlayCtx = overlayCanvas.getContext('2d');

export {
  fileInput,
  fileInfo,
  dropOverlay,
  correctionsBar,
  correctionsCount,
  clearCorrectionsBtn,
  searchInput,
  searchBtn,
  exactToggle,
  fuzzyToggle,
  searchSummary,
  procDetail,
  procDetailText,
  procSpinner,
  procBarInner,
  skipPageBtn,
  cancelProcBtn,
  resultsCount,
  resultsList,
  exportCsvBtn,
  toolbar,
  prevPageBtn,
  nextPageBtn,
  pageNumInput,
  pageCountLabel,
  currentPageBadge,
  zoomOutBtn,
  zoomInBtn,
  zoomLabel,
  fitWidthBtn,
  zoomResetBtn,
  canvasScroll,
  canvasStage,
  pageCanvas,
  overlayCanvas,
  rotatedTextToggle,
  emptyViewer,
  pageProgressBanner,
  pageProgressText,
  pageProgressSpinner,
  pageCtx,
  overlayCtx,
};
