-- ============================================================
-- 022_dedications.sql
--
-- DED-1: a signed-in member dedicates a song to someone for an occasion,
-- with a short message, optionally anonymously. Recipients are a name only
-- -- no email is ever collected for them. Dedications go live immediately;
-- the owner can remove any, a sender can remove their own.
--
-- LOCKDOWN. Both new tables are RLS enabled and FORCED with zero policies,
-- the same pattern every table in this project already uses (ratings,
-- activity_events). All access goes through SECURITY DEFINER functions or
-- the dedications_public view. This project's default privileges grant a
-- new function's execute to anon directly (confirmed in ACT-1/ACT-2), so
-- every function here is revoked from public AND anon explicitly before
-- granting exactly what it needs.
-- ============================================================

-- ------------------------------------------------------------
-- 1. dedications
-- ------------------------------------------------------------
create table if not exists public.dedications (
  id               uuid primary key default gen_random_uuid(),
  code             text unique not null,
  song_id          uuid not null references public.songs(id),
  sender_user_id   uuid not null references auth.users(id),
  is_anonymous     boolean not null default false,
  recipient_name   text not null,
  occasion         text not null check (occasion in (
    'birthday', 'wedding', 'anniversary', 'bar_bat_mitzvah', 'new_baby',
    'refuah_shleimah', 'in_memory', 'thank_you', 'just_because', 'other'
  )),
  occasion_other   text null,
  message          text null,
  status           text not null default 'live' check (status in ('live', 'removed')),
  removed_by       text null check (removed_by in ('sender', 'admin')),
  removed_reason   text null,
  created_at       timestamptz not null default now(),
  constraint dedications_recipient_len check (char_length(recipient_name) between 1 and 60),
  constraint dedications_occasion_other_len check (occasion_other is null or char_length(occasion_other) <= 40),
  constraint dedications_message_len check (message is null or char_length(message) <= 280)
);

create index if not exists dedications_song_created_idx   on public.dedications (song_id, created_at desc);
create index if not exists dedications_sender_created_idx on public.dedications (sender_user_id, created_at desc);
create index if not exists dedications_code_idx           on public.dedications (code);

alter table public.dedications enable row level security;
alter table public.dedications force row level security;
-- No policies at all: every read/write goes through a SECURITY DEFINER
-- function below, or (for the public-safe columns) the view after this.

-- ------------------------------------------------------------
-- 2. banned_terms -- a short admin-editable deny list. Seeded here with
-- obvious English and Hebrew slurs/profanity; the admin UI to edit this is
-- a later prompt, not this one. Stored lower-case: contains_banned_term()
-- below lower-cases its input the same way before comparing.
-- ------------------------------------------------------------
create table if not exists public.banned_terms (
  term text primary key
);

alter table public.banned_terms enable row level security;
alter table public.banned_terms force row level security;
-- No policies: not readable or writable by anon or authenticated. Only
-- contains_banned_term() (SECURITY DEFINER, below) ever reads this table.

insert into public.banned_terms (term) values
  ('fuck'), ('fucking'), ('shit'), ('bitch'), ('cunt'),
  ('nigger'), ('nigga'), ('faggot'), ('fag'), ('retard'),
  ('whore'), ('slut'), ('asshole'), ('bastard'), ('dick'), ('cock'),
  ('זונה'), ('שרמוטה'), ('זין'), ('חרא'), ('מניאק'), ('בן זונה'), ('קללה')
on conflict (term) do nothing;

-- ------------------------------------------------------------
-- 3. contains_banned_term: whole-word, case-insensitive. Splits on any
-- run of non-alphanumeric characters rather than building a regex out of
-- the term itself, so a term with regex-special characters can never break
-- or be used to inject a pattern. [:alnum:] is locale-aware in this
-- project's UTF8 database, so a Hebrew word splits the same way an ASCII
-- one does. Internal helper only -- revoked from every client role below;
-- create_dedication() still reaches it because a SECURITY DEFINER function
-- runs its own body, including nested calls, as its owner.
-- ------------------------------------------------------------
create or replace function public.contains_banned_term(p_text text)
returns boolean language plpgsql stable set search_path = public as $fn$
declare
  v_words text[];
begin
  if p_text is null or btrim(p_text) = '' then
    return false;
  end if;
  v_words := regexp_split_to_array(lower(p_text), '[^[:alnum:]]+');
  return exists (select 1 from public.banned_terms t where t.term = any(v_words));
end;
$fn$;
revoke all on function public.contains_banned_term(text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. generate_dedication_code: 8 characters, an unambiguous alphabet (no
-- 0/O, 1/I/L), retried on collision. Internal helper, same reasoning as
-- contains_banned_term above.
-- ------------------------------------------------------------
create or replace function public.generate_dedication_code()
returns text language plpgsql volatile set search_path = public as $fn$
declare
  v_alphabet text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_code text;
  v_tries int := 0;
begin
  loop
    v_code := '';
    for i in 1..8 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    if not exists (select 1 from public.dedications where code = v_code) then
      return v_code;
    end if;
    v_tries := v_tries + 1;
    if v_tries > 20 then
      raise exception 'Could not generate a unique dedication code.';
    end if;
  end loop;
end;
$fn$;
revoke all on function public.generate_dedication_code() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5. dedications_public: the only way anon or authenticated ever reads a
-- dedication. security_invoker = false (the default, named explicitly to
-- match this project's own convention on artists_public) means it runs as
-- its owner, which is how it can read a table whose RLS is forced with zero
-- policies: the owner's own privileges apply, and the column list and WHERE
-- clause are what actually keep this safe, not a client-visible policy.
-- sender_user_id is never a column here, anonymous or not.
-- ------------------------------------------------------------
create or replace view public.dedications_public with (security_invoker = false) as
select
  d.code, d.song_id,
  coalesce(nullif(s.title_translit, ''), s.title) as song_title,
  s.slug as song_slug, s.cover_url,
  d.recipient_name, d.occasion, d.occasion_other, d.message, d.created_at,
  case when d.is_anonymous then null else a.display_name end as sender_name
from public.dedications d
join public.songs s on s.id = d.song_id and s.status = 'approved'
left join public.artists a on a.id = d.sender_user_id
where d.status = 'live';

grant select on public.dedications_public to anon, authenticated;

-- ------------------------------------------------------------
-- 6. create_dedication(): the one write path for a new dedication.
-- ------------------------------------------------------------
create or replace function public.create_dedication(
  p_song_id uuid, p_recipient_name text, p_occasion text,
  p_occasion_other text, p_message text, p_is_anonymous boolean
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

  if p_occasion not in ('birthday', 'wedding', 'anniversary', 'bar_bat_mitzvah', 'new_baby',
                         'refuah_shleimah', 'in_memory', 'thank_you', 'just_because', 'other') then
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
    v_other := null; -- ignored unless the occasion is "other"
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
    code, song_id, sender_user_id, is_anonymous, recipient_name, occasion, occasion_other, message
  ) values (
    v_code, p_song_id, v_uid, coalesce(p_is_anonymous, false), v_recipient, p_occasion, v_other, v_message
  );

  -- "server" is not a real device: this write happens inside the database,
  -- not through the Worker's /event route, so there is no browser device id
  -- to carry. country/city stay null, as this prompt asks.
  insert into public.activity_events (user_id, device_id, event_type, song_id, meta)
  values (v_uid, 'server', 'dedication', p_song_id,
          jsonb_build_object('occasion', p_occasion, 'is_anonymous', coalesce(p_is_anonymous, false)));

  return v_code;
end;
$fn$;

revoke all on function public.create_dedication(uuid, text, text, text, text, boolean) from public, anon;
grant execute on function public.create_dedication(uuid, text, text, text, text, boolean) to authenticated;

-- ------------------------------------------------------------
-- 7. remove_my_dedication(): the sender's own removal path.
-- ------------------------------------------------------------
create or replace function public.remove_my_dedication(p_code text)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_uid  uuid := auth.uid();
  v_rows int;
begin
  if v_uid is null then
    raise exception 'Sign in to remove a dedication.';
  end if;

  update public.dedications
     set status = 'removed', removed_by = 'sender'
   where code = p_code and sender_user_id = v_uid and status = 'live';
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'That dedication could not be found, is not yours, or is already removed.';
  end if;
end;
$fn$;

revoke all on function public.remove_my_dedication(text) from public, anon;
grant execute on function public.remove_my_dedication(text) to authenticated;

-- ------------------------------------------------------------
-- 8. my_dedications(): the sender's own history, any status.
-- ------------------------------------------------------------
create or replace function public.my_dedications()
returns table (
  code text, created_at timestamptz, status text,
  song_id uuid, song_title text, song_slug text,
  recipient_name text, occasion text, occasion_other text, message text, is_anonymous boolean
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
      d.recipient_name, d.occasion, d.occasion_other, d.message, d.is_anonymous
    from public.dedications d
    left join public.songs s on s.id = d.song_id
    where d.sender_user_id = v_uid
    order by d.created_at desc;
end;
$fn$;

revoke all on function public.my_dedications() from public, anon;
grant execute on function public.my_dedications() to authenticated;

-- ------------------------------------------------------------
-- 9. Admin functions: the real sender (name and email) always, anonymous
-- or not -- "anonymous" only ever hides the sender from dedications_public.
-- ------------------------------------------------------------
create or replace function public.admin_list_dedications(p_status text default null, p_limit int default 50, p_before timestamptz default null)
returns table (
  code text, created_at timestamptz, status text,
  song_id uuid, song_title text, song_slug text,
  recipient_name text, occasion text, occasion_other text, message text,
  is_anonymous boolean, sender_user_id uuid, sender_name text, sender_email text,
  removed_by text, removed_reason text
)
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can list dedications.';
  end if;

  if p_status is not null and p_status not in ('live', 'removed') then
    raise exception 'Unknown status filter.';
  end if;

  return query
    select
      d.code, d.created_at, d.status,
      d.song_id, coalesce(nullif(s.title_translit, ''), s.title), s.slug,
      d.recipient_name, d.occasion, d.occasion_other, d.message,
      d.is_anonymous, d.sender_user_id, a.display_name, u.email::text,
      d.removed_by, d.removed_reason
    from public.dedications d
    left join public.songs s on s.id = d.song_id
    left join public.artists a on a.id = d.sender_user_id
    left join auth.users u on u.id = d.sender_user_id
    where (p_status is null or d.status = p_status)
      and (p_before is null or d.created_at < p_before)
    order by d.created_at desc
    limit greatest(1, least(p_limit, 200));
end;
$fn$;

revoke all on function public.admin_list_dedications(text, int, timestamptz) from public, anon;
grant execute on function public.admin_list_dedications(text, int, timestamptz) to authenticated;

create or replace function public.admin_remove_dedication(p_code text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_rows int;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can remove a dedication.';
  end if;

  update public.dedications
     set status = 'removed', removed_by = 'admin', removed_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where code = p_code and status = 'live';
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'That dedication could not be found or is already removed.';
  end if;
end;
$fn$;

revoke all on function public.admin_remove_dedication(text, text) from public, anon;
grant execute on function public.admin_remove_dedication(text, text) to authenticated;

-- ------------------------------------------------------------
-- 10. build_daily_report(): add a "Dedications yesterday" section, additive
-- to every key 015_daily_report.sql and 021_pulse.sql already wrote. Same
-- rolling 24-hour window the rest of this report already uses (v_since),
-- not the Pulse section's calendar-day "yesterday" just above it.
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
    )
  ) into v_out;

  return v_out;
end;
$fn$;

revoke all on function public.build_daily_report() from public, anon;
grant execute on function public.build_daily_report() to authenticated, service_role;
