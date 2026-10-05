-- ============================================================
-- 016_artist_page.sql — artist page data layer (ARTIST-1)
--
-- DATA ONLY. No UI reads any of this yet (ARTIST-2 builds the page).
--
-- PART A FINDINGS, recorded here so the skips below make sense:
--   - songs.play_count is already a lifetime, never-purged play counter
--     (incremented by increment_play_count(song_id uuid), guarded by
--     status='approved', same function that inserts into the 90-day-purged
--     `plays` table used only for the rolling plays_7d). So step 3's
--     "plays_total" is NOT added — song_milestones reads play_count instead.
--   - artists.bio already exists (text, check length <= 600). Step 2's
--     "only if absent" does not fire; nothing is added or tightened.
--
-- NO RLS IS LOOSENED BY THIS FILE. artist_picks and artist_follows are new
-- user-writable tables, so (like artists/songs/ratings) they get RLS enabled
-- AND forced. Every owner-row policy compares against auth.uid() directly —
-- artists.id IS the auth.users id here, there is no separate user_id column.
--
-- GRANTS: new tables inherit this project's existing default-privilege grant
-- of ALL to anon/authenticated (RLS is the real gate, same as every other
-- table here) — nothing extra to grant. New functions likewise default to
-- anon+authenticated EXECUTE; follow_artist is the one exception and has its
-- anon grant explicitly revoked below.
--
-- IDEMPOTENT throughout.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tunable settings this page reads.
-- ------------------------------------------------------------
insert into public.site_settings (key, value) values
  ('milestone_plays',    '[100,500,1000]'::jsonb),
  ('milestone_hearts',   '[10,50,100]'::jsonb),
  ('milestone_comments', '[5,25,50]'::jsonb),
  ('follow_daily_limit', to_jsonb(60)),
  ('picks_max',          to_jsonb(6))
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- 2. song_milestones — highest tier reached per track, per approved song.
--
-- A VIEW, not stored columns, same reasoning as song_badges: it cannot drift
-- from the counters it derives from. security_invoker so it runs as the
-- caller and inherits the RLS already on songs/comments — no new grant of
-- underlying access, same pattern as song_badges/artist_badges (012).
-- ------------------------------------------------------------
create or replace view public.song_milestones with (security_invoker = true) as
with cfg as (
  select
    coalesce((select value from public.site_settings where key = 'milestone_plays'),    '[100,500,1000]'::jsonb) as plays_arr,
    coalesce((select value from public.site_settings where key = 'milestone_hearts'),   '[10,50,100]'::jsonb)    as hearts_arr,
    coalesce((select value from public.site_settings where key = 'milestone_comments'), '[5,25,50]'::jsonb)      as comments_arr
),
approved_comments as (
  select song_id, count(*) as n
    from public.comments
   where status = 'approved'
   group by song_id
),
base as (
  select s.id as song_id, s.play_count as plays_val, s.like_count as hearts_val, coalesce(ac.n, 0) as comments_val
    from public.songs s
    left join approved_comments ac on ac.song_id = s.id
   where s.status = 'approved'
),
tracks as (
  select 'plays'::text as track, b.song_id, b.plays_val as val, cfg.plays_arr as thresholds from base b, cfg
  union all
  select 'hearts', b.song_id, b.hearts_val, cfg.hearts_arr from base b, cfg
  union all
  select 'comments', b.song_id, b.comments_val, cfg.comments_arr from base b, cfg
)
select t.song_id, t.track, m.tier, m.threshold
  from tracks t
  cross join lateral (
    select e.ord::int as tier, e.val::int as threshold
      from jsonb_array_elements_text(t.thresholds) with ordinality as e(val, ord)
     where t.val >= e.val::int
     order by e.ord desc
     limit 1
  ) m;

grant select on public.song_milestones to anon, authenticated;

-- ------------------------------------------------------------
-- 3. artist_picks — an artist's own or others' songs, with a note.
-- ------------------------------------------------------------
create table if not exists public.artist_picks (
  id         uuid primary key default gen_random_uuid(),
  artist_id  uuid not null references public.artists(id) on delete cascade,
  song_id    uuid not null references public.songs(id) on delete cascade,
  note       text check (char_length(note) <= 140),
  position   int not null check (position between 1 and 6),
  created_at timestamptz not null default now(),
  unique (artist_id, song_id),
  unique (artist_id, position)
);

create index if not exists idx_artist_picks_song_id on public.artist_picks(song_id);

alter table public.artist_picks enable row level security;
alter table public.artist_picks force row level security;

drop policy if exists artist_picks_read_all on public.artist_picks;
create policy artist_picks_read_all on public.artist_picks
  for select to anon, authenticated
  using (true);

drop policy if exists artist_picks_insert_own on public.artist_picks;
create policy artist_picks_insert_own on public.artist_picks
  for insert to authenticated
  with check (artist_id = (select auth.uid()));

drop policy if exists artist_picks_update_own on public.artist_picks;
create policy artist_picks_update_own on public.artist_picks
  for update to authenticated
  using (artist_id = (select auth.uid()))
  with check (artist_id = (select auth.uid()));

drop policy if exists artist_picks_delete_own on public.artist_picks;
create policy artist_picks_delete_own on public.artist_picks
  for delete to authenticated
  using (artist_id = (select auth.uid()));

-- BEFORE INSERT: the picks_max cap, and only approved songs may be picked.
-- SECURITY DEFINER so the song-status check sees the real status regardless
-- of whether the inserting artist could otherwise see that song's row.
create or replace function public.artist_picks_guard()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  v_max    int;
  v_count  int;
  v_status text;
begin
  select coalesce((value #>> '{}')::int, 6) into v_max
    from public.site_settings where key = 'picks_max';
  v_max := coalesce(v_max, 6);

  select count(*) into v_count from public.artist_picks where artist_id = new.artist_id;
  if v_count >= v_max then
    raise exception 'You can only pick up to % songs.', v_max;
  end if;

  select status into v_status from public.songs where id = new.song_id;
  if v_status is distinct from 'approved' then
    raise exception 'You can only pick published songs.';
  end if;

  return new;
end;
$function$;

drop trigger if exists artist_picks_before_insert on public.artist_picks;
create trigger artist_picks_before_insert
  before insert on public.artist_picks
  for each row execute function public.artist_picks_guard();

-- ------------------------------------------------------------
-- 4. artist_follows — who follows whom. Self-scoped; no one else reads rows.
-- ------------------------------------------------------------
create table if not exists public.artist_follows (
  follower_user_id uuid not null references auth.users(id) on delete cascade,
  artist_id        uuid not null references public.artists(id) on delete cascade,
  created_at       timestamptz not null default now(),
  primary key (follower_user_id, artist_id)
);

create index if not exists idx_artist_follows_artist_id on public.artist_follows(artist_id);

alter table public.artist_follows enable row level security;
alter table public.artist_follows force row level security;

drop policy if exists artist_follows_select_own on public.artist_follows;
create policy artist_follows_select_own on public.artist_follows
  for select to authenticated
  using (follower_user_id = (select auth.uid()));

drop policy if exists artist_follows_insert_own on public.artist_follows;
create policy artist_follows_insert_own on public.artist_follows
  for insert to authenticated
  with check (follower_user_id = (select auth.uid()));

drop policy if exists artist_follows_delete_own on public.artist_follows;
create policy artist_follows_delete_own on public.artist_follows
  for delete to authenticated
  using (follower_user_id = (select auth.uid()));

-- artist_follow_events — the rate-limit log follow_artist() reads and writes.
-- Chosen over a deleted_at tombstone on artist_follows itself so that table's
-- shape (and its single self-select policy) stays a plain "who follows whom"
-- set. No policies here at all: only follow_artist() (SECURITY DEFINER)
-- touches this table; direct client access is denied outright.
create table if not exists public.artist_follow_events (
  id               bigint generated always as identity primary key,
  follower_user_id uuid not null references auth.users(id) on delete cascade,
  artist_id        uuid not null references public.artists(id) on delete cascade,
  action           text not null check (action in ('follow','unfollow')),
  created_at       timestamptz not null default now()
);

create index if not exists idx_artist_follow_events_follower_created
  on public.artist_follow_events(follower_user_id, created_at);

alter table public.artist_follow_events enable row level security;
alter table public.artist_follow_events force row level security;

-- ------------------------------------------------------------
-- 5. follow_artist(p_artist_id, p_on) — toggles a follow, rate-limited.
-- ------------------------------------------------------------
create or replace function public.follow_artist(p_artist_id uuid, p_on boolean)
returns int language plpgsql security definer set search_path to 'public' as $function$
declare
  v_uid   uuid := auth.uid();
  v_limit int;
  v_today int;
  v_count int;
begin
  if v_uid is null then
    raise exception 'You must be signed in to follow an artist.';
  end if;

  if p_artist_id = v_uid then
    raise exception 'You cannot follow yourself.';
  end if;

  select coalesce((value #>> '{}')::int, 60) into v_limit
    from public.site_settings where key = 'follow_daily_limit';
  v_limit := coalesce(v_limit, 60);

  select count(*) into v_today
    from public.artist_follow_events
   where follower_user_id = v_uid
     and created_at > now() - interval '24 hours';
  if v_today + 1 > v_limit then
    raise exception 'You can follow or unfollow at most % artists per day.', v_limit;
  end if;

  if p_on then
    insert into public.artist_follows (follower_user_id, artist_id)
    values (v_uid, p_artist_id)
    on conflict (follower_user_id, artist_id) do nothing;
    insert into public.artist_follow_events (follower_user_id, artist_id, action)
    values (v_uid, p_artist_id, 'follow');
  else
    delete from public.artist_follows
     where follower_user_id = v_uid and artist_id = p_artist_id;
    insert into public.artist_follow_events (follower_user_id, artist_id, action)
    values (v_uid, p_artist_id, 'unfollow');
  end if;

  select count(*) into v_count from public.artist_follows where artist_id = p_artist_id;
  return v_count;
end;
$function$;

-- Postgres grants EXECUTE to PUBLIC on every new function by default,
-- regardless of the schema's default-privilege settings for named roles —
-- `revoke ... from anon` alone does NOT remove this, because anon inherits
-- through PUBLIC. Revoking from PUBLIC is the only way anon loses it.
revoke execute on function public.follow_artist(uuid, boolean) from public;
grant execute on function public.follow_artist(uuid, boolean) to authenticated;

-- ------------------------------------------------------------
-- 6. follower_count(p_artist_id) — public.
-- ------------------------------------------------------------
create or replace function public.follower_count(p_artist_id uuid)
returns int language sql stable security definer set search_path to 'public' as $function$
  select count(*)::int from public.artist_follows where artist_id = p_artist_id;
$function$;

grant execute on function public.follower_count(uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- 7. artist_stats(p_artist_id) — public.
--
-- weeks_on_chart here is a simpler count than artist_badges' version: every
-- distinct (week, song) pair that ever placed rank 1..10 on the plays chart,
-- not just completed (is_week_end) weeks at rank 1. The two numbers are
-- allowed to differ; this one is for the stats strip, not the trophy shelf.
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
    (select a.created_at::date from public.artists a where a.id = p_artist_id);
$function$;

grant execute on function public.artist_stats(uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- 8. recommend_for_artist(p_artist_id, p_limit) — "try these", public.
--
-- Guard: empty result until at least two distinct artists have an approved
-- song (otherwise every recommendation would just be the catalog's only
-- other artist, which isn't a recommendation).
--
-- top_channels is per returned row: the (up to two) mood channels that song
-- shares with this artist's catalog, for that row's header.
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
      + (case when exists (select 1 from public.song_badges sb where sb.song_id = c.id) then 2 else 0 end)
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

-- ------------------------------------------------------------
-- 9. Nightly cleanup — folded into the EXISTING take_chart_snapshot schedule
-- (jobid found by command text, not hardcoded, so this stays correct even if
-- the job was ever recreated). No second cron schedule is created.
-- ------------------------------------------------------------
create or replace function public.cleanup_stale_artist_picks()
returns void language sql security definer set search_path to 'public' as $function$
  delete from public.artist_picks ap
   where not exists (
     select 1 from public.songs s where s.id = ap.song_id and s.status = 'approved'
   );
$function$;

do $$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid from cron.job
   where command ilike '%take_chart_snapshot%' order by jobid limit 1;
  if v_jobid is not null then
    perform cron.alter_job(v_jobid,
      command := 'select public.take_chart_snapshot(); select public.cleanup_stale_artist_picks();');
  end if;
end;
$$;
