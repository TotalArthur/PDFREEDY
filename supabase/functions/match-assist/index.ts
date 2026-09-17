// match-assist — Supabase Edge Function.
//
// Called from src/app/aiMatch.js. Takes the search query plus a short list
// of ambiguous OCR reads (text + confidence, never the PDF or any image),
// asks Gemini whether any of them plausibly are the tag being searched for,
// and returns a short plain-text judgement.
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

// gemini-2.5-flash-lite is the cheapest generally-available Gemini model
// ($0.10/M input, $0.40/M output tokens as of Sept 2026) — plenty for a
// short judgement call over a handful of OCR strings. Override with the
// GEMINI_MODEL secret if you want a stronger model later.
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash-lite';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

  let body: { query?: string; candidates?: Array<{ page: number; text: string; rawText: string; confidence: number | null }> };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const query = (body.query || '').slice(0, 200);
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 8) : [];
  if (!query || !candidates.length) return json({ error: 'query and candidates are required' }, 400);

  const candidateLines = candidates
    .map((c, i) => {
      const conf = typeof c.confidence === 'number' ? Math.round(c.confidence) + '%' : 'n/a (text layer)';
      return `${i + 1}. page ${c.page} — OCR read "${c.rawText}" (as displayed: "${c.text}"), OCR confidence ${conf}`;
    })
    .join('\n');

  const prompt =
    `You are helping an engineer search a P&ID (piping and instrumentation diagram) drawing for the tag "${query}".\n` +
    `A local matcher already found these as its weakest ("Possible") candidates — OCR reads that only match ` +
    `the tag after allowing for character-recognition damage:\n\n${candidateLines}\n\n` +
    `For each candidate, judge in one short line whether it plausibly IS "${query}", given how OCR commonly ` +
    `confuses characters (0/O, 1/I/l, 5/S, 8/B, 6/G, 2/Z) and can drop characters entirely on blurred scans. ` +
    `End with a one-line overall recommendation of which candidate (if any) to check first. ` +
    `Be concise — this is read in a small sidebar panel, not a report. No markdown formatting.`;

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 400 },
        }),
      }
    );
    if (!resp.ok) {
      const errText = await resp.text();
      return json({ error: 'Gemini request failed: ' + errText.slice(0, 300) }, 502);
    }
    const data = await resp.json();
    const answer =
      data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('') ||
      'Gemini returned no answer.';
    return json({ answer });
  } catch (err) {
    return json({ error: 'Gemini request threw: ' + (err instanceof Error ? err.message : String(err)) }, 502);
  }
});
