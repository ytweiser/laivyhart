-- ============================================================
-- 021_pulse.sql
--
-- ACT-2: Pulse, the admin-only read layer over activity_events/activity_daily
-- (ACT-1), plus one carefully narrow public function for the homepage box.
--
-- Every admin function here is SECURITY DEFINER, raises unless
-- public.is_admin() is true (the same helper every other admin-gated
-- function in this project already calls), and is revoked from public and
-- anon explicitly before granting execute to authenticated only -- this
-- project's default privileges grant a new function's execute to anon
-- directly (confirmed in ACT-1), so the explicit revoke matters even though
-- these functions self-guard with is_admin() too; defense in depth, not a
-- single point of failure.
--
-- RLS on activity_events/activity_daily stays forced with zero policies
-- (ACT-1): every read here goes through these definer functions, never a
-- direct table grant.
-- ============================================================

-- ------------------------------------------------------------
-- 1. pulse_feed: the newest events, one row per event, for the live feed.
-- ------------------------------------------------------------
create or replace function public.pulse_feed(p_limit int default 50, p_before timestamptz default null)
returns table (
  id bigint, created_at timestamptz, event_type text,
  song_id uuid, song_title text, song_slug text,
  user_id uuid, display_name text, email text,
  device_id text, device_short text,
  city text, region text, country text, page text, meta jsonb
)
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can read the Pulse feed.';
  end if;

  return query
    select
      ae.id, ae.created_at, ae.event_type,
      ae.song_id, coalesce(nullif(s.title_translit, ''), s.title), s.slug,
      ae.user_id,
      coalesce(a.display_name, 'Visitor'),
      u.email::text,
      ae.device_id, left(ae.device_id, 8),
      ae.city, ae.region, ae.country, ae.page, ae.meta
    from public.activity_events ae
    left join public.songs s   on s.id = ae.song_id
    left join public.artists a on a.id = ae.user_id
    left join auth.users u     on u.id = ae.user_id
    where p_before is null or ae.created_at < p_before
    order by ae.created_at desc
    limit greatest(1, least(p_limit, 200));
end;
$fn$;

revoke all on function public.pulse_feed(int, timestamptz) from public, anon;
grant execute on function public.pulse_feed(int, timestamptz) to authenticated;

-- ------------------------------------------------------------
-- 2. pulse_summary: the range's tiles plus top songs/cities.
-- ------------------------------------------------------------
create or replace function public.pulse_summary(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_out jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can read the Pulse summary.';
  end if;

  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'listeners', (
      select count(distinct device_id) from public.activity_events
       where event_type = 'play_start' and created_at >= p_from and created_at < p_to
    ),
    'members_active', (
      select count(distinct user_id) from public.activity_events
       where user_id is not null and created_at >= p_from and created_at < p_to
    ),
    'new_members', (
      select count(*) from auth.users where created_at >= p_from and created_at < p_to
    ),
    'plays',     (select count(*) from public.activity_events where event_type = 'play_start'    and created_at >= p_from and created_at < p_to),
    'completes', (select count(*) from public.activity_events where event_type = 'play_complete' and created_at >= p_from and created_at < p_to),
    'completion_rate', (
      select case when count(*) filter (where event_type = 'play_start') = 0 then 0
             else round(100.0 * count(*) filter (where event_type = 'play_complete')
                             / count(*) filter (where event_type = 'play_start'), 1)
             end
        from public.activity_events where event_type in ('play_start','play_complete')
         and created_at >= p_from and created_at < p_to
    ),
    'hearts',   (select count(*) from public.activity_events where event_type = 'heart'   and created_at >= p_from and created_at < p_to),
    'ratings',  (select count(*) from public.activity_events where event_type = 'rate'    and created_at >= p_from and created_at < p_to),
    'comments', (select count(*) from public.activity_events where event_type = 'comment' and created_at >= p_from and created_at < p_to),
    'follows',  (select count(*) from public.activity_events where event_type = 'follow'  and created_at >= p_from and created_at < p_to),
    'shares',   (select count(*) from public.activity_events where event_type = 'share'   and created_at >= p_from and created_at < p_to),
    'searches', (select count(*) from public.activity_events where event_type = 'search'  and created_at >= p_from and created_at < p_to),
    'top_songs', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.plays desc), '[]'::jsonb) from (
        select s.id as song_id, coalesce(nullif(s.title_translit,''), s.title) as title, s.slug,
          count(*) filter (where ae.event_type = 'play_start')    as plays,
          count(*) filter (where ae.event_type = 'play_complete') as completes,
          case when count(*) filter (where ae.event_type = 'play_start') = 0 then 0
               else round(100.0 * count(*) filter (where ae.event_type = 'play_complete')
                               / count(*) filter (where ae.event_type = 'play_start'), 1)
               end as completion_rate
        from public.activity_events ae
        join public.songs s on s.id = ae.song_id
        where ae.event_type in ('play_start', 'play_complete')
          and ae.created_at >= p_from and ae.created_at < p_to
        group by s.id, s.title, s.title_translit, s.slug
        order by plays desc
        limit 10
      ) x
    ),
    'top_cities', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.n desc), '[]'::jsonb) from (
        select city, count(*) as n
          from public.activity_events
         where city is not null and created_at >= p_from and created_at < p_to
         group by city
         order by n desc
         limit 10
      ) x
    )
  ) into v_out;

  return v_out;
end;
$fn$;

revoke all on function public.pulse_summary(timestamptz, timestamptz) from public, anon;
grant execute on function public.pulse_summary(timestamptz, timestamptz) to authenticated;

-- ------------------------------------------------------------
-- 3. pulse_top_listeners: members (by user_id, across their devices) and
-- anonymous visitors (by device_id) ranked together by plays.
-- ------------------------------------------------------------
create or replace function public.pulse_top_listeners(p_from timestamptz, p_to timestamptz, p_limit int default 20)
returns table (
  kind text, user_id uuid, device_id text, display_name text,
  plays bigint, completes bigint, hearts bigint,
  last_city text, last_seen timestamptz
)
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can read Pulse top listeners.';
  end if;

  return query
    with agg as (
      select
        case when ae.user_id is not null then 'member' else 'visitor' end as kind,
        ae.user_id, ae.device_id,
        count(*) filter (where ae.event_type = 'play_start')    as plays,
        count(*) filter (where ae.event_type = 'play_complete') as completes,
        count(*) filter (where ae.event_type = 'heart')          as hearts,
        max(ae.created_at) as last_seen
      from public.activity_events ae
      where ae.created_at >= p_from and ae.created_at < p_to
      group by case when ae.user_id is not null then 'member' else 'visitor' end, ae.user_id, ae.device_id
    ),
    -- One row per identity's most recent city -- a member's across every
    -- device they used, a visitor's for their one device.
    last_city as (
      select distinct on (coalesce(ae.user_id::text, ae.device_id))
        coalesce(ae.user_id::text, ae.device_id) as identity, ae.city
      from public.activity_events ae
      where ae.created_at >= p_from and ae.created_at < p_to
      order by coalesce(ae.user_id::text, ae.device_id), ae.created_at desc
    )
    select
      agg.kind, agg.user_id, agg.device_id,
      coalesce(a.display_name, 'Visitor'),
      agg.plays, agg.completes, agg.hearts,
      lc.city, agg.last_seen
    from agg
    left join public.artists a on a.id = agg.user_id
    left join last_city lc on lc.identity = coalesce(agg.user_id::text, agg.device_id)
    order by agg.plays desc, agg.last_seen desc
    limit greatest(1, least(p_limit, 100));
end;
$fn$;

revoke all on function public.pulse_top_listeners(timestamptz, timestamptz, int) from public, anon;
grant execute on function public.pulse_top_listeners(timestamptz, timestamptz, int) to authenticated;

-- ------------------------------------------------------------
-- 4. pulse_song: one song's drilldown.
-- ------------------------------------------------------------
create or replace function public.pulse_song(p_song_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_out jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can read a song''s Pulse drilldown.';
  end if;

  select jsonb_build_object(
    'song_id', p_song_id,
    'funnel', jsonb_build_object(
      'start',    (select count(*) from public.activity_events where song_id = p_song_id and event_type = 'play_start'    and created_at >= p_from and created_at < p_to),
      'p25',      (select count(*) from public.activity_events where song_id = p_song_id and event_type = 'play_25'       and created_at >= p_from and created_at < p_to),
      'p50',      (select count(*) from public.activity_events where song_id = p_song_id and event_type = 'play_50'       and created_at >= p_from and created_at < p_to),
      'p75',      (select count(*) from public.activity_events where song_id = p_song_id and event_type = 'play_75'       and created_at >= p_from and created_at < p_to),
      'complete', (select count(*) from public.activity_events where song_id = p_song_id and event_type = 'play_complete' and created_at >= p_from and created_at < p_to)
    ),
    'hearts',  (select count(*) from public.activity_events where song_id = p_song_id and event_type = 'heart'  and created_at >= p_from and created_at < p_to),
    'ratings', (select count(*) from public.activity_events where song_id = p_song_id and event_type = 'rate'   and created_at >= p_from and created_at < p_to),
    'cities', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.n desc), '[]'::jsonb) from (
        select city, count(*) as n
          from public.activity_events
         where song_id = p_song_id and city is not null and created_at >= p_from and created_at < p_to
         group by city
         order by n desc
         limit 10
      ) x
    ),
    'listeners', jsonb_build_object(
      'members', (
        select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
          select distinct a.id as user_id, a.display_name
            from public.activity_events ae
            join public.artists a on a.id = ae.user_id
           where ae.song_id = p_song_id and ae.user_id is not null
             and ae.created_at >= p_from and ae.created_at < p_to
        ) x
      ),
      'visitor_count', (
        select count(distinct device_id) from public.activity_events
         where song_id = p_song_id and user_id is null
           and created_at >= p_from and created_at < p_to
      )
    )
  ) into v_out;

  return v_out;
end;
$fn$;

revoke all on function public.pulse_song(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.pulse_song(uuid, timestamptz, timestamptz) to authenticated;

-- ------------------------------------------------------------
-- 5. pulse_member: one identity's full history. Two overloads, dispatched by
-- argument type, so the admin UI can drill into a member (uuid) or an
-- anonymous visitor's device (text) through the one name the Pulse tab
-- calls either way.
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
        select ae.id, ae.created_at, ae.event_type, ae.song_id,
               coalesce(nullif(s.title_translit,''), s.title) as song_title, s.slug as song_slug,
               ae.city, ae.region, ae.country, ae.page, ae.meta
          from public.activity_events ae
          left join public.songs s on s.id = ae.song_id
         where ae.user_id = p_user_id
         order by ae.created_at desc
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
        select ae.id, ae.created_at, ae.event_type, ae.song_id,
               coalesce(nullif(s.title_translit,''), s.title) as song_title, s.slug as song_slug,
               ae.city, ae.region, ae.country, ae.page, ae.meta
          from public.activity_events ae
          left join public.songs s on s.id = ae.song_id
         where ae.device_id = p_device_id and ae.user_id is null
         order by ae.created_at desc
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
-- 6. pulse_retention: weekly cohorts of new devices/members and whether they
-- came back the following week.
-- ------------------------------------------------------------
create or replace function public.pulse_retention(p_weeks int default 8)
returns table (
  week_start date,
  new_devices int, devices_retained_next_week int, device_retention_pct numeric,
  new_members int, members_retained_next_week int, member_retention_pct numeric
)
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can read Pulse retention.';
  end if;

  return query
    with weeks as (
      select (date_trunc('week', now())::date - (7 * g)) as week_start
        from generate_series(1, greatest(1, least(p_weeks, 52))) as g
    ),
    first_seen as (
      select device_id, min(created_at) as first_at
        from public.activity_events
       group by device_id
    ),
    device_weeks as (
      select w.week_start, fs.device_id
        from weeks w
        join first_seen fs on date_trunc('week', fs.first_at)::date = w.week_start
    ),
    device_next as (
      select dw.week_start,
        count(distinct dw.device_id) as new_devices,
        count(distinct dw.device_id) filter (where exists (
          select 1 from public.activity_events ae2
           where ae2.device_id = dw.device_id
             and ae2.created_at >= dw.week_start + 7
             and ae2.created_at <  dw.week_start + 14
        )) as retained
      from device_weeks dw
      group by dw.week_start
    ),
    member_weeks as (
      select date_trunc('week', u.created_at)::date as week_start, u.id as user_id
        from auth.users u
    ),
    member_next as (
      select w.week_start,
        count(distinct mw.user_id) as new_members,
        count(distinct mw.user_id) filter (where exists (
          select 1 from public.activity_events ae3
           where ae3.user_id = mw.user_id
             and ae3.created_at >= w.week_start + 7
             and ae3.created_at <  w.week_start + 14
        )) as retained
      from weeks w
      left join member_weeks mw on mw.week_start = w.week_start
      group by w.week_start
    )
    select
      w.week_start,
      coalesce(dn.new_devices, 0)::int, coalesce(dn.retained, 0)::int,
      case when coalesce(dn.new_devices, 0) = 0 then 0 else round(100.0 * dn.retained / dn.new_devices, 1) end,
      coalesce(mn.new_members, 0)::int, coalesce(mn.retained, 0)::int,
      case when coalesce(mn.new_members, 0) = 0 then 0 else round(100.0 * mn.retained / mn.new_members, 1) end
    from weeks w
    left join device_next dn on dn.week_start = w.week_start
    left join member_next mn on mn.week_start = w.week_start
    order by w.week_start desc;
end;
$fn$;

revoke all on function public.pulse_retention(int) from public, anon;
grant execute on function public.pulse_retention(int) to authenticated;

-- ------------------------------------------------------------
-- 7. public_pulse: the ONLY function here anon may call, and deliberately
-- narrow. No user_id, device_id, name or meta is ever in its return type --
-- there is no column to leak one through, not just a value left out. Last
-- 24 hours only, play_start/heart only, and repeats from the same device on
-- the same song collapse to their most recent occurrence.
-- ------------------------------------------------------------
create or replace function public.public_pulse(p_limit int default 8)
returns table (
  event_type text, song_title text, song_slug text, cover_url text,
  city text, country text, minutes_ago int
)
language plpgsql security definer set search_path = public as $fn$
begin
  return query
    select
      d.event_type,
      coalesce(nullif(s.title_translit, ''), s.title) as song_title,
      s.slug, s.cover_url,
      d.city, d.country,
      greatest(0, floor(extract(epoch from (now() - d.created_at)) / 60))::int as minutes_ago
    from (
      select distinct on (ae.device_id, ae.song_id)
        ae.device_id, ae.song_id, ae.event_type, ae.city, ae.country, ae.created_at
        from public.activity_events ae
       where ae.event_type in ('play_start', 'heart')
         and ae.song_id is not null
         and ae.created_at >= now() - interval '24 hours'
       order by ae.device_id, ae.song_id, ae.created_at desc
    ) d
    join public.songs s on s.id = d.song_id and s.status = 'approved'
    order by d.created_at desc
    limit greatest(1, least(p_limit, 25));
end;
$fn$;

revoke all on function public.public_pulse(int) from public, anon;
grant execute on function public.public_pulse(int) to anon, authenticated;

-- ------------------------------------------------------------
-- 8. The public box's off switch. Seeded false; the owner flips it when
-- ready, same pattern as contribute_cta_enabled (015_daily_report.sql).
-- ------------------------------------------------------------
insert into public.site_settings (key, value) values
  ('pulse_public_enabled', to_jsonb(false))
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- 9. build_daily_report(), extended with a "Yesterday on Laivy Hart"
-- section. Every existing key and the admin-or-service-role guard are kept
-- exactly as 015_daily_report.sql wrote them; this is additive.
--
-- "Yesterday" here is the previous full UTC calendar day, computed directly
-- from activity_events at report time rather than read from activity_daily:
-- the nightly rollup runs at 22:10 UTC and rolls up ITS OWN "yesterday", so
-- by the time this report runs at 03:00 UTC the freshest day activity_daily
-- holds is two days back, not one. Querying activity_events directly keeps
-- this section accurate regardless of that lag. (activity_daily still exists
-- for Pulse's own longer-range reads, which do not have this same-day need.)
--
-- Unlike the rest of this report, raw numbers (plays, completion rate) ARE
-- shown here, by this prompt's explicit request -- a deliberate difference
-- from the "positions and counts only" note on the chart section above,
-- which this does not change.
-- ------------------------------------------------------------
create or replace function public.build_daily_report()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_role    text := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  v_since   timestamptz := now() - interval '24 hours';
  v_y_from  timestamptz := date_trunc('day', now()) - interval '1 day';
  v_y_to    timestamptz := date_trunc('day', now());
  v_cap     int;
  v_out     jsonb;
begin
  if not (public.is_admin() or v_role = 'service_role') then
    raise exception 'Only an admin or the report job can build the daily report.';
  end if;

  select coalesce((select (value #>> '{}')::int from public.site_settings where key='submit_max_per_day'), 5)
    into v_cap;

  select jsonb_build_object(
    'generated_at', now(),
    'window_hours', 24,

    'signups', (
      select jsonb_build_object(
        'count', count(*),
        'list', coalesce(jsonb_agg(jsonb_build_object(
                   'handle', a.handle, 'name', a.display_name, 'created_at', u.created_at)
                 order by u.created_at desc), '[]'::jsonb))
        from auth.users u
        left join public.artists a on a.id = u.id
       where u.created_at >= v_since
    ),

    'review_queue', (
      select jsonb_build_object(
        'count', count(*),
        'list', coalesce(jsonb_agg(jsonb_build_object(
                   'title', coalesce(nullif(s.title_translit,''), s.title),
                   'artist', a.handle, 'submitted_at', s.submitted_at)
                 order by s.submitted_at asc), '[]'::jsonb))
        from public.songs s
        left join public.artists a on a.id = s.artist_id
       where s.status = 'submitted'
    ),

    'pending_comments', (
      select count(*) from public.comments where status = 'pending'
    ),

    'proposed_tags_new', (
      select coalesce(jsonb_agg(distinct t), '[]'::jsonb)
        from public.songs s, unnest(s.proposed_tags) as t
       where s.status = 'submitted'
         and t <> ''
         and not exists (
           select 1 from public.songs v, unnest(v.tags) as vt
            where v.status = 'approved' and lower(vt) = lower(t))
    ),

    'anomalies', jsonb_build_object(
      'submissions_cap', v_cap,
      'submitters_at_or_over_cap', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'handle', a.handle, 'submissions_24h', x.n, 'over_cap', x.n > v_cap)
               order by x.n desc), '[]'::jsonb)
          from (select artist_id, count(*) as n
                  from public.submission_events
                 where created_at >= v_since
                 group by artist_id
                having count(*) >= v_cap) x
          join public.artists a on a.id = x.artist_id
      ),
      'ratings_from_young_accounts', (
        select jsonb_build_object(
          'count', count(*),
          'songs', coalesce(jsonb_agg(distinct coalesce(nullif(s.title_translit,''), s.title)), '[]'::jsonb))
          from public.ratings r
          join auth.users u on u.id = r.artist_id
          join public.songs s on s.id = r.song_id
         where r.created_at >= v_since
           and u.created_at > now() - interval '7 days'
      )
    ),

    'chart', (
      select jsonb_build_object(
        'chart_date', max(c.chart_date),
        'top10', coalesce((
          select jsonb_agg(jsonb_build_object('rank', c2.rank, 'title', c2.title) order by c2.rank)
            from public.chart_snapshots c2
           where c2.kind = 'plays'
             and c2.chart_date = (select max(chart_date) from public.chart_snapshots where kind='plays')
        ), '[]'::jsonb))
        from public.chart_snapshots c where c.kind = 'plays'
    ),

    -- ACT-2: "Yesterday on Laivy Hart" -- the previous full UTC day.
    'yesterday', jsonb_build_object(
      'date', v_y_from::date,
      'listeners', (
        select count(distinct device_id) from public.activity_events
         where event_type = 'play_start' and created_at >= v_y_from and created_at < v_y_to
      ),
      'members_active', (
        select count(distinct user_id) from public.activity_events
         where user_id is not null and created_at >= v_y_from and created_at < v_y_to
      ),
      'new_members', (
        select count(*) from auth.users where created_at >= v_y_from and created_at < v_y_to
      ),
      'plays', (
        select count(*) from public.activity_events
         where event_type = 'play_start' and created_at >= v_y_from and created_at < v_y_to
      ),
      'completion_rate', (
        select case when count(*) filter (where event_type = 'play_start') = 0 then 0
               else round(100.0 * count(*) filter (where event_type = 'play_complete')
                               / count(*) filter (where event_type = 'play_start'), 1)
               end
          from public.activity_events
         where event_type in ('play_start', 'play_complete')
           and created_at >= v_y_from and created_at < v_y_to
      ),
      'top_songs', (
        select coalesce(jsonb_agg(to_jsonb(x) order by x.plays desc), '[]'::jsonb) from (
          select coalesce(nullif(s.title_translit,''), s.title) as title,
            count(*) filter (where ae.event_type = 'play_start') as plays
          from public.activity_events ae
          join public.songs s on s.id = ae.song_id
          where ae.event_type = 'play_start' and ae.created_at >= v_y_from and ae.created_at < v_y_to
          group by s.id, s.title, s.title_translit
          order by plays desc
          limit 3
        ) x
      ),
      'top_cities', (
        select coalesce(jsonb_agg(to_jsonb(x) order by x.n desc), '[]'::jsonb) from (
          select city, count(*) as n
            from public.activity_events
           where city is not null and created_at >= v_y_from and created_at < v_y_to
           group by city
           order by n desc
           limit 3
        ) x
      )
    )
  ) into v_out;

  return v_out;
end;
$fn$;

revoke all on function public.build_daily_report() from public, anon;
grant execute on function public.build_daily_report() to authenticated, service_role;
