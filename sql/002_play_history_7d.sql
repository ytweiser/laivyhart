-- ============================================================
-- 002_play_history_7d.sql
--
-- Per-play history + a rolling 7-day listen count, for the homepage's weekly
-- ranking. Idempotent. Applied via the Supabase MCP as migration
-- "play_history_7d".
--
-- RLS: public.plays has RLS ENABLED with NO policies, so no client (anon or
-- authenticated) can read or write it directly. Rows are inserted only by
-- increment_play_count() (SECURITY DEFINER, owned by the table owner, which
-- bypasses RLS). songs.plays_7d is a plain column and inherits the existing
-- songs policies (public read; authenticated write).
-- ============================================================

-- 1) Per-play history table + index. RLS on, no policies.
create table if not exists public.plays (
  id        bigserial primary key,
  song_id   uuid not null references public.songs(id) on delete cascade,
  played_at timestamptz not null default now()
);
create index if not exists plays_song_played_idx on public.plays (song_id, played_at);
alter table public.plays enable row level security;

-- 2) increment_play_count: SAME behavior as before (bump songs.play_count) PLUS
--    log one row into plays. Signature unchanged (song_id uuid) -> void.
create or replace function public.increment_play_count(song_id uuid)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  update public.songs set play_count = play_count + 1 where id = song_id;
  insert into public.plays (song_id) values (song_id);
$function$;

-- 3) Rolling 7-day listen count.
alter table public.songs add column if not exists plays_7d int not null default 0;

-- 4) Recompute plays_7d for every song (0 where none) and prune history older
--    than 90 days so the table does not grow without bound.
create or replace function public.refresh_plays_7d()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.songs s
     set plays_7d = coalesce((
       select count(*) from public.plays p
        where p.song_id = s.id
          and p.played_at >= now() - interval '7 days'
     ), 0);
  delete from public.plays where played_at < now() - interval '90 days';
end;
$function$;

-- 5) Hourly refresh via pg_cron, at 5 minutes past every hour. Idempotent:
--    unschedule an existing job of the same name first.
create extension if not exists pg_cron;
do $$
begin
  if exists (select 1 from cron.job where jobname = 'refresh-plays-7d') then
    perform cron.unschedule('refresh-plays-7d');
  end if;
end $$;
select cron.schedule('refresh-plays-7d', '5 * * * *', 'select public.refresh_plays_7d()');
