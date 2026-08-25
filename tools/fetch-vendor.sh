#!/usr/bin/env bash
# Cache the two CDN libraries locally so tests/e2e.test.mjs can run hermetically.
# Dev-time only — the shipped page still loads them from the CDN.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p tests/vendor && cd tests/vendor
for url in \
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js" \
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js" \
  "https://cdn.jsdelivr.net/npm/tesseract.js@5.0.4/dist/tesseract.min.js" ; do
  curl -sSfL -o "$(basename "$url")" "$url"
  echo "fetched $(basename "$url")"
done
