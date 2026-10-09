-- ============================================================
-- 024_song_ideas.sql
--
-- SONG-1: members send a song idea in one plain box. Each week the owner
-- picks three and turns them into songs credited to the submitter. This
-- migration is the data layer, the admin read/write path, and the badge and
-- daily-report hooks. SONG-2 builds the public idea board and submission
-- form.
--
-- LOCKDOWN. Both new tables are RLS enabled and FORCED with zero policies,
-- the same pattern every table in this project already uses (ratings,
-- activity_events, dedications). All access goes through SECURITY DEFINER
-- functions or the song_ideas_board view. This project's default privileges
-- grant a new function's execute to anon directly (confirmed in ACT-1/ACT-2/
-- DED-1), so every function here is revoked from public AND anon explicitly
-- before granting exactly what it needs.
-- ============================================================

-- ------------------------------------------------------------
-- 1. song_ideas
-- ------------------------------------------------------------
create table if not exists public.song_ideas (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id),
  idea_text         text not null,
  credit_name       text null,
  is_anonymous      boolean not null default false,
  show_on_board     boolean not null default true,
  notify_email      boolean not null default true,
  status            text not null default 'received' check (status in (
    'received', 'picked', 'in_studio', 'released', 'not_picked', 'withdrawn'
  )),
  picked_week       date null,
  released_song_id  uuid null references public.songs(id),
  hearts_count      int not null default 0,
  brief_version     int not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint song_ideas_text_len check (char_length(idea_text) between 1 and 3000),
  constraint song_ideas_credit_len check (credit_name is null or char_length(credit_name) <= 60),
  constraint song_ideas_picked_week_is_sunday check (picked_week is null or extract(dow from picked_week) = 0),
  constraint song_ideas_released_song_id_unique unique (released_song_id)
);

create index if not exists song_ideas_status_created_idx on public.song_ideas (status, created_at desc);
create index if not exists song_ideas_user_created_idx   on public.song_ideas (user_id, created_at desc);
create index if not exists song_ideas_hearts_idx         on public.song_ideas (hearts_count desc);

alter table public.song_ideas enable row level security;
alter table public.song_ideas force row level security;
-- No policies at all: every read/write goes through a SECURITY DEFINER
-- function below, or (for the public-safe columns) the board view after this.

-- ------------------------------------------------------------
-- 2. song_idea_hearts
-- ------------------------------------------------------------
create table if not exists public.song_idea_hearts (
  idea_id    uuid not null references public.song_ideas(id) on delete cascade,
  user_id    uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (idea_id, user_id)
);

alter table public.song_idea_hearts enable row level security;
alter table public.song_idea_hearts force row level security;
-- No policies: not readable or writable by anon or authenticated directly.
-- toggle_song_idea_heart() (SECURITY DEFINER, below) is the only writer.

-- ------------------------------------------------------------
-- 3. song_idea_hearts_sync: keeps song_ideas.hearts_count in step with the
-- hearts table, the same denormalized-counter pattern songs.like_count
-- already uses elsewhere in this project.
-- ------------------------------------------------------------
create or replace function public.song_idea_hearts_sync()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if tg_op = 'INSERT' then
    update public.song_ideas set hearts_count = hearts_count + 1, updated_at = now() where id = new.idea_id;
  elsif tg_op = 'DELETE' then
    update public.song_ideas set hearts_count = greatest(0, hearts_count - 1), updated_at = now() where id = old.idea_id;
  end if;
  return null;
end;
$fn$;
revoke all on function public.song_idea_hearts_sync() from public, anon, authenticated;

drop trigger if exists song_idea_hearts_sync_ins on public.song_idea_hearts;
create trigger song_idea_hearts_sync_ins after insert on public.song_idea_hearts
  for each row execute function public.song_idea_hearts_sync();

drop trigger if exists song_idea_hearts_sync_del on public.song_idea_hearts;
create trigger song_idea_hearts_sync_del after delete on public.song_idea_hearts
  for each row execute function public.song_idea_hearts_sync();

-- ------------------------------------------------------------
-- 4. song_idea_credit: the one formula for "who gets the credit line",
-- shared by song_ideas_board, the release path below, and the daily report,
-- so the three can never read differently. Internal helper only -- revoked
-- from every client role, same reasoning as contains_banned_term
-- (022_dedications.sql): a SECURITY DEFINER caller still reaches it because
-- it runs its own body, including nested calls, as its owner.
-- ------------------------------------------------------------
create or replace function public.song_idea_credit(p_credit_name text, p_is_anonymous boolean, p_display_name text)
returns text language sql stable set search_path = public as $fn$
  select case
    when p_is_anonymous then 'Anonymous'
    else coalesce(nullif(btrim(coalesce(p_credit_name, '')), ''), p_display_name, 'Anonymous')
  end;
$fn$;
revoke all on function public.song_idea_credit(text, boolean, text) from public, anon, authenticated;
-- Unlike contains_banned_term/generate_dedication_code (022_dedications.sql),
-- this one IS called directly from a view's SELECT list (song_ideas_board,
-- point 5 below), not only from inside a SECURITY DEFINER function body. A
-- view's security_invoker setting governs how its underlying TABLES are
-- checked, not EXECUTE privilege on a function it calls -- that check
-- always runs as the actual querying role. So anon/authenticated need real
-- EXECUTE here for song_ideas_board to work for them at all. The function
-- itself stays a pure derivation (no table reads), so this is safe.
grant execute on function public.song_idea_credit(text, boolean, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 5. song_ideas_board: the only way anon or authenticated ever reads an
-- idea. security_invoker = false (the default, named explicitly to match
-- dedications_public's own convention) means it runs as its owner, which is
-- how it can read a table whose RLS is forced with zero policies: the
-- owner's own privileges apply, and the column list and WHERE clause are
-- what actually keep this safe, not a client-visible policy. user_id is
-- never a column here.
-- ------------------------------------------------------------
create or replace view public.song_ideas_board with (security_invoker = false) as
select
  si.id, si.idea_text,
  public.song_idea_credit(si.credit_name, si.is_anonymous, a.display_name) as credit,
  si.hearts_count, si.status, si.created_at,
  s.slug as released_song_slug
from public.song_ideas si
left join public.artists a on a.id = si.user_id
left join public.songs s on s.id = si.released_song_id and s.status = 'approved'
where si.show_on_board = true and si.status <> 'withdrawn';

grant select on public.song_ideas_board to anon, authenticated;

-- ------------------------------------------------------------
-- 6. submit_song_idea(): the one write path for a new idea. No rate cap, by
-- this prompt's own instruction.
-- ------------------------------------------------------------
create or replace function public.submit_song_idea(
  p_text text, p_credit_name text default null, p_is_anonymous boolean default false,
  p_show_on_board boolean default true, p_notify_email boolean default true
)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare
  v_uid    uuid := auth.uid();
  v_text   text;
  v_credit text;
  v_id     uuid;
begin
  if v_uid is null then
    raise exception 'Sign in to send a song idea.';
  end if;

  v_text := btrim(coalesce(p_text, ''));
  if char_length(v_text) < 1 or char_length(v_text) > 3000 then
    raise exception 'Your idea must be 1 to 3,000 characters.';
  end if;

  v_credit := nullif(btrim(coalesce(p_credit_name, '')), '');
  if v_credit is not null and char_length(v_credit) > 60 then
    raise exception 'The credit name must be 60 characters or fewer.';
  end if;

  if public.contains_banned_term(v_text) or public.contains_banned_term(v_credit) then
    raise exception 'That wording is not allowed here. Please rephrase it.';
  end if;

  insert into public.song_ideas (user_id, idea_text, credit_name, is_anonymous, show_on_board, notify_email)
  values (v_uid, v_text, v_credit, coalesce(p_is_anonymous, false), coalesce(p_show_on_board, true), coalesce(p_notify_email, true))
  returning id into v_id;

  -- "server": this write happens inside the database, not through the
  -- Worker's /event route, so there is no browser device id to carry.
  insert into public.activity_events (user_id, device_id, event_type, meta)
  values (v_uid, 'server', 'idea_submit', jsonb_build_object('idea_id', v_id));

  return v_id;
end;
$fn$;

revoke all on function public.submit_song_idea(text, text, boolean, boolean, boolean) from public, anon;
grant execute on function public.submit_song_idea(text, text, boolean, boolean, boolean) to authenticated;

-- ------------------------------------------------------------
-- 7. withdraw_my_song_idea(): the sender's own withdrawal path. Blocked once
-- released -- a song already made cannot be un-made by withdrawing the idea
-- behind it.
-- ------------------------------------------------------------
create or replace function public.withdraw_my_song_idea(p_id uuid)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_uid  uuid := auth.uid();
  v_rows int;
begin
  if v_uid is null then
    raise exception 'Sign in to withdraw a song idea.';
  end if;

  update public.song_ideas
     set status = 'withdrawn', updated_at = now()
   where id = p_id and user_id = v_uid and status <> 'released';
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'That idea could not be found, is not yours, or has already been released.';
  end if;
end;
$fn$;

revoke all on function public.withdraw_my_song_idea(uuid) from public, anon;
grant execute on function public.withdraw_my_song_idea(uuid) to authenticated;

-- ------------------------------------------------------------
-- 8. my_song_ideas(): the sender's own history, any status.
-- ------------------------------------------------------------
create or replace function public.my_song_ideas()
returns table (
  id uuid, idea_text text, credit_name text, is_anonymous boolean, show_on_board boolean,
  status text, hearts_count int, created_at timestamptz, picked_week date,
  released_song_id uuid, released_song_slug text, released_song_title text
)
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Sign in to see your song ideas.';
  end if;

  return query
    select si.id, si.idea_text, si.credit_name, si.is_anonymous, si.show_on_board,
      si.status, si.hearts_count, si.created_at, si.picked_week,
      si.released_song_id, s.slug, coalesce(nullif(s.title_translit, ''), s.title)
    from public.song_ideas si
    left join public.songs s on s.id = si.released_song_id
    where si.user_id = v_uid
    order by si.created_at desc;
end;
$fn$;

revoke all on function public.my_song_ideas() from public, anon;
grant execute on function public.my_song_ideas() to authenticated;

-- ------------------------------------------------------------
-- 9. toggle_song_idea_heart(): cannot heart your own idea. idea_heart is
-- logged only on an actual new heart (ON CONFLICT DO NOTHING leaves FOUND
-- false on a no-op re-heart), never on an un-heart.
-- ------------------------------------------------------------
create or replace function public.toggle_song_idea_heart(p_id uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_uid   uuid := auth.uid();
  v_owner uuid;
begin
  if v_uid is null then
    raise exception 'Sign in to heart a song idea.';
  end if;

  select user_id into v_owner from public.song_ideas where id = p_id;
  if v_owner is null then
    raise exception 'That idea could not be found.';
  end if;
  if v_owner = v_uid then
    raise exception 'You cannot heart your own idea.';
  end if;

  if coalesce(p_on, true) then
    insert into public.song_idea_hearts (idea_id, user_id) values (p_id, v_uid)
    on conflict (idea_id, user_id) do nothing;
    if found then
      insert into public.activity_events (user_id, device_id, event_type, meta)
      values (v_uid, 'server', 'idea_heart', jsonb_build_object('idea_id', p_id));
    end if;
  else
    delete from public.song_idea_hearts where idea_id = p_id and user_id = v_uid;
  end if;
end;
$fn$;

revoke all on function public.toggle_song_idea_heart(uuid, boolean) from public, anon;
grant execute on function public.toggle_song_idea_heart(uuid, boolean) to authenticated;

-- ------------------------------------------------------------
-- 10. songs.idea_id / songs.idea_credit: the credit line, frozen at release
-- time (not re-derived live) so it reads consistently even if the
-- submitter's display name or the idea's credit choice changes afterward.
-- idea_id is stripped from the public songs.json snapshot (internal
-- reference into a locked-down table); idea_credit is kept, the whole
-- point of this column.
-- ------------------------------------------------------------
alter table public.songs add column if not exists idea_id uuid references public.song_ideas(id);
alter table public.songs add column if not exists idea_credit text null;
alter table public.songs drop constraint if exists songs_idea_id_unique;
alter table public.songs add constraint songs_idea_id_unique unique (idea_id);

-- ------------------------------------------------------------
-- 11. Admin functions: the real submitter (name and email) always,
-- anonymous or not -- "anonymous" only ever hides the submitter from
-- song_ideas_board, the same convention DED-1 set for dedications.
-- ------------------------------------------------------------
create or replace function public.admin_list_song_ideas(
  p_status text default null, p_sort text default 'newest', p_limit int default 50, p_before timestamptz default null
)
returns table (
  id uuid, created_at timestamptz, status text, idea_text text,
  credit_name text, is_anonymous boolean, show_on_board boolean,
  hearts_count int, picked_week date,
  user_id uuid, submitter_name text, submitter_email text,
  released_song_id uuid, released_song_title text
)
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can list song ideas.';
  end if;

  if p_status is not null and p_status not in ('received', 'picked', 'in_studio', 'released', 'not_picked', 'withdrawn') then
    raise exception 'Unknown status filter.';
  end if;
  if p_sort not in ('newest', 'most_hearts') then
    raise exception 'Unknown sort.';
  end if;

  return query
    select si.id, si.created_at, si.status, si.idea_text,
      si.credit_name, si.is_anonymous, si.show_on_board,
      si.hearts_count, si.picked_week,
      si.user_id, a.display_name, u.email::text,
      si.released_song_id, coalesce(nullif(s.title_translit, ''), s.title)
    from public.song_ideas si
    left join public.artists a on a.id = si.user_id
    left join auth.users u on u.id = si.user_id
    left join public.songs s on s.id = si.released_song_id
    where (p_status is null or si.status = p_status)
      and (p_before is null or si.created_at < p_before)
    order by (case when p_sort = 'most_hearts' then si.hearts_count else 0 end) desc, si.created_at desc
    limit greatest(1, least(p_limit, 200));
end;
$fn$;

revoke all on function public.admin_list_song_ideas(text, text, int, timestamptz) from public, anon;
grant execute on function public.admin_list_song_ideas(text, text, int, timestamptz) to authenticated;

create or replace function public.admin_set_song_idea_status(p_id uuid, p_status text, p_released_song_id uuid default null)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_from        text;
  v_credit_name text;
  v_is_anon     boolean;
  v_user_id     uuid;
  v_display     text;
  v_credit      text;
  v_sunday      date;
  v_song_status text;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can change a song idea''s status.';
  end if;

  if p_status not in ('received', 'picked', 'in_studio', 'released', 'not_picked', 'withdrawn') then
    raise exception 'Unknown status.';
  end if;

  select status, credit_name, is_anonymous, user_id into v_from, v_credit_name, v_is_anon, v_user_id
    from public.song_ideas where id = p_id;
  if v_from is null then
    raise exception 'That idea could not be found.';
  end if;

  if p_status = 'released' then
    if p_released_song_id is null then
      raise exception 'Choose the song this idea became.';
    end if;
    select status into v_song_status from public.songs where id = p_released_song_id;
    if v_song_status is null then
      raise exception 'That song could not be found.';
    end if;

    select display_name into v_display from public.artists where id = v_user_id;
    v_credit := public.song_idea_credit(v_credit_name, v_is_anon, v_display);

    update public.songs set idea_id = p_id, idea_credit = v_credit where id = p_released_song_id;
    update public.song_ideas set status = 'released', released_song_id = p_released_song_id, updated_at = now() where id = p_id;
  elsif p_status = 'picked' then
    v_sunday := current_date + ((7 - extract(dow from current_date)::int) % 7);
    update public.song_ideas set status = 'picked', picked_week = v_sunday, updated_at = now() where id = p_id;
  else
    update public.song_ideas set status = p_status, updated_at = now() where id = p_id;
  end if;

  insert into public.activity_events (user_id, device_id, event_type, meta)
  values (auth.uid(), 'server', 'idea_status_change', jsonb_build_object('idea_id', p_id, 'from', v_from, 'to', p_status));
end;
$fn$;

revoke all on function public.admin_set_song_idea_status(uuid, text, uuid) from public, anon;
grant execute on function public.admin_set_song_idea_status(uuid, text, uuid) to authenticated;

create or replace function public.admin_week_picks(p_week date default null)
returns table (
  id uuid, idea_text text, status text, credit_name text, is_anonymous boolean,
  submitter_name text, released_song_id uuid, released_song_title text
)
language plpgsql security definer set search_path = public as $fn$
declare
  v_week date := coalesce(p_week, current_date + ((7 - extract(dow from current_date)::int) % 7));
begin
  if not public.is_admin() then
    raise exception 'Only an admin can list a week''s picks.';
  end if;

  return query
    select si.id, si.idea_text, si.status, si.credit_name, si.is_anonymous,
      a.display_name, si.released_song_id, coalesce(nullif(s.title_translit, ''), s.title)
    from public.song_ideas si
    left join public.artists a on a.id = si.user_id
    left join public.songs s on s.id = si.released_song_id
    where si.picked_week = v_week and si.status in ('picked', 'in_studio', 'released')
    order by si.created_at asc;
end;
$fn$;

revoke all on function public.admin_week_picks(date) from public, anon;
grant execute on function public.admin_week_picks(date) to authenticated;

-- ------------------------------------------------------------
-- 12. activity_events.event_type: add idea_status_change for admin pick/
-- studio/release/not-picked decisions. idea_submit and idea_heart already
-- existed in the check constraint (020_activity_log.sql); only this one is
-- new.
-- ------------------------------------------------------------
alter table public.activity_events drop constraint if exists activity_events_event_type_check;
alter table public.activity_events add constraint activity_events_event_type_check
  check (event_type in (
    'page_view', 'play_start', 'play_25', 'play_50', 'play_75', 'play_complete',
    'heart', 'unheart', 'rate', 'comment', 'follow', 'unfollow', 'share', 'search',
    'sign_in', 'sign_up', 'upload_submit', 'dedication', 'idea_submit', 'idea_heart',
    'idea_status_change'
  ));

-- ------------------------------------------------------------
-- 13. artist_badges: add "Idea made into a song" for the submitter's
-- profile. Recreated whole (CREATE OR REPLACE requires the same column
-- list and this adds a branch), switched from security_invoker = true to
-- = false: song_ideas is RLS-forced with zero policies, so an invoker-rights
-- read of it by anon would return nothing. Running as owner is the same,
-- already-documented tradeoff dedications_public makes (point 5 above) --
-- the SELECT list here emits only (artist_id, badge, value, sort), nothing
-- that was not already safe to aggregate. The six existing branches are
-- unchanged.
-- ------------------------------------------------------------
create or replace view public.artist_badges with (security_invoker = false) as
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
 group by artist_id
union all
-- NEW: at least one released idea, for the submitter -- songs.idea_id/
-- status='approved' only, so a since-unpublished song does not keep the
-- badge. Reads song_ideas directly (safe only because this view now runs
-- as owner, see header above); emits no idea text, no email.
select si.user_id as artist_id, 'idea_made_into_song'::text as badge, count(distinct si.id)::int as value, 11 as sort
  from public.song_ideas si
  join public.songs s on s.id = si.released_song_id and s.status = 'approved'
 where si.status = 'released'
 group by si.user_id;

grant select on public.artist_badges to anon, authenticated;

-- ------------------------------------------------------------
-- 14. build_daily_report(): add a "song_ideas" section, additive to every
-- key 015_daily_report.sql/021_pulse.sql/022_dedications.sql already wrote.
-- Same rolling 24-hour window the rest of this report already uses
-- (v_since). waiting_to_pick is a queue depth, not time-windowed, matching
-- how review_queue's own count works.
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
    ),

    -- DED-1: dedications sent in the last 24 hours. The real sender name is
    -- always shown here (this report is the owner's alone), prefixed
    -- "anonymous:" when the sender chose to hide from dedications_public.
    'dedications', (
      select jsonb_build_object(
        'count', count(*),
        'list', coalesce(jsonb_agg(jsonb_build_object(
                   'recipient', d.recipient_name,
                   'occasion', case when d.occasion = 'other' then d.occasion_other else replace(d.occasion, '_', ' ') end,
                   'song', coalesce(nullif(s.title_translit,''), s.title),
                   'sender', case when d.is_anonymous then 'anonymous: ' || coalesce(a.display_name, 'unknown')
                                  else coalesce(a.display_name, 'unknown') end
                 ) order by d.created_at desc), '[]'::jsonb))
        from public.dedications d
        left join public.songs s on s.id = d.song_id
        left join public.artists a on a.id = d.sender_user_id
       where d.created_at >= v_since and d.status = 'live'
    ),

    -- SONG-1: song ideas sent in the last 24 hours, plus how many are still
    -- sitting in the queue right now (not time-windowed, like review_queue).
    'song_ideas', (
      select jsonb_build_object(
        'count', count(*),
        'list', coalesce(jsonb_agg(jsonb_build_object(
                   'excerpt', left(si.idea_text, 120),
                   'credit', public.song_idea_credit(si.credit_name, si.is_anonymous, a.display_name)
                 ) order by si.created_at desc), '[]'::jsonb),
        'waiting_to_pick', (select count(*) from public.song_ideas where status = 'received'))
        from public.song_ideas si
        left join public.artists a on a.id = si.user_id
       where si.created_at >= v_since
    )
  ) into v_out;

  return v_out;
end;
$fn$;

revoke all on function public.build_daily_report() from public, anon;
grant execute on function public.build_daily_report() to authenticated, service_role;
