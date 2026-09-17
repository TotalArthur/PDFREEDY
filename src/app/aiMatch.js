// "Ask AI" — sends the current query plus the OCR text/confidence of the
// ambiguous ("Possible" band) hits to a Supabase Edge Function
// (supabase/functions/match-assist), which asks Gemini for a per-candidate
// plausibility verdict. The PDF itself is never part of this call — only
// short strings the app already extracted.
//
// This is the AI half of the "accuracy brain": accepting a verdict doesn't
// just display an opinion, it calls setCorrection() — the exact same path
// as manually using "Fix text" — which writes the correction into the
// shared library (public.corrections) and re-runs the search. The AI never
// writes to the database on its own; every save is a human clicking
// "Save as correction" on a specific verdict.
//
// Opt-in and best-effort: hidden entirely in local-only mode or when signed
// out, and any failure just shows an inline message rather than breaking
// search.
import { sb, CLOUD_ENABLED } from './supabaseClient.js';
import { S } from './state.js';
import { bandOf } from '../lib/bands.js';
import { logUsageEvent } from './usage.js';
import { setCorrection } from './corrections.js';
import { runFullSearch } from './search.js';

const $ = id => document.getElementById(id);
const askAiBtn = $('askAiBtn');
const askAiPanel = $('askAiPanel');

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

function updateAskAiVisibility() {
  if (!CLOUD_ENABLED || !sb || !S.user) { askAiBtn.hidden = true; return; }
  const candidates = possibleCandidates();
  askAiBtn.hidden = candidates.length === 0;
  askAiPanel.hidden = true;
}

function renderVerdicts(query, candidates, verdicts, bestIndex) {
  askAiPanel.innerHTML = '';
  if (!verdicts.length) {
    askAiPanel.textContent = 'Gemini found nothing plausible among these candidates.';
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
      const saveBtn = document.createElement('button');
      saveBtn.className = 'ai-save-btn';
      saveBtn.textContent = 'Save as correction for "' + query + '"';
      saveBtn.addEventListener('click', () => {
        setCorrection(candidate.rawText, query);
        logUsageEvent('ai_verdict_accepted', { query });
        saveBtn.textContent = 'Saved — reads as "' + query + '" from now on';
        saveBtn.disabled = true;
        runFullSearch();
      });
      row.appendChild(saveBtn);
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

function initAiMatch() {
  if (!CLOUD_ENABLED) return;
  askAiBtn.addEventListener('click', askAi);
}

export { initAiMatch, updateAskAiVisibility };
