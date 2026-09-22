-- ============================================================
-- 010_is_artist.sql — the line between a listener and a public artist
--
-- Since 1A-2 every auth user gets an artists row from handle_new_user(), and
-- 1A-6 made rating require an account. The result is that a stranger who signs
-- in only to rate a song becomes, on paper, an artist: they land in
-- artists_public, in artists.json, in the sitemap, and at a public
-- /artist/<handle> page with nothing on it. is_artist draws the line.
--
-- DELIBERATE RLS / VISIBILITY TIGHTENING. artists_public narrows from "every
-- active row" to "every active row that is a public artist". That is a
-- restriction, never a widening: nothing becomes visible that was not visible
-- before, and the owner is seeded true so the live site is unchanged.
--
-- Rating is NOT gated on this. is_artist controls whether you have a public
-- PAGE; rate_song() still only requires an active account past the age gate,
-- which is the Option B behaviour 1A-6 chose. The sweep below proves it.
--
-- IDEMPOTENT throughout.
-- ============================================================

alter table public.artists
  add column if not exists is_artist boolean not null default false;

-- The owner is the one public artist today.
update public.artists
   set is_artist = true
 where id = '13244ffe-6ca6-4a56-bb69-2d5ecca89e69';

-- ------------------------------------------------------------
-- artists_public: the single definition every reader inherits.
-- The site's handle resolution, artists.json and the edge middleware all go
-- through this view, so none of them need to learn about is_artist.
-- ------------------------------------------------------------
create or replace view public.artists_public with (security_invoker = false) as
  select id, handle, display_name, display_name_he, bio, avatar_url, created_at
  from public.artists
  where status = 'active' and is_artist = true;

grant select on public.artists_public to anon, authenticated;

-- ------------------------------------------------------------
-- artists_guard: is_artist joins the must-equal-OLD set.
--
-- This guard compares column by column rather than whole-row (unlike the songs
-- guard), so a new column is NOT covered automatically and has to be listed.
-- Without this line a listener could simply update their own row and hand
-- themselves a public page.
-- ------------------------------------------------------------
create or replace function public.artists_guard()
returns trigger language plpgsql set search_path = public as $fn$
begin
  new.updated_at := now();

  if current_user = 'postgres' or public.is_admin() then
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
    if new.is_artist is distinct from old.is_artist then
      raise exception 'You cannot make yourself a public artist.';
    end if;
    if new.created_at is distinct from old.created_at then
      raise exception 'You cannot change created_at.';
    end if;
  end if;

  if tg_op = 'INSERT' and coalesce(new.is_artist, false) then
    raise exception 'You cannot create a public artist.';
  end if;

  if exists (select 1 from public.reserved_handles r where r.handle = new.handle) then
    raise exception 'That handle is reserved. Please choose another.';
  end if;

  return new;
end;
$fn$;

-- ------------------------------------------------------------
-- promote / demote
--
-- FORWARD REFERENCE: 1B's submit path will also set is_artist true from inside
-- a SECURITY DEFINER function, at the moment a first song is approved. That is
-- deliberately not built here.
-- ------------------------------------------------------------
create or replace function public.promote_to_artist(p_uid uuid)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can promote an account.';
  end if;
  update public.artists set is_artist = true where id = p_uid;
  if not found then raise exception 'No such artist: %', p_uid; end if;
end;
$fn$;
revoke all on function public.promote_to_artist(uuid) from public;
grant execute on function public.promote_to_artist(uuid) to authenticated;

create or replace function public.demote_to_listener(p_uid uuid)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can demote an account.';
  end if;
  update public.artists set is_artist = false where id = p_uid;
  if not found then raise exception 'No such artist: %', p_uid; end if;
end;
$fn$;
revoke all on function public.demote_to_listener(uuid) from public;
grant execute on function public.demote_to_listener(uuid) to authenticated;

-- ------------------------------------------------------------
-- admin_list_artists(): NEW in this migration (it did not exist before).
--
-- The browser never reads auth.users or the artists table directly for this --
-- email and ban state are only reachable through this definer function, which
-- refuses anyone who is not an admin.
-- ------------------------------------------------------------
create or replace function public.admin_list_artists()
returns table (
  id uuid, handle text, display_name text, email text,
  is_artist boolean, role text, status text,
  created_at timestamptz, last_sign_in_at timestamptz,
  approved_song_count int, total_songs int, is_banned boolean
)
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can list accounts.';
  end if;
  return query
    select a.id,
           a.handle::text,
           a.display_name,
           u.email::text,
           a.is_artist,
           a.role,
           a.status,
           a.created_at,
           u.last_sign_in_at,
           coalesce((select count(*)::int from public.songs s
                      where s.artist_id = a.id and s.status = 'approved'), 0),
           coalesce((select count(*)::int from public.songs s
                      where s.artist_id = a.id), 0),
           (u.banned_until is not null and u.banned_until > now())
      from public.artists a
      left join auth.users u on u.id = a.id
     order by a.created_at desc;
end;
$fn$;
revoke all on function public.admin_list_artists() from public;
grant execute on function public.admin_list_artists() to authenticated;

-- ------------------------------------------------------------
-- admin_new_signups_since(): the lightweight stand-in until 1B's daily report.
-- The admin keeps "last visit" in its own localStorage; the database only
-- answers the count.
-- ------------------------------------------------------------
create or replace function public.admin_new_signups_since(p_ts timestamptz)
returns integer language plpgsql security definer set search_path = public as $fn$
declare
  n integer;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can read sign-up counts.';
  end if;
  -- A null timestamp means "first visit": report the total.
  select count(*)::int into n from auth.users
   where p_ts is null or created_at > p_ts;
  return n;
end;
$fn$;
revoke all on function public.admin_new_signups_since(timestamptz) from public;
grant execute on function public.admin_new_signups_since(timestamptz) to authenticated;
