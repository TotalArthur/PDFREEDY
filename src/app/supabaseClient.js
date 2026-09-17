// Thin wrapper around the Supabase JS client (loaded as a CDN global — see
// src/index.template.html — same pattern as pdf.js/tesseract.js/pdf-lib).
//
// Every consumer of `sb` must handle it being null: that's what "not
// configured" or "loaded from file:// with no network" looks like, and the
// app has to keep working locally either way.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseConfig.js';

const CLOUD_ENABLED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

let sb = null;
if (CLOUD_ENABLED) {
  try {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  } catch (err) {
    console.warn('Supabase client failed to initialize — running in local-only mode:', err);
    sb = null;
  }
}

export { sb, CLOUD_ENABLED };
