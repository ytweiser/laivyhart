-- ============================================================
-- 011b_memberships.sql — CH-2 Step 1, the final memberships
--
-- Membership DATA, not schema. Kept as a file for the record only; it was
-- applied through the MCP as 011b_memberships_final. Same shape as CH-1's
-- seed: resolved by slug, idempotent, aborts rather than mis-targeting.
--
-- "Hen Am" is resolved by the owner as Rising Like Lions. That song is
-- already in inspire-me and fire-me-up, so only the perceptions row is new.
--
-- COVERAGE IS NOT COMPLETE AFTER THIS FILE. The CH-2 prompt states this list
-- makes every approved song a member of at least one channel; it covers 4 of
-- the 5 songs that had none. "Hear it From Them" (hear-it-from-them-7886,
-- יָבֹאוּ וְיָעִידוּ) is absent from the list and still has no channel. It is
-- reported, not placed — inventing a placement is what CH-1 forbade.
-- ============================================================
do $$
declare
  n_new   int;
  missing text;
  orphans text;
begin
  create temp table _seed2 (slug text, channel_id text, ord int) on commit drop;

  insert into _seed2 (slug, channel_id, ord) values
    ('rising-like-lions-c892',   'perceptions',       60),   -- "Hen Am"
    ('bonds-of-darkness-abf4',   'move-me',           110),
    ('bonds-of-darkness-abf4',   'perceptions',       100),
    ('segulos-galore-2cc8',      'make-me-feel-good',  90),
    ('the-year-is-waiting-10a2', 'wind-me-down',       90),
    ('the-year-is-waiting-10a2', 'move-me',           120),
    ('in-a-flash-947d',          'fire-me-up',         10);

  select string_agg(distinct s.slug, ', ') into missing
    from _seed2 s
   where not exists (select 1 from public.songs g where g.slug = s.slug);
  if missing is not null then
    raise exception 'These slugs do not resolve to a song: %', missing;
  end if;

  if exists (select 1 from _seed2 s
              where not exists (select 1 from public.channels c where c.id = s.channel_id)) then
    raise exception 'Unknown channel id in the seed';
  end if;

  insert into public.song_channels (song_id, channel_id, sort_order)
  select g.id, s.channel_id, s.ord
    from _seed2 s
    join public.songs g on g.slug = s.slug
  on conflict (song_id, channel_id) do nothing;
  get diagnostics n_new = row_count;

  select string_agg(g.slug, ', ') into orphans
    from public.songs g
   where g.status = 'approved'
     and not exists (select 1 from public.song_channels sc where sc.song_id = g.id);

  raise notice 'inserted % new rows; still uncovered: %', n_new, coalesce(orphans, 'none');
end $$;

-- ------------------------------------------------------------
-- CH-3 Step 1: the last membership, appended here rather than given its own
-- file — it is one row of the same seed. Applied as
-- 011c_membership_hear_it_from_them.
--
-- "Hear it From Them" was the one approved song CH-2's list left unplaced.
-- With this row, coverage IS complete, so the assertion below is fatal again.
-- ------------------------------------------------------------
do $$
declare
  orphans text;
  n_fire  int;
begin
  if not exists (select 1 from public.songs where slug = 'hear-it-from-them-7886') then
    raise exception 'hear-it-from-them-7886 does not resolve to a song';
  end if;

  insert into public.song_channels (song_id, channel_id, sort_order)
  select g.id, 'fire-me-up', 90
    from public.songs g
   where g.slug = 'hear-it-from-them-7886'
  on conflict (song_id, channel_id) do nothing;

  select count(*) into n_fire from public.song_channels where channel_id = 'fire-me-up';
  if n_fire <> 9 then
    raise exception 'Expected fire-me-up to have 9 members, it has %', n_fire;
  end if;

  select string_agg(g.slug, ', ') into orphans
    from public.songs g
   where g.status = 'approved'
     and not exists (select 1 from public.song_channels sc where sc.song_id = g.id);
  if orphans is not null then
    raise exception 'Approved songs still with no channel: %', orphans;
  end if;
end $$;
