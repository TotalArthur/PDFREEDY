import { normalize } from '../lib/text.js';
import {
  correctionsBar,
  correctionsCount,
} from './dom.js';
import { sb, CLOUD_ENABLED } from './supabaseClient.js';
import { S } from './state.js';

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
  const cleared = !correctedText || normalize(correctedText) === key;
  if (cleared) corrections.delete(key);
  else corrections.set(key, correctedText);
  saveCorrections();
  updateCorrectionsBar();
  if (!cleared) pushCorrectionToCloud(key, correctedText);
}

// =======================================================================
// Shared cloud corrections library (opt-in — only runs when Supabase is
// configured and the signed-in account is active). The local Map/
// localStorage above stays the source of truth for matching, so search
// keeps working exactly the same offline; this just keeps it topped up from,
// and contributing to, the shared table everyone on the account draws from.
// =======================================================================
async function pullSharedCorrections() {
  if (!CLOUD_ENABLED || !sb || !S.user) return;
  const { data, error } = await sb.from('corrections').select('raw_key,corrected');
  if (error) { console.warn('Could not load shared corrections:', error); return; }
  let changed = false;
  for (const row of data) {
    if (!corrections.has(row.raw_key)) { corrections.set(row.raw_key, row.corrected); changed = true; }
  }
  if (changed) { saveCorrections(); updateCorrectionsBar(); }
  // Any correction made locally before signing in (or offline) hasn't made
  // it to the shared table yet — push it now so it benefits everyone else.
  const known = new Set(data.map(r => r.raw_key));
  for (const [key, corrected] of corrections) {
    if (!known.has(key)) pushCorrectionToCloud(key, corrected);
  }
}

function pushCorrectionToCloud(rawKey, corrected) {
  if (!CLOUD_ENABLED || !sb || !S.user) return;
  // RPC instead of a plain upsert: confirm_correction() increments
  // confirm_count when this (raw -> corrected) pair already exists, so a
  // correction independently confirmed more than once carries more weight
  // than one seen a single time — the "brain" gets more sure, not just
  // bigger.
  sb.rpc('confirm_correction', { p_raw_key: rawKey, p_corrected: corrected })
    .then(({ error }) => { if (error) console.warn('Could not save correction to shared library:', error); });
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

export { loadCorrections, setCorrection, getCorrection, updateCorrectionsBar, clearCorrections, pullSharedCorrections };
