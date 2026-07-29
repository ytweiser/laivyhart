/* ============================================================
   Laivy Hart shared Supabase config
   Single source of truth for the Supabase URL + publishable key.
   Loaded by both index.html and admin.html before their app code.

   The publishable ("sb_publishable_...") key is safe to expose in
   the browser: it only grants what your RLS policies allow.
   ============================================================ */
window.LAIVY_CONFIG = {
  SUPABASE_URL: "https://tshkrghrgokplakktvik.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_nvhaOpLWBxZxo7X7tRtCWw_QhQ82dV4",
};
