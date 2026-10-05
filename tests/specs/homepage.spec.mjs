/* ============================================================
   Homepage + /listen regression -- confirms ARTIST-2/ARTIST-3's shared
   function changes (railCardHTML, setupRailAffordances, renderList) never
   touched the homepage rails or broke song playback.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { makeReporter } from '../lib/report.mjs';

export async function run(browser, port) {
  const r = makeReporter('homepage.spec.mjs');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);

  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  await page.waitForSelector('#homepage .rail-item, #homepage .hero-tile', { timeout: 10000 });
  await page.waitForTimeout(500);

  const d = await page.evaluate(() => ({
    heroPresent: !!document.querySelector('.hero-tile'),
    cardCount: document.querySelectorAll('#homepage .rail-item').length,
    anyRibbonOnHomepage: document.querySelectorAll('#homepage .card-ribbon').length,
    anyRingOnHomepage: document.querySelectorAll('#homepage .card-ring').length,
    moodStripChips: document.querySelectorAll('.mood-card').length,
    railScrollable: Array.from(document.querySelectorAll('#homepage .rail-scroll-wrap')).map((w) => {
      const sc = w.querySelector('.rail-scroll, .editors-scroll');
      return sc ? sc.scrollWidth > sc.clientWidth + 1 : null;
    }),
  }));
  r.check('hero renders', d.heroPresent === true);
  r.check('homepage has cards', d.cardCount > 0, d.cardCount);
  r.check('no ribbon on homepage cards (artist-page-only)', d.anyRibbonOnHomepage === 0);
  r.check('no milestone ring on homepage cards', d.anyRingOnHomepage === 0);
  r.check('mood strip renders', d.moodStripChips === 3, d.moodStripChips);
  // AT LEAST ONE, not every rail: this harness's fixture is deliberately
  // tiny (9 songs across 3 artists), so a short rail legitimately fits
  // without overflowing at 1280px -- that is a fixture-size fact, not a
  // wiring failure. The real assertion is that the mechanism (edge fades +
  // arrows via setupRailAffordances) works AT ALL.
  const scrollable = d.railScrollable.filter((v) => v !== null);
  r.check('at least one homepage rail is scrollable (fades/arrows wiring intact)', scrollable.some(Boolean), JSON.stringify(d.railScrollable));

  await page.click('#homepage .rail-item');
  await page.waitForTimeout(300);
  const onListen = await page.evaluate(() => !document.getElementById('page-listen').classList.contains('hidden'));
  r.check('clicking a homepage card opens /listen', onListen === true);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
  return r;
}
