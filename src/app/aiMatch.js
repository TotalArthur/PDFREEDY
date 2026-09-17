// "Ask AI" — two related features, both part of the "accuracy brain":
//
//  - Ask AI about the uncertain matches: when a search finds something but
//    only in the weakest ("Possible") band, send the query plus those
//    candidates' OCR text/confidence to a Supabase Edge Function
//    (supabase/functions/match-assist), which asks Gemini for a per-
//    candidate plausibility verdict.
//  - Ask AI to search the whole document: when a search finds NOTHING at
//    all, send every short word/label extracted from the document instead
//    — same function, "fallback" mode. Gemini never sees an image or
//    invents a position: it only picks among words the app already
//    extracted, each with a real, already-known page + bounding box, so
//    accepting one jumps straight to the right spot with a pixel-accurate
//    highlight, not a guess.
//
// Either way, accepting a verdict doesn't just display an opinion — it
// calls setCorrection(), the exact same path as manually using "Fix text"
// or the "✓ Correct" tick, which writes the correction into the shared
// library (public.corrections) and re-runs the search. The AI never writes
// to the database on its own; a human always clicks to confirm first.
//
// Opt-in and best-effort: hidden entirely in local-only mode, when signed
// out, or before an account is approved — and any failure just shows an
// inline message rather than breaking search.
import { sb, CLOUD_ENABLED } from './supabaseClient.js';
import { S } from './state.js';
import { bandOf } from '../lib/bands.js';
import { logUsageEvent } from './usage.js';
import { setCorrection } from './corrections.js';
import { runFullSearch } from './search.js';
import { renderResultsList } from './results.js';
import { drawHighlights, jumpToResult } from './viewer.js';

const $ = id => document.getElementById(id);
const askAiBtn = $('askAiBtn');
const askAiFallbackBtn = $('askAiFallbackBtn');
const askAiPanel = $('askAiPanel');

const FALLBACK_WORD_CAP = 500;
const FALLBACK_WORD_LEN = [2, 30]; // [min, max] — tag-shaped strings only

function isApproved() {
  return !!(CLOUD_ENABLED && sb && S.user && S.profile && S.profile.status === 'active');
}

function possibleCandidates() {
  return S.lastResults
    .filter(r => bandOf(r) === 'possible')
    .slice(0, 8)
    .map(r => ({
      page: r.page,
      text: r.text,
      rawText: r.rawText || r.text,
      confidence: typeof r.confidence === 'number' ? r.confidence : null,
    }));
}

// Every short word the app has already extracted, across every processed
// page, with enough of its original identity (itemIndices / bbox) kept
// alongside to build a real, junpable/highlightable result if the AI picks
// it — never re-derived from an image, always the app's own extraction.
function allWordCandidates() {
  const out = [];
  for (let p = 1; p <= S.numPages; p++) {
    const d = S.pageData.get(p);
    if (!d) continue;
    if (d.textItems) {
      d.textItems.forEach((it, idx) => {
        const t = (it.str || '').trim();
        if (t.length < FALLBACK_WORD_LEN[0] || t.length > FALLBACK_WORD_LEN[1]) return;
        out.push({ page: p, source: 'text', text: t, rawText: t, confidence: null, itemIndices: [idx] });
      });
    }
    if (d.ocrLines) {
      for (const line of d.ocrLines) {
        for (const w of line.words) {
          const t = (w.text || '').trim();
          if (t.length < FALLBACK_WORD_LEN[0] || t.length > FALLBACK_WORD_LEN[1]) continue;
          out.push({ page: p, source: 'ocr', text: t, rawText: t, confidence: w.confidence, bbox: w.bbox });
        }
      }
    }
    if (out.length >= FALLBACK_WORD_CAP) break;
  }
  return out.slice(0, FALLBACK_WORD_CAP);
}

function updateAskAiVisibility() {
  if (!isApproved()) { askAiBtn.hidden = true; askAiFallbackBtn.hidden = true; return; }
  askAiPanel.hidden = true;

  const hasQuery = !!S.currentQuery.norm;
  const stillProcessing = S.isBackgroundRunning;

  if (S.lastResults.length === 0 && hasQuery && !stillProcessing) {
    askAiBtn.hidden = true;
    askAiFallbackBtn.hidden = allWordCandidates().length === 0;
    return;
  }
  askAiFallbackBtn.hidden = true;
  askAiBtn.hidden = possibleCandidates().length === 0;
}

// Builds a real result object from a fallback candidate — same shape
// buildResultElement/drawHighlights/jumpToResult already know how to
// render and highlight, just tagged aiFound so the row says where it came
// from. fuzzy:true files it under the "Possible" band, which is honest: an
// AI-suggested read is exactly as much a guess as any other Possible hit
// until a person confirms it.
function resultFromCandidate(candidate) {
  const base = {
    page: candidate.page, source: candidate.source,
    text: candidate.rawText, rawText: candidate.rawText,
    confidence: candidate.confidence,
    whole: false, fuzzy: true, confused: false,
    matchPos: null, matchLen: null,
    score: 0, reasons: ['Found by AI fallback search over every extracted word.'],
    aiFound: true,
  };
  if (candidate.source === 'text') return { ...base, itemIndices: candidate.itemIndices };
  return { ...base, bbox: candidate.bbox };
}

function renderVerdicts(query, candidates, verdicts, bestIndex, { fallback } = {}) {
  askAiPanel.innerHTML = '';
  const plausible = verdicts.filter(v => v.plausible && candidates[v.index - 1]);
  if (!verdicts.length) {
    askAiPanel.textContent = 'Gemini found nothing plausible among ' + candidates.length + ' candidates.';
    return;
  }

  // Fallback results become real rows in the results list (so they're
  // jumpable/highlightable/confirmable exactly like any other hit) instead
  // of only living in this panel.
  if (fallback && plausible.length) {
    S.lastResults = plausible.map(v => resultFromCandidate(candidates[v.index - 1]));
    S.activeResultIndex = -1;
    renderResultsList();
    drawHighlights();
    askAiPanel.textContent = plausible.length + ' possible match' + (plausible.length === 1 ? '' : 'es') +
      ' found — see the results list below (badged AI FOUND). Nothing is saved until you confirm one.';
    return;
  }
  if (fallback) {
    askAiPanel.textContent = 'Checked ' + candidates.length + ' extracted words — none plausibly matched "' + query + '".';
    return;
  }

  for (const v of verdicts) {
    const candidate = candidates[v.index - 1];
    if (!candidate) continue;

    const row = document.createElement('div');
    row.className = 'ai-verdict' + (v.plausible ? ' plausible' : '');

    const head = document.createElement('div');
    head.className = 'ai-verdict-head';
    head.innerHTML =
      '<span class="ai-verdict-text"></span>' +
      '<span class="badge ' + (v.plausible ? 'badge-fixed' : 'badge-page') + '"></span>' +
      (v.index === bestIndex ? '<span class="badge badge-text">BEST GUESS</span>' : '');
    head.querySelector('.ai-verdict-text').textContent = 'Page ' + candidate.page + ': "' + candidate.rawText + '"';
    head.querySelector('.badge:not(.badge-text)').textContent = v.plausible ? 'Plausible' : 'Not plausible';
    row.appendChild(head);

    const reason = document.createElement('div');
    reason.className = 'ai-verdict-reason';
    reason.textContent = v.reason || '';
    row.appendChild(reason);

    if (v.plausible) {
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'confirm-btn';
      confirmBtn.textContent = '✓ Confirm — this is "' + query + '"';
      confirmBtn.addEventListener('click', () => {
        setCorrection(candidate.rawText, query);
        logUsageEvent('ai_verdict_accepted', { query });
        confirmBtn.textContent = '✓ Confirmed';
        confirmBtn.disabled = true;
        runFullSearch();
      });
      row.appendChild(confirmBtn);
    }

    askAiPanel.appendChild(row);
  }
}

async function askAi() {
  const candidates = possibleCandidates();
  if (!candidates.length) return;
  const query = S.currentQuery.raw;
  askAiPanel.hidden = false;
  askAiPanel.textContent = 'Asking…';
  logUsageEvent('ai_match_requested', { query, candidateCount: candidates.length });
  try {
    const { data, error } = await sb.functions.invoke('match-assist', {
      body: { query, candidates },
    });
    if (error) throw error;
    renderVerdicts(query, candidates, (data && data.verdicts) || [], data && data.bestIndex);
  } catch (err) {
    console.warn('AI match-assist failed:', err);
    askAiPanel.textContent = 'AI assist unavailable right now (' + (err.message || err) + ').';
  }
}

async function askAiFallback() {
  const candidates = allWordCandidates();
  if (!candidates.length) return;
  const query = S.currentQuery.raw;
  askAiPanel.hidden = false;
  askAiPanel.textContent = 'Searching everything (' + candidates.length + ' words)…';
  logUsageEvent('ai_fallback_requested', { query, candidateCount: candidates.length });
  try {
    const { data, error } = await sb.functions.invoke('match-assist', {
      body: { query, candidates, mode: 'fallback' },
    });
    if (error) throw error;
    renderVerdicts(query, candidates, (data && data.verdicts) || [], data && data.bestIndex, { fallback: true });
  } catch (err) {
    console.warn('AI fallback search failed:', err);
    askAiPanel.textContent = 'AI assist unavailable right now (' + (err.message || err) + ').';
  }
}

function initAiMatch() {
  if (!CLOUD_ENABLED) return;
  askAiBtn.addEventListener('click', askAi);
  askAiFallbackBtn.addEventListener('click', askAiFallback);
}

export { initAiMatch, updateAskAiVisibility, isApproved };
