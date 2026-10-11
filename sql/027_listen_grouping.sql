-- ============================================================
-- 027_listen_grouping.sql
--
-- PULSE-2: one listen, one line. A single play produces up to five events
-- (play_start, play_25, play_50, play_75, play_complete); until now every
-- admin-facing read (pulse_feed, pulse_member) and the public ticker/Pulse
-- box showed each as its own row, so a finished song could show as five
-- lines and the public ticker could count a single listen's progress steps
-- as several "plays".
--
-- A "listen" (this migration's one new idea) is one play_start plus any
-- progress event on the SAME device, SAME song and SAME session that
-- follows it, up to (but not including) the next play_start on that
-- device -- regardless of what song that next play_start is for. Its
-- furthest progress is the highest of 25/50/75/complete reached inside
-- that window, or null if none was (less than 25%, "started").
--
-- No RLS change: activity_events stays exactly as locked down as ACT-1 left
-- it. No Worker change either -- the Worker still writes one row per raw
-- event exactly as before; every bit of this is a read-time grouping.
-- ============================================================

-- ------------------------------------------------------------
-- 0. Two narrow, partial indexes -- this migration's window functions walk
-- play_start rows per device, and progress-event lookups per
-- device+song+session, neither of which activity_events' existing indexes
-- (created_at, user_id, song_id, event_type -- see 020_activity_log.sql)
-- serve well. Partial (one event_type, or one small group of them) so each
-- stays small regardless of how large activity_events grows from the other
-- fifteen event types.
-- ------------------------------------------------------------
create index if not exists activity_events_device_playstart_idx
  on public.activity_events (device_id, created_at)
  where event_type = 'play_start';

create index if not exists activity_events_progress_idx
  on public.activity_events (device_id, song_id, session_id, created_at)
  where event_type in ('play_25', 'play_50', 'play_75', 'play_complete');

-- ------------------------------------------------------------
-- 1. public._pulse_listen_rows(): the shared "one row per listen"
-- grouping, called from inside pulse_feed and pulse_member below -- never
-- directly (revoked from every role, including authenticated; a plain
-- SECURITY DEFINER function, same as every other Pulse function, so it
-- still has to self-guard if it is ever reachable, but nothing grants
-- execute on it at all). Kept as one function rather than duplicating this
-- window-function logic in both callers.
--
-- p_user_id / p_device_id select which identity's listens to return (both
-- null, as pulse_feed calls it, means everyone's). Matches pulse_member's
-- own two-overload split: a signed-in identity is p_user_id, scoped to
-- every device they used; an anonymous visitor is p_device_id, scoped to
-- that one device AND only their truly-anonymous rows (user_id is null) --
-- the same restriction pulse_member(text) already applied before this.
--
-- lead() partitions by device_id alone and is computed over EVERY
-- play_start row first, filtering to the requested identity only after --
-- filtering first would let a window straddle a gap in the wrong identity's
-- play_starts and misattribute a boundary.
-- ------------------------------------------------------------
create or replace function public._pulse_listen_rows(p_user_id uuid default null, p_device_id text default null)
returns table (
  id bigint, created_at timestamptz, song_id uuid, user_id uuid, device_id text,
  city text, region text, country text, page text, furthest_pct int
)
language plpgsql security definer set search_path = public as $fn$
begin
  return query
    with starts as (
      select ae.id, ae.created_at, ae.song_id, ae.user_id, ae.device_id, ae.session_id,
             ae.city, ae.region, ae.country, ae.page,
             lead(ae.created_at) over (partition by ae.device_id order by ae.created_at) as next_start_at
        from public.activity_events ae
       where ae.event_type = 'play_start'
    )
    select
      s.id, s.created_at, s.song_id, s.user_id, s.device_id, s.city, s.region, s.country, s.page,
      (
        select max(case p.event_type
                     when 'play_complete' then 100
                     when 'play_75' then 75
                     when 'play_50' then 50
                     when 'play_25' then 25
                   end)
          from public.activity_events p
         where p.device_id = s.device_id
           and p.song_id = s.song_id
           and p.session_id is not distinct from s.session_id
           and p.event_type in ('play_25', 'play_50', 'play_75', 'play_complete')
           and p.created_at >= s.created_at
           and (s.next_start_at is null or p.created_at < s.next_start_at)
      ) as furthest_pct
    from starts s
    where (p_user_id is not null and s.user_id = p_user_id)
       or (p_user_id is null and p_device_id is not null and s.device_id = p_device_id and s.user_id is null)
       or (p_user_id is null and p_device_id is null);
end;
$fn$;

revoke all on function public._pulse_listen_rows(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. pulse_feed: one row per listen now, not per event. Return type grows
-- a column (furthest_pct), which create or replace cannot do in place --
-- Postgres requires the function to be dropped first.
-- ------------------------------------------------------------
drop function if exists public.pulse_feed(int, timestamptz);

create function public.pulse_feed(p_limit int default 50, p_before timestamptz default null)
returns table (
  id bigint, created_at timestamptz, event_type text,
  song_id uuid, song_title text, song_slug text,
  user_id uuid, display_name text, email text,
  device_id text, device_short text,
  city text, region text, country text, page text, meta jsonb,
  furthest_pct int
)
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can read the Pulse feed.';
  end if;

  return query
    select * from (
      select
        l.id, l.created_at, 'play_start'::text as event_type,
        l.song_id, coalesce(nullif(s.title_translit, ''), s.title), s.slug,
        l.user_id, coalesce(a.display_name, 'Visitor'), u.email::text,
        l.device_id, left(l.device_id, 8),
        l.city, l.region, l.country, l.page, '{}'::jsonb,
        l.furthest_pct
      from public._pulse_listen_rows() l
      left join public.songs s   on s.id = l.song_id
      left join public.artists a on a.id = l.user_id
      left join auth.users u     on u.id = l.user_id
      union all
      select
        ae.id, ae.created_at, ae.event_type,
        ae.song_id, coalesce(nullif(s.title_translit, ''), s.title), s.slug,
        ae.user_id, coalesce(a.display_name, 'Visitor'), u.email::text,
        ae.device_id, left(ae.device_id, 8),
        ae.city, ae.region, ae.country, ae.page, ae.meta,
        null::int
      from public.activity_events ae
      left join public.songs s   on s.id = ae.song_id
      left join public.artists a on a.id = ae.user_id
      left join auth.users u     on u.id = ae.user_id
      where ae.event_type not in ('play_start', 'play_25', 'play_50', 'play_75', 'play_complete')
    ) feed
    where p_before is null or feed.created_at < p_before
    order by feed.created_at desc
    limit greatest(1, least(p_limit, 200));
end;
$fn$;

revoke all on function public.pulse_feed(int, timestamptz) from public, anon;
grant execute on function public.pulse_feed(int, timestamptz) to authenticated;

-- ------------------------------------------------------------
-- 3. pulse_member: same grouping in the events list (totals are untouched
-- below -- 'plays'/'completes' already counted only play_start/
-- play_complete, so they are numerically identical whether or not the
-- progress events in between are grouped; only the per-event list changes
-- shape). Two overloads, same as 021_pulse.sql.
-- ------------------------------------------------------------
create or replace function public.pulse_member(p_user_id uuid, p_limit int default 200)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_out jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can read a member''s Pulse history.';
  end if;

  select jsonb_build_object(
    'user_id', p_user_id,
    'display_name', (select display_name from public.artists where id = p_user_id),
    'email', (select email from auth.users where id = p_user_id),
    'totals', jsonb_build_object(
      'plays',     (select count(*) from public.activity_events where user_id = p_user_id and event_type = 'play_start'),
      'completes', (select count(*) from public.activity_events where user_id = p_user_id and event_type = 'play_complete'),
      'hearts',    (select count(*) from public.activity_events where user_id = p_user_id and event_type = 'heart'),
      'ratings',   (select count(*) from public.activity_events where user_id = p_user_id and event_type = 'rate'),
      'comments',  (select count(*) from public.activity_events where user_id = p_user_id and event_type = 'comment'),
      'follows',   (select count(*) from public.activity_events where user_id = p_user_id and event_type = 'follow')
    ),
    'events', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) from (
        (
          select l.id, l.created_at, 'play_start'::text as event_type, l.song_id,
                 coalesce(nullif(s.title_translit,''), s.title) as song_title, s.slug as song_slug,
                 l.city, l.region, l.country, l.page, '{}'::jsonb as meta, l.furthest_pct
            from public._pulse_listen_rows(p_user_id, null) l
            left join public.songs s on s.id = l.song_id
        )
        union all
        (
          select ae.id, ae.created_at, ae.event_type, ae.song_id,
                 coalesce(nullif(s.title_translit,''), s.title) as song_title, s.slug as song_slug,
                 ae.city, ae.region, ae.country, ae.page, ae.meta, null::int as furthest_pct
            from public.activity_events ae
            left join public.songs s on s.id = ae.song_id
           where ae.user_id = p_user_id
             and ae.event_type not in ('play_start', 'play_25', 'play_50', 'play_75', 'play_complete')
        )
        order by created_at desc
        limit greatest(1, least(p_limit, 1000))
      ) x
    )
  ) into v_out;

  return v_out;
end;
$fn$;

create or replace function public.pulse_member(p_device_id text, p_limit int default 200)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_out jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can read a visitor''s Pulse history.';
  end if;

  select jsonb_build_object(
    'device_id', p_device_id,
    'display_name', 'Visitor',
    'totals', jsonb_build_object(
      'plays',     (select count(*) from public.activity_events where device_id = p_device_id and user_id is null and event_type = 'play_start'),
      'completes', (select count(*) from public.activity_events where device_id = p_device_id and user_id is null and event_type = 'play_complete'),
      'hearts',    (select count(*) from public.activity_events where device_id = p_device_id and user_id is null and event_type = 'heart')
    ),
    'events', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) from (
        (
          select l.id, l.created_at, 'play_start'::text as event_type, l.song_id,
                 coalesce(nullif(s.title_translit,''), s.title) as song_title, s.slug as song_slug,
                 l.city, l.region, l.country, l.page, '{}'::jsonb as meta, l.furthest_pct
            from public._pulse_listen_rows(null, p_device_id) l
            left join public.songs s on s.id = l.song_id
        )
        union all
        (
          select ae.id, ae.created_at, ae.event_type, ae.song_id,
                 coalesce(nullif(s.title_translit,''), s.title) as song_title, s.slug as song_slug,
                 ae.city, ae.region, ae.country, ae.page, ae.meta, null::int as furthest_pct
            from public.activity_events ae
            left join public.songs s on s.id = ae.song_id
           where ae.device_id = p_device_id and ae.user_id is null
             and ae.event_type not in ('play_start', 'play_25', 'play_50', 'play_75', 'play_complete')
        )
        order by created_at desc
        limit greatest(1, least(p_limit, 1000))
      ) x
    )
  ) into v_out;

  return v_out;
end;
$fn$;

revoke all on function public.pulse_member(uuid, int) from public, anon;
grant execute on function public.pulse_member(uuid, int) to authenticated;
revoke all on function public.pulse_member(text, int) from public, anon;
grant execute on function public.pulse_member(text, int) to authenticated;

-- ------------------------------------------------------------
-- 4. public_pulse: plays were already play_start-only; the only change is
-- collapsing repeats of the same device+song within 30 minutes to the
-- latest one (a running/cascading window, not a fixed 30-minute bucket --
-- a chain of replays each under 30 minutes apart stays one entry for as
-- long as the chain holds, which is what "within 30 minutes" means for a
-- live feed). Hearts are unchanged (already latest-per-device+song,
-- unbounded by time, which this prompt does not ask to change).
-- ------------------------------------------------------------
create or replace function public.public_pulse(p_limit integer default 8)
returns table(event_type text, song_title text, song_slug text, cover_url text, city text, country text, minutes_ago integer)
language plpgsql security definer set search_path to 'public' as $function$
begin
  return query
    with play_gaps as (
      select ae.device_id, ae.song_id, ae.display_city, ae.display_country, ae.created_at,
        ae.created_at - lag(ae.created_at) over (partition by ae.device_id, ae.song_id order by ae.created_at) as gap
      from public.activity_events ae
      where ae.event_type = 'play_start' and ae.song_id is not null
        and ae.created_at >= now() - interval '24 hours'
    ),
    play_clusters as (
      select *,
        sum(case when gap is null or gap > interval '30 minutes' then 1 else 0 end)
          over (partition by device_id, song_id order by created_at) as cluster_id
      from play_gaps
    ),
    plays as (
      select distinct on (device_id, song_id, cluster_id)
        device_id, song_id, 'play_start'::text as event_type, display_city, display_country, created_at
      from play_clusters
      order by device_id, song_id, cluster_id, created_at desc
    ),
    hearts as (
      select distinct on (ae.device_id, ae.song_id)
        ae.device_id, ae.song_id, ae.event_type, ae.display_city, ae.display_country, ae.created_at
      from public.activity_events ae
      where ae.event_type = 'heart' and ae.song_id is not null
        and ae.created_at >= now() - interval '24 hours'
      order by ae.device_id, ae.song_id, ae.created_at desc
    ),
    d as (
      select * from plays
      union all
      select * from hearts
    )
    select
      d.event_type,
      coalesce(nullif(s.title_translit, ''), s.title) as song_title,
      s.slug, s.cover_url,
      d.display_city, d.display_country,
      greatest(0, floor(extract(epoch from (now() - d.created_at)) / 60))::int as minutes_ago
    from d
    join public.songs s on s.id = d.song_id and s.status = 'approved'
    order by d.created_at desc
    limit greatest(1, least(p_limit, 25));
end;
$function$;

revoke all on function public.public_pulse(int) from public, anon;
grant execute on function public.public_pulse(int) to anon, authenticated;

-- ------------------------------------------------------------
-- 5. public_ticker: the 'play' branch was already play_start-only; same
-- 30-minute collapse as public_pulse above, over the 7-day window this
-- function already uses. heart/dedication/new_song branches unchanged.
-- ------------------------------------------------------------
create or replace function public.public_ticker(p_limit int default 20)
returns table (
  kind text, song_title text, song_slug text,
  display_city text, display_country text, created_at timestamptz
)
language plpgsql security definer set search_path = public as $fn$
declare
  v_since timestamptz := now() - interval '7 days';
begin
  -- Every internal column here is named ev_at, never created_at -- the
  -- OUT parameter created_at above makes a bare "created_at" inside this
  -- body ambiguous (it could mean the OUT parameter or a column; Postgres
  -- 42702, confirmed the hard way against the live project).  table-
  -- qualifying "created_at" was not enough on its own; the CTEs themselves
  -- need a column that is not spelled the same as the OUT parameter.
  return query
    with play_gaps as (
      select ae.device_id, ae.song_id, ae.display_city, ae.display_country, ae.created_at as ev_at,
        ae.created_at - lag(ae.created_at) over (partition by ae.device_id, ae.song_id order by ae.created_at) as gap
      from public.activity_events ae
      where ae.event_type = 'play_start' and ae.created_at >= v_since
    ),
    play_clusters as (
      select pg.device_id, pg.song_id, pg.display_city, pg.display_country, pg.ev_at,
        sum(case when pg.gap is null or pg.gap > interval '30 minutes' then 1 else 0 end)
          over (partition by pg.device_id, pg.song_id order by pg.ev_at) as cluster_id
      from play_gaps pg
    ),
    plays as (
      select distinct on (pc.device_id, pc.song_id, pc.cluster_id)
        pc.song_id, pc.display_city, pc.display_country, pc.ev_at
      from play_clusters pc
      order by pc.device_id, pc.song_id, pc.cluster_id, pc.ev_at desc
    )
    select * from (
      select 'play'::text as kind, coalesce(nullif(s.title_translit, ''), s.title) as song_title, s.slug as song_slug,
             p.display_city, p.display_country, p.ev_at as ev_at
        from plays p
        join public.songs s on s.id = p.song_id and s.status = 'approved'
      union all
      select 'heart', coalesce(nullif(s.title_translit, ''), s.title), s.slug,
             ae.display_city, ae.display_country, ae.created_at
        from public.activity_events ae
        join public.songs s on s.id = ae.song_id and s.status = 'approved'
       where ae.event_type = 'heart' and ae.created_at >= v_since
      union all
      select 'dedication', coalesce(nullif(s.title_translit, ''), s.title), s.slug,
             null::text, null::text, d.created_at
        from public.dedications d
        join public.songs s on s.id = d.song_id and s.status = 'approved'
       where d.status = 'live' and d.created_at >= v_since
      union all
      select 'new_song', coalesce(nullif(s.title_translit, ''), s.title), s.slug,
             null::text, null::text, coalesce(s.reviewed_at, s.created_at)
        from public.songs s
       where s.status = 'approved' and coalesce(s.reviewed_at, s.created_at) >= v_since
    ) x(kind, song_title, song_slug, display_city, display_country, ev_at)
    order by x.ev_at desc
    limit greatest(1, least(p_limit, 50));
end;
$fn$;

revoke all on function public.public_ticker(int) from public;
grant execute on function public.public_ticker(int) to anon, authenticated;

-- ------------------------------------------------------------
-- 6. Checked, not changed: pulse_summary, pulse_song, pulse_top_listeners
-- (021_pulse.sql) and build_daily_report()'s "yesterday" section
-- (015/021) all already count a play as exactly one play_start and a
-- completion as exactly one play_complete -- play_25/50/75 were never
-- counted as plays anywhere in these four. Confirmed by reading each; no
-- SQL change needed.
-- ------------------------------------------------------------
