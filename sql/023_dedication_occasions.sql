-- ============================================================
-- 023_dedication_occasions.sql
--
-- DED-3: a grouped, natural-language occasion list for dedications, in
-- place of DED-1's original flat ten. The only schema change this prompt
-- allows.
--
-- Existing rows checked before this migration: 1 total dedication, occasion
-- 'birthday'. Zero rows use 'bar_bat_mitzvah', so nothing is reclassified --
-- but the key stays in the CHECK constraint regardless, since a CHECK
-- constraint is evaluated per row forever, including rows written before
-- today. create_dedication() below is where "no longer accepted for new
-- rows" actually lives: its own validation list omits bar_bat_mitzvah, so a
-- fresh submission with that value is rejected even though the column
-- itself would still allow it.
-- ============================================================

alter table public.dedications drop constraint if exists dedications_occasion_check;
alter table public.dedications add constraint dedications_occasion_check
  check (occasion = any (array[
    'birthday', 'engagement', 'wedding', 'anniversary', 'bar_mitzvah', 'bat_mitzvah',
    'new_baby', 'bris', 'upsherin', 'graduation', 'siyum', 'new_job', 'new_home',
    'aliyah', 'retirement', 'refuah_shleimah', 'encouragement', 'thank_you',
    'in_memory', 'just_because', 'other',
    'bar_bat_mitzvah' -- legacy only, see header; never produced by create_dedication below
  ]));

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

  -- DED-3: the new 21-key list. bar_bat_mitzvah is deliberately absent --
  -- it stays valid on the table only for the rows that already used it.
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
