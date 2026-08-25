#!/usr/bin/env bash
# One-shot scaffold: carve the original single-file index.html into src/ modules.
# Kept in the repo as the record of how the split was produced; it is NOT part of
# the build (see build.mjs). Line numbers refer to the pre-split index.html at
# commit fada46e.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=${1:-orig.html}

cut_() { awk -v a="$1" -v b="$2" 'NR>=a && NR<=b' "$SRC" | sed 's/^  //'; }

# Shared mutable state moves onto a single object, because ES module `let`
# exports are read-only for importers and this code assigns to them from
# everywhere. The `getViewport({ scale })` shorthand is expanded first so the
# rewrite cannot turn it into a syntax error.
STATE='pdfDoc|numPages|currentPage|scale|pageProxyCache|pageData|lastResults|activeResultIndex|ocrWorker|currentRenderTask|docEpoch|processingCancelled|skipCurrentPageRequested|isBackgroundRunning|currentQuery|tickerHandle'
stateify() {
  sed 's/getViewport({ scale })/getViewport({ scale: S.scale })/g' \
  | perl -pe "s/(?<![.\\w\\\$])($STATE)\\b(?!\\s*:)/S.\$1/g"
}

# Emit the `import { ... } from './dom.js'` line a module actually needs, by
# looking for each dom export as a whole word in the module body.
autodom() {
  local body="$1" names=()
  while read -r n; do
    grep -qP "(?<![.\\w\$])$n\\b" "$body" && names+=("$n")
  done < <(grep -oP '^  \K\w+(?=,$)' src/app/dom.js)
  [ ${#names[@]} -eq 0 ] && return 0
  printf "import {\n"
  printf "  %s,\n" "${names[@]}"
  printf "} from './dom.js';\n"
}

# Emit exports for every top-level function/const a module body declares.
autoexport() {
  echo
  echo 'export {'
  grep -oP '^(async function|function|const|let) \K\w+' "$1" | sort -u | sed 's/^/  /;s/$/,/'
  echo '};'
}

mkdir -p src/lib src/app

# ---------------------------------------------------------------- app/dom.js
{
  echo '// Every element the app touches, resolved once. The bundle therefore has to'
  echo '// stay at the end of <body>, exactly where the original inline script was.'
  echo
  cut_ 398 441
} > /tmp/dom.body
{
  cat /tmp/dom.body
  echo
  echo 'export {'
  grep -oP '^(const|let) \K\w+' /tmp/dom.body | sed 's/^/  /;s/$/,/'
  echo '};'
} > src/app/dom.js

# ------------------------------------------------------------- app/config.js
{
  echo '// Tuning constants for extraction and matching.'
  echo
  cut_ 465 468
  echo
  echo 'export { OCR_SCALE, TEXT_LEN_THRESHOLD, JOIN_GAP_FACTOR, MAX_WINDOW };'
} > src/app/config.js

# -------------------------------------------------------------- app/state.js
cat > src/app/state.js <<'EOF'
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
EOF

# -------------------------------------------------------- app/corrections.js
cut_ 572 618 | stateify > /tmp/body
{
  echo "import { normalize } from '../lib/text.js';"
  autodom /tmp/body
  echo
  cat /tmp/body
  cat <<'EOF'

function clearCorrections() {
  corrections.clear();
  saveCorrections();
  updateCorrectionsBar();
}

export { loadCorrections, setCorrection, getCorrection, updateCorrectionsBar, clearCorrections };
EOF
} > src/app/corrections.js

# ---------------------------------------------------------------- app/pdf.js
cut_ 687 806 | stateify > /tmp/body
{
  cat <<'EOF'
import { S } from './state.js';
import { renderPage } from './viewer.js';
import { updateProcSummary, startBackgroundProcessing, hidePageProgressBanner } from './queue.js';
EOF
  autodom /tmp/body
  echo
  cat /tmp/body
  autoexport /tmp/body
} > src/app/pdf.js

# ---------------------------------------------------------- app/textlayer.js
cut_ 808 936 | stateify > /tmp/body
{
  cat <<'EOF'
import { S } from './state.js';
import { normalize } from '../lib/text.js';
import { matchWindow } from '../lib/matching.js';
import { TEXT_LEN_THRESHOLD, JOIN_GAP_FACTOR, MAX_WINDOW } from './config.js';
import { getPageProxy } from './pdf.js';
EOF
  autodom /tmp/body
  echo
  cat /tmp/body
  autoexport /tmp/body
} > src/app/textlayer.js

# ---------------------------------------------------------------- app/ocr.js
{ cut_ 938 968; echo; cut_ 1108 1227; } | stateify > /tmp/body
{
  cat <<'EOF'
import { S } from './state.js';
import { normalize } from '../lib/text.js';
import { matchWindow } from '../lib/matching.js';
import { preprocessForOcr, rotateCanvas } from '../lib/preprocess.js';
import { mapBoxBack, readingAxis, boundsOfPoints } from '../lib/geometry.js';
import { OCR_SCALE, JOIN_GAP_FACTOR, MAX_WINDOW } from './config.js';
import { getPageProxy } from './pdf.js';
import { getCorrection } from './corrections.js';
EOF
  autodom /tmp/body
  echo
  cat /tmp/body
  autoexport /tmp/body
} > src/app/ocr.js

# -------------------------------------------------------------- app/queue.js
# `let tickerHandle = null;` lived here; it is part of S now.
cut_ 1229 1371 | stateify | grep -v '^let S\.tickerHandle' > /tmp/body
{
  cat <<'EOF'
import { S } from './state.js';
import { extractTextLayer } from './textlayer.js';
import { runOcrForPage } from './ocr.js';
import { updatePageBadge, drawHighlights } from './viewer.js';
import { searchPage, mergeFreshResults } from './search.js';
EOF
  autodom /tmp/body
  echo
  cat /tmp/body
  autoexport /tmp/body
} > src/app/queue.js

# ------------------------------------------------------------- app/search.js
cut_ 1373 1438 | stateify > /tmp/body
{
  cat <<'EOF'
import { S } from './state.js';
import { normalize } from '../lib/text.js';
import { searchTextLayer } from './textlayer.js';
import { searchOcr } from './ocr.js';
import { renderResultsList } from './results.js';
import { drawHighlights } from './viewer.js';
EOF
  autodom /tmp/body
  echo
  cat /tmp/body
  autoexport /tmp/body
} > src/app/search.js

# ------------------------------------------------------------ app/results.js
cut_ 1440 1646 | stateify > /tmp/body
{
  cat <<'EOF'
import { S } from './state.js';
import { clamp, escapeHtml } from '../lib/text.js';
import { itemQuadCanvas, boundsOfPoints } from '../lib/geometry.js';
import { setCorrection } from './corrections.js';
import { getPageProxy } from './pdf.js';
import { runFullSearch } from './search.js';
import { jumpToResult } from './viewer.js';
EOF
  autodom /tmp/body
  echo
  cat /tmp/body
  autoexport /tmp/body
} > src/app/results.js

# ------------------------------------------------------------- app/viewer.js
cut_ 1648 1834 | stateify > /tmp/body
{
  cat <<'EOF'
import { S } from './state.js';
import { clamp } from '../lib/text.js';
import { itemQuadCanvas, boundsOfPoints } from '../lib/geometry.js';
import { getPageProxy } from './pdf.js';
import { updateProcSummary, hidePageProgressBanner } from './queue.js';
import { renderResultsList } from './results.js';
EOF
  autodom /tmp/body
  echo
  cat /tmp/body
  autoexport /tmp/body
} > src/app/viewer.js

# --------------------------------------------------------------- app/main.js
cat > src/app/main.js <<'EOF'
// Entry point. Imports are ordered so the leaf modules (dom, state) evaluate
// first; everything below that is function declarations plus event-listener
// registration, so the import cycles between them resolve at call time.
import { clearCorrectionsBtn } from './dom.js';
import { S } from './state.js';
import { loadCorrections, updateCorrectionsBar, clearCorrections } from './corrections.js';
import { runFullSearch } from './search.js';
import './pdf.js';
import './queue.js';
import './results.js';
import './viewer.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

clearCorrectionsBtn.addEventListener('click', () => {
  clearCorrections();
  if (S.currentQuery.norm) runFullSearch();
});

loadCorrections();
updateCorrectionsBar();
EOF

rm -f /tmp/body /tmp/dom.body
echo "extracted:"; wc -l src/app/*.js src/lib/*.js
