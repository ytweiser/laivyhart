-- ============================================================
-- 012_badges.sql — the badges data layer
--
-- DATA ONLY. No UI reads any of this yet (BADGE-2/3).
--
-- NO RLS IS LOOSENED BY THIS FILE. It adds two VIEWS and one helper function,
-- extends a CHECK constraint, and rewrites one nightly function. Both views are
-- declared `security_invoker = true`, so they run with the CALLER's rights and
-- inherit the RLS already on the tables underneath — chart_snapshots,
-- site_settings and songs each already carry a public-read policy, so anon can
-- read the views without any new grant of underlying access. Nothing becomes
-- visible that was not visible before; the views only derive from it.
--
-- WHAT THE VIEWS DO NOT EXPOSE: no raw play_count, plays_7d or like_count
-- value reaches the output. Only positions (rank 1), counts of weeks/songs, and
-- booleans. The house rule that play counts are never shown survives.
--
-- IDEMPOTENT throughout.
-- ============================================================

-- ------------------------------------------------------------
-- 1a. 'loved' joins the nightly kinds.
--
-- NOT RETROACTIVE, and it cannot be: chart_snapshots has no loved history
-- because nothing ever wrote one. was_most_loved is therefore empty until the
-- first nightly run after this migration, and earns forward from there.
-- ------------------------------------------------------------
alter table public.chart_snapshots drop constraint if exists chart_snapshots_kind_check;
alter table public.chart_snapshots add constraint chart_snapshots_kind_check
  check (kind = any (array['plays'::text, 'words'::text, 'music'::text, 'loved'::text]));

create or replace function public.take_chart_snapshot()
returns void language plpgsql security definer set search_path to 'public' as $function$
declare
  d       date    := ((now() at time zone 'Asia/Jerusalem')::date - 1);
  weekend boolean := (extract(dow from ((now() at time zone 'Asia/Jerusalem')::date - 1)) = 6);
  m       numeric;
begin
  select coalesce((value #>> '{}')::numeric, 5) into m
    from public.site_settings where key = 'min_ratings';
  m := coalesce(m, 5);

  -- UNCHANGED from 004/009b: the plays top 10.
  if not exists (select 1 from public.chart_snapshots where chart_date = d and kind = 'plays') then
    insert into public.chart_snapshots
      (chart_date, rank, song_id, title, plays_7d, play_count, like_count, is_week_end, kind)
    select d,
           (row_number() over (order by s.plays_7d desc, s.play_count desc, s.like_count desc, s.title))::smallint,
           s.id, s.title, s.plays_7d, s.play_count, s.like_count, weekend, 'plays'
    from public.songs s
    where s.status = 'approved'
    order by s.plays_7d desc, s.play_count desc, s.like_count desc, s.title
    limit 10;
  end if;

  -- UNCHANGED from 009: the Bayesian words and music top 10s.
  if not exists (select 1 from public.chart_snapshots where chart_date = d and kind in ('words','music')) then
    insert into public.chart_snapshots
      (chart_date, rank, song_id, title, plays_7d, play_count, like_count, is_week_end, kind)
    with mature as (
      select r.song_id, r.facet, r.score
        from public.ratings r
        join auth.users u on u.id = r.artist_id
       where u.created_at <= now() - interval '7 days'
    ),
    agg as (
      select song_id, facet, count(*)::numeric as n, sum(score)::numeric as s
        from mature group by song_id, facet
    ),
    prior as (
      select facet, coalesce(sum(s) / nullif(sum(n), 0), 3.0) as c
        from agg group by facet
    ),
    scored as (
      select a.facet, a.song_id, (a.s + m * p.c) / (a.n + m) as bayes
        from agg a join prior p on p.facet = a.facet
    ),
    ranked as (
      select sc.facet, sc.song_id, sc.bayes,
             row_number() over (partition by sc.facet order by sc.bayes desc, so.title) as rn
        from scored sc join public.songs so on so.id = sc.song_id
       where so.status = 'approved'
    )
    select d, rk.rn::smallint, so.id, so.title, so.plays_7d, so.play_count, so.like_count, weekend, rk.facet
      from ranked rk join public.songs so on so.id = rk.song_id
     where rk.rn <= 10;
  end if;

  -- NEW: the loved top 10, by the heart. Same date label, same week-end flag,
  -- same per-day idempotence guard, same transaction as the three above.
  if not exists (select 1 from public.chart_snapshots where chart_date = d and kind = 'loved') then
    insert into public.chart_snapshots
      (chart_date, rank, song_id, title, plays_7d, play_count, like_count, is_week_end, kind)
    select d,
           (row_number() over (order by s.like_count desc, s.play_count desc, s.title))::smallint,
           s.id, s.title, s.plays_7d, s.play_count, s.like_count, weekend, 'loved'
    from public.songs s
    where s.status = 'approved'
    order by s.like_count desc, s.play_count desc, s.title
    limit 10;
  end if;
end;
$function$;

-- ------------------------------------------------------------
-- 1b. Thresholds. Tunable without a deploy; read at compute time by the view.
-- ------------------------------------------------------------
insert into public.site_settings (key, value) values
  ('badge_new_days',          to_jsonb(30)),
  ('badge_most_loved_top_n',  to_jsonb(3)),
  ('badge_most_talked_top_n', to_jsonb(3)),
  ('badge_talked_min_songs',  to_jsonb(3))
on conflict (key) do nothing;

create or replace function public.badge_setting(p_key text, p_default int)
returns int language sql stable set search_path to 'public' as $$
  select coalesce(
    (select nullif(value #>> '{}', '')::int from public.site_settings where key = p_key),
    p_default);
$$;

-- ------------------------------------------------------------
-- 1c. song_badges — the single source of truth.
--
-- A VIEW, not stored columns, precisely so it cannot drift from the history it
-- derives from. One row per (song_id, badge) currently earned.
--
-- "A week at #1" means a COMPLETED chart week, so every weeks_* and
-- hit_number_one predicate is `is_week_end = true` — the per-row Saturday flag
-- take_chart_snapshot() sets from extract(dow ...) = 6. That matches how the
-- homepage weekly ranking is defined. number_one_week is the live exception:
-- it reads the latest chart_date present, week-end or not.
--
-- song_id is nullable on chart_snapshots (ON DELETE SET NULL), so every history
-- branch guards it.
-- ------------------------------------------------------------
create or replace view public.song_badges with (security_invoker = true) as
with cfg as (
  select public.badge_setting('badge_new_days', 30)          as new_days,
         public.badge_setting('badge_most_loved_top_n', 3)   as loved_n,
         public.badge_setting('badge_most_talked_top_n', 3)  as talked_n,
         public.badge_setting('badge_talked_min_songs', 3)   as talked_min
),
ok as (
  select id, like_count, comment_count, created_at
    from public.songs where status = 'approved'
),
latest as (select max(chart_date) as d from public.chart_snapshots where kind = 'plays')
-- 1. LIVE: this week's #1 on the most recent chart date.
select cs.song_id, 'number_one_week'::text as badge, null::int as value, 1 as sort
  from public.chart_snapshots cs
  join latest l on cs.chart_date = l.d
 where cs.kind = 'plays' and cs.rank = 1 and cs.song_id is not null
   and exists (select 1 from ok where ok.id = cs.song_id)
union all
-- 2. EARNED: ever #1 on a completed week.
select distinct cs.song_id, 'hit_number_one', null::int, 2
  from public.chart_snapshots cs
 where cs.kind = 'plays' and cs.rank = 1 and cs.is_week_end and cs.song_id is not null
   and exists (select 1 from ok where ok.id = cs.song_id)
union all
-- 3. EARNED, graduated: how many completed weeks at #1.
select cs.song_id, 'weeks_at_number_one', count(distinct cs.chart_date)::int, 3
  from public.chart_snapshots cs
 where cs.kind = 'plays' and cs.rank = 1 and cs.is_week_end and cs.song_id is not null
   and exists (select 1 from ok where ok.id = cs.song_id)
 group by cs.song_id
having count(distinct cs.chart_date) >= 1
union all
-- 4/5. EARNED: ever topped the words or the music list, any day.
select distinct cs.song_id, 'best_words', null::int, 4
  from public.chart_snapshots cs
 where cs.kind = 'words' and cs.rank = 1 and cs.song_id is not null
   and exists (select 1 from ok where ok.id = cs.song_id)
union all
select distinct cs.song_id, 'best_music', null::int, 5
  from public.chart_snapshots cs
 where cs.kind = 'music' and cs.rank = 1 and cs.song_id is not null
   and exists (select 1 from ok where ok.id = cs.song_id)
union all
-- 6. EARNED, graduated: completed weeks spent anywhere on the plays chart.
select cs.song_id, 'weeks_on_chart', count(distinct cs.chart_date)::int, 6
  from public.chart_snapshots cs
 where cs.kind = 'plays' and cs.is_week_end and cs.song_id is not null
   and exists (select 1 from ok where ok.id = cs.song_id)
 group by cs.song_id
having count(distinct cs.chart_date) >= 1
union all
-- 7. EARNED: ever topped the loved list. Forward-only; empty until tonight.
select distinct cs.song_id, 'was_most_loved', null::int, 7
  from public.chart_snapshots cs
 where cs.kind = 'loved' and cs.rank = 1 and cs.song_id is not null
   and exists (select 1 from ok where ok.id = cs.song_id)
union all
-- 8. LIVE: top N by the heart right now.
--    like_count > 0 is deliberate. With a small catalog a plain "top 3" would
--    hand "Most loved" to a song nobody has hearted, which is the same kind of
--    lie the 5-rating threshold exists to prevent.
select x.id, 'most_loved', null::int, 8
  from (select ok.id,
               row_number() over (order by ok.like_count desc, ok.id) as rn
          from ok where ok.like_count > 0) x, cfg
 where x.rn <= cfg.loved_n
union all
-- 9. LIVE: top N by comments, but only once the catalog has enough
--    conversation for a ranking to mean anything.
select x.id, 'most_talked', null::int, 9
  from (select ok.id,
               row_number() over (order by ok.comment_count desc, ok.id) as rn
          from ok where ok.comment_count > 0) x, cfg
 where x.rn <= cfg.talked_n
   and (select count(*) from ok where ok.comment_count > 0) >= cfg.talked_min
union all
-- 10. LIVE: recently released.
select ok.id, 'new', null::int, 10
  from ok, cfg
 where ok.created_at >= now() - make_interval(days => cfg.new_days);

grant select on public.song_badges to anon, authenticated;

-- ------------------------------------------------------------
-- 1d. artist_badges — the trophy case aggregate BADGE-3 will read.
--
-- SHAPE: mirrors song_badges — (artist_id, badge, value, sort) — so a consumer
-- uses one shape for both. EARNED badges only; the live ones are properties of
-- a song at this moment, not achievements, and would be misleading summed.
--
-- The weeks_* rows count DISTINCT WEEKS, not song-weeks: an artist with two
-- songs on the chart in the same week spent ONE week on the chart, not two.
-- The per-song counts are still in song_badges for anyone who wants them.
-- ------------------------------------------------------------
create or replace view public.artist_badges with (security_invoker = true) as
with hist as (
  select s.artist_id, cs.chart_date, cs.kind, cs.rank, cs.is_week_end, cs.song_id
    from public.chart_snapshots cs
    join public.songs s on s.id = cs.song_id
   where s.status = 'approved' and s.artist_id is not null and cs.song_id is not null
)
select artist_id, 'hit_number_one'::text as badge, count(distinct song_id)::int as value, 2 as sort
  from hist where kind = 'plays' and rank = 1 and is_week_end
 group by artist_id
union all
select artist_id, 'weeks_at_number_one', count(distinct chart_date)::int, 3
  from hist where kind = 'plays' and rank = 1 and is_week_end
 group by artist_id
union all
select artist_id, 'best_words', count(distinct song_id)::int, 4
  from hist where kind = 'words' and rank = 1
 group by artist_id
union all
select artist_id, 'best_music', count(distinct song_id)::int, 5
  from hist where kind = 'music' and rank = 1
 group by artist_id
union all
select artist_id, 'weeks_on_chart', count(distinct chart_date)::int, 6
  from hist where kind = 'plays' and is_week_end
 group by artist_id
union all
select artist_id, 'was_most_loved', count(distinct song_id)::int, 7
  from hist where kind = 'loved' and rank = 1
 group by artist_id;

grant select on public.artist_badges to anon, authenticated;
