-- ============================================================
-- 017_artist_page_tuning.sql — artist page data tuning (ARTIST-2 Part A)
--
-- Three changes, each CREATE OR REPLACE / UPSERT on objects sql/016 already
-- created. No new tables, no RLS touched.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Milestone thresholds, re-tuned so the catalog has something to show
--    today (the sql/016 defaults were set for a catalog much bigger than
--    this one's current play/heart/comment counts).
-- ------------------------------------------------------------
insert into public.site_settings (key, value) values
  ('milestone_plays',    '[50,250,1000]'::jsonb),
  ('milestone_hearts',   '[5,25,100]'::jsonb),
  ('milestone_comments', '[3,10,50]'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- ------------------------------------------------------------
-- 2. artist_stats — `since` is now the earlier of the artist's own
--    created_at and their earliest approved song's created_at, so an
--    artist whose account predates their first published song still shows
--    the song's date, not the (earlier, less meaningful) signup date.
--
--    least() in Postgres ignores NULLs and only returns NULL if every
--    argument is NULL, so an artist with zero approved songs still gets
--    their own created_at here — no coalesce needed.
--
--    Same signature, same SECURITY DEFINER/STABLE/search_path — CREATE OR
--    REPLACE on an unchanged signature preserves the function's existing
--    grants, so anon/authenticated EXECUTE survives this untouched. (Part C
--    of this file re-checks that, and that follow_artist's PUBLIC/anon
--    revoke is still intact, since neither relies on assumption alone.)
-- ------------------------------------------------------------
create or replace function public.artist_stats(p_artist_id uuid)
returns table(songs int, weeks_on_chart int, hearts int, comments int, since date)
language sql stable security definer set search_path to 'public' as $function$
  select
    (select count(*)::int from public.songs s
      where s.artist_id = p_artist_id and s.status = 'approved'),
    (select count(distinct (date_trunc('week', cs.chart_date), cs.song_id))::int
       from public.chart_snapshots cs
       join public.songs s on s.id = cs.song_id
      where s.artist_id = p_artist_id and cs.kind = 'plays' and cs.rank between 1 and 10),
    (select coalesce(sum(s.like_count), 0)::int from public.songs s
      where s.artist_id = p_artist_id and s.status = 'approved'),
    (select count(*)::int from public.comments c
       join public.songs s on s.id = c.song_id
      where s.artist_id = p_artist_id and s.status = 'approved' and c.status = 'approved'),
    (select least(
        a.created_at,
        (select min(s.created_at) from public.songs s
          where s.artist_id = p_artist_id and s.status = 'approved')
      )::date
      from public.artists a where a.id = p_artist_id);
$function$;

grant execute on function public.artist_stats(uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- 3. recommend_for_artist — the +2 badge bonus now counts only PERMANENT
--    (earned) badges: hit_number_one, weeks_at_number_one, best_words,
--    best_music, was_most_loved, weeks_on_chart. LIVE badges (number_one_week,
--    most_loved, most_talked, new) are properties of this moment, not
--    achievements — the same distinction artist_badges (012) already draws
--    by only aggregating earned badges, not live ones. Counting a live badge
--    here would score a "try these" candidate on something that could flip
--    off by the time the visitor clicks it.
--
--    Everything else (guard, channel/tag scoring, milestone bonus,
--    exclusions, ordering, top_channels) is unchanged from sql/016.
-- ------------------------------------------------------------
create or replace function public.recommend_for_artist(p_artist_id uuid, p_limit int default 6)
returns table(song_id uuid, score int, top_channels text[])
language plpgsql stable security definer set search_path to 'public' as $function$
declare
  v_artist_count int;
begin
  select count(distinct s.artist_id) into v_artist_count
    from public.songs s where s.status = 'approved' and s.artist_id is not null;

  if v_artist_count < 2 then
    return;
  end if;

  return query
  with mine as (
    select id, tags from public.songs where artist_id = p_artist_id and status = 'approved'
  ),
  my_channels as (
    select distinct sc.channel_id
      from public.song_channels sc
     where sc.song_id in (select id from mine)
  ),
  my_tags as (
    select distinct t from mine, unnest(mine.tags) as t
  ),
  candidates as (
    select s.id, s.tags, s.like_count, s.created_at
      from public.songs s
     where s.status = 'approved'
       and s.artist_id is distinct from p_artist_id
       and s.id not in (select pk.song_id from public.artist_picks pk where pk.artist_id = p_artist_id)
  )
  select
    c.id,
    (
      coalesce((select count(*) from public.song_channels sc
                 where sc.song_id = c.id and sc.channel_id in (select channel_id from my_channels)), 0) * 3
      + coalesce((select count(*) from unnest(c.tags) t where t in (select t from my_tags)), 0) * 1
      + (case when exists (
           select 1 from public.song_badges sb
            where sb.song_id = c.id
              and sb.badge in ('hit_number_one', 'weeks_at_number_one', 'best_words',
                                'best_music', 'was_most_loved', 'weeks_on_chart')
         ) then 2 else 0 end)
      + (case when exists (select 1 from public.song_milestones sm where sm.song_id = c.id) then 1 else 0 end)
    )::int as score,
    coalesce((
      select array_agg(ch.id order by ch.sort_order)
        from (select distinct sc.channel_id
                from public.song_channels sc
               where sc.song_id = c.id and sc.channel_id in (select channel_id from my_channels)
               limit 2) x
        join public.channels ch on ch.id = x.channel_id
    ), '{}'::text[]) as top_channels
  from candidates c
  order by score desc, c.like_count desc, c.created_at desc
  limit p_limit;
end;
$function$;

grant execute on function public.recommend_for_artist(uuid, int) to anon, authenticated;
