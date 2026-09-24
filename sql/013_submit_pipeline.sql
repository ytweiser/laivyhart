-- ============================================================
-- 013_submit_pipeline.sql — the contributor submit pipeline
--
-- Plumbing only. No contributor UI (1B-2), no public signup (1B-3). The public
-- site is unchanged: pending songs are not approved, so nothing new is visible.
--
-- RLS IS NOT LOOSENED FOR PUBLIC READS. The only new client-writable surface is
-- two suggestion columns on a song the artist already owns and may already
-- update (draft/submitted). song_channels and songs.tags[] stay admin-write;
-- contributors never write them. submission_events is readable by its own
-- artist and by admins, and is NOT client-insertable at all.
--
-- TWO TRIGGERS, ON PURPOSE. Read this before changing either:
--
--   BEFORE (songs_guard_artist_writes) stays SECURITY INVOKER. It must. The
--   guard's escape hatch is `current_user = 'postgres'`, and inside a SECURITY
--   DEFINER function current_user IS the owner — so making this definer would
--   make the escape always true and silently disable the entire guard for
--   every caller. It does validation, the caps, and the submitted_at stamp.
--
--   AFTER (songs_after_submit) is SECURITY DEFINER, because it writes
--   submission_events (no client insert) and flips artists.is_artist (blocked
--   for non-admins by artists_guard). For the reason above it does NOT use the
--   current_user escape; it gates on auth.uid() being present and the caller
--   not being an admin, which are unaffected by definer.
--
--   Why the side effects cannot live in the BEFORE trigger: a song inserted
--   straight as 'submitted' does not exist yet at BEFORE INSERT time, so
--   submission_events.song_id would violate its foreign key. AFTER covers
--   INSERT and UPDATE uniformly.
--
-- IDEMPOTENT throughout.
-- ============================================================

-- ------------------------------------------------------------
-- 1a. submission_events — the audit trail, and the source of the daily cap.
-- ------------------------------------------------------------
create table if not exists public.submission_events (
  id         bigint generated always as identity primary key,
  artist_id  uuid not null references public.artists(id) on delete cascade,
  song_id    uuid not null references public.songs(id)   on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists submission_events_artist_time_idx
  on public.submission_events (artist_id, created_at desc);

alter table public.submission_events enable row level security;
alter table public.submission_events force  row level security;

drop policy if exists submission_events_read_own on public.submission_events;
create policy submission_events_read_own on public.submission_events
  for select to authenticated using (artist_id = auth.uid());

drop policy if exists submission_events_admin_all on public.submission_events;
create policy submission_events_admin_all on public.submission_events
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- No insert/update/delete policy for anyone but an admin: the only writer is
-- the definer trigger, which bypasses RLS because postgres has BYPASSRLS.
grant select on public.submission_events to authenticated;

-- ------------------------------------------------------------
-- 1b. Contributor suggestions. The artist proposes; the OWNER decides at
--     approval (1B-3) and moves these into song_channels / tags[].
-- ------------------------------------------------------------
alter table public.songs
  add column if not exists proposed_channels text[] not null default '{}',
  add column if not exists proposed_tags     text[] not null default '{}';

-- ------------------------------------------------------------
-- 1c. The caps. Tunable without a deploy.
-- ------------------------------------------------------------
insert into public.site_settings (key, value) values
  ('submit_max_pending',       to_jsonb(3)),
  ('submit_max_per_day',       to_jsonb(5)),
  ('submit_min_account_hours', to_jsonb(0))
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- Caps check. SECURITY DEFINER so the counts are exact regardless of the
-- caller's RLS view, and safe to grant: it only raises or returns void, so
-- calling it directly achieves nothing.
-- ------------------------------------------------------------
create or replace function public.assert_submit_allowed(p_artist uuid, p_exclude_song uuid)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_max_pending int;
  v_max_day     int;
  v_min_hours   int;
  v_pending     int;
  v_today       int;
  v_created     timestamptz;
begin
  select coalesce((select (value #>> '{}')::int from public.site_settings where key='submit_max_pending'), 3),
         coalesce((select (value #>> '{}')::int from public.site_settings where key='submit_max_per_day'), 5),
         coalesce((select (value #>> '{}')::int from public.site_settings where key='submit_min_account_hours'), 0)
    into v_max_pending, v_max_day, v_min_hours;

  if v_min_hours > 0 then
    select created_at into v_created from public.artists where id = p_artist;
    if v_created is not null and v_created > now() - make_interval(hours => v_min_hours) then
      raise exception 'Your account is too new to submit a song. Please try again a little later.';
    end if;
  end if;

  -- The song being submitted is excluded so a resubmit of an already-pending
  -- song is not counted twice against its own cap.
  select count(*) into v_pending
    from public.songs
   where artist_id = p_artist
     and status = 'submitted'
     and (p_exclude_song is null or id <> p_exclude_song);
  if v_pending + 1 > v_max_pending then
    raise exception 'You can have at most % songs awaiting review.', v_max_pending;
  end if;

  select count(*) into v_today
    from public.submission_events
   where artist_id = p_artist
     and created_at > now() - interval '24 hours';
  if v_today + 1 > v_max_day then
    raise exception 'You can submit at most % songs per day.', v_max_day;
  end if;
end;
$fn$;
revoke all on function public.assert_submit_allowed(uuid, uuid) from public;
grant execute on function public.assert_submit_allowed(uuid, uuid) to authenticated;

-- ------------------------------------------------------------
-- 1d. The guard, rewritten. SECURITY INVOKER — see the header.
-- ------------------------------------------------------------
create or replace function public.songs_guard_artist_writes()
returns trigger language plpgsql set search_path to 'public' as $fn$
begin
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
      perform public.assert_submit_allowed(auth.uid(), null);
      new.submitted_at := now();
    end if;
    return new;
  end if;

  -- ---- UPDATE ----
  -- CHANGED IN 1B-1. An approved song used to be frozen outright. It can now
  -- be edited, but editing it sends it back to the queue: the only statuses a
  -- non-admin may move it to are 'submitted' (edit -> re-review) and 'removed'
  -- (withdraw). The locked-column list below still applies to both, so an edit
  -- can never smuggle in a slug, a counter or a feature flag.
  if old.status = 'approved' then
    if new.status = 'submitted' then
      null;                              -- falls through to the locked-column checks
    elsif new.status = 'removed' then
      null;
    else
      raise exception 'Editing a published song sends it back for review; set it to resubmit.';
    end if;
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

  -- Every non-admin path into 'submitted' -- from draft, from rejected, or an
  -- edit of an approved song -- passes through here, so the caps cannot be
  -- routed around.
  if new.status = 'submitted' and old.status is distinct from 'submitted' then
    perform public.assert_submit_allowed(auth.uid(), old.id);
    new.submitted_at := now();
  end if;

  return new;
end;
$fn$;

-- ------------------------------------------------------------
-- The side effects. SECURITY DEFINER — see the header for why this one may be
-- definer and the guard may not, and why it gates on auth.uid()/is_admin()
-- rather than on current_user.
-- ------------------------------------------------------------
create or replace function public.songs_after_submit()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  if auth.uid() is null then return null; end if;   -- cron, snapshot, psql
  if public.is_admin() then return null; end if;    -- admin review paths
  if new.status <> 'submitted' then return null; end if;
  if tg_op = 'UPDATE' and old.status = 'submitted' then return null; end if;

  insert into public.submission_events (artist_id, song_id)
  values (new.artist_id, new.id);

  -- First submission makes the account a public artist.
  update public.artists
     set is_artist = true
   where id = new.artist_id and is_artist = false;

  return null;
end;
$fn$;

drop trigger if exists songs_after_submit on public.songs;
create trigger songs_after_submit
  after insert or update on public.songs
  for each row execute function public.songs_after_submit();
