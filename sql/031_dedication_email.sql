-- ============================================================
-- 031_dedication_email.sql
--
-- SEND-1: a sender can email their dedication to the person it is for, once,
-- through the Worker (POST /dedication/email). WhatsApp and Copy link need
-- no data at all; this file is only for the email option.
--
-- PRIVATE. The three new columns and email_suppressions are never readable
-- by anon or authenticated: dedications stays RLS-forced with zero policies
-- (022), dedications_public names its columns and none of these, and every
-- function below is executable by service_role only -- the Worker, which
-- holds that key, is the only caller. songs.json, the sitemap and the
-- ticker never read dedications' columns beyond what they did before.
--
-- LIMITS, all on the server, inside claim_dedication_email() under a lock
-- on the address so two concurrent sends cannot both slip through:
--   5 dedication emails per sender per 24 hours
--   1 email per sender to the same address per 7 days
--   3 dedication emails per address per 7 days, all senders combined
-- A send counts from the moment it is claimed (email_sent_at set, status
-- still null while the Worker talks to Resend) until it fails.
-- ============================================================

-- ------------------------------------------------------------
-- 1. dedications: the recipient's email (lowercased), when the one email
-- went out, and how it ended.
-- ------------------------------------------------------------
alter table public.dedications add column if not exists recipient_email text null;
alter table public.dedications add column if not exists email_sent_at timestamptz null;
alter table public.dedications add column if not exists email_status text null;

alter table public.dedications drop constraint if exists dedications_email_status_check;
alter table public.dedications add constraint dedications_email_status_check
  check (email_status is null or email_status in ('sent', 'failed', 'suppressed', 'rate_limited'));
alter table public.dedications drop constraint if exists dedications_recipient_email_lower;
alter table public.dedications add constraint dedications_recipient_email_lower
  check (recipient_email is null or recipient_email = lower(recipient_email));

create index if not exists dedications_recipient_email_idx
  on public.dedications (recipient_email, email_sent_at desc) where recipient_email is not null;
create index if not exists dedications_sender_email_sent_idx
  on public.dedications (sender_user_id, email_sent_at desc) where email_sent_at is not null;

-- A second wall now that this table holds addresses: the client roles still
-- had Supabase's default table grants on it. RLS (forced, zero policies)
-- already returned no rows; no client code reads this table directly -- the
-- dedications_public view and the SECURITY DEFINER functions run as the
-- owner -- so the grants go entirely.
revoke all on table public.dedications from anon, authenticated;

comment on column public.dedications.recipient_email is
  'SEND-1: private. Lowercased. Only for delivering this one dedication email; never in any public read.';
comment on column public.dedications.email_status is
  'SEND-1: private. null while sending, then sent / failed; suppressed or rate_limited when blocked (no address kept then).';

-- ------------------------------------------------------------
-- 2. email_suppressions: addresses that asked never to get a dedication
-- email again (the unsubscribe page). Written only by the Worker.
-- ------------------------------------------------------------
create table if not exists public.email_suppressions (
  email      text primary key check (email = lower(email)),
  created_at timestamptz not null default now()
);
alter table public.email_suppressions enable row level security;
alter table public.email_suppressions force row level security;
-- No policies, and no table privileges for the client roles at all.
revoke all on table public.email_suppressions from public, anon, authenticated;

-- The same shape check the Worker and the browser use: something@host.tld,
-- no spaces, at most 254 characters.
create or replace function public.dedication_email_valid(p_email text)
returns boolean language sql immutable set search_path = public as $fn$
  select p_email is not null
     and char_length(p_email) <= 254
     and p_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
$fn$;
revoke all on function public.dedication_email_valid(text) from public, anon, authenticated;
grant execute on function public.dedication_email_valid(text) to service_role;

-- ------------------------------------------------------------
-- 3. claim_dedication_email(): every check, then the claim. Returns
--   { status: 'ok', ...what the email needs }  -- go ahead and send
--   { status: 'not_found' | 'not_owner' | 'invalid' | 'already_sent'
--             | 'suppressed' | 'rate_limited', limit? }
-- A blocked send (suppressed, rate_limited) is recorded on the dedication
-- without the address; the dedication itself is never touched otherwise.
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
    'sender_name', case when v_d.is_anonymous then null else a.display_name end,
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
-- 4. finish_dedication_email(): after Resend answers. 'sent' keeps the
-- address and stamps the time; 'failed' keeps the address (so the sender can
-- see what was tried) but clears the time, so a failure never counts toward
-- a limit and the sender may try again.
-- ------------------------------------------------------------
create or replace function public.finish_dedication_email(p_code text, p_status text)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  if p_status not in ('sent', 'failed') then
    raise exception 'finish_dedication_email: status must be sent or failed';
  end if;
  update public.dedications
     set email_status = p_status,
         email_sent_at = case when p_status = 'sent' then now() else null end
   where code = p_code and email_status is null and email_sent_at is not null;
end;
$fn$;
revoke all on function public.finish_dedication_email(text, text) from public, anon, authenticated;
grant execute on function public.finish_dedication_email(text, text) to service_role;

-- ------------------------------------------------------------
-- 5. suppress_dedication_email(): the unsubscribe page's one write.
-- ------------------------------------------------------------
create or replace function public.suppress_dedication_email(p_email text)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.dedication_email_valid(v_email) then
    raise exception 'Not an email address.';
  end if;
  insert into public.email_suppressions (email) values (v_email) on conflict (email) do nothing;
end;
$fn$;
revoke all on function public.suppress_dedication_email(text) from public, anon, authenticated;
grant execute on function public.suppress_dedication_email(text) to service_role;
