# The cloud backend (Supabase) — the accuracy brain

This turns on: accounts with an approval step, a shared OCR-correction library, usage
logging, and an "Ask AI" button that sends uncertain OCR reads to Gemini for a second
opinion. It does **one job** — make matching more accurate over time, shared across
everyone approved to use it. There is deliberately no PDF/file storage anywhere in this
backend; it never sees your drawings, only short OCR text strings.

This project's backend is already fully set up and deployed (project ref
`oixeiotnwosvdatequkv`) — this doc is the reference for what's running and how to change
it later, not a from-scratch walkthrough.

**Signing in is optional and never blocks the local tool.** Search, OCR, markup and export
all work fully signed out — the README's "never leaves your machine" promise stays true for
anyone who never signs in. Approval only gates the shared corrections library and AI-assist,
not the app itself. (The client-side gate isn't real security either way — it's JS anyone
can read. The actual enforcement boundary is server-side Row Level Security, which decides
who can read/write what in the database regardless of what the UI shows.)

## What's deployed

| Piece | What it does |
|---|---|
| `profiles` table | One row per account; `status` (`pending`/`active`/`revoked`) gates everything else |
| `corrections` table | The brain itself — shared map of garbled OCR reads to their true tag, plus a `confirm_count` that goes up each time the same fix is confirmed again |
| `confirm_correction()` function | Writes to `corrections`, incrementing `confirm_count` on repeats instead of just overwriting |
| `usage_events` table | Lightweight log (sign-ins, AI-assist calls) — admins only, no drawing content ever |
| `match-assist` edge function | Calls Gemini (`gemini-3.5-flash-lite`) with the query + candidates, returns a plausibility verdict per candidate. Two modes: `verdict` (a handful of "Possible"-band hits) and `fallback` (every extracted word, when the local matcher found nothing at all) |

## Two ways to confirm a fix, everywhere they appear

- **The "✓ Correct" tick** — on any uncertain (non-exact) search result. One click:
  "yes, this really is the tag I searched for." No typing.
- **"Fix text"** — for the rarer case where the right answer *isn't* what you searched for
  (manual entry).

Both call the same `setCorrection()` → `confirm_correction()` path, so either one teaches
the shared brain.

## How the AI-assist loop actually improves accuracy

1. A search comes back with "Possible"-band hits (the local matcher's weakest tier) — or,
   if it found literally nothing, a **"Ask AI to search the whole document"** button
   appears instead.
2. **Possible-band case**: clicking **Ask AI** sends the query and those candidates' OCR
   text/confidence to `match-assist` (mode `verdict`), which asks Gemini for a
   plausible/not verdict + reason on each one, shown in a panel with a tick to confirm.
3. **Nothing-found case**: clicking the fallback button sends the query plus every
   short word/label the app has already extracted across the whole document — still just
   text, page number and the bounding box the app already measured, never an image or an
   AI-invented coordinate (mode `fallback`). Gemini only ever picks among positions the
   app already knows; whatever it picks is exactly where the highlight lands. Any
   plausible pick becomes a real row in the results list (badged **AI FOUND**), so it's
   jumpable, highlightable and confirmable exactly like any other hit.
4. Either way, confirming a verdict calls the same `setCorrection()` path as manually
   using "Fix text"/the tick — it writes straight into `corrections` via
   `confirm_correction()`.
5. From then on, every user who hits that same garbled OCR read gets the correct tag
   automatically, with no AI call needed — the fix is now free and instant for everyone.

The AI never writes to the database by itself; a person always clicks to confirm first.

## Making changes later

**Schema changes** — edit `supabase/schema.sql`, then paste the whole file into
**SQL Editor → New query** in the [dashboard](https://supabase.com/dashboard/project/oixeiotnwosvdatequkv)
and run it. Every statement is guarded (`if not exists` / `drop ... if exists`), so
re-running the whole file is always safe.

**Redeploying the AI function** (e.g. after editing `supabase/functions/match-assist/index.ts`)
needs the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started):

```bash
supabase login
supabase link --project-ref oixeiotnwosvdatequkv
supabase functions deploy match-assist
```

**Changing the Gemini key or model**:

```bash
supabase secrets set GEMINI_API_KEY=your-new-key
supabase secrets set GEMINI_MODEL=gemini-3.5-flash-lite   # or another Gemini model
supabase functions deploy match-assist
```

The Gemini key only ever lives in Supabase's encrypted secrets store — it's never in any
file in this repo and never shipped to the browser.

**Approving a new account** — once they've signed up once (so a `profiles` row exists):

```sql
update public.profiles set status = 'active' where email = 'their-email@example.com';
```

## Rolling it back

Leave `SUPABASE_URL` / `SUPABASE_ANON_KEY` blank in `src/app/supabaseConfig.js` and
rebuild — every cloud feature disappears and the tool is exactly the local-only single
file it always was. Nothing about local search, corrections, or markup depends on any of
this.
