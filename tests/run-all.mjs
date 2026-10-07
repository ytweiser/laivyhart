#!/usr/bin/env node
/* ============================================================
   The one command: node run-all.mjs (or `npm test` from inside tests/).

   Starts the local static server, launches one shared headless browser, runs
   every browser-based spec plus the Node-only middleware spec, and reports
   combined pass/fail counts with a non-zero exit code on any failure.

   Never touches the live site or anyone's real Chrome -- see lib/browser.mjs
   for exactly what's blocked and why.
   ============================================================ */
import { launchBrowser } from './lib/browser.mjs';
import { serve } from './lib/server.mjs';

const PORT = Number(process.env.LAIVY_TEST_PORT || 8743);

async function main() {
  const server = await serve(PORT);
  const browser = await launchBrowser();
  const results = [];
  try {
    const homepage = await import('./specs/homepage.spec.mjs');
    results.push(await homepage.run(browser, PORT));

    const artistPage = await import('./specs/artist-page.spec.mjs');
    results.push(await artistPage.run(browser, PORT));

    const search = await import('./specs/search.spec.mjs');
    results.push(await search.run(browser, PORT));

    const settings = await import('./specs/settings.spec.mjs');
    results.push(await settings.run(browser, PORT));

    const songPage = await import('./specs/song-page.spec.mjs');
    results.push(await songPage.run(browser, PORT));

    const legalPages = await import('./specs/legal-pages.spec.mjs');
    results.push(await legalPages.run(PORT));
  } finally {
    await browser.close();
    server.close();
  }

  // Node-only, no browser/server needed.
  const middleware = await import('./specs/middleware.spec.mjs');
  results.push(await middleware.run());

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
