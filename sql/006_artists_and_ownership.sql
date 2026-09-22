-- ============================================================
-- 006_artists_and_ownership.sql
--
-- Schema foundation for opening laivyhart.com to other artists (stage 1A-1).
--
-- After this migration:
--   * public.artists exists, with the owner as the only row (role admin).
--   * every song has artist_id (all assigned to the owner) and status
--     (all existing songs approved).
--   * RLS on songs is rewritten: the public sees approved songs only, an
--     artist sees and writes their own, an admin sees and writes everything.
--   * public.reviews + review_song() exist (the approval pipeline).
--   * public.token_ledger exists but nothing writes to it in this stage.
--   * public.site_settings exists.
--
-- No frontend behaviour changes. No auth UI (that is 1A-2).
--
-- IDEMPOTENT: create ... if not exists, create or replace, drop policy /
-- trigger if exists before create. Safe to re-apply in full.
--
-- OWNER_UID is written in as a literal on purpose: this is a deterministic
-- migration for this one project (ref tshkrghrgokplakktvik), not a template.
-- ============================================================

-- ------------------------------------------------------------
-- 1.1 Extensions
-- ------------------------------------------------------------
create extension if not exists citext;

-- ------------------------------------------------------------
-- 1.2 artists
-- ------------------------------------------------------------
create table if not exists public.artists (
  id              uuid primary key references auth.users(id) on delete cascade,
  handle          citext not null unique check (handle ~ '^[a-z0-9][a-z0-9-]{2,29}$'),
  display_name    text not null check (char_length(display_name) between 1 and 60),
  display_name_he text check (char_length(display_name_he) <= 60),
  bio             text check (char_length(bio) <= 600),
  avatar_url      text,
  status          text not null default 'active' check (status in ('active','suspended','deleted')),
  role            text not null default 'artist' check (role in ('artist','admin')),
  onboarded       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.reserved_handles (handle citext primary key);

insert into public.reserved_handles (handle) values
  ('admin'),('laivyhart'),('laivy'),('api'),('auth'),('listen'),('artist'),
  ('artists'),('song'),('songs'),('settings'),('terms'),('about'),('charts'),
  ('chart'),('contest'),('contests'),('sponsored'),('www'),('mail'),('hello'),
  ('support'),('help'),('login'),('signin'),('signup'),('me')
on conflict (handle) do nothing;

-- Not secret: the signup form needs to tell someone their handle is taken.
alter table public.reserved_handles enable row level security;
drop policy if exists reserved_handles_read_all on public.reserved_handles;
create policy reserved_handles_read_all on public.reserved_handles
  for select to anon, authenticated using (true);

-- ------------------------------------------------------------
-- 1.3 Public projection of artists
--
-- security_invoker = false on purpose: this view is how anon reads artist
-- profiles, and artists itself has no anon SELECT policy. The view is the
-- allow-list -- it exposes only non-sensitive columns of active artists and
-- never status, role or onboarded.
-- ------------------------------------------------------------
create or replace view public.artists_public with (security_invoker = false) as
  select id, handle, display_name, display_name_he, bio, avatar_url, created_at
  from public.artists
  where status = 'active';

grant select on public.artists_public to anon, authenticated;

-- ------------------------------------------------------------
-- 1.4 Helpers
-- ------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.artists
     where id = auth.uid() and role = 'admin' and status = 'active'
  );
$fn$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

create or replace function public.is_active_artist()
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.artists
     where id = auth.uid() and status = 'active'
  );
$fn$;
revoke all on function public.is_active_artist() from public;
grant execute on function public.is_active_artist() to anon, authenticated;

-- ------------------------------------------------------------
-- 1.5 New auth user -> artist row
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  v_handle citext := 'artist-' || substr(replace(new.id::text, '-', ''), 1, 8);
  v_name   text   := coalesce(
                       nullif(new.raw_user_meta_data->>'full_name', ''),
                       nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
                       'artist'
                     );
begin
  insert into public.artists (id, handle, display_name)
  values (new.id, v_handle, left(v_name, 60))
  on conflict (id) do nothing;
  return new;
end;
$fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- 1.6 The owner
-- ------------------------------------------------------------
insert into public.artists (id, handle, display_name, role, onboarded)
values ('13244ffe-6ca6-4a56-bb69-2d5ecca89e69', 'laivyhart', 'Laivy Hart', 'admin', true)
on conflict (id) do update
  set role = 'admin', handle = 'laivyhart', display_name = 'Laivy Hart', onboarded = true;

-- ------------------------------------------------------------
-- 1.7 artists guard
-- ------------------------------------------------------------
create or replace function public.artists_guard()
returns trigger language plpgsql set search_path = public as $fn$
begin
  new.updated_at := now();

  if public.is_admin() then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id then
      raise exception 'You cannot change an artist id.';
    end if;
    if new.role is distinct from old.role then
      raise exception 'You cannot change your own role.';
    end if;
    if new.status is distinct from old.status then
      raise exception 'You cannot change your own status.';
    end if;
    if new.created_at is distinct from old.created_at then
      raise exception 'You cannot change created_at.';
    end if;
  end if;

  if exists (select 1 from public.reserved_handles r where r.handle = new.handle) then
    raise exception 'That handle is reserved. Please choose another.';
  end if;

  return new;
end;
$fn$;

drop trigger if exists artists_guard on public.artists;
create trigger artists_guard
  before insert or update on public.artists
  for each row execute function public.artists_guard();

-- ------------------------------------------------------------
-- 1.8 artists RLS
-- ------------------------------------------------------------
alter table public.artists enable row level security;
alter table public.artists force row level security;

drop policy if exists artists_read_self   on public.artists;
drop policy if exists artists_update_self on public.artists;
drop policy if exists artists_admin_all   on public.artists;

create policy artists_read_self on public.artists
  for select to authenticated using (id = auth.uid());
create policy artists_update_self on public.artists
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy artists_admin_all on public.artists
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- No insert policy: rows are created by handle_new_user() only.

-- ------------------------------------------------------------
-- 1.9 songs: ownership + status
-- ------------------------------------------------------------
alter table public.songs
  add column if not exists artist_id uuid references public.artists(id),
  add column if not exists status text not null default 'draft'
    check (status in ('draft','submitted','approved','rejected','removed')),
  add column if not exists submitted_at timestamptz,
  add column if not exists reviewed_at timestamptz,
  add column if not exists slug text unique,
  add column if not exists duration_seconds integer,
  add column if not exists source text not null default 'uploaded'
    check (source in ('uploaded','ai_lyrics','ai_generated')),
  add column if not exists contest_id uuid;

update public.songs
   set artist_id = '13244ffe-6ca6-4a56-bb69-2d5ecca89e69'
 where artist_id is null;

-- Only rows still at the default that belong to the owner, so re-running this
-- file can never flip a future artist draft to approved.
update public.songs
   set status = 'approved', reviewed_at = coalesce(reviewed_at, created_at)
 where status = 'draft'
   and artist_id = '13244ffe-6ca6-4a56-bb69-2d5ecca89e69';

alter table public.songs alter column artist_id set not null;

create index if not exists songs_artist_status_idx on public.songs (artist_id, status);
create index if not exists songs_status_created_idx on public.songs (status, created_at desc);

alter table public.comments add column if not exists artist_id uuid references public.artists(id);

-- ------------------------------------------------------------
-- 1.10 songs RLS
--
-- The four policies being dropped were: "Public can read songs" (select,
-- anon+authenticated, using true), "Authenticated users can insert songs"
-- (with check true), "Authenticated users can update songs" (using true,
-- with check true) and "Authenticated users can delete songs" (using true).
-- That model was "any logged-in user may do anything"; with exactly one auth
-- user it was owner-only in practice, but it does not survive signups.
-- ------------------------------------------------------------
alter table public.songs enable row level security;
alter table public.songs force row level security;

drop policy if exists "Public can read songs"                on public.songs;
drop policy if exists "Authenticated users can insert songs" on public.songs;
drop policy if exists "Authenticated users can update songs" on public.songs;
drop policy if exists "Authenticated users can delete songs" on public.songs;
drop policy if exists songs_read_public      on public.songs;
drop policy if exists songs_read_own         on public.songs;
drop policy if exists songs_insert_own       on public.songs;
drop policy if exists songs_update_own       on public.songs;
drop policy if exists songs_delete_own_draft on public.songs;
drop policy if exists songs_admin_all        on public.songs;

create policy songs_read_public on public.songs
  for select to anon, authenticated using (status = 'approved');
create policy songs_read_own on public.songs
  for select to authenticated using (artist_id = auth.uid());
create policy songs_insert_own on public.songs
  for insert to authenticated with check (artist_id = auth.uid() and public.is_active_artist());
create policy songs_update_own on public.songs
  for update to authenticated using (artist_id = auth.uid() and public.is_active_artist())
  with check (artist_id = auth.uid());
create policy songs_delete_own_draft on public.songs
  for delete to authenticated using (artist_id = auth.uid() and status = 'draft');
create policy songs_admin_all on public.songs
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------
-- 1.11 songs guard
-- ------------------------------------------------------------
create or replace function public.songs_guard_artist_writes()
returns trigger language plpgsql set search_path = public as $fn$
begin
  -- Trusted server-side paths run with no JWT: pg_cron (refresh_plays_7d,
  -- take_chart_snapshot) and the SECURITY DEFINER counter functions that anon
  -- calls (increment_play_count, toggle_like, toggle_love,
  -- refresh_song_comment_count). Those maintain counters on approved songs and
  -- are guarded on their own terms below; blocking them here would break the
  -- hourly refresh. No web role can reach this trigger without a JWT, because
  -- anon has no insert/update/delete policy on songs at all.
  if auth.uid() is null then
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
       or coalesce(new.like_tune_count,0) <> 0 or coalesce(new.comment_count,0) <> 0 then
      raise exception 'You cannot set play or love counts.';
    end if;
    if new.reviewed_at is not null then
      raise exception 'You cannot set reviewed_at.';
    end if;
    if new.status = 'submitted' then
      new.submitted_at := now();
    end if;
    return new;
  end if;

  -- UPDATE from here down.

  -- An approved song is frozen. The one move an artist still has is to pull it
  -- down; everything else goes through Laivy Hart. Comparing the whole row as
  -- jsonb catches every column, including ones added after this was written.
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
     or new.comment_count is distinct from old.comment_count then
    raise exception 'You cannot change play or love counts.';
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

drop trigger if exists songs_guard_artist_writes on public.songs;
create trigger songs_guard_artist_writes
  before insert or update on public.songs
  for each row execute function public.songs_guard_artist_writes();

-- ------------------------------------------------------------
-- 1.12 Status guards on the existing public functions
--
-- Same signatures, same SECURITY DEFINER, same search_path. Each now refuses
-- to touch a song that is not approved, so a draft can never accumulate plays,
-- loves or comments and can never enter the chart.
-- ------------------------------------------------------------
create or replace function public.increment_play_count(song_id uuid)
returns void language sql security definer set search_path to 'public' as $fn$
  update public.songs
     set play_count = play_count + 1
   where id = song_id and status = 'approved';

  insert into public.plays (song_id)
  select increment_play_count.song_id
   where exists (
     select 1 from public.songs s
      where s.id = increment_play_count.song_id and s.status = 'approved'
   );
$fn$;

create or replace function public.toggle_like(song_id uuid, liked boolean)
returns integer language plpgsql security definer set search_path to 'public' as $fn$
declare
  new_count integer;
begin
  update public.songs
    set like_count = greatest(0, like_count + case when liked then 1 else -1 end)
    where id = song_id and status = 'approved'
    returning like_count into new_count;
  return new_count;  -- null if no such song, or it is not approved
end;
$fn$;

create or replace function public.toggle_love(song_id uuid, kind text, "on" boolean)
returns integer language plpgsql security definer set search_path to 'public' as $fn$
declare
  delta  int := case when "on" then 1 else -1 end;
  newval int;
begin
  if kind not in ('lyrics', 'music') then
    raise exception 'invalid love kind: %', kind;
  end if;

  if kind = 'lyrics' then
    update public.songs
       set like_lyrics_count = greatest(0, coalesce(like_lyrics_count, 0) + delta)
     where id = song_id and status = 'approved'
     returning like_lyrics_count into newval;
  else
    update public.songs
       set like_tune_count = greatest(0, coalesce(like_tune_count, 0) + delta)
     where id = song_id and status = 'approved'
     returning like_tune_count into newval;
  end if;

  return newval;  -- null if no such song, or it is not approved
end;
$fn$;

-- There is no comment-submission function: comments are inserted straight
-- through the "comments anon insert pending" policy. The equivalent guard is
-- therefore a trigger rather than a redefined function.
create or replace function public.comments_require_approved_song()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if public.is_admin() then
    return new;
  end if;
  if not exists (
    select 1 from public.songs where id = new.song_id and status = 'approved'
  ) then
    raise exception 'Comments are only accepted on published songs.';
  end if;
  return new;
end;
$fn$;

drop trigger if exists comments_require_approved_song on public.comments;
create trigger comments_require_approved_song
  before insert on public.comments
  for each row execute function public.comments_require_approved_song();

create or replace function public.take_chart_snapshot()
returns void language plpgsql security definer set search_path to 'public' as $fn$
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
  where s.status = 'approved'
  order by s.plays_7d desc, s.play_count desc, s.like_count desc, s.title
  limit 10;
end;
$fn$;

create or replace function public.refresh_plays_7d()
returns void language plpgsql security definer set search_path to 'public' as $fn$
begin
  update public.songs s
     set plays_7d = coalesce((
       select count(*) from public.plays p
        where p.song_id = s.id
          and p.played_at >= now() - interval '7 days'
     ), 0)
   where s.status = 'approved';
  delete from public.plays where played_at < now() - interval '90 days';
end;
$fn$;

-- ------------------------------------------------------------
-- 1.13 reviews
-- ------------------------------------------------------------
create table if not exists public.reviews (
  id bigint generated always as identity primary key,
  song_id uuid not null references public.songs(id) on delete cascade,
  reviewer_kind text not null check (reviewer_kind in ('human','ai')),
  reviewer_id uuid references public.artists(id),
  model text,
  decision text not null check (decision in ('approve','reject','remove','restore','recommend_approve','recommend_reject','flag')),
  confidence numeric(4,3) check (confidence between 0 and 1),
  reason text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index if not exists reviews_song_idx on public.reviews (song_id, created_at desc);

alter table public.reviews enable row level security;
alter table public.reviews force row level security;

drop policy if exists reviews_read_own_songs on public.reviews;
drop policy if exists reviews_admin_all      on public.reviews;

create policy reviews_read_own_songs on public.reviews
  for select to authenticated using (
    exists (select 1 from public.songs s where s.id = reviews.song_id and s.artist_id = auth.uid())
  );
create policy reviews_admin_all on public.reviews
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- No client insert policy: rows are written by review_song() only.

create or replace function public.review_song(p_song uuid, p_decision text, p_reason text)
returns text language plpgsql security definer set search_path = public as $fn$
declare
  v_status text;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can review songs.';
  end if;
  if p_decision not in ('approve','reject','remove','restore') then
    raise exception 'Unknown review decision: %', p_decision;
  end if;

  v_status := case p_decision
                when 'approve' then 'approved'
                when 'reject'  then 'rejected'
                when 'remove'  then 'removed'
                when 'restore' then 'approved'
              end;

  insert into public.reviews (song_id, reviewer_kind, reviewer_id, decision, reason)
  values (p_song, 'human', auth.uid(), p_decision, p_reason);

  update public.songs
     set status = v_status, reviewed_at = now()
   where id = p_song;

  if not found then
    raise exception 'No such song: %', p_song;
  end if;

  return v_status;
end;
$fn$;
revoke all on function public.review_song(uuid, text, text) from public;
grant execute on function public.review_song(uuid, text, text) to authenticated;

-- ------------------------------------------------------------
-- 1.14 token_ledger  (created now, written by nothing in this stage)
-- ------------------------------------------------------------
create table if not exists public.token_ledger (
  id bigint generated always as identity primary key,
  artist_id uuid not null references public.artists(id) on delete cascade,
  amount integer not null check (amount <> 0),
  reason text not null check (reason in ('love_given','comment_approved','song_shared','site_shared','song_approved','weekly_bonus','ai_lyrics','ai_cover','ai_song','admin_adjust')),
  reference_type text,
  reference_id text,
  note text,
  created_at timestamptz not null default now()
);
create unique index if not exists token_ledger_once_idx
  on public.token_ledger (artist_id, reason, reference_id)
  where reference_id is not null;

create or replace function public.token_balance(p_artist uuid)
returns integer language sql stable security definer set search_path = public as $fn$
  select coalesce(sum(amount), 0)::integer
    from public.token_ledger where artist_id = p_artist;
$fn$;
revoke all on function public.token_balance(uuid) from public;
grant execute on function public.token_balance(uuid) to authenticated;

alter table public.token_ledger enable row level security;
alter table public.token_ledger force row level security;

drop policy if exists ledger_read_own  on public.token_ledger;
drop policy if exists ledger_admin_all on public.token_ledger;

create policy ledger_read_own on public.token_ledger
  for select to authenticated using (artist_id = auth.uid());
create policy ledger_admin_all on public.token_ledger
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- No client insert policy.

-- ------------------------------------------------------------
-- 1.15 site_settings
-- ------------------------------------------------------------
create table if not exists public.site_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.site_settings (key, value) values
  ('min_ratings', '5'),
  ('account_age_hours', '48')
on conflict (key) do nothing;

alter table public.site_settings enable row level security;

drop policy if exists settings_read_all  on public.site_settings;
drop policy if exists settings_admin_all on public.site_settings;

create policy settings_read_all on public.site_settings
  for select to anon, authenticated using (true);
create policy settings_admin_all on public.site_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
