-- ============================================================
-- 018_artist_page_social.sql — ARTIST-3: Honors threshold + picks reorder
--
-- Two changes. Follow, the bio editor and the picks add/remove/note-edit all
-- run on RLS + functions sql/016/017 already shipped — nothing new for them
-- here. Only the Honors tally-vs-row distinction and the picks reorder swap
-- need database changes.
-- ============================================================

-- ------------------------------------------------------------
-- 1. honors_min_weeks_on_chart — the Honors ROW's weeks-on-chart threshold
--    (step 10: a song qualifies on Hit #1 / Weeks at #1 / Best words / Best
--    music / Was Most loved outright, or on Weeks on the chart only once it
--    reaches this many). The Trophy case tally (artist_badges) is read
--    as-is and is NOT touched by this — it stays every earned badge, no
--    threshold. Read by the client and by scripts/snapshot-songs.mjs so the
--    two never compute two different answers.
-- ------------------------------------------------------------
insert into public.site_settings (key, value) values
  ('honors_min_weeks_on_chart', to_jsonb(4))
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- 2. artist_picks reorder: swapping two adjacent picks' positions is two
--    UPDATEs through the SAME (artist_id, position) unique constraint --
--    done as two separate client requests (two transactions), the first one
--    alone can collide with whichever row already holds the destination
--    position. Fixed by making that constraint DEFERRABLE INITIALLY
--    DEFERRED (checked at COMMIT, not per-statement) and doing both updates
--    inside ONE function call, which PostgREST already runs as a single
--    transaction -- so by the time the constraint is checked, both rows
--    have already moved and the swap is consistent either way.
--
--    SECURITY INVOKER, not DEFINER: it needs no elevated privilege. It runs
--    as the calling (authenticated) role, so the existing artist_picks RLS
--    update policy (artist_id = (select auth.uid())) already scopes it to
--    the caller's own picks; the explicit WHERE below is belt and braces,
--    not the real guard.
-- ------------------------------------------------------------
alter table public.artist_picks
  drop constraint artist_picks_artist_id_position_key,
  add constraint artist_picks_artist_id_position_key
    unique (artist_id, position) deferrable initially deferred;

create or replace function public.swap_my_pick_positions(p_pos_a int, p_pos_b int)
returns void language plpgsql security invoker set search_path to 'public' as $function$
declare
  v_id_a uuid;
  v_id_b uuid;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to reorder your picks.';
  end if;
  if p_pos_a = p_pos_b then
    return;
  end if;

  -- Identify both rows by their OWN id before touching either. Updating by
  -- `where position = p_pos_a` a second time, after the first UPDATE has
  -- already moved a row into p_pos_b, matches BOTH rows (the one just moved
  -- there and the one already there) and sends both to the same position --
  -- a real bug this prompt's own aborting test caught before it shipped.
  select id into v_id_a from public.artist_picks
   where artist_id = (select auth.uid()) and position = p_pos_a;
  select id into v_id_b from public.artist_picks
   where artist_id = (select auth.uid()) and position = p_pos_b;
  if v_id_a is null or v_id_b is null then
    raise exception 'Both positions must already hold a pick.';
  end if;

  update public.artist_picks set position = p_pos_b where id = v_id_a;
  update public.artist_picks set position = p_pos_a where id = v_id_b;
end;
$function$;

-- Revoke from BOTH anon and PUBLIC: this project's own ALTER DEFAULT
-- PRIVILEGES grants EXECUTE on every new function directly to anon (not
-- just via PUBLIC membership) -- see follow_artist's own fix in sql/016 for
-- the first half of this; revoking from PUBLIC alone was not enough there
-- either, it was just enough to make the symptom disappear that one time.
revoke execute on function public.swap_my_pick_positions(int, int) from anon, public;
grant execute on function public.swap_my_pick_positions(int, int) to authenticated;
