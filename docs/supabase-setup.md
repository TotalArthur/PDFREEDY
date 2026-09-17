# Setting up the cloud backend (Supabase)

This turns on: accounts with an approval step, a shared OCR-correction library, cloud-saved
projects (PDF storage), usage logging, and an "Ask AI" button that sends uncertain OCR
reads to Gemini for a second opinion. Everything below is a one-time setup. The code side
is already done — this is just the account/dashboard steps only you can do.

**Signing in is optional and never blocks the local tool.** Search, OCR, markup and export
all work fully signed out, exactly as before — the README's "never leaves your machine"
promise stays true for anyone who never signs in. Approval only gates the cloud extras
(shared corrections, cloud projects, AI-assist), not the app itself. (An earlier version of
this feature gated the whole app behind sign-in; that turned out to be worse in every way —
it made the tool unusable the moment the network was down, and it isn't real security
either way since it's client-side JS anyone can read. The actual enforcement boundary is
server-side: Row Level Security decides who can read/write what, regardless of what the UI
shows.)

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in / create an account.
2. **New project** → pick an organization, name it (e.g. `pdfreedy`), set a database
   password (save it somewhere — you likely won't need it again unless you use the CLI),
   pick a region close to you.
3. Wait ~2 minutes for provisioning.

## 2. Get your API keys — done

`src/app/supabaseConfig.js` already has your project's URL and publishable key filled in
(project ref `oixeiotnwosvdatequkv`). That key is safe to ship in the built file — it
identifies the project, not a person; access is enforced by the database rules from step 3,
not by keeping this key secret. Nothing to do here unless you rotate it later.

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

1. Open the tool. It's fully usable already, signed out. Click **Sign in** in the header,
   then **Create account** with `artwdickson@gmail.com` and a password. The header will
   show "(pending approval)" — expected, every new signup starts pending, and the Projects
   button and shared corrections stay off until approved.
2. Back in the Supabase dashboard, **SQL Editor → New query**:

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

From the repo root:

```bash
supabase login
supabase link --project-ref oixeiotnwosvdatequkv
supabase secrets set GEMINI_API_KEY=your-key-here
supabase functions deploy match-assist
```

That's it — the "Ask AI about the uncertain matches" button (shows up in the sidebar
whenever a search has Possible-band results) will start working for approved users. It
defaults to `gemini-2.5-flash-lite`, currently the cheapest generally-available Gemini
model. To use a different one, set `supabase secrets set GEMINI_MODEL=gemini-...` and
redeploy.

The Gemini key only ever needs to exist in two places: wherever you copy it from, and this
`secrets set` command. It never goes into any file in this repo — the edge function reads
it from Supabase's encrypted secrets store at request time, so it's never shipped to the
browser or visible to anyone without dashboard/CLI access to this project.

## What each piece does, at a glance

| Feature | Where | Gate |
|---|---|---|
| Local search / OCR / markup / export | everywhere | none — works fully signed out |
| Sign in / sign up | "Sign in" button in header, opens a dismissible dialog | none (anyone can create an account) |
| Shared OCR corrections | automatic, syncs on sign-in | active account |
| Save/open PDF in the cloud | "Projects" button in header | active account, explicit click to upload |
| Ask AI | button under search, appears when results include uncertain matches | active account + `GEMINI_API_KEY` secret set |
| Usage log | `usage_events` table, readable by admins only | automatic for active accounts |

## Rolling it back

Leave `SUPABASE_URL` / `SUPABASE_ANON_KEY` blank in `src/app/supabaseConfig.js` and
rebuild — every cloud feature disappears and the tool is exactly the local-only single
file it always was. Nothing about local search, corrections, or markup depends on any of
this.
