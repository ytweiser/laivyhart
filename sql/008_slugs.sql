-- ============================================================
-- 008_slugs.sql
--
-- Permanent, shareable URLs for songs: /song/<slug>.
--
-- WHERE THE SLUG IS ASSIGNED, AND WHY THERE:
--   inside review_song(), at the moment a song becomes approved -- NOT in a
--   BEFORE trigger. A trigger would have to fire before
--   songs_guard_artist_writes (the 1A-1 guard), which freezes approved songs
--   and lists slug among the columns a non-admin may not change. Postgres
--   orders BEFORE triggers alphabetically, so a trigger named
--   'songs_assign_slug' would in fact sort first today -- but that is an
--   accident of naming, and any future trigger could silently reorder it.
--   review_song() is already the single path every status change goes through
--   (1A-4 enforced that in the admin), it already stamps status and
--   reviewed_at in one transaction, and it runs SECURITY DEFINER where the
--   guard yields. One place, and no ordering to reason about.
--
-- The guard still lists slug as must-equal-OLD for non-admins, so an artist
-- can never change a slug once it exists. That is left exactly as it was.
--
-- RLS IS UNCHANGED by this migration: no policy is added, dropped or altered.
--
-- IDEMPOTENT: create or replace throughout, and the backfill only fills nulls.
-- ============================================================

-- unaccent folds Latin diacritics to their base letter. It is marked STABLE
-- rather than IMMUTABLE (its dictionary is loaded at run time), which is why
-- slugify below is STABLE too. That costs nothing here -- slugify is called
-- from review_song() and the backfill, never from an index.
create extension if not exists unaccent;

-- ------------------------------------------------------------
-- slugify: lower-case ASCII, hyphen-separated.
--
-- Anything left outside a-z0-9 after folding -- Hebrew, punctuation, spaces --
-- collapses to a single hyphen, and leading/trailing hyphens are trimmed. A
-- Hebrew-only title therefore slugifies to '', which is exactly what
-- song_slug() needs in order to fall back to the transliteration.
-- ------------------------------------------------------------
create or replace function public.slugify(txt text)
returns text language sql stable set search_path = public, extensions as $fn$
  select trim(both '-' from
    regexp_replace(lower(unaccent(coalesce(txt, ''))), '[^a-z0-9]+', '-', 'g'));
$fn$;

-- ------------------------------------------------------------
-- song_slug: the readable part, plus four hex characters of the id.
--
-- The suffix is what makes the slug safe: unique without a lookup, and stable
-- across a title edit, because a slug is only ever assigned once.
-- ------------------------------------------------------------
create or replace function public.song_slug(p_title text, p_translit text, p_id uuid)
returns text language sql stable set search_path = public as $fn$
  select coalesce(
           nullif(public.slugify(p_title), ''),
           nullif(public.slugify(p_translit), ''),
           'song')
         || '-' || left(replace(p_id::text, '-', ''), 4);
$fn$;

-- ------------------------------------------------------------
-- review_song(): unchanged except that approving now fills a missing slug.
-- coalesce means an existing slug is never rewritten.
-- ------------------------------------------------------------
create or replace function public.review_song(p_song uuid, p_decision text, p_reason text)
returns text language plpgsql security definer set search_path = public as $fn$
declare
  v_status text;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can review songs.';
  end if;
  if p_decision not in ('approve','reject','remove','restore') then
    raise exception 'Unknown review decision: %', p_decision;
  end if;

  v_status := case p_decision
                when 'approve' then 'approved'
                when 'reject'  then 'rejected'
                when 'remove'  then 'removed'
                when 'restore' then 'approved'
              end;

  insert into public.reviews (song_id, reviewer_kind, reviewer_id, decision, reason)
  values (p_song, 'human', auth.uid(), p_decision, p_reason);

  update public.songs
     set status = v_status,
         reviewed_at = now(),
         -- Assigned once, on first approval, and never rewritten afterwards.
         slug = case when v_status = 'approved'
                     then coalesce(slug, public.song_slug(title, title_translit, id))
                     else slug end
   where id = p_song;

  if not found then
    raise exception 'No such song: %', p_song;
  end if;

  return v_status;
end;
$fn$;
revoke all on function public.review_song(uuid, text, text) from public;
grant execute on function public.review_song(uuid, text, text) to authenticated;

-- ------------------------------------------------------------
-- Backfill the songs approved before slugs existed. Nulls only, so re-running
-- this file changes nothing.
-- ------------------------------------------------------------
update public.songs
   set slug = public.song_slug(title, title_translit, id)
 where status = 'approved' and slug is null;
