// Best-effort usage logging. Never blocks or throws into a caller — a
// licensing/analytics table being briefly unreachable must never stop
// someone from searching a drawing.
import { sb, CLOUD_ENABLED } from './supabaseClient.js';
import { S } from './state.js';

function logUsageEvent(eventType, metadata = {}) {
  if (!CLOUD_ENABLED || !sb || !S.user) return;
  sb.from('usage_events')
    .insert({ user_id: S.user.id, event_type: eventType, metadata })
    .then(({ error }) => { if (error) console.warn('usage_events insert failed:', error); });
}

export { logUsageEvent };
