// "Ask AI" — sends the current query plus the OCR text/confidence of the
// ambiguous ("Possible" band) hits to a Supabase Edge Function
// (supabase/functions/match-assist), which asks Gemini whether any of them
// plausibly read the tag and returns a short judgement. The PDF itself is
// never part of this call — only short strings the app already extracted.
//
// Opt-in and best-effort: hidden entirely in local-only mode or when signed
// out, and any failure just shows an inline message rather than breaking
// search.
import { sb, CLOUD_ENABLED } from './supabaseClient.js';
import { S } from './state.js';
import { BANDS, bandOf } from '../lib/bands.js';
import { logUsageEvent } from './usage.js';

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

async function askAi() {
  const candidates = possibleCandidates();
  if (!candidates.length) return;
  askAiPanel.hidden = false;
  askAiPanel.textContent = 'Asking…';
  logUsageEvent('ai_match_requested', { query: S.currentQuery.raw, candidateCount: candidates.length });
  try {
    const { data, error } = await sb.functions.invoke('match-assist', {
      body: { query: S.currentQuery.raw, candidates },
    });
    if (error) throw error;
    askAiPanel.textContent = (data && data.answer) || 'No response.';
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
