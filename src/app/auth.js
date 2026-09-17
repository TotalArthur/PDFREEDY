// Accounts + access to the cloud extras.
//
// If Supabase isn't configured (supabaseConfig.js left blank), the app runs
// fully local with no accounts UI at all — same as it always did.
//
// Once configured, signing in is OPTIONAL and never blocks local search,
// OCR, markup or export — those keep working fully signed out, exactly as
// advertised in the README. What being signed in and approved
// (profiles.status = 'active') unlocks is the accuracy brain: the shared
// OCR corrections library and AI-assisted matching — each of those checks
// S.profile itself before doing anything (see corrections.js, aiMatch.js),
// so this module's only job is keeping S.user/S.profile in sync and
// reflecting status in the header.
import { sb, CLOUD_ENABLED } from './supabaseClient.js';
import { S } from './state.js';
import { logUsageEvent } from './usage.js';

const $ = id => document.getElementById(id);
const authOverlay = $('authOverlay');
const authEmail = $('authEmail');
const authPassword = $('authPassword');
const authError = $('authError');
const authSignInBtn = $('authSignInBtn');
const authSignUpBtn = $('authSignUpBtn');
const authCloseBtn = $('authCloseBtn');
const userBadge = $('userBadge');
const userEmailLabel = $('userEmailLabel');
const signInBtn = $('signInBtn');
const signOutBtn = $('signOutBtn');

const authReadyListeners = [];
function onAuthReady(fn) { authReadyListeners.push(fn); }

function showError(msg) {
  authError.textContent = msg;
  authError.hidden = !msg;
}

function openAuthOverlay() { showError(''); authOverlay.hidden = false; }
function closeAuthOverlay() { authOverlay.hidden = true; }

// header state: 'signedOut' | 'pending' | 'revoked' | 'active'
function renderBadge(state, session, profile) {
  userBadge.hidden = false;
  signInBtn.hidden = state !== 'signedOut';
  signOutBtn.hidden = state === 'signedOut';

  if (state === 'signedOut') userEmailLabel.textContent = '';
  else if (state === 'pending') userEmailLabel.textContent = session.user.email + ' (pending approval)';
  else if (state === 'revoked') userEmailLabel.textContent = session.user.email + ' (access revoked)';
  else userEmailLabel.textContent = session.user.email + (profile.is_admin ? ' (admin)' : '');
}

async function fetchProfile(userId) {
  const { data, error } = await sb.from('profiles').select('id,email,status,is_admin').eq('id', userId).single();
  if (error) {
    console.warn('Could not load profile:', error);
    return null;
  }
  return data;
}

async function applySession(session) {
  if (!session) {
    S.user = null;
    S.profile = null;
    renderBadge('signedOut');
    for (const fn of authReadyListeners) fn(null, null);
    return;
  }
  S.user = session.user;
  const profile = await fetchProfile(session.user.id);
  S.profile = profile;

  if (!profile || profile.status === 'pending') { renderBadge('pending', session); return; }
  if (profile.status === 'revoked') { renderBadge('revoked', session); return; }

  renderBadge('active', session, profile);
  closeAuthOverlay();
  logUsageEvent('session_start');
  for (const fn of authReadyListeners) fn(S.user, S.profile);
}

async function signIn() {
  showError('');
  const { error } = await sb.auth.signInWithPassword({ email: authEmail.value.trim(), password: authPassword.value });
  if (error) showError(error.message);
}

async function signUp() {
  showError('');
  const { error } = await sb.auth.signUp({ email: authEmail.value.trim(), password: authPassword.value });
  if (error) { showError(error.message); return; }
  showError('Account created — approval is required before the cloud extras unlock.');
}

async function signOut() {
  await sb.auth.signOut();
}

function initAuth() {
  if (!CLOUD_ENABLED || !sb) {
    // Local-only mode (or the Supabase script failed to load, e.g. an ad
    // blocker) — no accounts UI, never block anything. Still fire the ready
    // callbacks so other modules that wait on "auth settled" run.
    for (const fn of authReadyListeners) fn(null, null);
    return;
  }

  signInBtn.addEventListener('click', openAuthOverlay);
  authCloseBtn.addEventListener('click', closeAuthOverlay);
  authSignInBtn.addEventListener('click', signIn);
  authSignUpBtn.addEventListener('click', signUp);
  signOutBtn.addEventListener('click', signOut);
  authPassword.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') signIn(); });

  sb.auth.onAuthStateChange((_event, session) => { applySession(session); });
  sb.auth.getSession()
    .then(({ data }) => applySession(data.session))
    .catch((err) => { console.warn('Could not restore session:', err); applySession(null); });
}

export { initAuth, onAuthReady };
