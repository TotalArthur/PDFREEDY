#!/usr/bin/env bash
# Cache pdf.js, pdf-lib, tesseract.js and its worker/core/language data
# locally, so tests/e2e.test.mjs (which exercises the real OCR path) runs
# with no network. Dev-time only — the shipped page still loads them from
# the CDN.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p tests/vendor && cd tests/vendor
for url in \
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js" \
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js" \
  "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js" \
  "https://cdn.jsdelivr.net/npm/tesseract.js@5.0.4/dist/tesseract.min.js" \
  "https://cdn.jsdelivr.net/npm/tesseract.js@5.0.4/dist/worker.min.js" \
  "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core-simd.wasm.js" \
  "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core.wasm.js" \
  "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core-simd-lstm.wasm.js" \
  "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core-lstm.wasm.js" \
  "https://tessdata.projectnaptha.com/4.0.0_best/eng.traineddata.gz" ; do
  curl -sSfL -o "$(basename "$url")" "$url"
  echo "fetched $(basename "$url")"
done
