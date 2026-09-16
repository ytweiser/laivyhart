-- ============================================================
-- 004_chart_history.sql
--
-- Daily top-10 chart snapshots (Jerusalem day), for a public chart history.
-- Idempotent. Applied via the Supabase MCP as migration "chart_history".
--
-- RLS: chart_snapshots is public-safe (no personal data) — anon + authenticated
-- may SELECT; there is no client write policy, so rows are inserted only by the
-- SECURITY DEFINER take_chart_snapshot() (which bypasses RLS as the owner).
-- title is stored alongside song_id so history stays readable if a song is
-- later deleted (song_id then goes null via ON DELETE SET NULL).
-- ============================================================

create table if not exists public.chart_snapshots (
  id          bigserial primary key,
  chart_date  date     not null,
  rank        smallint not null,
  song_id     uuid references public.songs(id) on delete set null,
  title       text     not null,
  plays_7d    int      not null,
  play_count  int      not null,
  like_count  int      not null,
  is_week_end boolean  not null default false,
  unique (chart_date, rank)
);

alter table public.chart_snapshots enable row level security;
drop policy if exists "chart_snapshots public read" on public.chart_snapshots;
create policy "chart_snapshots public read"
  on public.chart_snapshots for select to anon, authenticated using (true);

-- Close the Jerusalem day that just ended and record its top 10. Ordered by
-- plays_7d desc, play_count desc, like_count desc, title — which during the
-- fallback period (no plays_7d yet) is effectively the all-time order, so the
-- history still starts today. Skips a date already recorded (idempotent). Marks
-- is_week_end when that Jerusalem date is a Saturday (dow = 6).
create or replace function public.take_chart_snapshot()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  d       date    := ((now() at time zone 'Asia/Jerusalem')::date - 1);
  weekend boolean := (extract(dow from ((now() at time zone 'Asia/Jerusalem')::date - 1)) = 6);
begin
  if exists (select 1 from public.chart_snapshots where chart_date = d) then
    return;
  end if;
  insert into public.chart_snapshots
    (chart_date, rank, song_id, title, plays_7d, play_count, like_count, is_week_end)
  select d,
         (row_number() over (order by s.plays_7d desc, s.play_count desc, s.like_count desc, s.title))::smallint,
         s.id, s.title, s.plays_7d, s.play_count, s.like_count, weekend
  from public.songs s
  order by s.plays_7d desc, s.play_count desc, s.like_count desc, s.title
  limit 10;
end;
$function$;

-- Nightly at 22:10 UTC (01:10 Jerusalem summer / 00:10 winter), just after the
-- hourly plays_7d refresh at :05.
create extension if not exists pg_cron;
do $$
begin
  if exists (select 1 from cron.job where jobname = 'take-chart-snapshot') then
    perform cron.unschedule('take-chart-snapshot');
  end if;
end $$;
select cron.schedule('take-chart-snapshot', '10 22 * * *', 'select public.take_chart_snapshot()');
