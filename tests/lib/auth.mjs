/* ============================================================
   Fakes a signed-in supabase-js session for this harness, without ever
   contacting Supabase Auth.

   supabase-js v2 persists its session as JSON under a predictable
   localStorage key (sb-<project-ref>-auth-token, confirmed against
   js/supabase-client.js's own comment: storageKey is left at the default).
   Writing a well-formed, NOT-YET-EXPIRED session there before the page's
   first script runs (page.addInitScript) makes the client restore it
   synchronously on load -- no network call, no real JWT signature needed,
   since nothing here ever sends this token to anything but this harness's
   own stubbed endpoints.

   auth.js's apply(user) then fires two real Supabase reads to build
   authState().artist: artists_public (by id) and artists (self-row, RLS-
   scoped). Both must be stubbed -- see wireSupabaseStubs's `selfArtistRow`
   fixture and stub-supabase.mjs's own `/rest/v1/artists?` handler.
   ============================================================ */

const STORAGE_KEY = 'sb-tshkrghrgokplakktvik-auth-token';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(payload) {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.not-a-real-signature`;
}

/**
 * Must be called BEFORE page.goto (it's an addInitScript, so it only takes
 * effect on navigations after this call). `user` is { id, email, createdAt }.
 * `createdAt` defaults to 30 days ago (an established account); pass a recent
 * Date (e.g. `new Date(Date.now() - 60000)`) to simulate a brand-new signup --
 * POLISH-1 removed the 48-hour rating age gate, so this is how that scenario
 * is exercised here.
 */
export async function signInAs(page, user) {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = fakeJwt({ sub: user.id, email: user.email, aud: 'authenticated', role: 'authenticated', exp: now + 3600, iat: now });
  const createdAt = user.createdAt || new Date(Date.now() - 30 * 86400000);
  const session = {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: 'fake-refresh-token-' + user.id,
    user: {
      id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email,
      email_confirmed_at: new Date().toISOString(),
      app_metadata: { provider: 'email' }, user_metadata: {},
      created_at: createdAt.toISOString(),
      updated_at: new Date().toISOString(),
    },
  };
  await page.addInitScript(([key, value]) => {
    try { localStorage.setItem(key, value); } catch (e) {}
  }, [STORAGE_KEY, JSON.stringify(session)]);
}
