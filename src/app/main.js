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
