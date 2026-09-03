#!/usr/bin/env node
/* ============================================================
   Regenerate songs.json — a static snapshot of the public songs list.

   songs.json is the outage/offline fallback: if Supabase is unavailable
   (network error, or HTTP 402 when the project is paused), index.html and
   middleware.js read this file instead so the jukebox keeps working.

   Rerun this after adding or editing songs (and after the R2 cover migration,
   so the snapshot carries R2 cover URLs):

     node scripts/snapshot-songs.mjs

   It reads the Supabase URL + publishable key straight from config.js (the
   single source of truth) and writes the rows exactly as index.html's
   `.from('songs').select('*').order('title')` returns them, which is what
   mapSong() expects.
   ============================================================ */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const cfg = readFileSync(join(root, 'config.js'), 'utf8');
const url = cfg.match(/SUPABASE_URL:\s*"([^"]+)"/)?.[1];
const key = cfg.match(/SUPABASE_ANON_KEY:\s*"([^"]+)"/)?.[1];
if (!url || !key) {
  console.error('Could not read SUPABASE_URL / SUPABASE_ANON_KEY from config.js');
  process.exit(1);
}

const endpoint = `${url}/rest/v1/songs?select=*&order=title`;
const res = await fetch(endpoint, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
if (!res.ok) {
  console.error(`Supabase returned HTTP ${res.status} — snapshot NOT updated.`);
  process.exit(1);
}
const rows = await res.json();
if (!Array.isArray(rows)) {
  console.error('Unexpected response (not an array) — snapshot NOT updated.');
  process.exit(1);
}

writeFileSync(join(root, 'songs.json'), JSON.stringify(rows, null, 2) + '\n');
console.log(`Wrote songs.json with ${rows.length} songs.`);
