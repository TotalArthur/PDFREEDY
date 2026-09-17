// Accounts + access control.
//
// If Supabase isn't configured (supabaseConfig.js left blank), the app runs
// fully local with no gate at all — same as it always did. Once configured,
// nothing in the app is usable until the signed-in account has a `profiles`
// row with status = 'active' (see supabase/schema.sql): new signups land as
// 'pending' until Arthur approves them, matching the "not for use without
// express permission" line in the header.
import { sb, CLOUD_ENABLED } from './supabaseClient.js';
import { S } from './state.js';
import { logUsageEvent } from './usage.js';

const $ = id => document.getElementById(id);
const authOverlay = $('authOverlay');
const authForm = $('authForm');
const authEmail = $('authEmail');
const authPassword = $('authPassword');
const authError = $('authError');
const authSignInBtn = $('authSignInBtn');
const authSignUpBtn = $('authSignUpBtn');
const authPending = $('authPending');
const authPendingEmail = $('authPendingEmail');
const authRevoked = $('authRevoked');
const authSignOutFromPendingBtn = $('authSignOutFromPendingBtn');
const authSignOutFromRevokedBtn = $('authSignOutFromRevokedBtn');
const userBadge = $('userBadge');
const userEmailLabel = $('userEmailLabel');
const signOutBtn = $('signOutBtn');
const projectsBtn = $('projectsBtn');

const authReadyListeners = [];
function onAuthReady(fn) { authReadyListeners.push(fn); }

function showError(msg) {
  authError.textContent = msg;
  authError.hidden = !msg;
}

function showGateState(state) {
  authForm.hidden = state !== 'form';
  authPending.hidden = state !== 'pending';
  authRevoked.hidden = state !== 'revoked';
  authOverlay.hidden = state === 'unlocked';
  userBadge.hidden = state !== 'unlocked';
  projectsBtn.hidden = state !== 'unlocked';
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
    showGateState('form');
    return;
  }
  S.user = session.user;
  const profile = await fetchProfile(session.user.id);
  S.profile = profile;

  if (!profile || profile.status === 'pending') {
    authPendingEmail.textContent = session.user.email;
    showGateState('pending');
    return;
  }
  if (profile.status === 'revoked') {
    showGateState('revoked');
    return;
  }
  // active
  userEmailLabel.textContent = session.user.email + (profile.is_admin ? ' (admin)' : '');
  showGateState('unlocked');
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
  showError('Account created. If approval is required you\'ll see a pending screen after signing in.');
}

async function signOut() {
  await sb.auth.signOut();
}

function initAuth() {
  if (!CLOUD_ENABLED) {
    // Local-only mode: no accounts, nothing to gate. Keep the overlay hidden
    // and the badge hidden, and just fire the ready callbacks immediately so
    // other modules that wait on "auth settled" still run.
    authOverlay.hidden = true;
    userBadge.hidden = true;
    projectsBtn.hidden = true;
    for (const fn of authReadyListeners) fn(null, null);
    return;
  }

  authSignInBtn.addEventListener('click', signIn);
  authSignUpBtn.addEventListener('click', signUp);
  authSignOutFromPendingBtn.addEventListener('click', signOut);
  authSignOutFromRevokedBtn.addEventListener('click', signOut);
  signOutBtn.addEventListener('click', signOut);
  authPassword.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') signIn(); });

  sb.auth.onAuthStateChange((_event, session) => { applySession(session); });
  sb.auth.getSession().then(({ data }) => applySession(data.session));
}

export { initAuth, onAuthReady };
