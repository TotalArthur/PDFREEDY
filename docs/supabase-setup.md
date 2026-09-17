# Setting up the cloud backend (Supabase)

This turns on: accounts + an approval gate, a shared OCR-correction library, cloud-saved
projects (PDF storage), usage logging, and an "Ask AI" button that sends uncertain OCR
reads to Gemini for a second opinion. Everything below is a one-time setup. The code side
is already done — this is just the account/dashboard steps only you can do.

Local mode (no accounts, nothing uploaded, exactly how the tool worked before) is what you
get if you skip this entirely.

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in / create an account.
2. **New project** → pick an organization, name it (e.g. `pdfreedy`), set a database
   password (save it somewhere — you likely won't need it again unless you use the CLI),
   pick a region close to you.
3. Wait ~2 minutes for provisioning.

## 2. Get your API keys

**Project Settings → API**. You need two values:

- **Project URL** (`https://xxxxxxxx.supabase.co`)
- **anon / public key** (a long JWT-looking string)

Open `src/app/supabaseConfig.js` in this repo and paste them in:

```js
const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJ...';
```

Then rebuild: `npm run build` (regenerates `index.html`, which is the file that actually
ships/runs). The anon key is safe to ship in the built file — it identifies the project,
not a person; access is enforced by the database rules from step 3, not by keeping this
key secret.

## 3. Create the database schema

**SQL Editor → New query**, paste the entire contents of `supabase/schema.sql` from this
repo, and click **Run**. This creates every table (`profiles`, `corrections`, `projects`,
`project_files`, `usage_events`) and locks them down with row-level security so users can
only ever see their own data (or, for the shared corrections library, data everyone's
allowed to see).

## 4. Create the storage bucket

**Storage → New bucket**. Name it exactly `pdfs`, leave it **Private** (not public). The
storage access policies were already created by the SQL you ran in step 3.

## 5. Sign up once, then approve yourself

1. Rebuild (`npm run build`) and open the tool — you'll see a sign-in screen.
2. Click **Create account**, use `artwdickson@gmail.com` and a password. You'll land on a
   "not yet approved" screen — expected, every new signup starts pending.
3. Back in the Supabase dashboard, **SQL Editor → New query**:

   ```sql
   update public.profiles set status = 'active', is_admin = true
     where email = 'artwdickson@gmail.com';
   ```

   Run it. Reload the tool — you're in, and marked as admin.
4. To approve anyone else later, run the same update with their email and `is_admin =
   false`, or build a tiny admin view later — for now the SQL editor is the approval flow.

## 6. Wire up the AI-assist function (Gemini)

This step needs the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
installed on your machine (`npm install -g supabase`, or `brew install supabase/tap/supabase`).

1. Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) if you
   don't already have one set up.
2. From the repo root:

   ```bash
   supabase login
   supabase link --project-ref xxxxxxxx        # the ref is in your project URL
   supabase secrets set GEMINI_API_KEY=your-key-here
   supabase functions deploy match-assist
   ```

3. That's it — the "Ask AI about the uncertain matches" button (shows up in the sidebar
   whenever a search has Possible-band results) will start working for approved users.

If you ever want to change the model it calls, set another secret:
`supabase secrets set GEMINI_MODEL=gemini-2.0-flash` (or whichever Gemini model you prefer)
and redeploy the function.

## What each piece does, at a glance

| Feature | Where | Gate |
|---|---|---|
| Sign in / sign up | header + gate overlay | none (anyone can create an account) |
| Using the app at all | everywhere | account must be `active` (you approve it) |
| Shared OCR corrections | automatic, syncs on sign-in | active account |
| Save/open PDF in the cloud | "Projects" button in header | active account, explicit click to upload |
| Ask AI | button under search, appears when results include uncertain matches | active account + `GEMINI_API_KEY` secret set |
| Usage log | `usage_events` table, readable by admins only | automatic for active accounts |

## Rolling it back

Leave `SUPABASE_URL` / `SUPABASE_ANON_KEY` blank in `src/app/supabaseConfig.js` and
rebuild — every cloud feature disappears and the tool is exactly the local-only single
file it always was. Nothing about local search, corrections, or markup depends on any of
this.
