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

let res;
try {
  res = await fetch(`${url}/rest/v1/songs?select=*&order=title`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
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

writeFileSync(outPath, JSON.stringify(rows, null, 2) + '\n');
console.log(`[snapshot] Wrote songs.json with ${rows.length} songs.`);

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
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
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
