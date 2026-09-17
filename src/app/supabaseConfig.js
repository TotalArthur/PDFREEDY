// Fill these in after creating your Supabase project (Settings > API in the
// dashboard). The anon key is safe to ship in client code — it identifies the
// project, not a user; every table it can touch is locked down with Row
// Level Security policies (see supabase/schema.sql), so the key alone grants
// nothing.
//
// Leave both blank to run PDFreedy in fully local mode — search, corrections
// and markup all still work with no network calls at all. The cloud features
// (accounts, shared correction library, saved projects, AI-assisted
// matching) simply stay off.
const SUPABASE_URL = '';
const SUPABASE_ANON_KEY = '';

export { SUPABASE_URL, SUPABASE_ANON_KEY };
