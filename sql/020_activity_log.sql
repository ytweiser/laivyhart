-- ============================================================
-- 020_activity_log.sql
--
-- ACT-1: a first-party activity log, separate from GA4. Every meaningful
-- action on the Site is recorded tied to the member when signed in, or to an
-- anonymous per-browser device id otherwise, with city/country (never an IP
-- address) so the owner can see who is doing what. Nothing here changes what
-- the public sees: both tables are locked down to the owner only.
--
-- LOCKDOWN. RLS is enabled and FORCED on both tables, with zero policies for
-- anon or authenticated -- the same pattern every table in this project
-- already uses (e.g. public.ratings in 009_ratings.sql). The project's
-- default privileges grant table-level access to anon/authenticated
-- automatically on every new table (confirmed against pg_default_acl), which
-- is exactly why FORCE ROW LEVEL SECURITY, not a table-level REVOKE, is the
-- real boundary: with it on and no policies, zero rows are selectable or
-- writable by anon/authenticated regardless of that table-level grant. Only
-- the service role (which bypasses RLS) and SECURITY DEFINER admin-only read
-- functions -- added in ACT-2, not here -- can read these tables.
--
-- Writer: only the Worker, through the service role key, ever inserts into
-- activity_events (POST /event in worker/src/index.js). No browser code and
-- no Supabase client in this project ever holds that key.
-- ============================================================

-- ------------------------------------------------------------
-- 1. activity_events -- one row per logged action.
-- ------------------------------------------------------------
create table if not exists public.activity_events (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id    uuid null references auth.users(id) on delete set null,
  device_id  text not null,
  session_id text,
  event_type text not null check (event_type in (
    'page_view', 'play_start', 'play_25', 'play_50', 'play_75', 'play_complete',
    'heart', 'unheart', 'rate', 'comment', 'follow', 'unfollow', 'share', 'search',
    'sign_in', 'sign_up', 'upload_submit', 'dedication', 'idea_submit', 'idea_heart'
  )),
  song_id    uuid null references public.songs(id) on delete set null,
  artist_id  uuid null references public.artists(id) on delete set null,
  meta       jsonb not null default '{}',
  page       text,
  city       text,
  region     text,
  country    text
);

create index if not exists activity_events_created_idx     on public.activity_events (created_at desc);
create index if not exists activity_events_user_created_idx  on public.activity_events (user_id, created_at);
create index if not exists activity_events_song_created_idx  on public.activity_events (song_id, created_at);
create index if not exists activity_events_type_created_idx  on public.activity_events (event_type, created_at);

alter table public.activity_events enable row level security;
alter table public.activity_events force row level security;
-- No policies at all: nothing is readable or writable by anon or
-- authenticated, by design. See the file header.

-- ------------------------------------------------------------
-- 2. activity_daily -- the nightly rollup. One row per (day, event_type,
-- song_id, country); song_id and country are nullable, so a plain primary
-- key cannot express that key (NULL <> NULL), hence the coalesce-safe unique
-- index below instead of a literal "primary key (...)".
-- ------------------------------------------------------------
create table if not exists public.activity_daily (
  day        date not null,
  event_type text not null,
  song_id    uuid null references public.songs(id) on delete set null,
  country    text null,
  members    int not null default 0,
  devices    int not null default 0,
  events     int not null default 0
);

create unique index if not exists activity_daily_key_uidx on public.activity_daily (
  day, event_type,
  coalesce(song_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(country, '')
);

alter table public.activity_daily enable row level security;
alter table public.activity_daily force row level security;
-- Same lockdown as activity_events: no policies for anon or authenticated.

-- ------------------------------------------------------------
-- 3. Admin-only reads reuse the EXISTING public.is_admin() check (006), the
-- same one every other admin-gated function in this project already calls.
-- The SECURITY DEFINER read functions themselves are ACT-2's job, not this
-- migration's -- nothing here grants anon/authenticated/public any access
-- to either table.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 4. The nightly rollup + 12-month purge, folded into the EXISTING
-- take-chart-snapshot cron job (found by command text, same pattern
-- 016_artist_page.sql already used for cleanup_stale_artist_picks -- no
-- second cron schedule is created).
--
-- rollup_activity_daily() rolls YESTERDAY's events (the job runs at 22:10
-- UTC, after that UTC day is long over) into activity_daily, overwriting any
-- existing row for the same key so a re-run is idempotent rather than
-- double-counting. members = distinct signed-in users; devices = distinct
-- device ids (signed-in and anonymous alike); events = raw row count.
-- ------------------------------------------------------------
create or replace function public.rollup_activity_daily()
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_day date := (now() - interval '1 day')::date;
begin
  insert into public.activity_daily (day, event_type, song_id, country, members, devices, events)
  select
    v_day,
    ae.event_type,
    ae.song_id,
    ae.country,
    count(distinct ae.user_id) filter (where ae.user_id is not null),
    count(distinct ae.device_id),
    count(*)
  from public.activity_events ae
  where ae.created_at >= v_day and ae.created_at < v_day + 1
  group by ae.event_type, ae.song_id, ae.country
  on conflict (day, event_type, coalesce(song_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(country, ''))
  do update set
    members = excluded.members,
    devices = excluded.devices,
    events  = excluded.events;
end;
$fn$;

-- Detailed, per-event rows older than 12 months are deleted; the daily
-- totals rolled up above are kept indefinitely (they carry no per-visitor
-- identity -- see privacy.html).
create or replace function public.purge_old_activity_events()
returns void language sql security definer set search_path = public as $fn$
  delete from public.activity_events where created_at < now() - interval '12 months';
$fn$;

-- Step 5: this project's default privileges grant EXECUTE on a new function
-- to anon and authenticated directly (confirmed against pg_default_acl, not
-- assumed) -- a plain "revoke ... from public" does NOT remove that, since
-- it is not a PUBLIC grant. Both are revoked explicitly here. Nothing is
-- granted back: only the cron job (running as postgres, which is not subject
-- to these grants) ever calls either function.
revoke all on function public.rollup_activity_daily()     from public, anon, authenticated;
revoke all on function public.purge_old_activity_events() from public, anon, authenticated;

do $$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid from cron.job
   where command ilike '%take_chart_snapshot%' order by jobid limit 1;
  if v_jobid is not null then
    perform cron.alter_job(v_jobid,
      command := 'select public.take_chart_snapshot(); select public.cleanup_stale_artist_picks(); '
              || 'select public.rollup_activity_daily(); select public.purge_old_activity_events();');
  end if;
end;
$$;
