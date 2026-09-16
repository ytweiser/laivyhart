-- ============================================================
-- 003_like_facets.sql
--
-- Optional "what moved you?" facet on a like: melody / words / all of it.
-- Idempotent. Applied via the Supabase MCP as migration "like_facets".
--
-- The heart itself is unchanged: songs.like_count and toggle_like() keep their
-- exact behavior (toggle_like is intentionally NOT redefined here). set_like_facet
-- only moves the three facet counters and never touches like_count. RLS: the new
-- columns inherit the existing songs policies; the counters are written only by
-- the SECURITY DEFINER function below.
-- ============================================================

-- 1) Three facet counters on songs.
alter table public.songs add column if not exists like_tune_count   int not null default 0;
alter table public.songs add column if not exists like_lyrics_count int not null default 0;
alter table public.songs add column if not exists like_all_count    int not null default 0;

-- 2) Move a visitor's facet choice. facet is 'tune' | 'lyrics' | 'all' | null.
--    Decrements previous_facet's counter (if it names one of the three) and
--    increments facet's counter (if not null); clamps at 0; never touches
--    like_count. Same grants as toggle_like (anon + authenticated).
create or replace function public.set_like_facet(song_id uuid, facet text, previous_facet text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if facet is not null and facet not in ('tune', 'lyrics', 'all') then
    raise exception 'invalid facet: %', facet;
  end if;

  -- Decrement the previously-chosen facet, if it was one of the three.
  if previous_facet = 'tune' then
    update public.songs set like_tune_count   = greatest(0, like_tune_count   - 1) where id = song_id;
  elsif previous_facet = 'lyrics' then
    update public.songs set like_lyrics_count = greatest(0, like_lyrics_count - 1) where id = song_id;
  elsif previous_facet = 'all' then
    update public.songs set like_all_count    = greatest(0, like_all_count    - 1) where id = song_id;
  end if;

  -- Increment the newly-chosen facet, if any.
  if facet = 'tune' then
    update public.songs set like_tune_count   = like_tune_count   + 1 where id = song_id;
  elsif facet = 'lyrics' then
    update public.songs set like_lyrics_count = like_lyrics_count + 1 where id = song_id;
  elsif facet = 'all' then
    update public.songs set like_all_count    = like_all_count    + 1 where id = song_id;
  end if;
end;
$function$;

grant execute on function public.set_like_facet(uuid, text, text) to anon, authenticated;
