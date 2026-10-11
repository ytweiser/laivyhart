-- ============================================================
-- 026_public_ticker.sql
--
-- HOME-1: a public, site-wide activity ticker across the top of the
-- homepage and /listen, and the data behind "nearest decent-size city"
-- (the Worker resolves request.cf's coordinates to a city from a filtered
-- GeoNames list -- worker/src/cities.json, worker/src/geo.js -- and writes
-- the result here; this migration is just the two new columns it writes
-- into, the backfill of existing rows, and the public read).
--
-- No RLS change: activity_events stays exactly as locked down as ACT-1
-- left it (RLS enabled and forced, zero policies, the service role is the
-- only writer). The new columns are reachable by anon/authenticated only
-- through public_ticker() below and the existing public_pulse(), both
-- SECURITY DEFINER, both emitting aggregates and derived city/country
-- text, never a user id, a device id, a name, or a message.
-- ============================================================

-- ------------------------------------------------------------
-- 1. activity_events.display_city / display_country.
--
-- city/region/country (ACT-1) are UNCHANGED and still exist only for the
-- owner's own Pulse dashboard, which can show a literal, fine-grained
-- Cloudflare-reported location since only the owner ever reads it.
-- display_city/display_country are the DIFFERENT, coarser pair that is
-- safe to put in front of every visitor: always a decent-size city
-- (population >= 100,000) or nothing, never the raw city Cloudflare
-- reported. Latitude and longitude are never columns here at all -- the
-- Worker resolves them to a city name in memory and discards them; see
-- worker/src/geo.js's own header for that guarantee.
-- ------------------------------------------------------------
alter table public.activity_events add column if not exists display_city text;
alter table public.activity_events add column if not exists display_country text;

-- ------------------------------------------------------------
-- 2. Backfill, from city/country exactly as they already are (no region
-- fallback here -- that fallback is for the Worker's LIVE resolution, see
-- worker/src/geo.js; a backfill only works from what the row already has).
--
-- Checked against this project's live data before writing this: exactly
-- four distinct (city, country) pairs exist on rows with a non-null city,
-- so this is four literal matches, not a few-thousand-row reference table
-- bundled into a migration for a one-time pass. 'Buffalo'/US and
-- 'Charleston'/US exactly match a listed decent-size city; "Giv'at
-- Shmuel"/IL is too small to be in the list at all, and "Reẖovot"/IL
-- differs from the list's ASCII "Rehovot" by one diacritic -- both
-- correctly fall through to "no match", display_city stays null, shown as
-- the country alone, exactly as the live fallback's own last resort does.
-- ------------------------------------------------------------
update public.activity_events set display_country = country where country is not null and display_country is null;
update public.activity_events set display_city = 'Buffalo' where city = 'Buffalo' and country = 'US' and display_city is null;
update public.activity_events set display_city = 'Charleston' where city = 'Charleston' and country = 'US' and display_city is null;

-- ------------------------------------------------------------
-- 3. public_pulse(): switches to display_city/display_country as its
-- location source. The RETURNS TABLE column names stay `city`/`country`
-- on purpose -- index.html's existing Pulse box reads those names and
-- needs no change; only what populates them moves.
-- ------------------------------------------------------------
create or replace function public.public_pulse(p_limit integer default 8)
returns table(event_type text, song_title text, song_slug text, cover_url text, city text, country text, minutes_ago integer)
language plpgsql security definer set search_path to 'public' as $function$
begin
  return query
    select
      d.event_type,
      coalesce(nullif(s.title_translit, ''), s.title) as song_title,
      s.slug, s.cover_url,
      d.display_city, d.display_country,
      greatest(0, floor(extract(epoch from (now() - d.created_at)) / 60))::int as minutes_ago
    from (
      select distinct on (ae.device_id, ae.song_id)
        ae.device_id, ae.song_id, ae.event_type, ae.display_city, ae.display_country, ae.created_at
        from public.activity_events ae
       where ae.event_type in ('play_start', 'heart')
         and ae.song_id is not null
         and ae.created_at >= now() - interval '24 hours'
       order by ae.device_id, ae.song_id, ae.created_at desc
    ) d
    join public.songs s on s.id = d.song_id and s.status = 'approved'
    order by d.created_at desc
    limit greatest(1, least(p_limit, 25));
end;
$function$;
-- Grants unchanged from 021_pulse.sql (anon, authenticated already had
-- execute); re-asserted here since this is a full CREATE OR REPLACE.
revoke all on function public.public_pulse(integer) from public;
grant execute on function public.public_pulse(integer) to anon, authenticated;

-- ------------------------------------------------------------
-- 4. public_ticker(): the new homepage/listen ticker band's one data
-- source. Four kinds of item, last 7 days, newest first:
--   'play'       a play, with the decent-size city/country it happened in
--   'heart'      a heart, same
--   'dedication' a dedication was sent FOR this song -- never the
--                recipient's name, the sender, or the message
--   'new_song'   a song was approved/released
-- No user id, device id, name or message in any branch. city/country are
-- null for 'dedication' and 'new_song' on purpose -- neither is tied to a
-- visitor's location.
-- ------------------------------------------------------------
create or replace function public.public_ticker(p_limit int default 20)
returns table (
  kind text, song_title text, song_slug text,
  display_city text, display_country text, created_at timestamptz
)
language plpgsql security definer set search_path = public as $fn$
declare
  v_since timestamptz := now() - interval '7 days';
begin
  return query
    select * from (
      select 'play'::text as kind, coalesce(nullif(s.title_translit, ''), s.title) as song_title, s.slug as song_slug,
             ae.display_city, ae.display_country, ae.created_at
        from public.activity_events ae
        join public.songs s on s.id = ae.song_id and s.status = 'approved'
       where ae.event_type = 'play_start' and ae.created_at >= v_since
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
       where d.status = 'live' and d.created_at >= v_since
      union all
      select 'new_song', coalesce(nullif(s.title_translit, ''), s.title), s.slug,
             null::text, null::text, coalesce(s.reviewed_at, s.created_at)
        from public.songs s
       where s.status = 'approved' and coalesce(s.reviewed_at, s.created_at) >= v_since
    ) x
    order by created_at desc
    limit greatest(1, least(p_limit, 50));
end;
$fn$;

revoke all on function public.public_ticker(int) from public;
grant execute on function public.public_ticker(int) to anon, authenticated;
