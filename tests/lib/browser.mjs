/* ============================================================
   Shared browser setup for every spec in this harness.

   - laivy-no-track is set before any page script runs, so no play/like/love
     event is ever enqueued, let alone sent anywhere (see index.html's own
     noTrack()).
   - laivyhart.com/www.laivyhart.com, Google Tag Manager/Analytics, R2 (audio)
     and wsrv.nl (cover images) are blocked outright. This harness runs
     offline/sandboxed: those hosts either must never be hit by a TEST
     (laivyhart.com itself -- the guard line this harness exists to enforce),
     or simply are not reachable here and would otherwise hang/retry and
     starve any wait condition that isn't scoped to a specific selector.
   - serviceWorkers: 'block' -- sw.js's stale-while-revalidate strategy for
     artists.json/channels.json/etc. intercepts fetches BEFORE Playwright's
     page.route ever sees them if the SW is allowed to register, which
     silently breaks every stub below it. Confirmed the hard way once
     already; see docs/testing.md if that file exists, or just trust this
     comment and don't remove the option.
   ============================================================ */
import { chromium } from 'playwright-core';

export async function launchBrowser() {
  return chromium.launch({ headless: true });
}

export async function newPage(browser, viewport) {
  const page = await browser.newPage({
    viewport: viewport || { width: 1280, height: 1000 },
    serviceWorkers: 'block',
  });
  await page.route('**://laivyhart.com/**', (r) => r.abort());
  await page.route('**://www.laivyhart.com/**', (r) => r.abort());
  await page.route('**googletagmanager.com/**', (r) => r.abort());
  await page.route('**google-analytics.com/**', (r) => r.abort());
  await page.route('**r2.dev/**', (r) => r.abort());
  await page.route('**wsrv.nl/**', (r) => r.abort());
  await page.addInitScript(() => { try { localStorage.setItem('laivy-no-track', '1'); } catch (e) {} });
  return page;
}

export function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Expected noise from this harness's own host blocking above, not a real
    // app error.
    if (/Failed to load resource/.test(m.text())) return;
    errors.push(m.text());
  });
  return errors;
}
