-- ============================================================
-- 032_dedication_show_publicly.sql
--
-- SHOW-1: a dedication appears in public places only when its sender ticked
-- "Also show this on Laivy Hart". Off by default. The /d/<code> page keeps
-- working for anyone who has the link either way -- that is how the person
-- it is for opens it -- through dedication_by_code(), which the lists never
-- use. /d/ pages are noindex always (middleware.js) and never in the
-- sitemap (a static file with no /d/ entries).
--
-- Public places, all filtered here to show_publicly = true:
--   dedications_public (the view)  -> the Dedications strip on a song
--   public_ticker()                -> the homepage / listen ticker
--   member_profile()               -> /u/<handle>: the list and the count
-- The admin's list and the owner's daily report stay unfiltered (private).
--
-- Recipient emails stay out of every one of these (sql/031): none of the
-- definitions below names an email column.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The column, and the rows that exist today: on for the site owner's
-- own (account handle 'laivyhart'), so the strip keeps showing them; off
-- for everyone else's. The backfill runs only in the run that adds the
-- column, so running this file again never resets a sender's later choice.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'dedications' and column_name = 'show_publicly'
  ) then
    alter table public.dedications add column show_publicly boolean not null default false;
    update public.dedications d
       set show_publicly = exists (
         select 1 from public.artists a where a.id = d.sender_user_id and a.handle = 'laivyhart'
       );
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. dedications_public: the lists' view, public dedications only. Same
-- columns as before (029), still no email column, no sender_user_id.
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
where d.status = 'live' and d.show_publicly;

grant select on public.dedications_public to anon, authenticated;

-- ------------------------------------------------------------
-- 3. dedication_by_code(): ONE live dedication by its code, public or not,
-- for its own /d/<code> page and that page's link preview. The code is the
-- key (8 characters from 31, unguessable); there is no way to list.
-- ------------------------------------------------------------
create or replace function public.dedication_by_code(p_code text)
returns table (
  code text, song_id uuid, song_title text, song_slug text, cover_url text,
  recipient_name text, occasion text, occasion_other text, message text,
  created_at timestamptz, sender_name text, sender_handle text, show_publicly boolean
)
language sql stable security definer set search_path = public as $fn$
  select d.code, d.song_id,
    coalesce(nullif(s.title_translit, ''), s.title), s.slug, s.cover_url,
    d.recipient_name, d.occasion, d.occasion_other, d.message, d.created_at,
    case when d.is_anonymous then null else a.display_name end,
    case when d.is_anonymous then null else a.handle::text end,
    d.show_publicly
  from public.dedications d
  join public.songs s on s.id = d.song_id and s.status = 'approved'
  left join public.artists a on a.id = d.sender_user_id
  where d.code = p_code and d.status = 'live';
$fn$;
revoke all on function public.dedication_by_code(text) from public, anon;
grant execute on function public.dedication_by_code(text) to anon, authenticated;

-- ------------------------------------------------------------
-- 4. create_dedication(): one new argument, p_show_publicly (default off).
-- Dropped and recreated (a new signature), grants re-applied below.
-- Everything else is exactly 023's body.
-- ------------------------------------------------------------
drop function if exists public.create_dedication(uuid, text, text, text, text, boolean);
create or replace function public.create_dedication(
  p_song_id uuid, p_recipient_name text, p_occasion text,
  p_occasion_other text, p_message text, p_is_anonymous boolean,
  p_show_publicly boolean default false
)
returns text language plpgsql security definer set search_path = public as $fn$
declare
  v_uid       uuid := auth.uid();
  v_status    text;
  v_recipient text;
  v_message   text;
  v_other     text;
  v_code      text;
  v_cap       int := 30;
  v_recent    int;
begin
  if v_uid is null then
    raise exception 'Sign in to send a dedication.';
  end if;

  select status into v_status from public.songs where id = p_song_id;
  if v_status is null or v_status is distinct from 'approved' then
    raise exception 'This song is not available.';
  end if;

  v_recipient := btrim(coalesce(p_recipient_name, ''));
  if char_length(v_recipient) < 1 or char_length(v_recipient) > 60 then
    raise exception 'The recipient''s name must be 1 to 60 characters.';
  end if;

  if p_occasion not in (
    'birthday', 'engagement', 'wedding', 'anniversary', 'bar_mitzvah', 'bat_mitzvah',
    'new_baby', 'bris', 'upsherin', 'graduation', 'siyum', 'new_job', 'new_home',
    'aliyah', 'retirement', 'refuah_shleimah', 'encouragement', 'thank_you',
    'in_memory', 'just_because', 'other'
  ) then
    raise exception 'Unknown occasion.';
  end if;

  v_other := nullif(btrim(coalesce(p_occasion_other, '')), '');
  if p_occasion = 'other' then
    if v_other is null then
      raise exception 'Describe the occasion in a few words.';
    end if;
    if char_length(v_other) > 40 then
      raise exception 'Describe the occasion in 40 characters or fewer.';
    end if;
  else
    v_other := null;
  end if;

  v_message := nullif(btrim(coalesce(p_message, '')), '');
  if v_message is not null and char_length(v_message) > 280 then
    raise exception 'The message must be 280 characters or fewer.';
  end if;

  if public.contains_banned_term(v_recipient)
     or public.contains_banned_term(v_message)
     or public.contains_banned_term(v_other) then
    raise exception 'That wording is not allowed here. Please rephrase it.';
  end if;

  select count(*) into v_recent
    from public.dedications
   where sender_user_id = v_uid and created_at > now() - interval '24 hours';
  if v_recent >= v_cap then
    raise exception 'You can send at most % dedications per day.', v_cap;
  end if;

  v_code := public.generate_dedication_code();

  insert into public.dedications (
    code, song_id, sender_user_id, is_anonymous, recipient_name, occasion, occasion_other, message, show_publicly
  ) values (
    v_code, p_song_id, v_uid, coalesce(p_is_anonymous, false), v_recipient, p_occasion, v_other, v_message,
    coalesce(p_show_publicly, false)
  );

  insert into public.activity_events (user_id, device_id, event_type, song_id, meta)
  values (v_uid, 'server', 'dedication', p_song_id,
          jsonb_build_object('occasion', p_occasion, 'is_anonymous', coalesce(p_is_anonymous, false)));

  return v_code;
end;
$fn$;
revoke all on function public.create_dedication(uuid, text, text, text, text, boolean, boolean) from public, anon;
grant execute on function public.create_dedication(uuid, text, text, text, text, boolean, boolean) to authenticated;

-- ------------------------------------------------------------
-- 5. my_dedications(): the sender's own list now carries show_publicly, for
-- the "Shown on site" switch. A new column means drop and recreate.
-- ------------------------------------------------------------
drop function if exists public.my_dedications();
create or replace function public.my_dedications()
returns table (
  code text, created_at timestamptz, status text, song_id uuid, song_title text, song_slug text,
  recipient_name text, occasion text, occasion_other text, message text, is_anonymous boolean,
  show_publicly boolean
)
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Sign in to see your dedications.';
  end if;

  return query
    select d.code, d.created_at, d.status, d.song_id,
      coalesce(nullif(s.title_translit, ''), s.title), s.slug,
      d.recipient_name, d.occasion, d.occasion_other, d.message, d.is_anonymous,
      d.show_publicly
    from public.dedications d
    left join public.songs s on s.id = d.song_id
    where d.sender_user_id = v_uid
    order by d.created_at desc;
end;
$fn$;
revoke all on function public.my_dedications() from public, anon;
grant execute on function public.my_dedications() to authenticated;

-- ------------------------------------------------------------
-- 6. set_my_dedication_public(): the switch. The sender's own live
-- dedications only.
-- ------------------------------------------------------------
create or replace function public.set_my_dedication_public(p_code text, p_show boolean)
returns boolean language plpgsql security definer set search_path = public as $fn$
declare
  v_uid  uuid := auth.uid();
  v_rows int;
begin
  if v_uid is null then
    raise exception 'Sign in to change your dedication.';
  end if;
  update public.dedications
     set show_publicly = coalesce(p_show, false)
   where code = p_code and sender_user_id = v_uid and status = 'live';
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'That dedication is not yours, or it was removed.';
  end if;
  return coalesce(p_show, false);
end;
$fn$;
revoke all on function public.set_my_dedication_public(text, boolean) from public, anon;
grant execute on function public.set_my_dedication_public(text, boolean) to authenticated;

-- ------------------------------------------------------------
-- 7. public_ticker(): 027's body with one line added -- the dedication
-- events come only from public dedications.
-- ------------------------------------------------------------
create or replace function public.public_ticker(p_limit integer default 20)
returns table(kind text, song_title text, song_slug text, display_city text, display_country text, created_at timestamptz)
language plpgsql security definer set search_path = public as $fn$
declare
  v_since timestamptz := now() - interval '7 days';
begin
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
       where d.status = 'live' and d.show_publicly and d.created_at >= v_since
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
revoke all on function public.public_ticker(integer) from public, anon;
grant execute on function public.public_ticker(integer) to anon, authenticated;

-- ------------------------------------------------------------
-- 8. member_profile(): 029's body with the dedications count and list
-- limited to public dedications (still never anonymous ones).
-- ------------------------------------------------------------
create or replace function public.member_profile(p_handle text)
returns json language plpgsql stable security definer set search_path = public as $fn$
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
      'dedications_sent', (select count(*) from public.dedications where sender_user_id = v_member.id and is_anonymous = false and status = 'live' and show_publicly),
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
         where sender_user_id = v_member.id and is_anonymous = false and status = 'live' and show_publicly
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
revoke all on function public.member_profile(text) from public, anon;
grant execute on function public.member_profile(text) to anon, authenticated;
