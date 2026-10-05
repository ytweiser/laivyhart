/* ============================================================
   Synthetic, deterministic fixture data for the local verification harness.

   Entirely fictional — no real artist, song, or commenter from the live
   database appears here. That is deliberate: a harness committed to the
   repo and run by every later prompt must not go stale the moment a real
   song is added or approved, and must never carry a real commenter's name
   into git history. Shapes match exactly what the real REST/RPC endpoints
   return (confirmed against the live, already-migrated project while
   building this), so stubbing with this data exercises the real code paths.

   Three artists, chosen to cover every scenario this harness (and future
   ARTIST-N prompts) needs:
     NOVA_ASH    — the main subject. Six songs covering every Honors/Success
                   edge case: a song that qualifies on an outright badge, one
                   that has ONLY weeks_on_chart below the honors threshold
                   (must NOT appear in Honors), one with only a live badge
                   (must NOT appear either), songs with/without milestones,
                   and one with a Hebrew title (content — must survive the
                   "no Hebrew labels" rule; only labels are stripped).
     SABLE_RIDGE — a second artist, for picks-by-another-artist and
                   recommend_for_artist's "try these" row.
     BRAND_NEW   — one approved song, nothing earned: the empty-artist case.
   ============================================================ */

export const NOVA_ASH = '11111111-1111-4111-8111-111111111111';
export const SABLE_RIDGE = '22222222-2222-4222-8222-222222222222';
export const BRAND_NEW = '33333333-3333-4333-8333-333333333333';

export const SONGS = {
  SUPERNOVA: 'a0000000-0000-4000-8000-000000000001',
  QUIET_STATIC: 'a0000000-0000-4000-8000-000000000002',
  LOW_LIGHT: 'a0000000-0000-4000-8000-000000000003',
  PAPER_MOONS: 'a0000000-0000-4000-8000-000000000004',
  AFTERGLOW: 'a0000000-0000-4000-8000-000000000005',
  QUIET_NIGHT_HE: 'a0000000-0000-4000-8000-000000000006',
  BORROWED_LIGHT: 'b0000000-0000-4000-8000-000000000001',
  QUIET_FIRE: 'b0000000-0000-4000-8000-000000000002',
  FIRST_LIGHT: 'c0000000-0000-4000-8000-000000000001',
};

export const ARTISTS_PUBLIC = [
  { id: NOVA_ASH, handle: 'nova-ash', display_name: 'Nova Ash', display_name_he: null, bio: null, avatar_url: null, created_at: '2026-01-15T00:00:00+00:00' },
  { id: SABLE_RIDGE, handle: 'sable-ridge', display_name: 'Sable Ridge', display_name_he: null, bio: 'Songs written between shifts.', avatar_url: null, created_at: '2026-03-01T00:00:00+00:00' },
  { id: BRAND_NEW, handle: 'brand-new-artist', display_name: 'Brand New Artist', display_name_he: null, bio: null, avatar_url: null, created_at: '2026-10-01T00:00:00+00:00' },
];

const artistEmbed = (id) => {
  const a = ARTISTS_PUBLIC.find((x) => x.id === id);
  return a ? { handle: a.handle, display_name: a.display_name, avatar_url: a.avatar_url } : null;
};

function song(over) {
  return {
    language: 'English', title_translit: '', categories: [], tags: [], about: '',
    lyrics_original: '', lyrics_translation: '', cover_url: null, cover_focus_x: 50, cover_focus_y: 50,
    featured_category: null, featured: false, featured_order: null, comment_count: 0,
    length_seconds: 180, duration_seconds: 180, play_count: 0, plays_7d: 0,
    like_count: 0, like_tune_count: 0, like_lyrics_count: 0, status: 'approved',
    channels: [], badges: [], milestones: [],
    ...over,
    artist: artistEmbed(over.artist_id),
  };
}

// SONGS array: the shape index.html's `songs?select=*,artist:...` returns,
// and what songs.json embeds (channels/badges/milestones included).
export const SONGS_ROWS = [
  song({ id: SONGS.SUPERNOVA, artist_id: NOVA_ASH, title: 'Supernova', slug: 'supernova-a000',
    created_at: '2026-02-01T00:00:00+00:00', like_count: 12,
    channels: ['inspire-me', 'move-me'],
    badges: [
      { badge: 'hit_number_one', value: 3, sort: 2 },
      { badge: 'weeks_at_number_one', value: 2, sort: 3 },
      { badge: 'weeks_on_chart', value: 5, sort: 6 },
    ],
    milestones: [
      { track: 'plays', tier: 2, threshold: 250 },
      { track: 'hearts', tier: 1, threshold: 5 },
    ] }),
  // Below the honors_min_weeks_on_chart threshold (4) and no other permanent
  // badge: must NOT appear in the Honors row under the new rule (ARTIST-3),
  // even though it carries a permanent badge.
  song({ id: SONGS.QUIET_STATIC, artist_id: NOVA_ASH, title: 'Quiet Static', slug: 'quiet-static-a000',
    created_at: '2026-02-05T00:00:00+00:00', like_count: 2,
    channels: ['inspire-me'],
    badges: [{ badge: 'weeks_on_chart', value: 2, sort: 6 }] }),
  song({ id: SONGS.LOW_LIGHT, artist_id: NOVA_ASH, title: 'Low Light', slug: 'low-light-a000',
    created_at: '2026-02-10T00:00:00+00:00', like_count: 4,
    channels: ['move-me'],
    badges: [{ badge: 'best_words', value: 1, sort: 4 }] }),
  song({ id: SONGS.PAPER_MOONS, artist_id: NOVA_ASH, title: 'Paper Moons', slug: 'paper-moons-a000',
    created_at: '2026-02-15T00:00:00+00:00', like_count: 6,
    channels: ['wind-me-down'],
    badges: [{ badge: 'was_most_loved', value: 1, sort: 7 }],
    milestones: [{ track: 'comments', tier: 1, threshold: 3 }] }),
  song({ id: SONGS.AFTERGLOW, artist_id: NOVA_ASH, title: 'Afterglow', slug: 'afterglow-a000',
    created_at: '2026-02-20T00:00:00+00:00', like_count: 1 }),
  // Hebrew TITLE (content, must survive) with only LIVE badges (must not
  // qualify for Honors either before or after ARTIST-3).
  song({ id: SONGS.QUIET_NIGHT_HE, artist_id: NOVA_ASH, title: 'לילה שקט', title_translit: 'Laila Shaket', language: 'Hebrew',
    slug: 'quiet-night-a000', created_at: '2026-02-25T00:00:00+00:00', like_count: 5,
    badges: [{ badge: 'most_loved', value: null, sort: 8 }, { badge: 'new', value: null, sort: 10 }] }),

  song({ id: SONGS.BORROWED_LIGHT, artist_id: SABLE_RIDGE, title: 'Borrowed Light', slug: 'borrowed-light-b000',
    created_at: '2026-03-05T00:00:00+00:00', like_count: 2, channels: ['inspire-me'] }),
  song({ id: SONGS.QUIET_FIRE, artist_id: SABLE_RIDGE, title: 'Quiet Fire', slug: 'quiet-fire-b000',
    created_at: '2026-03-10T00:00:00+00:00', like_count: 1, channels: ['inspire-me'] }),

  song({ id: SONGS.FIRST_LIGHT, artist_id: BRAND_NEW, title: 'First Light', slug: 'first-light-c000',
    created_at: '2026-10-01T00:00:00+00:00', like_count: 0 }),
];

export const CHANNELS_ROWS = [
  { id: 'inspire-me', title: 'INSPIRE ME', tagline: '', sort_order: 1, active: true },
  { id: 'move-me', title: 'MOVE ME', tagline: '', sort_order: 2, active: true },
  { id: 'wind-me-down', title: 'WIND ME DOWN', tagline: '', sort_order: 3, active: true },
];
export const SONG_CHANNELS_ROWS = SONGS_ROWS.flatMap((s) => (s.channels || []).map((channel_id) => ({ song_id: s.id, channel_id })));
export const SONG_BADGES_ROWS = SONGS_ROWS.flatMap((s) => (s.badges || []).map((b) => ({ song_id: s.id, ...b })));
export const SONG_MILESTONES_ROWS = SONGS_ROWS.flatMap((s) => (s.milestones || []).map((m) => ({ song_id: s.id, ...m })));

// Trophy case (artist_badges) — the UNCHANGED tally, deliberately NOT
// recomputed from honors_min_weeks_on_chart (ARTIST-3 step 10 says so).
export const ARTIST_BADGES_ROWS = [
  { artist_id: NOVA_ASH, badge: 'hit_number_one', value: 1, sort: 2 },
  { artist_id: NOVA_ASH, badge: 'weeks_at_number_one', value: 2, sort: 3 },
  { artist_id: NOVA_ASH, badge: 'best_words', value: 1, sort: 4 },
  { artist_id: NOVA_ASH, badge: 'weeks_on_chart', value: 7, sort: 6 },
  { artist_id: NOVA_ASH, badge: 'was_most_loved', value: 1, sort: 7 },
];

export const ARTIST_STATS = {
  [NOVA_ASH]: { songs: 6, weeks_on_chart: 9, hearts: 30, comments: 2, since: '2026-02-01' },
  [SABLE_RIDGE]: { songs: 2, weeks_on_chart: 0, hearts: 3, comments: 0, since: '2026-03-05' },
  [BRAND_NEW]: { songs: 1, weeks_on_chart: 0, hearts: 0, comments: 0, since: '2026-10-01' },
};

export const FOLLOWER_COUNTS = { [NOVA_ASH]: 12, [SABLE_RIDGE]: 4, [BRAND_NEW]: 0 };

// FK-embed shape: `songs!comments_song_id_fkey!inner(...)`.
export const COMMENTS_ROWS = [
  { name: 'Dana', city: 'Tel Aviv', body: 'This one lives in my head now.', created_at: '2026-04-01T10:00:00+00:00',
    songs: { slug: 'supernova-a000', title: 'Supernova', status: 'approved', language: 'English', artist_id: NOVA_ASH, title_translit: null } },
  { name: '', city: '', body: 'Been playing this on repeat since it dropped, the bridge gets me every single time and I still don’t know why.', created_at: '2026-04-03T09:00:00+00:00',
    songs: { slug: 'paper-moons-a000', title: 'Paper Moons', status: 'approved', language: 'English', artist_id: NOVA_ASH, title_translit: null } },
  { name: 'Reuven', city: '', body: 'Third one for the three-comment case.', created_at: '2026-04-02T09:00:00+00:00',
    songs: { slug: 'low-light-a000', title: 'Low Light', status: 'approved', language: 'English', artist_id: NOVA_ASH, title_translit: null } },
];

// chart_snapshots — enough rows that Catalog's "Chart history" sort has a
// real, non-trivial order to assert on (Supernova ahead of Low Light).
function chartRows(songId, weeks, kind = 'plays', rank = 1) {
  return weeks.map((date) => ({ song_id: songId, chart_date: date, rank, kind }));
}
export const CHART_SNAPSHOTS_ROWS = [
  ...chartRows(SONGS.SUPERNOVA, ['2026-02-02', '2026-02-09', '2026-02-16']),
  ...chartRows(SONGS.LOW_LIGHT, ['2026-02-16']),
];

export const SITE_SETTINGS_ROWS = [
  { key: 'milestone_plays', value: [50, 250, 1000] },
  { key: 'milestone_hearts', value: [5, 25, 100] },
  { key: 'milestone_comments', value: [3, 10, 50] },
  { key: 'honors_min_weeks_on_chart', value: 4 },
  { key: 'follow_daily_limit', value: 60 },
  { key: 'picks_max', value: 6 },
  { key: 'contribute_cta_enabled', value: false },
];

// Default artist_picks / recommend_for_artist: empty. Scenario overrides
// (tests/scenarios/*) replace these to exercise the rich case.
export const ARTIST_PICKS_ROWS = [];
export const RECOMMEND_ROWS = [];

// A plain listener: signed in, never uploaded a song, no artists row at all
// (loadSelfFlags' fallback kicks in: is_artist false). Used to test Follow
// from a THIRD account, and "My songs"/"My picks" gating for a non-artist.
export const LISTENER_ID = '44444444-4444-4444-8444-444444444444';

// Signed-in sessions, for /settings (My page) and Follow scenarios. Shape
// matches what js/auth.js reads off supabase-js's session (tests/lib/auth.mjs).
export const SESSION_USERS = {
  NOVA: { id: NOVA_ASH, email: 'nova@example.test' },
  LISTENER: { id: LISTENER_ID, email: 'listener@example.test' },
};

// auth.js's loadSelfFlags() reads THIS shape from the `artists` TABLE
// (RLS-scoped to the caller's own row) -- distinct from ARTISTS_PUBLIC
// above, which is the `artists_public` VIEW everyone can read. Keyed by
// user id; an id with no entry here means "no row" (loadSelfFlags' own
// fallback: is_artist false).
export const SELF_ARTIST_ROWS = {
  [NOVA_ASH]: { role: 'artist', onboarded: true, is_artist: true, handle: 'nova-ash', display_name: 'Nova Ash', display_name_he: null, bio: null, avatar_url: null },
};

// artist_follows rows readable under the CALLER's own RLS -- who Nova Ash
// herself follows, for the My page "Following" list.
export const ARTIST_FOLLOWS_ROWS = [
  { artist_id: SABLE_RIDGE },
];

/* ============================================================
   The STATIC snapshot (songs.json / artists.json / channels.json /
   settings.json), exactly the shape scripts/snapshot-songs.mjs writes --
   used ONLY by the outage-fallback scenario, via page.route on the local
   static server's own /*.json responses (see tests/lib/stub-static.mjs).
   Kept in sync with SONGS_ROWS/etc. by hand; if you add a song or badge
   above, check whether honors_min_weeks_on_chart's result below still
   matches what honorsQualifies() would compute.
   ============================================================ */
const CHANNEL_TITLE_BY_ID = new Map(CHANNELS_ROWS.map((c) => [c.id, c.title]));
function moodChipsFor(artistId) {
  const counts = new Map();
  for (const s of SONGS_ROWS) {
    if (s.artist_id !== artistId) continue;
    for (const cid of (s.channels || [])) counts.set(cid, (counts.get(cid) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([id, count]) => ({ id, title: CHANNEL_TITLE_BY_ID.get(id) || id, count }))
    .sort((x, y) => y.count - x.count || x.title.localeCompare(y.title));
}

export const ARTISTS_JSON_ROWS = ARTISTS_PUBLIC.map((a) => ({
  id: a.id, handle: a.handle, name: a.display_name, name_he: a.display_name_he, avatar: a.avatar_url, bio: a.bio,
  song_count: SONGS_ROWS.filter((s) => s.artist_id === a.id).length,
  badges: ARTIST_BADGES_ROWS.filter((b) => b.artist_id === a.id),
  stats: ARTIST_STATS[a.id] || null,
  mood_chips: moodChipsFor(a.id),
  picks: ARTIST_PICKS_ROWS.filter((p) => p.artist_id === a.id),
  honors: a.id === NOVA_ASH ? [SONGS.SUPERNOVA, SONGS.LOW_LIGHT, SONGS.PAPER_MOONS] : [],
  milestones: SONG_MILESTONES_ROWS.filter((m) => SONGS_ROWS.find((s) => s.id === m.song_id)?.artist_id === a.id),
  follower_count: FOLLOWER_COUNTS[a.id] ?? 0,
}));
