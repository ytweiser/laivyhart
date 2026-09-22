/* ============================================================
   The ONE Supabase client for this document.

   Why this file exists, and why it is a classic script rather than a module:

   index.html and admin.html both load supabase-js as the UMD bundle
   (window.supabase) and their app code is one large classic <script>, not a
   module. A module is deferred, so it always runs AFTER that inline script --
   which means the client cannot be created inside js/auth.js without the app
   code finding nothing when it runs. Creating a second client instead is the
   thing to avoid: two clients on one document share the same localStorage
   storage key and race on token refresh, which shows up as random sign-outs.

   So: this classic script runs before the app code, creates exactly one client,
   and hangs it on window.laivy.supabase. The inline app code reads it from
   there, and js/auth.js (a module, running later) re-exports that same
   instance. One createClient call per document.

   Load order in every page: supabase-js UMD -> config.js -> this -> app code
   -> js/auth.js (module) -> js/account-ui.js (module).
   ============================================================ */
(function () {
  window.laivy = window.laivy || {};

  var cfg = window.LAIVY_CONFIG || {};
  if (!window.supabase || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    console.error('[laivy] Supabase config or SDK missing; auth is disabled on this page.');
    return;
  }

  // The key is the publishable (anon) key from config.js. The service role key
  // must never appear in anything the browser loads.
  window.laivy.supabase = window.supabase.createClient(
    cfg.SUPABASE_URL,
    cfg.SUPABASE_ANON_KEY,
    {
      auth: {
        // PKCE is the right flow for a browser app with no backend secret.
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        // Lets the client pick the code out of /auth/callback itself.
        detectSessionInUrl: true,
        // storageKey deliberately left at the default, which resolves to
        // sb-<project-ref>-auth-token.
      },
    }
  );
})();
