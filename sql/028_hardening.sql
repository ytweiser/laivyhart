-- ============================================================
-- 028_hardening.sql
--
-- 1B-4: function permissions, audited and locked down. This project's
-- default privileges (pg_default_acl) grant EXECUTE on every NEW function
-- in public to anon and authenticated automatically -- confirmed present
-- since before this migration, and the reason nearly every prior
-- migration's own functions carry an explicit "revoke ... from public,
-- anon" comment right after creating them. Part A fixes the default
-- itself, going forward; Part B re-asserts the correct grant on every
-- function that already exists, from how the site and admin actually
-- call each one (grepped, not guessed -- see the report this migration
-- shipped with for the full before/after table).
--
-- RLS is untouched everywhere in this file. activity_events and every
-- other RLS-forced table stay exactly as locked down as their own
-- migrations left them.
-- ============================================================

-- ------------------------------------------------------------
-- PART A: the default itself.
--
-- pg_default_acl showed two creating roles in schema public:
--   - postgres: owns this project's 67 own functions (is_admin,
--     pulse_feed, create_dedication, ...). Every migration in sql/ runs as
--     postgres, so this is the one default that actually governs this
--     project's own future functions.
--   - supabase_admin: owns 51 functions, every one of them installed by
--     the citext/unaccent extensions (citext_cmp, unaccent_lexize, ...) --
--     plain string/regex utilities, not application logic, and not
--     something this project creates going forward. postgres is not a
--     member of supabase_admin and is not a superuser on this managed
--     project, so postgres cannot alter supabase_admin's default
--     privileges at all (confirmed: ALTER DEFAULT PRIVILEGES FOR ROLE
--     supabase_admin ... errors 42501, permission denied). Left as is --
--     there is nothing here to fix even if it mattered, since nothing
--     this project creates is owned by supabase_admin.
--
-- Table/sequence defaults are NOT changed (left exactly as found, both for
-- postgres and supabase_admin) -- RLS forced on every sensitive table is
-- the real boundary there, same reasoning ACT-1 and every migration since
-- has relied on; a table-level grant with RLS forced and zero policies
-- still returns nothing to anon/authenticated, so tightening it buys
-- nothing and risks breaking the one legitimate direct-table reader
-- (service_role, via the Worker) for no benefit.
-- ------------------------------------------------------------
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- ------------------------------------------------------------
-- PART B: every existing function, reclassified.
--
-- Every SECURITY DEFINER function already sets search_path (confirmed by
-- reading pg_proc.proconfig for all 67 -- every one carries
-- search_path=public already); nothing to add here.
--
-- The pattern below, for every function: revoke from public and anon
-- explicitly (removing any bare PUBLIC pseudo-role grant too, which is
-- different from and redundant with the anon/authenticated roles this
-- project actually uses), then grant back exactly what its class needs.
-- service_role is never touched -- it already has execute from the
-- default (Part A does not touch service_role), and every one of these
-- classes assumes the Worker's service-role key can still call anything
-- it needs to directly against Postgres if it ever has to.
--
-- Classes:
--   PUBLIC   -- anon and authenticated (visitors browsing signed out).
--   MEMBERS  -- authenticated only (requires an account to call at all).
--   ADMIN    -- authenticated only; is_admin() is checked INSIDE the
--              function body, so the grant alone is not the real gate --
--              it just keeps a non-admin signed-in member from even
--              reaching that check through a role that was never going to
--              need to.
--   RLS-ONLY -- authenticated only, not because anything calls it
--              directly, but because an RLS policy evaluated for
--              authenticated references it (confirmed by grepping every
--              USING/WITH CHECK clause in sql/ -- only is_admin() and
--              is_active_artist() appear there, both in policies scoped
--              `to authenticated`, never `to anon`).
--   INTERNAL -- no grant at all beyond the owner and whatever service_role
--              already has. Three kinds, confirmed the same way:
--                - trigger functions (grepped every "execute function" in
--                  sql/): firing a trigger does not require the
--                  DML-performing role to hold EXECUTE on the trigger
--                  function -- that is enforced by the trigger manager,
--                  not the normal function-call path -- so these need no
--                  grant for the site to keep working.
--                - helper functions called only from inside another
--                  function's body (grepped every "public.name(" call
--                  site): callable by nobody but their caller, which runs
--                  as the function owner regardless of who originally
--                  invoked the outer function.
--                - cron-scheduled functions (grepped cron.schedule /
--                  cron.alter_job): run as postgres via pg_cron, same
--                  reasoning.
--              Three functions (delete_category, rename_category,
--              token_balance) had zero references anywhere in sql/ or the
--              app at all -- not called by the client, not by another
--              function, not by a trigger or cron job. Apparently dead
--              code (categories were retired by CH-2; token_balance looks
--              like an unbuilt feature). Not dropped here -- this
--              migration is about permissions, not deleting functions --
--              but locked down the same as any other internal function,
--              since nothing legitimate depends on them being callable.
--
-- Two deliberate exceptions, both confirmed empirically (not guessed)
-- before deciding either way -- the same lesson twice, which is why this
-- migration's own Node anon-key verification afterward is not optional:
--
-- - song_idea_credit(text, boolean, text) looks like a pure internal
--   formatting helper (only called from inside my_song_ideas()/
--   admin_list_song_ideas()/submit_song_idea() and from the
--   song_ideas_board VIEW's own select list), but that view is PUBLIC
--   (selected by anon on /your-song/ideas) and security_invoker=false
--   does NOT exempt a function called from a view's select list from its
--   own EXECUTE check against the querying role -- confirmed by revoking
--   it and immediately trying `select * from song_ideas_board` as anon
--   inside a rolled-back transaction, which failed with "permission
--   denied for function song_idea_credit".
-- - badge_setting(text, integer) looked the same way (only called from
--   inside another function and, it turns out, from song_badges' own
--   select list -- a PUBLIC view, the badge shelf on every song card).
--   This one was NOT caught by the rolled-back-transaction check above;
--   it was caught by this migration's own required Node-with-the-real-
--   anon-key verification (item 15), which is exactly why that step is
--   required and not optional -- a plain `select * from public.song_badges`
--   with the real anon key failed with "permission denied for function
--   badge_setting" after the first pass of this migration had locked it
--   down as internal. Fixed in a follow-up migration
--   (hardening_fix_badge_setting_view_dependency) and folded back into
--   this file so the committed migration matches what is actually live.
--
-- Both stay PUBLIC (anon, authenticated).
-- ------------------------------------------------------------

-- ---- PUBLIC (anon, authenticated) ----
revoke all on function public.artist_stats(uuid) from public, anon;
grant execute on function public.artist_stats(uuid) to anon, authenticated;

revoke all on function public.follower_count(uuid) from public, anon;
grant execute on function public.follower_count(uuid) to anon, authenticated;

revoke all on function public.recommend_for_artist(uuid, integer) from public, anon;
grant execute on function public.recommend_for_artist(uuid, integer) to anon, authenticated;

revoke all on function public.toggle_love(uuid, text, boolean) from public, anon;
grant execute on function public.toggle_love(uuid, text, boolean) to anon, authenticated;

revoke all on function public.increment_play_count(uuid) from public, anon;
grant execute on function public.increment_play_count(uuid) to anon, authenticated;

revoke all on function public.toggle_like(uuid, boolean) from public, anon;
grant execute on function public.toggle_like(uuid, boolean) to anon, authenticated;

revoke all on function public.public_pulse(integer) from public, anon;
grant execute on function public.public_pulse(integer) to anon, authenticated;

revoke all on function public.public_ticker(integer) from public, anon;
grant execute on function public.public_ticker(integer) to anon, authenticated;

revoke all on function public.song_idea_credit(text, boolean, text) from public;
grant execute on function public.song_idea_credit(text, boolean, text) to anon, authenticated;

revoke all on function public.badge_setting(text, integer) from public;
grant execute on function public.badge_setting(text, integer) to anon, authenticated;

-- ---- MEMBERS (authenticated only) ----
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

revoke all on function public.rate_song(uuid, text, smallint) from public, anon;
grant execute on function public.rate_song(uuid, text, smallint) to authenticated;

revoke all on function public.create_dedication(uuid, text, text, text, text, boolean) from public, anon;
grant execute on function public.create_dedication(uuid, text, text, text, text, boolean) to authenticated;

revoke all on function public.follow_artist(uuid, boolean) from public, anon;
grant execute on function public.follow_artist(uuid, boolean) to authenticated;

revoke all on function public.my_dedications() from public, anon;
grant execute on function public.my_dedications() to authenticated;

revoke all on function public.my_song_ideas() from public, anon;
grant execute on function public.my_song_ideas() to authenticated;

revoke all on function public.remove_my_dedication(text) from public, anon;
grant execute on function public.remove_my_dedication(text) to authenticated;

revoke all on function public.submit_song_idea(text, text, boolean, boolean, boolean) from public, anon;
grant execute on function public.submit_song_idea(text, text, boolean, boolean, boolean) to authenticated;

revoke all on function public.swap_my_pick_positions(integer, integer) from public, anon;
grant execute on function public.swap_my_pick_positions(integer, integer) to authenticated;

revoke all on function public.toggle_song_idea_heart(uuid, boolean) from public, anon;
grant execute on function public.toggle_song_idea_heart(uuid, boolean) to authenticated;

revoke all on function public.withdraw_my_song_idea(uuid) from public, anon;
grant execute on function public.withdraw_my_song_idea(uuid) to authenticated;

-- ---- ADMIN (authenticated; is_admin() checked inside) ----
revoke all on function public.admin_delete_artist(uuid) from public, anon;
grant execute on function public.admin_delete_artist(uuid) to authenticated;

revoke all on function public.admin_list_artists() from public, anon;
grant execute on function public.admin_list_artists() to authenticated;

revoke all on function public.admin_new_signups_since(timestamptz) from public, anon;
grant execute on function public.admin_new_signups_since(timestamptz) to authenticated;

revoke all on function public.promote_to_artist(uuid) from public, anon;
grant execute on function public.promote_to_artist(uuid) to authenticated;

revoke all on function public.demote_to_listener(uuid) from public, anon;
grant execute on function public.demote_to_listener(uuid) to authenticated;

revoke all on function public.review_song(uuid, text, text) from public, anon;
grant execute on function public.review_song(uuid, text, text) to authenticated;

revoke all on function public.admin_list_dedications(text, integer, timestamptz) from public, anon;
grant execute on function public.admin_list_dedications(text, integer, timestamptz) to authenticated;

revoke all on function public.admin_list_song_ideas(text, text, integer, timestamptz) from public, anon;
grant execute on function public.admin_list_song_ideas(text, text, integer, timestamptz) to authenticated;

revoke all on function public.admin_remove_dedication(text, text) from public, anon;
grant execute on function public.admin_remove_dedication(text, text) to authenticated;

revoke all on function public.admin_set_song_idea_status(uuid, text, uuid) from public, anon;
grant execute on function public.admin_set_song_idea_status(uuid, text, uuid) to authenticated;

revoke all on function public.admin_week_picks(date) from public, anon;
grant execute on function public.admin_week_picks(date) to authenticated;

revoke all on function public.pulse_feed(integer, timestamptz) from public, anon;
grant execute on function public.pulse_feed(integer, timestamptz) to authenticated;

revoke all on function public.pulse_member(uuid, integer) from public, anon;
grant execute on function public.pulse_member(uuid, integer) to authenticated;

revoke all on function public.pulse_member(text, integer) from public, anon;
grant execute on function public.pulse_member(text, integer) to authenticated;

revoke all on function public.pulse_retention(integer) from public, anon;
grant execute on function public.pulse_retention(integer) to authenticated;

revoke all on function public.pulse_song(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.pulse_song(uuid, timestamptz, timestamptz) to authenticated;

revoke all on function public.pulse_summary(timestamptz, timestamptz) from public, anon;
grant execute on function public.pulse_summary(timestamptz, timestamptz) to authenticated;

revoke all on function public.pulse_top_listeners(timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.pulse_top_listeners(timestamptz, timestamptz, integer) to authenticated;

-- build_daily_report(): admin (authenticated) AND the Worker's cron job
-- (service_role). Already correctly set by 021_pulse.sql; re-asserted
-- here for completeness/consistency with every other function in this
-- audit, not because it was wrong.
revoke all on function public.build_daily_report() from public, anon;
grant execute on function public.build_daily_report() to authenticated, service_role;

-- ---- RLS-ONLY (authenticated; referenced inside a policy, never called
-- directly) ----
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

revoke all on function public.is_active_artist() from public, anon;
grant execute on function public.is_active_artist() to authenticated;

-- ---- INTERNAL (no grant beyond the owner/service_role) ----
-- Trigger functions.
revoke all on function public.artist_picks_guard() from public, anon, authenticated;
revoke all on function public.artists_guard() from public, anon, authenticated;
revoke all on function public.comments_refresh_count_tg() from public, anon, authenticated;
revoke all on function public.comments_require_approved_song() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.ratings_refresh_tg() from public, anon, authenticated;
revoke all on function public.songs_after_submit() from public, anon, authenticated;
revoke all on function public.songs_guard_artist_writes() from public, anon, authenticated;

-- Helper functions, called only from inside another function's body.
revoke all on function public.assert_submit_allowed(uuid, uuid) from public, anon, authenticated;
revoke all on function public.ratings_refresh_song(uuid, text) from public, anon, authenticated;
revoke all on function public.refresh_song_comment_count(uuid) from public, anon, authenticated;
revoke all on function public.slugify(text) from public, anon, authenticated;
revoke all on function public.song_slug(text, text, uuid) from public, anon, authenticated;

-- Cron-scheduled (pg_cron, runs as postgres).
revoke all on function public.cleanup_stale_artist_picks() from public, anon, authenticated;
revoke all on function public.refresh_plays_7d() from public, anon, authenticated;
revoke all on function public.take_chart_snapshot() from public, anon, authenticated;

-- Dead code (no caller anywhere in sql/ or the app) -- locked down, not
-- dropped; see this file's own header comment above.
revoke all on function public.delete_category(text) from public, anon, authenticated;
revoke all on function public.rename_category(text, text) from public, anon, authenticated;
revoke all on function public.token_balance(uuid) from public, anon, authenticated;

-- Already correctly locked down before this migration -- re-asserted for
-- completeness, not because anything was wrong.
revoke all on function public._pulse_listen_rows(uuid, text) from public, anon, authenticated;
revoke all on function public.contains_banned_term(text) from public, anon, authenticated;
revoke all on function public.generate_dedication_code() from public, anon, authenticated;
revoke all on function public.song_idea_hearts_sync() from public, anon, authenticated;
revoke all on function public.rollup_activity_daily() from public, anon, authenticated;
revoke all on function public.purge_old_activity_events() from public, anon, authenticated;
