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
| `match-assist` edge function | Calls Gemini (`gemini-2.5-flash-lite`) with the query + ambiguous OCR reads, returns a plausibility verdict per candidate |

## How the AI-assist loop actually improves accuracy

1. A search comes back with "Possible"-band hits — the local matcher's weakest tier.
2. Clicking **Ask AI** sends the query and those candidates' OCR text/confidence to
   `match-assist`, which asks Gemini for a plausible/not verdict + reason on each one.
3. Each plausible verdict gets a **"Save as correction"** button. Clicking it calls the
   same `setCorrection()` path as manually using "Fix text" — it writes straight into
   `corrections` via `confirm_correction()`.
4. From then on, every user who hits that same garbled OCR read gets the correct tag
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
supabase secrets set GEMINI_MODEL=gemini-2.5-flash-lite   # or another Gemini model
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
