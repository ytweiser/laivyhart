/* ============================================================
   CANON-1: laivyhart.com (no www) is the one canonical address. Vercel
   308-redirects www to it, so every file this site serves or produces at
   build time should read/write the bare domain, not the www form -- a
   leftover www link just adds a redirect hop for a visitor or a crawler.

   Plain filesystem scan, no browser needed. Scoped to what the site itself
   serves or produces at build time -- `tests/` (this harness, including its
   own egress block list that intentionally blocks both the bare and www
   hosts) and `worker/` (the Cloudflare Worker, a separate runtime whose CORS
   allowlist intentionally keeps both origins -- CANON-1's own guard line:
   "Do not change the Worker") are out of scope and skipped.
   ============================================================ */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../lib/report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'tests', 'worker']);
const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.xml', '.txt', '.webmanifest', '.md']);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
}

export async function run() {
  const r = makeReporter('canonical-origin.spec.mjs');

  const files = [];
  walk(ROOT, files);
  const offenders = [];
  for (const full of files) {
    const rel = relative(ROOT, full).split('\\').join('/');
    const dot = rel.lastIndexOf('.');
    const ext = dot === -1 ? '' : rel.slice(dot);
    if (!TEXT_EXT.has(ext)) continue;
    const text = readFileSync(full, 'utf8');
    if (text.includes('https://www.laivyhart.com')) offenders.push(rel);
  }
  r.check('no file served to the browser or produced by the build contains https://www.laivyhart.com', offenders.length === 0, offenders.join(', '));

  return r;
}
