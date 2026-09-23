-- ============================================================
-- 011_channels.sql — channels (overlapping mood sets) and memberships
--
-- DATA ONLY. This adds two tables, their RLS, the eight channels and the
-- song memberships. Nothing on the site reads them yet; the homepage strip
-- and the /listen swap are CH-2.
--
-- NO EXISTING POLICY IS LOOSENED BY THIS FILE. It adds two new tables and
-- four new policies that apply only to those tables. `categories` and
-- `song.categories[]` / `featured_category` are left exactly as they are —
-- channels are additive, and retiring categories from the UI is CH-2's job.
--
-- The read policies match the pattern `categories` already uses (public read,
-- admin write), with the one improvement of naming the target roles
-- explicitly (`to anon, authenticated`) rather than `to public`.
--
-- MEMBERSHIPS ARE RESOLVED BY SLUG, not by hardcoded uuid: slugs are stable,
-- unique among approved songs, and readable in review. The seed asserts the
-- expected row count and aborts if any slug fails to resolve, so a typo can
-- never silently produce a short channel.
--
-- IDEMPOTENT throughout: re-running refreshes channel titles/taglines/order
-- and adds no duplicate memberships.
-- ============================================================

-- ------------------------------------------------------------
-- Tables
-- ------------------------------------------------------------
create table if not exists public.channels (
  id          text primary key,
  title       text not null,
  tagline     text not null default '',
  sort_order  int  not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.song_channels (
  song_id    uuid not null references public.songs(id) on delete cascade,
  channel_id text not null references public.channels(id) on delete cascade,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  primary key (song_id, channel_id)
);

-- The primary key already indexes (song_id, channel_id), which serves
-- "channels for this song". This one serves the other direction, "songs in
-- this channel", which is what the CH-2 strip will ask for on every render.
create index if not exists song_channels_channel_idx on public.song_channels (channel_id);

-- ------------------------------------------------------------
-- RLS. Both tables are public-read because the strip has to render for a
-- signed-out visitor, and admin-write because only the owner curates them.
-- ------------------------------------------------------------
alter table public.channels enable row level security;
alter table public.song_channels enable row level security;

drop policy if exists channels_read_all on public.channels;
create policy channels_read_all on public.channels
  for select to anon, authenticated using (true);

drop policy if exists channels_admin_all on public.channels;
create policy channels_admin_all on public.channels
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists song_channels_read_all on public.song_channels;
create policy song_channels_read_all on public.song_channels
  for select to anon, authenticated using (true);

drop policy if exists song_channels_admin_all on public.song_channels;
create policy song_channels_admin_all on public.song_channels
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select on public.channels to anon, authenticated;
grant select on public.song_channels to anon, authenticated;

-- ------------------------------------------------------------
-- The eight channels. on conflict do update so re-running this file is how
-- titles, taglines and ordering get corrected.
--
-- Taglines are stored but deliberately not shown in the CH-2 strip (the
-- owner's choice); they are for the admin and a future channel page.
-- ------------------------------------------------------------
insert into public.channels (id, title, tagline, sort_order) values
  ('inspire-me',        'INSPIRE ME',        'For songs that make you want to rise, act, grow, overcome.', 10),
  ('make-me-feel-good', 'MAKE ME FEEL GOOD', 'Bright, warm, optimistic, joyful.',                          20),
  ('move-me',           'MOVE ME',           'Heart, family, longing, vulnerability, beauty.',             30),
  ('perceptions',       'PERCEPTIONS',       'You''ve always seen it one way. Maybe there''s another.',     40),
  ('help-me-escape',    'HELP ME ESCAPE',    'Music that takes you somewhere else.',                       50),
  ('fire-me-up',        'FIRE ME UP',        'Driving, powerful, defiant.',                                60),
  ('wind-me-down',      'WIND ME DOWN',      'Quiet, warm, reflective.',                                   70),
  ('celebrate-with-me', 'CELEBRATE WITH ME', 'A different reason to press play.',                          80)
on conflict (id) do update
  set title      = excluded.title,
      tagline    = excluded.tagline,
      sort_order = excluded.sort_order;

-- ------------------------------------------------------------
-- Memberships.
--
-- Four owner-supplied resolutions are applied here:
--   "Newport to Lakewood" / "America 250"  = Jewish USA        (jewish-usa-79e6)
--   "Hatzur Tamim"                          = My Perfect World  (my-perfect-world-62c8)
--   "Achas Shoalty"                         = Asking for 1      (asking-for-1-5647)
--   the Ephraim / father-son song           = omitted entirely
-- and two resolved from the database itself:
--   "Bishvili"  = ברכי נפשי / Nature's Beauty (nature-s-beauty-e93c) — its
--                 lyrics carry "בִּשְׁבִילִי נִבְרָא הָעוֹלָם"; the only match.
--   "America 250" corroborated: Jewish USA is the only song whose text
--                 contains Newport, Lakewood, 250 and America.
--
-- NOT SEEDED: "Hen Am", listed under perceptions and fire-me-up, matches no
-- title, transliteration, slug or lyric in the database. Rather than guess it
-- is left out and reported. Adding it later is one idempotent insert.
-- ------------------------------------------------------------
do $$
declare
  n_expected int;
  n_actual   int;
  missing    text;
begin
  create temp table _seed (slug text, channel_id text, ord int) on commit drop;

  insert into _seed (slug, channel_id, ord) values
    -- INSPIRE ME
    ('emet-la-amito-a3ca',        'inspire-me', 10),
    ('do-your-best-f3da',         'inspire-me', 20),
    ('we-can-conquer-6fb0',       'inspire-me', 30),
    ('sulam-yaakov-f60c',         'inspire-me', 40),
    ('rising-like-lions-c892',    'inspire-me', 50),
    ('standing-proud-9ed3',       'inspire-me', 60),
    ('the-walls-fall-first-8797', 'inspire-me', 70),
    ('fires-still-burning-12d6',  'inspire-me', 80),
    -- MAKE ME FEEL GOOD
    ('rebirth-a6d0',              'make-me-feel-good', 10),
    ('geshem-v-tal-f0e4',         'make-me-feel-good', 20),
    ('kamu-vaneha-b40b',          'make-me-feel-good', 30),
    ('tiferet-banim-7ee6',        'make-me-feel-good', 40),
    ('shechina-returns-f1a1',     'make-me-feel-good', 50),
    ('dovid-s-holy-dance-0d81',   'make-me-feel-good', 60),
    ('my-perfect-world-62c8',     'make-me-feel-good', 70),
    ('holy-land-vacation-1743',   'make-me-feel-good', 80),
    -- MOVE ME
    ('al-tashlicheini-b8dd',      'move-me', 10),
    ('refaeinu-f4b2',             'move-me', 20),
    ('touch-my-soul-3734',        'move-me', 30),
    ('yearnings-13e9',            'move-me', 40),
    ('please-open-c627',          'move-me', 50),
    ('how-i-wish-c40b',           'move-me', 60),
    ('she-carried-me-9e71',       'move-me', 70),
    ('home-for-the-shechina-00d5','move-me', 80),
    ('tiferet-banim-7ee6',        'move-me', 90),
    ('your-better-half-26b4',     'move-me', 100),
    -- PERCEPTIONS  ("Hen Am" omitted, unresolved)
    ('al-blima-3a59',             'perceptions', 10),
    ('sulam-yaakov-f60c',         'perceptions', 20),
    ('emet-la-amito-a3ca',        'perceptions', 30),
    ('mal-ah-ha-aretz-deah-0670', 'perceptions', 40),
    ('oseh-shalom-2a3e',          'perceptions', 50),
    ('nature-s-beauty-e93c',      'perceptions', 70),   -- "Bishvili"
    ('my-perfect-world-62c8',     'perceptions', 80),
    ('asking-for-1-5647',         'perceptions', 90),
    -- HELP ME ESCAPE
    ('nature-s-beauty-e93c',      'help-me-escape', 10), -- "Bishvili"
    ('geshem-v-tal-f0e4',         'help-me-escape', 20),
    ('touch-my-soul-3734',        'help-me-escape', 30),
    ('rebirth-a6d0',              'help-me-escape', 40),
    ('holy-land-vacation-1743',   'help-me-escape', 50),
    ('jewish-usa-79e6',           'help-me-escape', 60), -- "America 250"
    ('my-perfect-world-62c8',     'help-me-escape', 70),
    ('please-open-c627',          'help-me-escape', 80),
    -- FIRE ME UP  ("Hen Am" omitted, unresolved)
    ('shattered-exile-5a5d',      'fire-me-up', 20),
    ('rising-like-lions-c892',    'fire-me-up', 30),
    ('standing-proud-9ed3',       'fire-me-up', 40),
    ('the-walls-fall-first-8797', 'fire-me-up', 50),
    ('we-can-conquer-6fb0',       'fire-me-up', 60),
    ('fires-still-burning-12d6',  'fire-me-up', 70),
    ('dovid-s-holy-dance-0d81',   'fire-me-up', 80),
    -- WIND ME DOWN
    ('al-blima-3a59',             'wind-me-down', 10),
    ('touch-my-soul-3734',        'wind-me-down', 20),
    ('al-tashlicheini-b8dd',      'wind-me-down', 30),
    ('please-open-c627',          'wind-me-down', 40),
    ('refaeinu-f4b2',             'wind-me-down', 50),
    ('nature-s-beauty-e93c',      'wind-me-down', 60), -- "Bishvili"
    ('oseh-shalom-2a3e',          'wind-me-down', 70),
    ('geshem-v-tal-f0e4',         'wind-me-down', 80),
    -- CELEBRATE WITH ME
    ('dovid-s-holy-dance-0d81',   'celebrate-with-me', 10),
    ('shechina-returns-f1a1',     'celebrate-with-me', 20),
    ('tiferet-banim-7ee6',        'celebrate-with-me', 30),
    ('kamu-vaneha-b40b',          'celebrate-with-me', 40),
    ('holy-land-vacation-1743',   'celebrate-with-me', 50),
    ('my-perfect-world-62c8',     'celebrate-with-me', 60);

  select count(*) into n_expected from _seed;

  -- Every slug must resolve, or we stop rather than seeding a short channel.
  select string_agg(distinct s.slug, ', ') into missing
    from _seed s
   where not exists (select 1 from public.songs g where g.slug = s.slug);
  if missing is not null then
    raise exception 'These slugs do not resolve to a song: %', missing;
  end if;

  insert into public.song_channels (song_id, channel_id, sort_order)
  select g.id, s.channel_id, s.ord
    from _seed s
    join public.songs g on g.slug = s.slug
  on conflict (song_id, channel_id) do nothing;

  select count(*) into n_actual from public.song_channels;
  if n_actual <> n_expected then
    raise exception 'Expected % membership rows, found %', n_expected, n_actual;
  end if;

  if (select count(*) from public.channels) <> 8 then
    raise exception 'Expected 8 channels';
  end if;
end $$;
