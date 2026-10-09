-- ============================================================
-- 019_remove_rating_age_gate.sql
--
-- POLISH-1: drop the 48-hour account-age wait on rating (words/music stars).
-- A brand-new account can now rate a song as soon as they sign in.
--
-- rate_song() keeps every other check exactly as it was: sign-in required,
-- facet in ('words','music'), score 1 to 5, the song must be approved,
-- the account must be active (public.is_active_artist(), unrelated to age),
-- and you cannot rate your own song. One row per (song, rater, facet),
-- changeable via the same on-conflict upsert. Same signature, same grants
-- (revoke from public, grant execute to authenticated only -- anon still has
-- no path in). Idempotent: create or replace, applied as a named migration.
--
-- The age gate lived in two places: the read in rate_song() below, and the
-- site_settings row that supplied the hour count. Both go together so no
-- dead setting is left behind.
-- ============================================================

create or replace function public.rate_song(p_song uuid, p_facet text, p_score smallint)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_uid       uuid := auth.uid();
  v_owner     uuid;
  v_status    text;
begin
  if v_uid is null then
    raise exception 'Sign in to rate.';
  end if;
  if p_facet not in ('words','music') then
    raise exception 'Unknown rating.';
  end if;
  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception 'A rating is 1 to 5.';
  end if;

  select artist_id, status into v_owner, v_status from public.songs where id = p_song;
  if v_owner is null or v_status is distinct from 'approved' then
    raise exception 'This song is not available.';
  end if;
  if not public.is_active_artist() then
    raise exception 'This account cannot rate.';
  end if;
  if v_owner = v_uid then
    raise exception 'You cannot rate your own song.';
  end if;

  insert into public.ratings (song_id, artist_id, facet, score)
  values (p_song, v_uid, p_facet, p_score)
  on conflict (song_id, artist_id, facet)
  do update set score = excluded.score, updated_at = now();
end;
$fn$;
revoke all on function public.rate_song(uuid, text, smallint) from public;
grant execute on function public.rate_song(uuid, text, smallint) to authenticated;

-- The hour count this function used to read. No code references it anymore.
delete from public.site_settings where key = 'account_age_hours';
