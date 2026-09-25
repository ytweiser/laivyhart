#!/usr/bin/env node
/* ============================================================
   Regenerate songs.json (the public songs list) and chart.json (the latest
   daily chart snapshot) — the static snapshots the site falls back to.

   songs.json is the outage/offline fallback: if Supabase is unavailable
   (network error, or HTTP 402 when the project is paused), index.html and
   middleware.js read this file instead so the jukebox keeps working.

   This runs automatically on every Vercel deploy (see vercel.json buildCommand)
   so songs.json is regenerated from the live database and no longer needs a
   manual commit. You can still run it by hand:

     node scripts/snapshot-songs.mjs

   It reads the Supabase URL + publishable key straight from config.js (the
   single source of truth, available at build time) and writes the rows exactly
   as index.html's `.from('songs').select('*').order('title')` returns them,
   which is what mapSong() expects.

   Since 006_artists_and_ownership it also filters to status = 'approved' and
   embeds the owning artist on each row, and writes artists.json beside
   songs.json. Since CH-1 it also embeds `channels: [id, …]` on each row and
   writes channels.json. Since BADGE-1 it also embeds
   `badges: [{badge, value, sort}, …]` read from the song_badges view. Category fields are still emitted untouched; retiring
   them from the UI is CH-2. The status filter is belt and braces: RLS already hides
   everything else from the publishable key, but naming it here means the
   snapshot cannot quietly start carrying drafts if that policy ever loosens.

   BUILD-SAFE: if Supabase is unreachable or returns a non-2xx (e.g. HTTP 402
   while the project is paused), this does NOT fail — it keeps the committed
   songs.json and exits 0 so the deploy still succeeds with the last good
   snapshot. It only fails hard if there is no existing snapshot to fall back
   to (which would leave the site with no data).
   ============================================================ */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'songs.json');
const chartPath = join(root, 'chart.json');
const artistsPath = join(root, 'artists.json');
const channelsPath = join(root, 'channels.json');
const sitemapPath = join(root, 'sitemap.xml');
const robotsPath = join(root, 'robots.txt');

// Keep the committed snapshot and let the build proceed, unless there is no
// snapshot at all (then there is nothing to serve, so fail hard).
function keepExisting(reason) {
  if (existsSync(outPath)) {
    console.warn(`[snapshot] ${reason} — keeping the existing songs.json.`);
    process.exit(0);
  }
  console.error(`[snapshot] ${reason} — and no existing songs.json to fall back to.`);
  process.exit(1);
}

const cfg = readFileSync(join(root, 'config.js'), 'utf8');
const url = cfg.match(/SUPABASE_URL:\s*"([^"]+)"/)?.[1];
const key = cfg.match(/SUPABASE_ANON_KEY:\s*"([^"]+)"/)?.[1];
if (!url || !key) keepExisting('Could not read Supabase config from config.js');

const headers = { apikey: key, Authorization: `Bearer ${key}` };

let res;
try {
  res = await fetch(`${url}/rest/v1/songs?select=*&status=eq.approved&order=title`, { headers });
} catch (e) {
  keepExisting(`Supabase request failed (${e && e.message})`);
}
if (!res.ok) keepExisting(`Supabase returned HTTP ${res.status}`);

let rows;
try {
  rows = await res.json();
} catch (e) {
  keepExisting('Supabase response was not valid JSON');
}
if (!Array.isArray(rows) || rows.length === 0) {
  keepExisting('Supabase response was empty or not an array');
}

/* ------------------------------------------------------------
   Artists. Read from artists_public (the view, not the table: it is the
   allow-list of non-sensitive columns for active artists) and embed a compact
   artist object on every song, so a consumer of songs.json never has to join.

   Soft-fail on purpose: songs.json is the artifact the site cannot do without,
   so if the artists request fails we still write the songs, just without the
   embedded artist, and leave any existing artists.json in place. Nothing reads
   the field yet, so a build that misses it degrades rather than breaks.
   ------------------------------------------------------------ */
function compactArtist(a) {
  return {
    id: a.id,
    handle: a.handle,
    name: a.display_name,
    name_he: a.display_name_he,
    avatar: a.avatar_url,
  };
}

/* The artist embedded on each SONG uses the live read's shape exactly
   (HERO-2: index.html embeds artist:artists_public!songs_artist_id_fkey(
   handle, display_name, avatar_url)), so one renderer serves live and
   snapshot. artists.json keeps compactArtist -- it is a different artifact
   (artist pages, middleware) with bio/song_count/badges alongside. */
function songArtist(a) {
  return { handle: a.handle, display_name: a.display_name, avatar_url: a.avatar_url };
}

let artists = null;
try {
  const ares = await fetch(
    `${url}/rest/v1/artists_public?select=id,handle,display_name,display_name_he,avatar_url,bio,created_at&order=handle`,
    { headers },
  );
  if (!ares.ok) throw new Error(`HTTP ${ares.status}`);
  const arows = await ares.json();
  if (!Array.isArray(arows)) throw new Error('not an array');
  artists = arows;
} catch (e) {
  console.warn(`[snapshot] Could not read artists_public (${e && e.message}) — writing songs.json without the embedded artist, and keeping any existing artists.json.`);
}

if (artists) {
  const byId = new Map(artists.map((a) => [a.id, songArtist(a)]));
  for (const row of rows) {
    row.artist = byId.get(row.artist_id) || null;
  }
}

/* ------------------------------------------------------------
   Channels (CH-1). Overlapping mood sets, many per song — the browse layer
   that will replace the three category groups. This embeds `channels: [id, …]`
   on every song, ordered by the CHANNEL's sort_order so a consumer can render
   them in the owner's intended order without a second lookup, and writes
   channels.json beside songs.json.

   Nothing in index.html reads either yet; the homepage strip and the /listen
   swap are CH-2. Category fields are deliberately left untouched.

   Soft-fail like artists above: songs.json is the artifact the site cannot do
   without, so if either channel request fails we still write the songs, just
   without the channel ids, and keep any existing channels.json.
   ------------------------------------------------------------ */
let channels = null;
try {
  const cres = await fetch(
    `${url}/rest/v1/channels?select=id,title,tagline,sort_order,active&order=sort_order`,
    { headers },
  );
  if (!cres.ok) throw new Error(`HTTP ${cres.status}`);
  const crows = await cres.json();
  if (!Array.isArray(crows)) throw new Error('not an array');

  const mres = await fetch(
    `${url}/rest/v1/song_channels?select=song_id,channel_id`,
    { headers },
  );
  if (!mres.ok) throw new Error(`memberships HTTP ${mres.status}`);
  const mrows = await mres.json();
  if (!Array.isArray(mrows)) throw new Error('memberships not an array');

  channels = crows;

  // Rank by the channel's own sort_order, so every song's list comes out in
  // the same, deliberate order rather than in whatever order PostgREST
  // returned the membership rows.
  const rank = new Map(crows.map((c, i) => [c.id, i]));
  const bySong = new Map();
  for (const m of mrows) {
    if (!rank.has(m.channel_id)) continue;          // inactive or unknown
    if (!bySong.has(m.song_id)) bySong.set(m.song_id, []);
    bySong.get(m.song_id).push(m.channel_id);
  }
  for (const [, list] of bySong) list.sort((a, b) => rank.get(a) - rank.get(b));
  for (const row of rows) row.channels = bySong.get(row.id) || [];
} catch (e) {
  console.warn(`[snapshot] Could not read channels (${e && e.message}) — writing songs.json without channel ids, and keeping any existing channels.json.`);
}

/* ------------------------------------------------------------
   Badges (BADGE-1). song_badges is a VIEW, so there is nothing to compute
   here -- read it and group by song. Ordered by `sort`, which is the priority
   the view already assigns, so a consumer never re-derives it.

   CAVEAT worth knowing: four of these badges are LIVE (number_one_week,
   most_loved, most_talked, new), so what lands in songs.json is their value at
   BUILD TIME. The snapshot is the offline/outage fallback; a live read is
   always fresher. BADGE-2 decides which to prefer.

   Soft-fail like artists and channels: songs.json is the artifact the site
   cannot do without, so a failed badge read still writes the songs, just
   without the badges array.
   ------------------------------------------------------------ */
try {
  const bres = await fetch(`${url}/rest/v1/song_badges?select=song_id,badge,value,sort`, { headers });
  if (!bres.ok) throw new Error(`HTTP ${bres.status}`);
  const brows = await bres.json();
  if (!Array.isArray(brows)) throw new Error('not an array');

  const bySong = new Map();
  for (const b of brows) {
    if (!bySong.has(b.song_id)) bySong.set(b.song_id, []);
    bySong.get(b.song_id).push({ badge: b.badge, value: b.value, sort: b.sort });
  }
  for (const [, list] of bySong) list.sort((a, b) => a.sort - b.sort);
  for (const row of rows) row.badges = bySong.get(row.id) || [];

  const earned = rows.reduce((n, r) => n + r.badges.length, 0);
  console.log(`[snapshot] Read ${earned} badge(s) across ${bySong.size} song(s).`);
} catch (e) {
  console.warn(`[snapshot] Could not read song_badges (${e && e.message}) — writing songs.json without badges.`);
}

/* 1B-3: the public settings subset, so the homepage's launch switch has a
   build-time fallback. Only the keys listed are ever written -- site_settings
   also holds admin knobs that do not belong in a public file. On failure the
   file is simply not rewritten and the site falls back to its defaults (off). */
try {
  const PUBLIC_KEYS = ['contribute_cta_enabled'];
  const sres = await fetch(`${url}/rest/v1/site_settings?select=key,value&key=in.(${PUBLIC_KEYS.join(',')})`, { headers });
  if (!sres.ok) throw new Error(`HTTP ${sres.status}`);
  const srows = await sres.json();
  if (!Array.isArray(srows)) throw new Error('not an array');
  writeFileSync(join(root, 'settings.json'), JSON.stringify(srows, null, 2) + '\n');
  console.log(`[snapshot] Wrote settings.json with ${srows.length} public setting(s).`);
} catch (e) {
  console.warn(`[snapshot] Could not read public settings (${e && e.message}) — keeping any existing settings.json.`);
}

/* 1B-1: songs.json is a PUBLIC file. proposed_channels and proposed_tags are a
   contributor's private suggestions to the owner, consumed at review time, so
   they are stripped here rather than published. `select=*` picks up every new
   column automatically, which is convenient until a column is internal. */
for (const row of rows) {
  delete row.proposed_channels;
  delete row.proposed_tags;
}

writeFileSync(outPath, JSON.stringify(rows, null, 2) + '\n');
console.log(`[snapshot] Wrote songs.json with ${rows.length} approved songs.`);

if (channels) {
  writeFileSync(channelsPath, JSON.stringify(channels, null, 2) + '\n');
  const placed = rows.filter((r) => r.channels && r.channels.length).length;
  console.log(`[snapshot] Wrote channels.json with ${channels.length} channel(s); `
    + `${placed}/${rows.length} songs carry at least one channel.`);
}

if (artists) {
  // song_count is approved songs only, matching what songs.json carries.
  const counts = new Map();
  for (const row of rows) counts.set(row.artist_id, (counts.get(row.artist_id) || 0) + 1);

  /* BADGE-3: the trophy-case aggregate, so artists.json is a real fallback for
     the artist page rather than leaving the case blank during an outage. Read
     from the artist_badges view -- the aggregate semantics (distinct weeks,
     not song-weeks) live there and must not be re-derived from song badges,
     which would silently give a different answer. */
  let artistBadges = new Map();
  try {
    const abres = await fetch(`${url}/rest/v1/artist_badges?select=artist_id,badge,value,sort`, { headers });
    if (!abres.ok) throw new Error(`HTTP ${abres.status}`);
    const abrows = await abres.json();
    if (!Array.isArray(abrows)) throw new Error('not an array');
    for (const b of abrows) {
      if (!artistBadges.has(b.artist_id)) artistBadges.set(b.artist_id, []);
      artistBadges.get(b.artist_id).push({ badge: b.badge, value: b.value, sort: b.sort });
    }
    for (const [, list] of artistBadges) list.sort((x, y) => x.sort - y.sort);
    console.log(`[snapshot] Read artist honors for ${artistBadges.size} artist(s).`);
  } catch (e) {
    console.warn(`[snapshot] Could not read artist_badges (${e && e.message}) — artists.json without honors.`);
  }

  const out = artists.map((a) => ({
    ...compactArtist(a),
    song_count: counts.get(a.id) || 0,
    badges: artistBadges.get(a.id) || [],
  }));
  writeFileSync(artistsPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`[snapshot] Wrote artists.json with ${out.length} artist(s).`);
}

/* ------------------------------------------------------------
   chart.json — the latest daily chart snapshot (top 10).

   The homepage weekly ranking (hero + "Most listened this week" rail) reads
   this instead of the live plays_7d, so the order only changes once a night
   when take_chart_snapshot() closes the Jerusalem day. index.html prefers the
   live chart_snapshots rows when Supabase is reachable (so a new night's chart
   appears without a deploy) and falls back to this file otherwise.

   Same build-safe rule as songs.json, and softer: any failure here keeps the
   existing chart.json and never fails the build. With no chart.json at all the
   homepage simply ranks by play_count, so there is nothing to fail hard over.
   ------------------------------------------------------------ */
function keepExistingChart(reason) {
  console.warn(`[snapshot] ${reason} — keeping the existing chart.json.`);
}

async function writeChart() {
  let cres;
  try {
    // ranks 1-10 of one date, so the 10 newest rows are the latest chart.
    // kind=plays: the nightly words/music lists live in this table too (1A-6).
    cres = await fetch(
      `${url}/rest/v1/chart_snapshots?select=chart_date,rank,song_id&kind=eq.plays&order=chart_date.desc,rank.asc&limit=10`,
      { headers },
    );
  } catch (e) {
    return keepExistingChart(`Chart request failed (${e && e.message})`);
  }
  if (!cres.ok) return keepExistingChart(`Chart request returned HTTP ${cres.status}`);

  let crows;
  try {
    crows = await cres.json();
  } catch (e) {
    return keepExistingChart('Chart response was not valid JSON');
  }
  if (!Array.isArray(crows) || crows.length === 0) {
    return keepExistingChart('Chart response was empty or not an array');
  }

  // Guard against a half-written date: keep only the newest chart_date's rows.
  const chartDate = crows[0].chart_date;
  const entries = crows
    .filter((r) => r.chart_date === chartDate && r.song_id && r.rank >= 1 && r.rank <= 10)
    .sort((a, b) => a.rank - b.rank)
    .map((r) => ({ rank: r.rank, song_id: r.song_id }));
  if (entries.length === 0) return keepExistingChart('Chart rows had no usable entries');

  writeFileSync(chartPath, JSON.stringify({ chart_date: chartDate, entries }, null, 2) + '\n');
  console.log(`[snapshot] Wrote chart.json for ${chartDate} with ${entries.length} entries.`);
}

await writeChart();

/* ------------------------------------------------------------
   sitemap.xml + robots.txt

   vercel.json sets outputDirectory ".", so the repo root IS the served root
   and both files land at https://www.laivyhart.com/<name>.

   lastmod: songs have no updated_at, so reviewed_at (when the song became
   public) is the honest signal, falling back to created_at. Priorities are
   uniform and modest on purpose -- a sitemap tells a crawler what exists, it
   does not rank anything, and pretending otherwise just adds noise.

   Only approved songs with a slug, and only artists that artists_public
   returned (which already excludes suspended and deleted), ever appear.
   ------------------------------------------------------------ */
const SITE = 'https://www.laivyhart.com';

function xmlEscape(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function day(v) {
  const t = v ? Date.parse(v) : NaN;
  return isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}
function urlEntry(loc, lastmod, priority) {
  return '  <url>\n    <loc>' + xmlEscape(loc) + '</loc>\n'
    + (lastmod ? '    <lastmod>' + lastmod + '</lastmod>\n' : '')
    + '    <priority>' + priority + '</priority>\n  </url>';
}

try {
  const entries = [
    urlEntry(SITE + '/', null, '1.0'),
    urlEntry(SITE + '/listen', null, '0.8'),
    urlEntry(SITE + '/about', null, '0.5'),
    urlEntry(SITE + '/terms', null, '0.3'),
  ];
  for (const s of rows) {
    if (s.status !== 'approved' || !s.slug) continue;
    entries.push(urlEntry(SITE + '/song/' + encodeURIComponent(s.slug),
                          day(s.reviewed_at || s.created_at), '0.7'));
  }
  for (const a of (artists || [])) {
    entries.push(urlEntry(SITE + '/artist/' + encodeURIComponent(a.handle),
                          day(a.created_at), '0.6'));
  }
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemap.org/schemas/sitemap/0.9">\n'.replace('www.sitemap.org', 'www.sitemaps.org')
    + entries.join('\n') + '\n</urlset>\n';
  writeFileSync(sitemapPath, xml);
  console.log(`[snapshot] Wrote sitemap.xml with ${entries.length} URLs.`);

  writeFileSync(robotsPath,
    'User-agent: *\n' +
    'Allow: /\n' +
    'Disallow: /admin.html\n' +
    'Disallow: /auth/\n' +
    'Disallow: /settings\n' +
    '\n' +
    'Sitemap: ' + SITE + '/sitemap.xml\n');
  console.log('[snapshot] Wrote robots.txt.');
} catch (e) {
  // Same build-safe rule as everything else here: a missing sitemap is a
  // smaller problem than a failed deploy.
  console.warn(`[snapshot] Could not write sitemap/robots (${e && e.message}) — keeping any existing files.`);
}
