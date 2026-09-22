/* ============================================================
   Auth state for the whole site.

   Re-exports the single client created by js/supabase-client.js (see the note
   in that file for why the client is not created here), keeps one small piece
   of shared state on window.laivy.auth, and fires a `laivy:auth` event whenever
   it changes.

   Anything that renders reads window.laivy.auth. Nothing in a render path ever
   calls getSession(): that is async and would either block paint or cause a
   flash. The chip renders signed-out first and corrects itself on the first
   event, which arrives within a frame or two.
   ============================================================ */

export const supabase = (window.laivy && window.laivy.supabase) || null;

window.laivy = window.laivy || {};
window.laivy.auth = window.laivy.auth || { user: null, artist: null, ready: false };

const state = window.laivy.auth;

function emit() {
  try {
    window.dispatchEvent(new CustomEvent('laivy:auth', { detail: { ...state } }));
  } catch (e) { /* never let a listener break auth */ }
}

/* The artist row comes from artists_public, not artists: it is the view that
   anon can read, it only carries non-sensitive columns, and it excludes
   suspended and deleted artists. A signed-in visitor whose artist row is
   missing from it (suspended, deleted, or not created yet) simply gets
   artist = null, and the UI treats them as signed in with no profile. */
async function loadArtist(userId) {
  if (!supabase || !userId) return null;
  try {
    const { data, error } = await supabase
      .from('artists_public')
      .select('id, handle, display_name, display_name_he, bio, avatar_url, created_at')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (e) {
    console.warn('[laivy] could not load artist profile', e && e.message);
    return null;
  }
}

/* artists_public deliberately does not expose role or onboarded, so those two
   come from the artists table itself, which RLS scopes to the caller's own row
   (artists_read_self). Failure here is not fatal: role falls back to 'artist'
   and onboarded to true, i.e. the quiet, non-nagging default. */
async function loadSelfFlags(userId) {
  if (!supabase || !userId) return { role: 'artist', onboarded: true };
  try {
    const { data, error } = await supabase
      .from('artists')
      .select('role, onboarded')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    return { role: (data && data.role) || 'artist', onboarded: data ? !!data.onboarded : true };
  } catch (e) {
    return { role: 'artist', onboarded: true };
  }
}

async function apply(user) {
  state.user = user || null;
  if (user) {
    const [artist, flags] = await Promise.all([loadArtist(user.id), loadSelfFlags(user.id)]);
    state.artist = artist ? { ...artist, ...flags } : { id: user.id, ...flags, handle: null, display_name: null };
  } else {
    state.artist = null;
  }
  state.ready = true;
  emit();
}

if (supabase) {
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') { apply(null); return; }
    // INITIAL_SESSION fires on every load, with session null when signed out.
    apply(session ? session.user : null);
  });
} else {
  state.ready = true;
  emit();
}

/* ---------------- helpers ---------------- */

// Where the provider sends the browser back to. `next` carries the page the
// visitor was on so the callback can put them back there.
function callbackUrl() {
  const next = location.pathname + location.search;
  return `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
}

export async function signInWithEmail(email) {
  if (!supabase) throw new Error('Auth is unavailable.');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: callbackUrl() },
  });
  if (error) throw error;
}

export async function signInWithGoogle() {
  if (!supabase) throw new Error('Auth is unavailable.');
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: callbackUrl(), queryParams: { prompt: 'select_account' } },
  });
  if (error) throw error;
}

export async function signOut() {
  if (!supabase) return;
  try { await supabase.auth.signOut(); } catch (e) { /* clear locally anyway */ }
  apply(null);
}

// Call after a profile edit so the chip and settings pick up the new values.
export async function refreshArtist() {
  if (state.user) await apply(state.user);
  return state.artist;
}

/* UI ONLY. The authoritative check is the is_admin() function in the database,
   which every admin policy calls; this just decides whether to draw a menu
   item. Never gate access on it. */
export function isAdmin() {
  return !!(state.artist && state.artist.role === 'admin');
}

export function authState() { return state; }
