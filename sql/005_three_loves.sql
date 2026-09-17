-- ============================================================
-- 005_three_loves.sql
--
-- Three independent loves on the /listen dock: "the words", "the music",
-- "the song". Idempotent. Applied via the Supabase MCP as migration
-- "three_loves".
--
-- The heart is unchanged: songs.like_count is still "love the song" and
-- toggle_like() is still its RPC (intentionally NOT redefined here). What
-- changes is the other two: they are no longer one exclusive facet OF a like
-- but two independent toggles of their own, so set_like_facet (pick one of
-- three) is replaced by toggle_love (turn one of two on or off).
--
-- like_all_count goes away: "all of it" was only meaningful as the third
-- choice in an exclusive facet, and with independent loves it is just the
-- heart. Any nonzero value is folded into like_count before the column drops.
--
-- RLS is unchanged: the counters are written only by the SECURITY DEFINER
-- function below, never by a client.
-- ============================================================

-- 1) Fold "all of it" into the heart, then retire the column. The update is
--    guarded on the column still existing so re-running this file is safe.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'songs' and column_name = 'like_all_count'
  ) then
    update public.songs
       set like_count = coalesce(like_count, 0) + like_all_count
     where coalesce(like_all_count, 0) <> 0;
  end if;
end
$$;

alter table public.songs drop column if exists like_all_count;

-- 2) The old exclusive-facet RPC is gone.
drop function if exists public.set_like_facet(uuid, text, text);

-- 3) Turn one love on or off. kind is 'lyrics' (the words) or 'music' (the
--    music); "on" true increments, false decrements, clamped at 0. Never
--    touches like_count, which belongs to toggle_like(). Returns the new count
--    so the client can reconcile. Same grants as toggle_like.
--    "on" is a reserved word, so it is quoted here and at every use.
create or replace function public.toggle_love(song_id uuid, kind text, "on" boolean)
returns int
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  delta  int := case when "on" then 1 else -1 end;
  newval int;
begin
  if kind not in ('lyrics', 'music') then
    raise exception 'invalid love kind: %', kind;
  end if;

  if kind = 'lyrics' then
    update public.songs
       set like_lyrics_count = greatest(0, coalesce(like_lyrics_count, 0) + delta)
     where id = song_id
     returning like_lyrics_count into newval;
  else
    update public.songs
       set like_tune_count = greatest(0, coalesce(like_tune_count, 0) + delta)
     where id = song_id
     returning like_tune_count into newval;
  end if;

  return newval;
end;
$function$;

grant execute on function public.toggle_love(uuid, text, boolean) to anon, authenticated;
