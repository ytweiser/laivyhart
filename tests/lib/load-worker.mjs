/* ============================================================
   HOME-1: loads worker/src/index.js for a Node-direct test, the same way
   middleware.spec.mjs loads middleware.js -- via a scratch copy with one
   import rewritten, because the two runtimes disagree about static JSON
   imports in a way neither side is "wrong" about.

   worker/src/geo.js does `import CITIES from './cities.json';` with no
   assertion, which is what Cloudflare's own bundler wants (and Workers
   have no filesystem to read it from at runtime, so this has to stay a
   real import, not a readFileSync). Node 22's own ESM loader, running
   geo.js directly with no bundler, refuses that same import without an
   explicit `with { type: 'json' }` attribute. So: copy worker/src/ to a
   temp dir, add the attribute to the copy's geo.js only, import the copy.
   No logic changes, just that one attribute, exactly middleware.spec.mjs's
   own reasoning for songs.json/artists.json.
   ============================================================ */
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function shimScratchCopy() {
  const scratch = mkdtempSync(join(tmpdir(), 'laivy-worker-test-'));
  cpSync(join(ROOT, 'worker', 'src'), scratch, { recursive: true });

  const geoPath = join(scratch, 'geo.js');
  const original = readFileSync(geoPath, 'utf8');
  const shimmed = original.replace(
    "import CITIES from './cities.json';",
    "import CITIES from './cities.json' with { type: 'json' };",
  );
  writeFileSync(geoPath, shimmed);

  return scratch;
}

export async function loadWorker() {
  return import(join(shimScratchCopy(), 'index.js'));
}

// HOME-1: the nearest-city spec exercises geo.js directly rather than
// through the Worker's /event route, so it needs its own loader -- same
// scratch-copy-and-shim, just importing geo.js instead of index.js.
export async function loadGeo() {
  return import(join(shimScratchCopy(), 'geo.js'));
}
