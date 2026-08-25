import { normalize } from '../lib/text.js';
import {
  correctionsBar,
  correctionsCount,
} from './dom.js';

// =======================================================================
// OCR corrections ("teach it the right answer")
//
// Tesseract can't be retrained in the browser, so instead of pretending to
// learn we keep a dictionary: normalized-raw-OCR-text -> what it really says.
// A correction entered once is applied to EVERY occurrence of that same
// misread string, on every page and in every future search — including in
// documents opened later, since the dictionary is persisted. That's what
// makes a 0%-confidence garbled read findable by its true tag from then on.
//
// Persistence is best-effort: some browsers give file:// pages no usable
// localStorage, in which case corrections simply stay session-only.
// =======================================================================
const CORRECTIONS_KEY = 'pidTagFinder.ocrCorrections.v1';
let corrections = new Map();   // normalize(rawOcrText) -> corrected string

function loadCorrections() {
  try {
    const raw = window.localStorage.getItem(CORRECTIONS_KEY);
    if (raw) corrections = new Map(JSON.parse(raw));
  } catch (err) {
    console.warn('Corrections could not be loaded (session-only):', err);
  }
}
function saveCorrections() {
  try {
    window.localStorage.setItem(CORRECTIONS_KEY, JSON.stringify([...corrections]));
  } catch (err) {
    console.warn('Corrections could not be saved (session-only):', err);
  }
}
function setCorrection(rawText, correctedText) {
  const key = normalize(rawText);
  if (!key) return;
  if (!correctedText || normalize(correctedText) === key) corrections.delete(key);
  else corrections.set(key, correctedText);
  saveCorrections();
  updateCorrectionsBar();
}
function getCorrection(rawText) {
  return corrections.get(normalize(rawText)) || null;
}
function updateCorrectionsBar() {
  const n = corrections.size;
  correctionsBar.classList.toggle('visible', n > 0);
  correctionsCount.textContent = n + ' saved OCR correction' + (n === 1 ? '' : 's') + ' applied';
}

function clearCorrections() {
  corrections.clear();
  saveCorrections();
  updateCorrectionsBar();
}

export { loadCorrections, setCorrection, getCorrection, updateCorrectionsBar, clearCorrections };
