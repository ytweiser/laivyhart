-- ============================================================
-- 009_ratings.sql  — words & music, 1 to 5, signed-in only (Option B)
--
-- The heart is untouched: still anonymous, still one tap, still toggle_like
-- writing like_count. Only the quill (words) and the equalizer (music) become
-- ratings, and those require an account.
--
-- NEW TABLE WITH RESTRICTIVE POLICIES. No existing policy is loosened anywhere
-- in this migration. public.ratings is readable only by the rater and an admin;
-- the public sees nothing but the four aggregate columns on songs, which the
-- existing songs select policy already exposes.
--
-- IDEMPOTENT: create ... if not exists, create or replace, drop policy/trigger
-- if exists before create, and the aggregate trigger recomputes from scratch
-- rather than incrementing, so re-running it can never drift.
-- ============================================================

-- ------------------------------------------------------------
-- 1.1 ratings
-- One row per (song, rater, facet). Changeable by the rater through
-- rate_song(); never deletable by them.
-- ------------------------------------------------------------
create table if not exists public.ratings (
  song_id    uuid not null references public.songs(id) on delete cascade,
  artist_id  uuid not null references public.artists(id) on delete cascade,
  facet      text not null check (facet in ('words','music')),
  score      smallint not null check (score between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (song_id, artist_id, facet)
);
create index if not exists ratings_song_facet_idx on public.ratings (song_id, facet);

-- ------------------------------------------------------------
-- 1.2 aggregates on songs (what the public can see)
-- ------------------------------------------------------------
alter table public.songs
  add column if not exists rating_words_n   int not null default 0,
  add column if not exists rating_words_sum int not null default 0,
  add column if not exists rating_music_n   int not null default 0,
  add column if not exists rating_music_sum int not null default 0;

-- ------------------------------------------------------------
-- songs_guard_artist_writes: add the trusted-server-side escape.
--
-- WHY THIS IS NEEDED NOW. The aggregate trigger below updates songs. It runs
-- while a signed-in rater is the caller, so auth.uid() is NOT null and the
-- existing cron escape does not apply; the rater is not an admin; and the song
-- is approved, so the guard's "approved songs are frozen" rule would raise and
-- every rating would fail. artists_guard already took exactly this escape in
-- 007 for delete_my_account().
--
-- This does NOT weaken the whole-row jsonb comparison, which is left exactly as
-- it is and still covers the four new columns automatically (1A-1 wrote it that
-- way precisely so later columns would be covered without being listed). It
-- adds one more trusted path: inside a postgres-owned SECURITY DEFINER function
-- current_user is 'postgres', and a PostgREST request is 'anon' or
-- 'authenticated' and can never be postgres, so it is not forgeable from a
-- browser.
-- ------------------------------------------------------------
create or replace function public.songs_guard_artist_writes()
returns trigger language plpgsql set search_path = public as $fn$
begin
  -- Trusted server-side paths: pg_cron and the SECURITY DEFINER counter
  -- functions run with no JWT; postgres-owned SECURITY DEFINER functions
  -- (rate_song's aggregate trigger, review_song) run as postgres.
  if auth.uid() is null or current_user = 'postgres' then
    return new;
  end if;

  if public.is_admin() then
    if tg_op = 'UPDATE'
       and new.status = 'submitted'
       and old.status is distinct from 'submitted' then
      new.submitted_at := now();
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.artist_id is distinct from auth.uid() then
      raise exception 'You can only create songs under your own account.';
    end if;
    if coalesce(new.featured, false) then
      raise exception 'You cannot feature your own song.';
    end if;
    if new.featured_order is not null then
      raise exception 'You cannot set featured_order.';
    end if;
    if new.status not in ('draft','submitted') then
      raise exception 'A new song must start as draft or submitted.';
    end if;
    if new.slug is not null then
      raise exception 'You cannot set a slug.';
    end if;
    if new.source is distinct from 'uploaded' then
      raise exception 'You cannot set source.';
    end if;
    if new.contest_id is not null then
      raise exception 'You cannot set contest_id.';
    end if;
    if coalesce(new.play_count,0) <> 0 or coalesce(new.plays_7d,0) <> 0
       or coalesce(new.like_count,0) <> 0 or coalesce(new.like_lyrics_count,0) <> 0
       or coalesce(new.like_tune_count,0) <> 0 or coalesce(new.comment_count,0) <> 0
       or coalesce(new.rating_words_n,0) <> 0 or coalesce(new.rating_words_sum,0) <> 0
       or coalesce(new.rating_music_n,0) <> 0 or coalesce(new.rating_music_sum,0) <> 0 then
      raise exception 'You cannot set play, love or rating counts.';
    end if;
    if new.reviewed_at is not null then
      raise exception 'You cannot set reviewed_at.';
    end if;
    if new.status = 'submitted' then
      new.submitted_at := now();
    end if;
    return new;
  end if;

  if old.status = 'approved' then
    if new.status = 'removed'
       and (to_jsonb(new) - 'status') = (to_jsonb(old) - 'status') then
      return new;
    end if;
    raise exception 'Approved songs cannot be edited; contact Laivy Hart.';
  end if;

  if new.artist_id is distinct from old.artist_id then
    raise exception 'You cannot transfer a song to another artist.';
  end if;
  if new.featured is distinct from old.featured
     or new.featured_order is distinct from old.featured_order
     or new.featured_category is distinct from old.featured_category then
    raise exception 'You cannot change featuring.';
  end if;
  if new.slug is distinct from old.slug then
    raise exception 'You cannot change the slug.';
  end if;
  if new.play_count is distinct from old.play_count
     or new.plays_7d is distinct from old.plays_7d
     or new.like_count is distinct from old.like_count
     or new.like_lyrics_count is distinct from old.like_lyrics_count
     or new.like_tune_count is distinct from old.like_tune_count
     or new.comment_count is distinct from old.comment_count
     or new.rating_words_n is distinct from old.rating_words_n
     or new.rating_words_sum is distinct from old.rating_words_sum
     or new.rating_music_n is distinct from old.rating_music_n
     or new.rating_music_sum is distinct from old.rating_music_sum then
    raise exception 'You cannot change play, love or rating counts.';
  end if;
  if new.reviewed_at is distinct from old.reviewed_at then
    raise exception 'You cannot change reviewed_at.';
  end if;
  if new.source is distinct from old.source then
    raise exception 'You cannot change source.';
  end if;
  if new.contest_id is distinct from old.contest_id then
    raise exception 'You cannot change contest_id.';
  end if;

  if new.status not in ('draft','submitted','removed') then
    raise exception 'You cannot approve or reject your own song.';
  end if;
  if new.status = 'submitted' and old.status is distinct from 'submitted' then
    new.submitted_at := now();
  end if;

  return new;
end;
$fn$;

-- ------------------------------------------------------------
-- 1.3 keep the aggregates correct
--
-- Recomputed from the table rather than incremented. Slower per rating and
-- entirely worth it: it is self-healing, it cannot drift, and re-running this
-- migration or replaying a trigger cannot double-count.
-- ------------------------------------------------------------
create or replace function public.ratings_refresh_song(p_song uuid, p_facet text)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  if p_facet = 'words' then
    update public.songs s
       set rating_words_n   = coalesce((select count(*) from public.ratings r where r.song_id = s.id and r.facet = 'words'), 0),
           rating_words_sum = coalesce((select sum(score) from public.ratings r where r.song_id = s.id and r.facet = 'words'), 0)
     where s.id = p_song;
  else
    update public.songs s
       set rating_music_n   = coalesce((select count(*) from public.ratings r where r.song_id = s.id and r.facet = 'music'), 0),
           rating_music_sum = coalesce((select sum(score) from public.ratings r where r.song_id = s.id and r.facet = 'music'), 0)
     where s.id = p_song;
  end if;
end;
$fn$;

create or replace function public.ratings_refresh_tg()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if tg_op = 'DELETE' then
    perform public.ratings_refresh_song(old.song_id, old.facet);
    return old;
  end if;
  perform public.ratings_refresh_song(new.song_id, new.facet);
  -- A moved row (song or facet changed) has to fix the row it left behind too.
  if tg_op = 'UPDATE' and (new.song_id is distinct from old.song_id
                           or new.facet is distinct from old.facet) then
    perform public.ratings_refresh_song(old.song_id, old.facet);
  end if;
  return new;
end;
$fn$;

drop trigger if exists ratings_refresh on public.ratings;
create trigger ratings_refresh
  after insert or update or delete on public.ratings
  for each row execute function public.ratings_refresh_tg();

-- ------------------------------------------------------------
-- 1.4 rate_song(): the only write path into ratings
-- ------------------------------------------------------------
create or replace function public.rate_song(p_song uuid, p_facet text, p_score smallint)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_uid       uuid := auth.uid();
  v_owner     uuid;
  v_status    text;
  v_hours     numeric;
  v_created   timestamptz;
begin
  if v_uid is null then
    raise exception 'Sign in to rate.';
  end if;
  if p_facet not in ('words','music') then
    raise exception 'Unknown rating.';
  end if;
  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception 'A rating is 1 to 5.';
  end if;

  select artist_id, status into v_owner, v_status from public.songs where id = p_song;
  if v_owner is null or v_status is distinct from 'approved' then
    raise exception 'This song is not available.';
  end if;
  if not public.is_active_artist() then
    raise exception 'This account cannot rate.';
  end if;
  if v_owner = v_uid then
    raise exception 'You cannot rate your own song.';
  end if;

  -- The age gate is a setting, not a constant, so it can be relaxed for a test
  -- and put back without a deploy.
  select coalesce((value #>> '{}')::numeric, 48) into v_hours
    from public.site_settings where key = 'account_age_hours';
  v_hours := coalesce(v_hours, 48);
  select created_at into v_created from auth.users where id = v_uid;
  if v_created is null or v_created > now() - make_interval(hours => v_hours::int) then
    raise exception 'New accounts can rate after % hours.', v_hours::int;
  end if;

  insert into public.ratings (song_id, artist_id, facet, score)
  values (p_song, v_uid, p_facet, p_score)
  on conflict (song_id, artist_id, facet)
  do update set score = excluded.score, updated_at = now();
end;
$fn$;
revoke all on function public.rate_song(uuid, text, smallint) from public;
grant execute on function public.rate_song(uuid, text, smallint) to authenticated;

-- ------------------------------------------------------------
-- 1.6 RLS. Read-your-own plus admin. No direct writes at all: rate_song() is
-- SECURITY DEFINER and is the only way a row is ever created or changed.
-- ------------------------------------------------------------
alter table public.ratings enable row level security;
alter table public.ratings force row level security;

drop policy if exists ratings_read_own  on public.ratings;
drop policy if exists ratings_admin_all on public.ratings;

create policy ratings_read_own on public.ratings
  for select to authenticated using (artist_id = auth.uid());
create policy ratings_admin_all on public.ratings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------
-- 1.7 chart_snapshots.kind, and the two new nightly lists
-- ------------------------------------------------------------
alter table public.chart_snapshots
  add column if not exists kind text not null default 'plays';

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'chart_snapshots_kind_check') then
    alter table public.chart_snapshots
      add constraint chart_snapshots_kind_check check (kind in ('plays','words','music'));
  end if;
end
$do$;

update public.chart_snapshots set kind = 'plays' where kind is null;
create index if not exists chart_snapshots_kind_date_idx
  on public.chart_snapshots (kind, chart_date desc, rank);

/* The uniqueness rule has to grow a dimension along with the table.
   chart_snapshots was UNIQUE (chart_date, rank), which was right while there
   was one chart a night. With three, the words row at rank 1 collides with the
   plays row at rank 1 for the same date -- caught by the verification below,
   which is exactly the kind of thing that would otherwise have failed silently
   in the cron job at 22:10 every night once the first rating existed. */
do $do$
begin
  if exists (select 1 from pg_constraint where conname = 'chart_snapshots_chart_date_rank_key') then
    alter table public.chart_snapshots drop constraint chart_snapshots_chart_date_rank_key;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chart_snapshots_date_kind_rank_key') then
    alter table public.chart_snapshots
      add constraint chart_snapshots_date_kind_rank_key unique (chart_date, kind, rank);
  end if;
end
$do$;

/* take_chart_snapshot(): the plays top-10 exactly as before, plus a top-10 by
   words and by music.

   THE RANKING USES A DIFFERENT SOURCE FROM THE DISPLAY, ON PURPOSE.

   The live per-song average shown in the dock comes from the cached
   rating_<facet>_n/sum columns, which count every rating from every account.
   The nightly RANKING instead recomputes from the ratings table joined to
   auth.users, counting only raters whose account is at least 7 days old. A
   brand-new account can therefore move what a visitor sees on one song, but
   cannot move the chart -- which is the thing worth gaming. Keeping the cached
   columns out of the ranking is what makes that split possible.

   Bayesian average: (sum + m*C) / (n + m), the algebraic simplification of
   (n/(n+m))*(sum/n) + (m/(n+m))*C, which also stays defined at n = 0.
   m = site_settings.min_ratings; C = that night's site-wide mean for the facet,
   3.0 when there are no mature ratings at all.

   Songs with no mature rating are excluded rather than seeded at the prior --
   otherwise every unrated song ties at C and the list is arbitrary. With zero
   ratings today both lists are simply empty, which is correct.
*/
create or replace function public.take_chart_snapshot()
returns void language plpgsql security definer set search_path = public as $fn$
declare
  d       date    := ((now() at time zone 'Asia/Jerusalem')::date - 1);
  weekend boolean := (extract(dow from ((now() at time zone 'Asia/Jerusalem')::date - 1)) = 6);
  m       numeric;
begin
  select coalesce((value #>> '{}')::numeric, 5) into m
    from public.site_settings where key = 'min_ratings';
  m := coalesce(m, 5);

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
end;
$fn$;
