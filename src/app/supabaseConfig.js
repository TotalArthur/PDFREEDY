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
const SUPABASE_URL = 'https://oixeiotnwosvdatequkv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_IBMvu5xBhOpW1RfSpTMf7A_7vB-26vK';

export { SUPABASE_URL, SUPABASE_ANON_KEY };
