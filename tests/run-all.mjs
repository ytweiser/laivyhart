#!/usr/bin/env node
/* ============================================================
   The one command: node run-all.mjs (or `npm test` from inside tests/).

   Starts the local static server, launches one shared headless browser, runs
   every browser-based spec plus the Node-only specs, and reports combined
   pass/fail counts with a non-zero exit code on any failure.

   --only <names>: run just the named specs (comma-separated, matched against
   each spec's short name below -- e.g. `node run-all.mjs --only your-song-page,idea-credit`).
   Meant for iterating on one area while working on a prompt; see CLAUDE.md's
   testing rules for when to use this versus the full run.

   Never touches the live site or anyone's real Chrome -- see lib/browser.mjs
   for exactly what's blocked and why.
   ============================================================ */
import { launchBrowser } from './lib/browser.mjs';
import { serve } from './lib/server.mjs';

const PORT = Number(process.env.LAIVY_TEST_PORT || 8743);

// name: the short name --only matches against. kind: 'browser' (run(browser,
// PORT)), 'port' (run(PORT), no browser instance needed but still wants the
// static server), or 'none' (run(), no server or browser at all).
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
  { name: 'admin-dedications', path: './specs/admin-dedications.spec.mjs', kind: 'browser' },
  { name: 'dedicate', path: './specs/dedicate.spec.mjs', kind: 'browser' },
  { name: 'dedication-page', path: './specs/dedication-page.spec.mjs', kind: 'browser' },
  { name: 'dedication-occasions', path: './specs/dedication-occasions.spec.mjs', kind: 'browser' },
  { name: 'admin-song-ideas', path: './specs/admin-song-ideas.spec.mjs', kind: 'browser' },
  { name: 'your-song-page', path: './specs/your-song-page.spec.mjs', kind: 'browser' },
  { name: 'your-song-ideas-board', path: './specs/your-song-ideas-board.spec.mjs', kind: 'browser' },
  { name: 'idea-credit', path: './specs/idea-credit.spec.mjs', kind: 'browser' },
  { name: 'middleware', path: './specs/middleware.spec.mjs', kind: 'none' },
  { name: 'worker-activity', path: './specs/worker-activity.spec.mjs', kind: 'none' },
  { name: 'canonical-origin', path: './specs/canonical-origin.spec.mjs', kind: 'none' },
  { name: 'worker-song-idea-notify', path: './specs/worker-song-idea-notify.spec.mjs', kind: 'none' },
];

function parseOnly(argv) {
  const i = argv.indexOf('--only');
  if (i === -1) return null;
  const arg = argv[i + 1] || '';
  return arg.split(',').map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const only = parseOnly(process.argv.slice(2));
  const specs = only ? SPECS.filter((s) => only.includes(s.name)) : SPECS;

  if (only) {
    const unknown = only.filter((n) => !SPECS.some((s) => s.name === n));
    if (unknown.length) {
      console.error(`Unknown spec name(s): ${unknown.join(', ')}`);
      console.error(`Known names: ${SPECS.map((s) => s.name).join(', ')}`);
      process.exit(1);
    }
    console.log(`--only: running ${specs.map((s) => s.name).join(', ')}`);
  }

  const results = [];
  const needsServerOrBrowser = specs.some((s) => s.kind !== 'none');

  if (needsServerOrBrowser) {
    const server = await serve(PORT);
    const browser = await launchBrowser();
    try {
      for (const s of specs) {
        if (s.kind === 'none') continue;
        const mod = await import(s.path);
        results.push(s.kind === 'browser' ? await mod.run(browser, PORT) : await mod.run(PORT));
      }
    } finally {
      await browser.close();
      server.close();
    }
  }

  for (const s of specs) {
    if (s.kind !== 'none') continue;
    const mod = await import(s.path);
    results.push(await mod.run());
  }

  const totalPassed = results.reduce((n, r) => n + r.passed, 0);
  const totalFailed = results.reduce((n, r) => n + r.failed, 0);
  console.log(`\n${'='.repeat(50)}`);
  console.log(`TOTAL: ${totalPassed} passed, ${totalFailed} failed`);
  if (totalFailed) {
    console.log('\nFailures:');
    for (const r of results) for (const f of r.failures) console.log('  - ' + f);
  }
  process.exit(totalFailed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
