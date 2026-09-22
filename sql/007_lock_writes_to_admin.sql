-- ============================================================
-- 007_lock_writes_to_admin.sql
--
-- 1A-2 leads with SQL because sign-in is about to exist.
--
-- Until now "authenticated" meant "the owner", because the owner was the only
-- auth.users row. 1A-1 fixed that for songs. comments and categories were left
-- on the original permissive model, where any logged-in user could write. The
-- moment a stranger can sign in, those are holes. This migration closes them.
--
-- DELIBERATE RLS CHANGE, and it only ever RESTRICTS:
--   * anonymous commenting keeps working exactly as before (insert pending,
--     read approved) -- those two policies are untouched.
--   * what a signed-in non-admin loses: updating or deleting comments, reading
--     pending comments, and writing categories. None of that is reachable from
--     the public UI; it was only ever the admin's.
--
-- Also adds delete_my_account() / admin_delete_artist() for the settings page.
--
-- IDEMPOTENT: drop policy if exists before create, create or replace.
-- ============================================================

-- ------------------------------------------------------------
-- comments
--
-- Keep, exactly as they are:
--   "comments anon insert pending"  INSERT {anon,authenticated} with_check status='pending'
--   "comments anon read approved"   SELECT {anon}               using status='approved'
-- ------------------------------------------------------------
drop policy if exists "comments auth update"   on public.comments;
drop policy if exists "comments auth delete"   on public.comments;
drop policy if exists "comments auth read all" on public.comments;
drop policy if exists comments_admin_all       on public.comments;

-- FOR ALL covers select/insert/update/delete, so reading pending comments in
-- the admin is already granted here; no separate read policy is needed.
create policy comments_admin_all on public.comments
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------
-- categories  (public read stays)
-- ------------------------------------------------------------
drop policy if exists "categories authenticated insert" on public.categories;
drop policy if exists "categories authenticated update" on public.categories;
drop policy if exists "categories authenticated delete" on public.categories;
drop policy if exists categories_admin_all             on public.categories;

create policy categories_admin_all on public.categories
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------
-- chart_snapshots: verified there is no authenticated write policy to drop.
-- Only "chart_snapshots public read" (SELECT, anon+authenticated) exists, and
-- it stays. Writes happen inside take_chart_snapshot(), SECURITY DEFINER.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- artists_guard: let postgres-owned SECURITY DEFINER functions through.
--
-- delete_my_account() has to set status='deleted' on the caller's own row,
-- which the guard otherwise refuses ("You cannot change your own status") --
-- correctly, for a direct web write. Inside a SECURITY DEFINER function owned
-- by postgres, current_user is 'postgres'; a PostgREST request is 'anon' or
-- 'authenticated' and can never be postgres, so this is not forgeable from a
-- browser. Same shape as the auth.uid() is null escape in songs_guard.
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

-- ------------------------------------------------------------
-- Account deletion
--
-- WHY THIS DOES NOT DELETE THE auth.users ROW.
--
-- The FK graph makes that impossible without destroying data:
--     artists.id   REFERENCES auth.users(id) ON DELETE CASCADE
--     songs.artist_id REFERENCES artists(id)          -- NO ACTION
-- Deleting auth.users cascades the artists row away, which then violates
-- songs_artist_id_fkey for every song that artist ever had. The delete raises
-- and the whole transaction -- including the scrubbing done first -- rolls
-- back. It would fail for exactly the people most likely to use it.
--
-- So the artists row stays as a scrubbed tombstone (songs keep a valid owner
-- and the site keeps its play history), and the auth user is BANNED instead of
-- deleted, which is what actually stops them signing back in. Everything
-- personal is gone: name, Hebrew name, bio, avatar, and the handle is freed for
-- someone else. Their songs come off the site.
--
-- A ban does not invalidate an already-issued JWT until it expires, so the
-- client calls signOut() immediately after this returns.
--
-- If the owner ever wants a true hard delete, the songs have to be reassigned
-- or deleted FIRST -- note that deleting the user from the Supabase dashboard
-- will fail with a foreign key error for the same reason.
-- ------------------------------------------------------------
create or replace function public.delete_my_account()
returns text language plpgsql security definer set search_path = public as $fn$
declare
  v_uid uuid := auth.uid();
  v_songs int;
begin
  if v_uid is null then
    raise exception 'You must be signed in to delete your account.';
  end if;

  update public.artists
     set status          = 'deleted',
         display_name    = 'Deleted artist',
         display_name_he = null,
         bio             = null,
         avatar_url      = null,
         handle          = 'deleted-' || left(v_uid::text, 8),
         onboarded       = false
   where id = v_uid;

  if not found then
    raise exception 'No artist profile for this account.';
  end if;

  update public.songs set status = 'removed' where artist_id = v_uid;
  get diagnostics v_songs = row_count;

  -- Stops any future sign-in. See the note above on why not a delete.
  update auth.users set banned_until = 'infinity'::timestamptz where id = v_uid;

  return format('deleted; %s song(s) removed', v_songs);
end;
$fn$;
revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;

-- Admin variant, wired into the admin UI in 1A-7, not now.
create or replace function public.admin_delete_artist(p_uid uuid)
returns text language plpgsql security definer set search_path = public as $fn$
declare
  v_songs int;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete another artist.';
  end if;
  if p_uid is null then
    raise exception 'No artist given.';
  end if;

  update public.artists
     set status          = 'deleted',
         display_name    = 'Deleted artist',
         display_name_he = null,
         bio             = null,
         avatar_url      = null,
         handle          = 'deleted-' || left(p_uid::text, 8),
         onboarded       = false
   where id = p_uid;

  if not found then
    raise exception 'No such artist: %', p_uid;
  end if;

  update public.songs set status = 'removed' where artist_id = p_uid;
  get diagnostics v_songs = row_count;

  update auth.users set banned_until = 'infinity'::timestamptz where id = p_uid;

  return format('deleted; %s song(s) removed', v_songs);
end;
$fn$;
revoke all on function public.admin_delete_artist(uuid) from public;
grant execute on function public.admin_delete_artist(uuid) to authenticated;
