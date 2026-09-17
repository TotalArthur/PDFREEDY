// match-assist — Supabase Edge Function. Part of the "accuracy brain":
// this is the only piece of the backend that calls out to an LLM, and it
// exists purely to turn ambiguous OCR reads into confirmed corrections.
//
// Called from src/app/aiMatch.js in two modes:
//
//  - "verdict" (default): the query plus the app's own weakest ("Possible"
//    band) matches. Used when the local matcher found something but isn't
//    sure of it.
//  - "fallback": the query plus EVERY short word/label extracted from the
//    document (still just text + page + bbox the app already has — never
//    an image). Used when the local matcher found nothing at all, as a
//    last resort.
//
// Both modes ask Gemini for a per-candidate plausibility verdict in
// structured JSON, never coordinates — the app already knows the exact
// on-page position of every candidate it sends (that's what makes fallback
// mode possible without ever sending pixels), so all Gemini does is pick
// which of those already-known positions is the right one. Accepting a
// verdict writes it straight into the shared corrections table
// (public.corrections) via confirm_correction(), same as manually using
// "Fix text"/the tick-to-confirm button. The AI never writes to the
// database itself; a human in the loop always confirms before anything is
// remembered.
//
// Deploy:
//   supabase functions deploy match-assist --project-ref <your-project-ref>
//   supabase secrets set GEMINI_API_KEY=<your-key> --project-ref <your-project-ref>
//
// This function requires a valid user JWT (the client SDK sends one
// automatically for a signed-in session) and additionally checks the
// caller's profiles.status = 'active' before spending any Gemini quota on
// their behalf.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// gemini-3.5-flash-lite is the cheapest Gemini model Google isn't actively
// sunsetting ($0.30/M input, $2.50/M output as of Sept 2026) — plenty for a
// short judgement call over a handful of OCR strings. The 2.5 generation
// (including 2.5-flash-lite, briefly used here) is being shut down
// entirely on 16 Oct 2026. Override with the GEMINI_MODEL secret if you
// want a stronger model later.
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-3.5-flash-lite';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdicts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'INTEGER', description: '1-based index matching the candidate list' },
          plausible: { type: 'BOOLEAN' },
          reason: { type: 'STRING', description: 'One short sentence.' },
        },
        required: ['index', 'plausible', 'reason'],
      },
    },
    bestIndex: {
      type: 'INTEGER',
      nullable: true,
      description: 'Index of the single strongest candidate, or null if none are plausible.',
    },
  },
  required: ['verdicts'],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY is not configured on this project' }, 500);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'missing Authorization header' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceRoleKey);

  const { data: userData, error: userErr } = await admin.auth.getUser(
    authHeader.replace(/^Bearer\s+/i, '')
  );
  if (userErr || !userData?.user) return json({ error: 'invalid session' }, 401);

  const { data: profile } = await admin
    .from('profiles')
    .select('status')
    .eq('id', userData.user.id)
    .single();
  if (!profile || profile.status !== 'active') return json({ error: 'account not active' }, 403);

  let body: {
    query?: string;
    mode?: string;
    candidates?: Array<{ page: number; text: string; rawText: string; confidence: number | null }>;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const query = (body.query || '').slice(0, 200);
  const isFallback = body.mode === 'fallback';
  // Fallback mode sends every short word on the document, so it needs a much
  // higher cap than the handful of already-filtered "Possible" candidates
  // verdict mode gets.
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, isFallback ? 500 : 8) : [];
  if (!query || !candidates.length) return json({ error: 'query and candidates are required' }, 400);

  const candidateLines = candidates
    .map((c, i) => {
      const conf = typeof c.confidence === 'number' ? Math.round(c.confidence) + '%' : 'n/a (text layer)';
      return `${i + 1}. page ${c.page} — "${c.rawText}"${isFallback ? '' : ` (as displayed: "${c.text}")`}, OCR confidence ${conf}`;
    })
    .join('\n');

  const prompt = isFallback
    ? `You are helping an engineer search a P&ID (piping and instrumentation diagram) drawing for the tag ` +
      `"${query}". A local matcher searched every page and found NOTHING, even allowing for OCR damage — so this ` +
      `is a last resort. Below is every short label/word extracted from the whole document (most are unrelated: ` +
      `other tags, notes, title-block text). Find any that could plausibly BE "${query}", accounting for OCR ` +
      `misreads (0/O, 1/I/l, 5/S, 8/B, 6/G, 2/Z confusions, and dropped characters).\n\n${candidateLines}\n\n` +
      `Only mark plausible=true for a real, explainable match — with hundreds of irrelevant candidates here, a ` +
      `false positive is worse than saying none match. Set bestIndex to the single strongest candidate if any are ` +
      `plausible, otherwise null.`
    : `You are helping an engineer search a P&ID (piping and instrumentation diagram) drawing for the tag "${query}".\n` +
      `A local matcher already found these as its weakest ("Possible") candidates — OCR reads that only match ` +
      `the tag after allowing for character-recognition damage:\n\n${candidateLines}\n\n` +
      `For each candidate (1 to ${candidates.length}), judge whether it plausibly IS "${query}", given how OCR ` +
      `commonly confuses characters (0/O, 1/I/l, 5/S, 8/B, 6/G, 2/Z) and can drop characters entirely on blurred ` +
      `scans. Be conservative — only mark plausible=true when the OCR damage is physically explainable, not on a ` +
      `guess. Set bestIndex to the single strongest candidate if any are plausible, otherwise null.`;

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: isFallback ? 2000 : 800,
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
          },
        }),
      }
    );
    if (!resp.ok) {
      const errText = await resp.text();
      return json({ error: 'Gemini request failed: ' + errText.slice(0, 300) }, 502);
    }
    const data = await resp.json();
    const raw = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('') || '';
    let parsed: { verdicts?: unknown; bestIndex?: number | null };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ error: 'Gemini returned unparseable output' }, 502);
    }
    return json({ verdicts: parsed.verdicts || [], bestIndex: parsed.bestIndex ?? null });
  } catch (err) {
    return json({ error: 'Gemini request threw: ' + (err instanceof Error ? err.message : String(err)) }, 502);
  }
});
