-- ============================================================
-- 001_phase_a_tags_featured_counts.sql
--
-- Phase A data groundwork for the homepage + search features:
--   * songs.tags            text[]  (searchable/free-form labels)
--   * songs.featured         bool    (show on the homepage)
--   * songs.featured_order   int     (lower = first; null = unordered)
--   * songs.comment_count    int     (approved comments, trigger-maintained)
--
-- Idempotent: safe to run more than once (IF NOT EXISTS / OR REPLACE /
-- DROP TRIGGER IF EXISTS throughout). Applied via the Supabase MCP
-- apply_migration tool as "phase_a_tags_featured_counts".
--
-- RLS: intentionally NOT touched. The four new columns live on public.songs
-- and are covered by the existing songs policies (anon+authenticated SELECT;
-- authenticated INSERT/UPDATE/DELETE). comment_count is written only by the
-- SECURITY DEFINER refresh function below (fired from a trigger), so anon
-- comment inserts can update it without any new songs-write grant.
-- ============================================================

-- 1-4) New columns on songs. ---------------------------------------------------
alter table public.songs add column if not exists tags           text[]  not null default '{}';
alter table public.songs add column if not exists featured       boolean not null default false;
alter table public.songs add column if not exists featured_order int;                       -- null = featured but unordered
alter table public.songs add column if not exists comment_count  int     not null default 0; -- approved comments only

-- 5) Recompute one song's approved-comment count. SECURITY DEFINER so the
--    comments trigger can update songs even when the caller (anon) has no
--    songs-write privilege.
create or replace function public.refresh_song_comment_count(p_song_id uuid)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  update public.songs
     set comment_count = (
       select count(*)
         from public.comments
        where song_id = p_song_id
          and status = 'approved'
     )
   where id = p_song_id;
$function$;

-- 6) Trigger function: keep comment_count in sync as comments are inserted,
--    have their status/song_id changed, or deleted. Refreshes NEW.song_id and,
--    when it differs (a moved comment) or on DELETE, OLD.song_id too.
create or replace function public.comments_refresh_count_tg()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if (tg_op = 'DELETE') then
    perform public.refresh_song_comment_count(old.song_id);
    return old;
  end if;

  -- INSERT or UPDATE OF status, song_id
  perform public.refresh_song_comment_count(new.song_id);
  if (tg_op = 'UPDATE' and new.song_id is distinct from old.song_id) then
    perform public.refresh_song_comment_count(old.song_id);
  end if;
  return new;
end;
$function$;

drop trigger if exists comments_refresh_count on public.comments;
create trigger comments_refresh_count
  after insert or delete or update of status, song_id on public.comments
  for each row execute function public.comments_refresh_count_tg();

-- 7) One-time backfill of comment_count for every song.
update public.songs s
   set comment_count = (
     select count(*)
       from public.comments c
      where c.song_id = s.id
        and c.status = 'approved'
   );

-- 8) GIN index for tag containment/overlap searches.
create index if not exists songs_tags_gin on public.songs using gin (tags);
