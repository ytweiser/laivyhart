#!/usr/bin/env node
/* ============================================================
   HOME-1: regenerates worker/src/cities.json, the compact list of
   decent-size world cities the Worker uses to turn request.cf's
   coordinates into a shareable "played in <city>" label.

   Source: GeoNames (https://www.geonames.org, CC BY 4.0), cities15000
   (every city with a population over 15,000), filtered down here to
   population >= 100,000 -- "decent-size", per this prompt's own wording.
   admin1CodesASCII.txt supplies the human-readable region name (GeoNames'
   raw rows only carry a numeric/alpha admin1 code, not a name).

   This is a manual, occasional utility, not part of any build or deploy
   step (the city list does not change often enough to justify a network
   fetch on every Worker deploy, and Workers have no filesystem access at
   runtime anyway -- the committed JSON is what actually ships). Run it by
   hand when GeoNames publishes a fresher dump:

     node scripts/build-cities.mjs

   Output fields are deliberately short keys (n/r/c/a/o) since this file
   ships inside the Worker bundle: n = ASCII name (GeoNames' own
   transliteration, e.g. "Petah Tiqva" rather than "Petaẖ Tiqva", so it
   renders the same everywhere), r = region name (null for the handful of
   territories GeoNames has no admin1 entry for), c = ISO 3166-1 alpha-2
   country code, a/o = latitude/longitude rounded to 4 decimal places
   (about 11m -- far finer than "nearest city" ever needs, just avoids
   carrying GeoNames' own float noise).
   ============================================================ */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = join(ROOT, 'worker', 'src', 'cities.json');
const MIN_POPULATION = 100000;

const CITIES15000_URL = 'https://download.geonames.org/export/dump/cities15000.zip';
const ADMIN1_URL = 'https://download.geonames.org/export/dump/admin1CodesASCII.txt';

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res;
}

async function main() {
  console.log('[build-cities] fetching admin1 region names...');
  const admin1Text = await (await fetchText(ADMIN1_URL)).text();
  const admin1Map = new Map();
  for (const line of admin1Text.split('\n')) {
    if (!line.trim()) continue;
    const [code, name] = line.split('\t');
    if (code && name) admin1Map.set(code, name);
  }

  console.log('[build-cities] fetching cities15000 (zipped)...');
  const zipBuf = new Uint8Array(await (await fetchText(CITIES15000_URL)).arrayBuffer());

  // No zip library in scope for a one-off script -- shell out to the
  // system `unzip`, which every dev machine and CI image already has.
  const { writeFileSync: writeTmp } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const scratch = mkdtempSync(join(tmpdir(), 'laivy-cities-'));
  const zipPath = join(scratch, 'cities15000.zip');
  writeTmp(zipPath, zipBuf);
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', scratch]);
  const { readFileSync } = await import('node:fs');
  const citiesText = readFileSync(join(scratch, 'cities15000.txt'), 'utf8');

  const out = [];
  for (const line of citiesText.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const asciiname = cols[2];
    const lat = parseFloat(cols[4]);
    const lon = parseFloat(cols[5]);
    const cc = cols[8];
    const admin1 = cols[10];
    const population = parseInt(cols[14], 10);
    if (!(population >= MIN_POPULATION)) continue;
    const region = admin1Map.get(cc + '.' + admin1) || null;
    out.push({
      n: asciiname,
      r: region,
      c: cc,
      a: Math.round(lat * 10000) / 10000,
      o: Math.round(lon * 10000) / 10000,
    });
  }

  writeFileSync(OUT_PATH, JSON.stringify(out));
  console.log(`[build-cities] wrote ${out.length} cities (population >= ${MIN_POPULATION.toLocaleString()}) to ${OUT_PATH}`);
}

main().catch((e) => { console.error('[build-cities] failed:', e && e.message); process.exit(1); });
