-- ============================================================
-- 033_dedication_name_privately.sql
--
-- NAME-1: "without my name" (dedications.is_anonymous) now means anonymous
-- in PUBLIC places only. Everything sent to the person it is for -- the
-- /d/<code> page and its link preview, the email -- always carries the
-- sender's name. Public places are unchanged: dedications_public still
-- nulls the name when is_anonymous is true, member_profile() still leaves
-- those out, the ticker shows no names. (The Dedications strip also stops
-- linking a "from someone" card to its /d/ page, in the browser, so the
-- name stays hidden from the public.)
--
-- Three function definitions, nothing else: no table, column or row is
-- touched by this file. Running it again gives the same result.
--   dedication_by_code()          the sender's name, always
--   claim_dedication_email()      the sender's name, always (031's body
--                                 otherwise unchanged)
--   set_my_dedication_anonymous() the "Without my name" switch on My page;
--                                 it can turn anonymity ON only while the
--                                 dedication is shown on the site
-- The name is display_name, else handle: the same fallback the site uses
-- for the sender in the form.
-- ============================================================

-- ------------------------------------------------------------
-- 1. dedication_by_code(): 032's, with the sender always named.
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
    coalesce(nullif(a.display_name, ''), a.handle::text),
    a.handle::text,
    d.show_publicly
  from public.dedications d
  join public.songs s on s.id = d.song_id and s.status = 'approved'
  left join public.artists a on a.id = d.sender_user_id
  where d.code = p_code and d.status = 'live';
$fn$;
revoke all on function public.dedication_by_code(text) from public, anon;
grant execute on function public.dedication_by_code(text) to anon, authenticated;

-- ------------------------------------------------------------
-- 2. claim_dedication_email(): 031's body; only the returned sender_name
-- changes (always the name).
-- ------------------------------------------------------------
create or replace function public.claim_dedication_email(p_code text, p_sender uuid, p_email text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_d     public.dedications%rowtype;
  v_n     int;
  v_limit text := null;
  v_out   jsonb;
begin
  select * into v_d from public.dedications where code = p_code and status = 'live' for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_d.sender_user_id is distinct from p_sender then
    return jsonb_build_object('status', 'not_owner');
  end if;
  if not public.dedication_email_valid(v_email) then
    return jsonb_build_object('status', 'invalid');
  end if;
  if v_d.email_status = 'sent' or (v_d.email_status is null and v_d.email_sent_at is not null) then
    return jsonb_build_object('status', 'already_sent');
  end if;

  -- One sender at a time per address, for the counts below.
  perform pg_advisory_xact_lock(hashtext('dedication_email:' || v_email));

  if exists (select 1 from public.email_suppressions where email = v_email) then
    update public.dedications set email_status = 'suppressed', recipient_email = null, email_sent_at = null
     where id = v_d.id;
    return jsonb_build_object('status', 'suppressed');
  end if;

  select count(*) into v_n from public.dedications
   where sender_user_id = p_sender and email_sent_at > now() - interval '24 hours'
     and (email_status is null or email_status = 'sent');
  if v_n >= 5 then v_limit := 'sender_daily'; end if;

  if v_limit is null then
    select count(*) into v_n from public.dedications
     where sender_user_id = p_sender and recipient_email = v_email
       and email_sent_at > now() - interval '7 days'
       and (email_status is null or email_status = 'sent');
    if v_n >= 1 then v_limit := 'same_address_week'; end if;
  end if;

  if v_limit is null then
    select count(*) into v_n from public.dedications
     where recipient_email = v_email and email_sent_at > now() - interval '7 days'
       and (email_status is null or email_status = 'sent');
    if v_n >= 3 then v_limit := 'address_week'; end if;
  end if;

  if v_limit is not null then
    update public.dedications set email_status = 'rate_limited', recipient_email = null, email_sent_at = null
     where id = v_d.id;
    return jsonb_build_object('status', 'rate_limited', 'limit', v_limit);
  end if;

  update public.dedications
     set recipient_email = v_email, email_sent_at = now(), email_status = null
   where id = v_d.id;

  select jsonb_build_object(
    'status', 'ok',
    'code', v_d.code,
    'recipient_name', v_d.recipient_name,
    'occasion', v_d.occasion,
    'occasion_other', v_d.occasion_other,
    'message', v_d.message,
    'sender_name', coalesce(nullif(a.display_name, ''), a.handle::text),
    'song_id', s.id,
    'song_title', coalesce(nullif(s.title_translit, ''), s.title),
    'cover_url', s.cover_url,
    'cover_focus_x', s.cover_focus_x,
    'cover_focus_y', s.cover_focus_y
  ) into v_out
  from public.songs s
  left join public.artists a on a.id = v_d.sender_user_id
  where s.id = v_d.song_id;
  return v_out;
end;
$fn$;
revoke all on function public.claim_dedication_email(text, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_dedication_email(text, uuid, text) to service_role;

-- ------------------------------------------------------------
-- 3. set_my_dedication_anonymous(): "Without my name" on My page. The
-- sender's own live dedications only; ON is refused unless the dedication
-- is shown on the site (off is always allowed -- My page sends it when
-- "Shown on site" is turned off, so anonymity never lingers on a private
-- one).
-- ------------------------------------------------------------
create or replace function public.set_my_dedication_anonymous(p_code text, p_anon boolean)
returns boolean language plpgsql security definer set search_path = public as $fn$
declare
  v_uid  uuid := auth.uid();
  v_show boolean;
begin
  if v_uid is null then
    raise exception 'Sign in to change your dedication.';
  end if;
  select show_publicly into v_show
    from public.dedications
   where code = p_code and sender_user_id = v_uid and status = 'live'
   for update;
  if not found then
    raise exception 'That dedication is not yours, or it was removed.';
  end if;
  if coalesce(p_anon, false) and not v_show then
    raise exception 'Turn on "Shown on site" first.';
  end if;
  update public.dedications
     set is_anonymous = coalesce(p_anon, false)
   where code = p_code and sender_user_id = v_uid and status = 'live';
  return coalesce(p_anon, false);
end;
$fn$;
revoke all on function public.set_my_dedication_anonymous(text, boolean) from public, anon;
grant execute on function public.set_my_dedication_anonymous(text, boolean) to authenticated;
