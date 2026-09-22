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
   songs.json. The status filter is belt and braces: RLS already hides
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
  const byId = new Map(artists.map((a) => [a.id, compactArtist(a)]));
  for (const row of rows) {
    row.artist = byId.get(row.artist_id) || null;
  }
}

writeFileSync(outPath, JSON.stringify(rows, null, 2) + '\n');
console.log(`[snapshot] Wrote songs.json with ${rows.length} approved songs.`);

if (artists) {
  // song_count is approved songs only, matching what songs.json carries.
  const counts = new Map();
  for (const row of rows) counts.set(row.artist_id, (counts.get(row.artist_id) || 0) + 1);
  const out = artists.map((a) => ({ ...compactArtist(a), song_count: counts.get(a.id) || 0 }));
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
    cres = await fetch(
      `${url}/rest/v1/chart_snapshots?select=chart_date,rank,song_id&order=chart_date.desc,rank.asc&limit=10`,
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
