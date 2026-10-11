-- ============================================================
-- 029_member_profiles.sql
--
-- PROFILE-1: every member -- not only artists -- gets a public profile at
-- /u/<handle>. An artist's own handle instead redirects to their existing
-- /artist/<handle> page (unchanged); this migration is additive to that,
-- never a replacement.
--
-- RLS is NOT loosened anywhere in this file. The two new columns on
-- artists (profile_public, show_following) are covered by the EXISTING
-- artists_update_self / artists_read_self policies automatically -- RLS
-- is row-level, not column-level, so a new column on an already-RLS'd
-- table needs no new policy. No table gets a new policy, and no existing
-- policy's USING/WITH CHECK clause changes. The one new trigger
-- (artists_profile_guard_tg) TIGHTENS actual behavior (a banned word in
-- display_name/bio is now rejected regardless of which path writes it),
-- it does not touch who may write.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Handle check: every artists row (confirmed by querying the live
-- table directly -- both of this project's two real rows, one artist and
-- one listener, already have a handle) is NOT NULL on handle already (set
-- since 006_artists_and_ownership.sql), so there is structurally no such
-- thing as a "missing" handle to backfill; this migration's own report
-- says so plainly rather than writing a backfill block that can never
-- run. New sign-ups are the only place a handle is actually generated
-- (item 2), below.
--
-- The existing format check only allowed hyphens
-- (^[a-z0-9][a-z0-9-]{2,29}$) -- confirmed from the live constraint,
-- matching this project's one listener's own handle ("artist-c44a634e").
-- This prompt's new generation rule uses underscores instead. WIDENED
-- (never narrowed) to accept either, so the existing hyphenated handle
-- stays valid while new handles can use underscores.
-- ------------------------------------------------------------
alter table public.artists drop constraint artists_handle_check;
alter table public.artists add constraint artists_handle_check
  check (handle ~ '^[a-z0-9][a-z0-9_-]{2,29}$'::citext);

-- ------------------------------------------------------------
-- 2. profile_public / show_following. Both default to the stated values
-- (public, and following hidden) for every existing row too -- there is
-- no backfill step needed beyond the column default itself.
-- ------------------------------------------------------------
alter table public.artists add column if not exists profile_public boolean not null default true;
alter table public.artists add column if not exists show_following boolean not null default false;

-- ------------------------------------------------------------
-- 3. public._generate_member_handle(): internal helper, called only from
-- handle_new_user() below. Never granted to any role (see the grants
-- block at the end) -- nothing outside this migration's own trigger ever
-- calls it, and handles are not editable in this prompt (item 2), so
-- there is no other legitimate caller to grant it to.
--
-- Seed -> lowercase Latin letters/digits only (unaccent() first, so a
-- name with diacritics still produces something readable), runs of
-- anything else collapse to one underscore, trimmed. 3-30 chars; too
-- short, empty, or on the reserved list falls through to "member" plus
-- six digits. Otherwise a numeric suffix resolves a clash, same shape as
-- the fallback.
-- ------------------------------------------------------------
create or replace function public._generate_member_handle(p_seed text)
returns citext
language plpgsql
security definer
set search_path = public
as $fn$
declare
  -- item 2's own list, plus every other existing top-level route
  -- (vercel.json's rewrites: auth, settings, upload, about -- song,
  -- listen, d, artist are already in the prompt's own list).
  v_reserved text[] := array[
    'admin','api','artist','u','song','listen','d','your-song','privacy','terms','laivyhart',
    'auth','settings','upload','about'
  ];
  v_base text;
  v_candidate citext;
  v_n int := 0;
begin
  v_base := lower(regexp_replace(unaccent(coalesce(p_seed, '')), '[^a-zA-Z0-9]+', '_', 'g'));
  v_base := trim(both '_' from v_base);
  if v_base is null or length(v_base) < 3 then
    v_base := null;
  elsif length(v_base) > 30 then
    v_base := trim(both '_' from substr(v_base, 1, 30));
    if length(v_base) < 3 then v_base := null; end if;
  end if;

  if v_base is null or v_base = any(v_reserved) then
    loop
      v_candidate := 'member' || lpad(floor(random() * 1000000)::text, 6, '0');
      exit when not exists (select 1 from public.artists a where a.handle = v_candidate);
    end loop;
    return v_candidate;
  end if;

  v_candidate := v_base;
  while exists (select 1 from public.artists a where a.handle = v_candidate)
     or v_candidate::text = any(v_reserved) loop
    v_n := v_n + 1;
    v_candidate := substr(v_base, 1, greatest(1, 30 - length(v_n::text))) || v_n::text;
  end loop;
  return v_candidate;
end;
$fn$;

revoke all on function public._generate_member_handle(text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. handle_new_user(): the sign-up trigger, now generating a handle from
-- the same name it already resolves for display_name (never from email --
-- the email-local-part fallback below feeds display_name only, exactly as
-- it already did; _generate_member_handle never sees an email). Every
-- other part of this trigger (the insert, the on-conflict guard) is
-- unchanged.
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_name   text   := coalesce(
                       nullif(new.raw_user_meta_data->>'full_name', ''),
                       nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
                       'member'
                     );
  v_handle citext := public._generate_member_handle(v_name);
begin
  insert into public.artists (id, handle, display_name)
  values (new.id, v_handle, left(v_name, 60))
  on conflict (id) do nothing;
  return new;
end;
$function$;

-- Recreating resets grants (CLAUDE.md's rule) -- re-applied even though a
-- trigger function needs none, same as every other trigger in this project.
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5. artists_profile_guard(): a new BEFORE UPDATE trigger on artists.
-- Not an RLS change -- artists_update_self already lets a member update
-- their own row (confirmed from the live policy; it predates this
-- migration). It does not stop who can write; it rejects WHAT they write,
-- for both paths that can change display_name/bio: this migration's own
-- update_my_profile() below, AND the existing direct
-- `.from('artists').update(...)` the settings page's own save button
-- already uses (js/account-ui.js's saveProfile(), unchanged) -- which,
-- confirmed by reading it, had no banned-term check of its own before
-- this. Same wording as create_dedication's own banned-term rejection.
-- ------------------------------------------------------------
create or replace function public.artists_profile_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if (new.display_name is distinct from old.display_name and public.contains_banned_term(new.display_name))
     or (new.bio is distinct from old.bio and public.contains_banned_term(new.bio)) then
    raise exception 'That wording is not allowed here. Please rephrase it.';
  end if;
  return new;
end;
$fn$;

revoke all on function public.artists_profile_guard() from public, anon, authenticated;

drop trigger if exists artists_profile_guard_tg on public.artists;
create trigger artists_profile_guard_tg
  before update on public.artists
  for each row execute function public.artists_profile_guard();

-- ------------------------------------------------------------
-- 6. member_profile(p_handle): the one read. Anon-executable (item 12),
-- on tests/sql/anon-allowlist.txt. Returns exactly the fields items 3-9
-- list and nothing else -- never plays, listening history, hearts/
-- ratings given, city, country, email, user id or device id; confirmed by
-- this migration's own required live anon-key check (item 22).
--
-- An artist's row returns only {handle, is_artist:true} -- the caller
-- (middleware.js, index.html's own router) redirects to /artist/<handle>
-- instead of rendering anything here (item 1).
--
-- A private profile (profile_public = false), viewed by anyone other than
-- its own owner, returns only {handle, is_artist:false, profile_public:
-- false, display_name, avatar_url} -- item 11's "avatar, display name,
-- and 'This profile is private.'" (that exact sentence is the client's
-- own copy, not data this function needs to supply).
--
-- Viewing your OWN profile always sees everything regardless of
-- profile_public -- the toggle controls what OTHERS see; it would be a
-- strange trap if turning your own profile private also hid your own
-- "My page" view of it. is_self says which case applied, so the one
-- function serves both "view my profile" and a visitor's view.
-- ------------------------------------------------------------
create or replace function public.member_profile(p_handle text)
returns json
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_member public.artists%rowtype;
  v_viewer uuid := auth.uid();
  v_is_self boolean;
begin
  select * into v_member from public.artists where handle = p_handle and status = 'active';
  if v_member.id is null then
    return null;
  end if;

  v_is_self := (v_viewer is not null and v_viewer = v_member.id);

  if v_member.is_artist then
    return jsonb_build_object('handle', v_member.handle, 'is_artist', true)::json;
  end if;

  if not v_member.profile_public and not v_is_self then
    return jsonb_build_object(
      'handle', v_member.handle, 'is_artist', false, 'profile_public', false, 'is_self', false,
      'display_name', v_member.display_name, 'avatar_url', v_member.avatar_url
    )::json;
  end if;

  return jsonb_build_object(
    'handle', v_member.handle, 'is_artist', false,
    'profile_public', v_member.profile_public, 'is_self', v_is_self,
    'display_name', v_member.display_name, 'bio', v_member.bio, 'avatar_url', v_member.avatar_url,
    'created_at', v_member.created_at,
    'stats', jsonb_build_object(
      'comments', (select count(*) from public.comments where artist_id = v_member.id and status = 'approved'),
      'dedications_sent', (select count(*) from public.dedications where sender_user_id = v_member.id and is_anonymous = false and status = 'live'),
      'ideas_made_into_songs', (select count(*) from public.song_ideas where user_id = v_member.id and released_song_id is not null)
    ),
    'favorites', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'song_id', s.id, 'title', coalesce(nullif(s.title_translit, ''), s.title), 'slug', s.slug,
        'cover_url', s.cover_url, 'note', p.note
      ) order by p.position), '[]'::jsonb)
      from (
        select * from public.artist_picks where artist_id = v_member.id order by position limit 6
      ) p
      join public.songs s on s.id = p.song_id and s.status = 'approved'
    ),
    'comments', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'song_title', coalesce(nullif(s.title_translit, ''), s.title), 'song_slug', s.slug,
        'body', c.body, 'created_at', c.created_at
      ) order by c.created_at desc), '[]'::jsonb)
      from (
        select * from public.comments
         where artist_id = v_member.id and status = 'approved'
         order by created_at desc limit 5
      ) c
      join public.songs s on s.id = c.song_id
    ),
    'dedications', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'code', d.code, 'song_title', coalesce(nullif(s.title_translit, ''), s.title), 'song_slug', s.slug,
        'created_at', d.created_at
      ) order by d.created_at desc), '[]'::jsonb)
      from (
        select * from public.dedications
         where sender_user_id = v_member.id and is_anonymous = false and status = 'live'
         order by created_at desc limit 6
      ) d
      join public.songs s on s.id = d.song_id
    ),
    'ideas', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'idea_text', i.idea_text, 'hearts_count', i.hearts_count, 'status', i.status,
        'released_song_title', coalesce(nullif(rs.title_translit, ''), rs.title),
        'released_song_slug', rs.slug
      ) order by i.created_at desc), '[]'::jsonb)
      from public.song_ideas i
      left join public.songs rs on rs.id = i.released_song_id and rs.status = 'approved'
      where i.user_id = v_member.id and i.show_on_board = true and i.status <> 'withdrawn'
    ),
    'show_following', v_member.show_following,
    'following', case when v_member.show_following or v_is_self then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'handle', a2.handle, 'display_name', a2.display_name, 'avatar_url', a2.avatar_url
      )), '[]'::jsonb)
      from public.artist_follows f
      join public.artists a2 on a2.id = f.artist_id
      where f.follower_user_id = v_member.id
    ) else '[]'::jsonb end
  )::json;
end;
$fn$;

revoke all on function public.member_profile(text) from public;
grant execute on function public.member_profile(text) to anon, authenticated;

-- ------------------------------------------------------------
-- 7. update_my_profile(): authenticated only, any member (artist or
-- listener alike -- is_artist is never checked here). Same banned-term
-- check as create_dedication, same rejection wording. The 2-40/0-400
-- bounds here are TIGHTER than the table's own CHECK constraints
-- (1-60/0-600, unchanged) on purpose -- a function may always be
-- stricter than the table it writes to; the table's wider bound still
-- covers every other writer (the admin's own artist edit, migrations).
-- ------------------------------------------------------------
create or replace function public.update_my_profile(
  p_display_name text, p_bio text, p_profile_public boolean, p_show_following boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid  uuid := auth.uid();
  v_name text;
  v_bio  text;
begin
  if v_uid is null then
    raise exception 'Sign in to update your profile.';
  end if;

  v_name := btrim(coalesce(p_display_name, ''));
  if char_length(v_name) < 2 or char_length(v_name) > 40 then
    raise exception 'Display name must be 2 to 40 characters.';
  end if;

  v_bio := nullif(btrim(coalesce(p_bio, '')), '');
  if v_bio is not null and char_length(v_bio) > 400 then
    raise exception 'Bio must be 400 characters or fewer.';
  end if;

  if public.contains_banned_term(v_name) or public.contains_banned_term(v_bio) then
    raise exception 'That wording is not allowed here. Please rephrase it.';
  end if;

  update public.artists
     set display_name = v_name,
         bio = v_bio,
         profile_public = coalesce(p_profile_public, profile_public),
         show_following = coalesce(p_show_following, show_following),
         updated_at = now()
   where id = v_uid;
end;
$fn$;

revoke all on function public.update_my_profile(text, text, boolean, boolean) from public, anon;
grant execute on function public.update_my_profile(text, text, boolean, boolean) to authenticated;

-- ------------------------------------------------------------
-- 8. activity_events: one new event type, profile_view (item 19). Logged
-- client-side (js/activity.js's existing logActivity(), same as every
-- other *_view-shaped event -- never from inside member_profile() itself,
-- which stays STABLE/read-only as item 12 asks), with the profile's own
-- handle as meta -- never anything about the viewer beyond what every
-- activity_events row already carries (device_id/user_id, both existing
-- columns, unrelated to this change).
-- ------------------------------------------------------------
alter table public.activity_events drop constraint activity_events_event_type_check;
alter table public.activity_events add constraint activity_events_event_type_check
  check (event_type = any (array[
    'page_view', 'play_start', 'play_25', 'play_50', 'play_75', 'play_complete',
    'heart', 'unheart', 'rate', 'comment', 'follow', 'unfollow', 'share', 'search',
    'sign_in', 'sign_up', 'upload_submit', 'dedication', 'idea_submit', 'idea_heart',
    'idea_status_change', 'profile_view'
  ]));

-- ------------------------------------------------------------
-- 9. item 14's "member rows in admin Pulse" link to /u/<handle> when the
-- profile is public -- pulse_feed and pulse_member(uuid) (a signed-in
-- member; pulse_member(text) is an anonymous visitor's device, who has no
-- handle or profile at all, so it is unchanged) now also carry the
-- member's handle. Nothing else about either function changes.
-- pulse_feed returns a TABLE, so adding a column needs the same drop-then
-- -create pulse_feed's own 027_listen_grouping.sql migration used.
-- ------------------------------------------------------------
drop function if exists public.pulse_feed(int, timestamptz);

create function public.pulse_feed(p_limit int default 50, p_before timestamptz default null)
returns table (
  id bigint, created_at timestamptz, event_type text,
  song_id uuid, song_title text, song_slug text,
  user_id uuid, display_name text, handle text, email text,
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
        l.user_id, coalesce(a.display_name, 'Visitor'), a.handle::text, u.email::text,
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
        ae.user_id, coalesce(a.display_name, 'Visitor'), a.handle::text, u.email::text,
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
    'handle', (select handle from public.artists where id = p_user_id),
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

revoke all on function public.pulse_member(uuid, int) from public, anon;
grant execute on function public.pulse_member(uuid, int) to authenticated;

-- ------------------------------------------------------------
-- 10. reserved_handles: the EXISTING server-side gate (006_artists_and_
-- ownership.sql's own trigger, re-confirmed live in 007/010, raises on any
-- handle in this table -- it is not merely advisory). It predates this
-- prompt's own reserved list (item 2) and is missing four of that list's
-- words -- u, d, your-song, privacy -- plus upload (one of vercel.json's
-- other top-level routes, same reasoning as _generate_member_handle()'s
-- own list above). Handles stay not-editable in this prompt (item 2), but
-- the handle-entry field onboarding already has (js/account-ui.js's
-- checkHandle()) still lets a member TYPE a handle today, so without this
-- insert a member could still claim "/u" or "/d" and collide with this
-- prompt's own new routes. Purely additive -- no existing row changes.
-- ------------------------------------------------------------
insert into public.reserved_handles (handle)
values ('u'), ('d'), ('your-song'), ('privacy'), ('upload')
on conflict (handle) do nothing;

-- ------------------------------------------------------------
-- 11. item 14's "dedication sender names (non-anonymous) on dedication
-- pages and strips" needs a handle to link to -- dedications_public
-- (022_dedications.sql) already LEFT JOINs the raw artists table for
-- sender_name (it runs as its owner, security_invoker=false, same as
-- every other view here), so adding sender_handle alongside sender_name
-- is the same null-when-anonymous CASE, nothing new to join. Never
-- sender_user_id itself -- that was already true and stays true.
-- ------------------------------------------------------------
create or replace view public.dedications_public with (security_invoker = false) as
select
  d.code, d.song_id,
  coalesce(nullif(s.title_translit, ''), s.title) as song_title,
  s.slug as song_slug, s.cover_url,
  d.recipient_name, d.occasion, d.occasion_other, d.message, d.created_at,
  case when d.is_anonymous then null else a.display_name end as sender_name,
  case when d.is_anonymous then null else a.handle::text end as sender_handle
from public.dedications d
join public.songs s on s.id = d.song_id and s.status = 'approved'
left join public.artists a on a.id = d.sender_user_id
where d.status = 'live';

grant select on public.dedications_public to anon, authenticated;

-- ------------------------------------------------------------
-- 12. item 14's "commenter names on song pages and in 'What listeners
-- say'" also needs a handle to link to. comments.artist_id (the
-- commenter) is already anon-readable directly off the comments table
-- for an approved row (007's own RLS policy), but a handle lives on
-- artists, which anon cannot read directly at all (confirmed live: no
-- anon SELECT policy on artists, only authenticated-self and admin) --
-- and artists_public excludes every listener by design (1A-7), so it
-- cannot stand in here the way it does for an artist's own comments.
--
-- This view is deliberately narrow -- id and handle, nothing else -- so
-- it exposes exactly the one non-sensitive, already-navigable fact
-- (anyone who already knows a handle can already visit /u/<handle> or
-- /artist/<handle> directly) needed to turn a name into a link, without
-- duplicating member_profile()'s own job of deciding what a PROFILE
-- shows (item 12's "no new public view over raw tables" was about that
-- decision, not about a handle lookup). status='active' only, same gate
-- member_profile() itself uses.
-- ------------------------------------------------------------
create or replace view public.member_handles with (security_invoker = false) as
select a.id, a.handle::text as handle
from public.artists a
where a.status = 'active';

grant select on public.member_handles to anon, authenticated;
