#!/usr/bin/env node
/* ============================================================
   The one command: node run-all.mjs (or `npm test` from inside tests/).

   TEST-1: runs every spec file across a pool of forked worker processes
   (default: CPU cores minus one, override with --jobs N), each with its
   own static server port and its own browser, launched once per worker and
   reused across that worker's specs (lib/worker-entry.mjs). A separate OS
   process per worker -- not threads, not concurrent promises in one
   process -- is what actually isolates module-level state (jwksCache,
   pickAutoId, ...) between specs running at the same time; see that file's
   own header for why.

   --only <names>: run just the named specs (comma-separated, matched
   against each spec's short name below -- e.g.
   `node run-all.mjs --only your-song-page,idea-credit`). Spread across the
   same worker pool as a full run, just with fewer specs to place.

   Reports combined pass/fail counts with a non-zero exit code on any
   failure, same meaning as the old single-process run: a total line, and
   every failure listed with the spec it came from and its message.

   Never touches the live site or anyone's real Chrome -- see lib/browser.mjs
   for exactly what's blocked and why.
   ============================================================ */
import { fork } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_PORT = Number(process.env.LAIVY_TEST_PORT || 8743);

// name: the short name --only and the worker pool both key off. kind:
// 'browser' (run(browser, port)), 'port' (run(port), no browser instance
// needed but still wants the static server), or 'none' (run(), no server
// or browser at all).
const SPECS = [
  { name: 'homepage', path: './specs/homepage.spec.mjs', kind: 'browser' },
  { name: 'artist-page', path: './specs/artist-page.spec.mjs', kind: 'browser' },
  { name: 'search', path: './specs/search.spec.mjs', kind: 'browser' },
  { name: 'settings', path: './specs/settings.spec.mjs', kind: 'browser' },
  { name: 'song-page', path: './specs/song-page.spec.mjs', kind: 'browser' },
  { name: 'legal-pages', path: './specs/legal-pages.spec.mjs', kind: 'port' },
  { name: 'rating', path: './specs/rating.spec.mjs', kind: 'browser' },
  { name: 'activity', path: './specs/activity.spec.mjs', kind: 'browser' },
  { name: 'admin-pulse', path: './specs/admin-pulse.spec.mjs', kind: 'browser' },
  { name: 'homepage-pulse', path: './specs/homepage-pulse.spec.mjs', kind: 'browser' },
  { name: 'homepage-ticker', path: './specs/homepage-ticker.spec.mjs', kind: 'browser' },
  { name: 'homepage-show-some-hart', path: './specs/homepage-show-some-hart.spec.mjs', kind: 'browser' },
  { name: 'admin-dedications', path: './specs/admin-dedications.spec.mjs', kind: 'browser' },
  { name: 'dedicate', path: './specs/dedicate.spec.mjs', kind: 'browser' },
  { name: 'dedication-send', path: './specs/dedication-send.spec.mjs', kind: 'browser' },
  { name: 'now-playing-layout', path: './specs/now-playing-layout.spec.mjs', kind: 'browser' },
  { name: 'lyrics-lang', path: './specs/lyrics-lang.spec.mjs', kind: 'browser' },
  { name: 'site-header', path: './specs/site-header.spec.mjs', kind: 'browser' },
  { name: 'select-contrast', path: './specs/select-contrast.spec.mjs', kind: 'browser' },
  { name: 'dedication-page', path: './specs/dedication-page.spec.mjs', kind: 'browser' },
  { name: 'profile', path: './specs/profile.spec.mjs', kind: 'browser' },
  { name: 'dedication-occasions', path: './specs/dedication-occasions.spec.mjs', kind: 'browser' },
  { name: 'admin-song-ideas', path: './specs/admin-song-ideas.spec.mjs', kind: 'browser' },
  { name: 'your-song-page', path: './specs/your-song-page.spec.mjs', kind: 'browser' },
  { name: 'your-song-ideas-board', path: './specs/your-song-ideas-board.spec.mjs', kind: 'browser' },
  { name: 'idea-credit', path: './specs/idea-credit.spec.mjs', kind: 'browser' },
  { name: 'your-song-nav', path: './specs/your-song-nav.spec.mjs', kind: 'browser' },
  { name: 'middleware', path: './specs/middleware.spec.mjs', kind: 'none' },
  { name: 'worker-activity', path: './specs/worker-activity.spec.mjs', kind: 'none' },
  { name: 'worker-geo', path: './specs/worker-geo.spec.mjs', kind: 'none' },
  { name: 'canonical-origin', path: './specs/canonical-origin.spec.mjs', kind: 'none' },
  { name: 'grants-audit', path: './specs/grants-audit.spec.mjs', kind: 'none' },
  { name: 'worker-song-idea-notify', path: './specs/worker-song-idea-notify.spec.mjs', kind: 'none' },
  { name: 'play-continuation', path: './specs/play-continuation.spec.mjs', kind: 'browser' },
  { name: 'share-og', path: './specs/share-og.spec.mjs', kind: 'none' },
  { name: 'worker-og-upload', path: './specs/worker-og-upload.spec.mjs', kind: 'none' },
  { name: 'image-compress', path: './specs/image-compress.spec.mjs', kind: 'browser' },
  { name: 'stations', path: './specs/stations.spec.mjs', kind: 'browser' },
  { name: 'sleep-timer', path: './specs/sleep-timer.spec.mjs', kind: 'browser' },
  { name: 'thoughts-block', path: './specs/thoughts-block.spec.mjs', kind: 'browser' },
  { name: 'meta-row', path: './specs/meta-row.spec.mjs', kind: 'browser' },
  { name: 'share-text', path: './specs/share-text.spec.mjs', kind: 'browser' },
];

function parseArg(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  return argv[i + 1] || null;
}

function runWorker(port, specs) {
  return new Promise((resolve) => {
    const child = fork(join(__dirname, 'lib', 'worker-entry.mjs'), [JSON.stringify({ port, specs })], {
      stdio: 'inherit',
    });
    let settled = false;
    child.on('message', (msg) => { settled = true; resolve(msg); });
    child.on('error', (e) => { if (!settled) { settled = true; resolve({ ok: false, error: String(e) }); } });
    child.on('exit', (code) => {
      if (!settled) resolve({ ok: false, error: `worker for [${specs.map((s) => s.name).join(', ')}] exited with code ${code} before reporting` });
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const only = parseArg(argv, '--only');
  const onlyNames = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const jobsArg = parseArg(argv, '--jobs');
  const defaultJobs = Math.max(1, os.cpus().length - 1);
  const jobs = jobsArg ? Math.max(1, Number(jobsArg)) : defaultJobs;

  let specs = SPECS;
  if (onlyNames) {
    const unknown = onlyNames.filter((n) => !SPECS.some((s) => s.name === n));
    if (unknown.length) {
      console.error(`Unknown spec name(s): ${unknown.join(', ')}`);
      console.error(`Known names: ${SPECS.map((s) => s.name).join(', ')}`);
      process.exit(1);
    }
    specs = SPECS.filter((s) => onlyNames.includes(s.name));
    console.log(`--only: running ${specs.map((s) => s.name).join(', ')}`);
  }

  const numWorkers = Math.max(1, Math.min(jobs, specs.length));
  console.log(`Running ${specs.length} spec file(s) across ${numWorkers} worker(s)...`);

  // Round-robin, not a contiguous slice: adjacent entries above are often
  // related (the your-song-* trio, the admin-* trio, ...) and tend to be
  // similarly sized, so spreading by stride balances the pool better than
  // handing one worker a whole cluster of the slowest specs.
  const buckets = Array.from({ length: numWorkers }, () => []);
  // Resolved to an absolute URL here, relative to THIS file -- worker-entry.mjs
  // lives one directory down (tests/lib/), so a bare relative path like
  // './specs/...' would resolve wrong there.
  specs.forEach((s, i) => buckets[i % numWorkers].push({ ...s, path: new URL(s.path, import.meta.url).href }));

  const t0 = Date.now();
  const workerResults = await Promise.all(
    buckets.map((bucket, i) => runWorker(BASE_PORT + i, bucket)),
  );
  const wallMs = Date.now() - t0;

  const allResults = [];
  let hadWorkerError = false;
  for (const wr of workerResults) {
    if (!wr || !wr.ok) {
      hadWorkerError = true;
      console.error('A test worker failed to report results:', wr && wr.error);
      continue;
    }
    allResults.push(...wr.results);
  }

  const totalPassed = allResults.reduce((n, r) => n + r.passed, 0);
  const totalFailed = allResults.reduce((n, r) => n + r.failed, 0);
  console.log(`\n${'='.repeat(50)}`);
  console.log(`TOTAL: ${totalPassed} passed, ${totalFailed} failed`);
  if (totalFailed) {
    console.log('\nFailures:');
    for (const r of allResults) for (const f of r.failures) console.log(`  - [${r.name}] ${f}`);
  }
  console.log(`Wall time: ${(wallMs / 1000).toFixed(1)}s across ${numWorkers} worker(s)`);
  process.exit((totalFailed || hadWorkerError) ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
