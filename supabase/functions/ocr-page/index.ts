// ocr-page — Supabase Edge Function.
//
// The one deliberate exception to "never send anything but short text
// strings" in this backend: called from src/app/aiPageOcr.js only when
// someone explicitly clicks "Read this page with AI" on a specific page —
// never automatically, never for a whole document at once. Sends that one
// page's rendered image to Gemini's vision model and asks for every
// short tag/label on it plus a bounding box, using Gemini's own
// documented box_2d convention (integers 0-1000, [ymin,xmin,ymax,xmax]
// normalized to the image) so its spatial grounding is used the way it
// was trained, rather than free-text coordinates.
//
// Detections are appended to that page's OCR word list client-side and
// become real, searchable, highlightable results — not a separate
// find-once feature. Nothing here writes to the database; this function
// only returns detections, same "human confirms before anything is
// remembered" rule as match-assist.
//
// Deploy:
//   supabase functions deploy ocr-page --project-ref <your-project-ref>
// (shares the GEMINI_API_KEY / GEMINI_MODEL secrets already set for match-assist)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-3.5-flash-lite';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      text: { type: 'STRING', description: 'The exact tag/label text, as printed.' },
      box_2d: {
        type: 'ARRAY',
        items: { type: 'INTEGER' },
        description: 'Tight bounding box as [ymin, xmin, ymax, xmax], each 0-1000, normalized to image size.',
      },
    },
    required: ['text', 'box_2d'],
  },
};

const PROMPT =
  'This image is one page of a P&ID (piping and instrumentation diagram) engineering drawing. ' +
  'Find every short equipment/instrument tag, line number, or valve/component label on it — ' +
  'things like "PT-11004", "V-6801-15PW4", "FIC-2015". Do NOT include paragraph text, the title ' +
  'block boilerplate, revision history, or general notes. For each one, give its exact text ' +
  'exactly as printed (do not correct or normalize it) and a tight bounding box in the box_2d ' +
  'format: [ymin, xmin, ymax, xmax], each an integer 0-1000, normalized to this image\'s ' +
  'dimensions. If the same tag appears in several places, include every occurrence separately, ' +
  'each with its own box.';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // base64-decoded

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

  let body: { imageBase64?: string; mimeType?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const imageBase64 = body.imageBase64 || '';
  const mimeType = body.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
  if (!imageBase64) return json({ error: 'imageBase64 is required' }, 400);
  // Rough size guard — base64 is ~4/3 the decoded size.
  if (imageBase64.length > MAX_IMAGE_BYTES * 4 / 3) return json({ error: 'image too large' }, 413);

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mimeType, data: imageBase64 } },
              { text: PROMPT },
            ],
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 4000,
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
    let detections: unknown;
    try {
      detections = JSON.parse(raw);
    } catch {
      return json({ error: 'Gemini returned unparseable output' }, 502);
    }
    return json({ detections: Array.isArray(detections) ? detections : [] });
  } catch (err) {
    return json({ error: 'Gemini request threw: ' + (err instanceof Error ? err.message : String(err)) }, 502);
  }
});
