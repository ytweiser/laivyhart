#!/usr/bin/env node
/* ============================================================
   Regenerate songs.json — a static snapshot of the public songs list.

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
