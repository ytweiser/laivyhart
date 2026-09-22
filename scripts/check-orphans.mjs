#!/usr/bin/env node
/* ============================================================
   Housekeeping: reconcile the R2 avatars/ prefix against the artists table.

   Reports two things and CHANGES NOTHING:
     ORPHANS  — objects under avatars/ that no live artist row points at.
                Usually a replaced photo: the upload path writes a new
                avatars/<uid>/<timestamp>.jpg each time and never deletes the
                previous one, so every change leaves one behind.
     MISSING  — an artists.avatar_url that points at an object which is not
                there, which would render as a broken image.

   Deleting is deliberately not automated. An orphan is somebody's photo, a
   mistake is not reversible, and this runs rarely enough that a human reading
   the list once a month is the right cost.

     node scripts/check-orphans.mjs

   LISTING NEEDS WRANGLER 4. The pinned wrangler in worker/ is 3.114, whose
   `r2 object` command only has get/put/delete -- there is no list subcommand,
   so the orphan half cannot run there. Either upgrade:
       cd worker && npm i -D wrangler@4
       npx wrangler r2 object list laivyhart-audio --prefix avatars/
   or read the prefix in the Cloudflare dashboard (R2 > laivyhart-audio >
   avatars/). The MISSING direction needs no listing and always runs.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUCKET = 'laivyhart-audio';
const PREFIX = 'avatars/';

const cfg = readFileSync(join(root, 'config.js'), 'utf8');
const url = cfg.match(/SUPABASE_URL:\s*"([^"]+)"/)?.[1];
const key = cfg.match(/SUPABASE_ANON_KEY:\s*"([^"]+)"/)?.[1];

/* artists_public only returns PUBLIC artists since 1A-7, and a listener can
   have an avatar too, so this reads the snapshot AND the view and unions them.
   An avatar referenced by a listener is NOT an orphan. */
async function referencedAvatars() {
  const refs = new Set();
  try {
    const res = await fetch(`${url}/rest/v1/artists_public?select=id,avatar_url`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (res.ok) {
      for (const a of await res.json()) if (a.avatar_url) refs.add(a.avatar_url);
    }
  } catch (e) { /* fall through to the snapshot */ }
  try {
    for (const a of JSON.parse(readFileSync(join(root, 'artists.json'), 'utf8'))) {
      if (a.avatar) refs.add(a.avatar);
    }
  } catch (e) { /* no snapshot yet */ }
  return refs;
}

function listR2Keys() {
  try {
    const out = execSync(
      `npx --no-install wrangler r2 object list ${BUCKET} --prefix ${PREFIX}`,
      { cwd: join(root, 'worker'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000 },
    );
    // Tolerate either the JSON listing or the plain table, since the shape has
    // changed between wrangler majors.
    try {
      const j = JSON.parse(out);
      const arr = Array.isArray(j) ? j : (j.objects || j.result || []);
      return arr.map((o) => o.key || o.name).filter(Boolean);
    } catch (e) {
      return out.split('\n').map((l) => (l.match(/(avatars\/\S+)/) || [])[1]).filter(Boolean);
    }
  } catch (e) {
    return null;    // no list subcommand on wrangler 3, or not logged in
  }
}

const refs = await referencedAvatars();
const keys = listR2Keys();

console.log(`referenced avatar_url values : ${refs.size}`);
for (const r of refs) console.log(`  ref  ${r}`);

if (keys === null) {
  console.log('\nORPHANS: not checked. The pinned wrangler (3.x) has no `r2 object list`.');
  console.log('  Upgrade:  cd worker && npm i -D wrangler@4');
  console.log('  Then:     npx wrangler r2 object list laivyhart-audio --prefix avatars/');
  console.log('  Or read R2 > laivyhart-audio > avatars/ in the Cloudflare dashboard.');
  if (refs.size === 0) {
    console.log('  Note: nothing references an avatar yet, so anything under avatars/');
    console.log('  would be an orphan. The upload route has never run in production.');
  }
} else {
  console.log(`\nobjects under ${PREFIX} : ${keys.length}`);
  const orphans = keys.filter((k) => ![...refs].some((r) => r.endsWith(k)));
  console.log(`ORPHANS (no live artist points at these): ${orphans.length}`);
  for (const o of orphans) console.log(`  orphan  ${o}`);
}

// The other direction needs no bucket listing: just ask for the object.
console.log('\nMISSING (avatar_url that does not resolve):');
let missing = 0;
for (const r of refs) {
  try {
    const res = await fetch(r, { method: 'HEAD' });
    if (!res.ok) { missing++; console.log(`  missing  ${r}  (HTTP ${res.status})`); }
  } catch (e) {
    missing++; console.log(`  missing  ${r}  (${e && e.message})`);
  }
}
if (!missing) console.log('  none');
console.log('\nNothing was deleted. This is a report.');
