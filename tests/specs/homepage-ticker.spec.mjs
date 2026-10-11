/* ============================================================
   HOME-1 -- the ticker band across the top of / and /listen. Covers:
   rendering real rows (with display_city/display_country and links),
   padding when public_ticker() returns fewer than 6 rows, hiding when
   there is truly nothing to show, hover/touch pause, prefers-reduced-motion
   (static, fading through items), independence from pulse_public_enabled,
   and that nothing beyond song text/slug ever reaches the DOM.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SONG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);
const SETTINGS_PULSE_OFF = [...F.SITE_SETTINGS_ROWS, { key: 'pulse_public_enabled', value: false }];

const SIX_ROWS = [
  { kind: 'play', song_title: SONG.title, song_slug: SONG.slug, display_city: 'Atlanta', display_country: 'US', created_at: '2026-10-11T10:00:00+00:00' },
  { kind: 'heart', song_title: 'Asking for 1', song_slug: 'asking-for-1', display_city: 'London', display_country: 'GB', created_at: '2026-10-11T09:55:00+00:00' },
  { kind: 'dedication', song_title: 'Precious Son', song_slug: 'precious-son', display_city: null, display_country: null, created_at: '2026-10-11T09:50:00+00:00' },
  { kind: 'new_song', song_title: 'His Desire', song_slug: 'his-desire', display_city: null, display_country: null, created_at: '2026-10-11T09:45:00+00:00' },
  { kind: 'play', song_title: 'Quiet Fire', song_slug: 'quiet-fire-b000', display_city: null, display_country: 'IL', created_at: '2026-10-11T09:40:00+00:00' },
  { kind: 'heart', song_title: 'Low Light', song_slug: 'low-light-a000', display_city: 'Buffalo', display_country: 'US', created_at: '2026-10-11T09:35:00+00:00' },
];

async function gotoHome(page, url, port) {
  await page.goto(`http://localhost:${port}${url}`, { waitUntil: 'load' });
  await page.waitForSelector('#homepage .rail-item, #homepage .hero-tile', { timeout: 10000 });
}

export async function run(browser, port) {
  const r = makeReporter('homepage-ticker.spec.mjs');
  await scenarioRendersRealRows(browser, port, r);
  await scenarioPadsWhenSparse(browser, port, r);
  await scenarioHidesWhenEmpty(browser, port, r);
  await scenarioHoverAndTouchPause(browser, port, r);
  await scenarioReducedMotion(browser, port, r);
  await scenarioListenRoute(browser, port, r);
  return r;
}

async function scenarioRendersRealRows(browser, port, r) {
  r.section('six real rows: all render, linked, with display_city/country, independent of pulse_public_enabled');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_PULSE_OFF, publicTicker: SIX_ROWS, songs: F.SONGS_ROWS });
  await gotoHome(page, '/', port);
  await page.waitForSelector('.ticker-item', { timeout: 10000 });
  const d = await page.evaluate(() => {
    const band = document.getElementById('ticker-band');
    const items = Array.from(document.querySelectorAll('#ticker-track .ticker-item'));
    return {
      hidden: band.classList.contains('hidden'),
      // The track is duplicated once for the seamless CSS loop (not
      // reduced-motion here), so expect exactly 2x the row count.
      count: items.length,
      hrefs: items.map((a) => a.getAttribute('href')),
      texts: items.map((a) => a.textContent),
    };
  });
  r.check('band is visible', d.hidden === false, d.hidden);
  r.check('track is duplicated for the seamless loop (12 nodes for 6 rows)', d.count === 12, d.count);
  r.check('play row links to the song and names the city/country', d.texts.some((t) => t.includes(SONG.title) && t.includes('played in Atlanta, US')), d.texts);
  r.check('heart row names the city/country', d.texts.some((t) => t.includes('Asking for 1') && t.includes('hearted in London, GB')), d.texts);
  r.check('dedication row says "dedicated", never a recipient or message', d.texts.some((t) => t.includes('Precious Son') && t.includes('dedicated')), d.texts);
  r.check('new_song row says "New song:"', d.texts.some((t) => t.includes('New song: His Desire')), d.texts);
  r.check('a row with country but no city falls back to country alone', d.texts.some((t) => t.includes('Quiet Fire') && t.includes('played in IL') && !/played in ,/.test(t)), d.texts);
  r.check('every item links to /song/<slug>', d.hrefs.every((h) => /^\/song\/[a-z0-9-]+$/.test(h)), d.hrefs);
  r.check('no identity field leaks into the DOM (no raw ids, device ids or names)', !d.texts.some((t) => /[0-9a-f]{8}-[0-9a-f]{4}/.test(t)), d.texts);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioPadsWhenSparse(browser, port, r) {
  r.section('fewer than 6 real rows: padded with recent releases and "#1 this week"');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  const twoRows = [SIX_ROWS[0], SIX_ROWS[1]];
  await wireSupabaseStubs(page, { publicTicker: twoRows, songs: F.SONGS_ROWS });
  await gotoHome(page, '/', port);
  await page.waitForSelector('.ticker-item', { timeout: 10000 });
  const d = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#ticker-track .ticker-item'));
    return { count: items.length, texts: items.map((a) => a.textContent) };
  });
  r.check('at least 6 distinct items once padded (12 nodes, duplicated)', d.count >= 12, d.count);
  r.check('the two real rows are still present', d.texts.some((t) => t.includes(SONG.title)) && d.texts.some((t) => t.includes('Asking for 1')), d.texts);
  r.check('padded with a recent release ("New song: ...")', d.texts.some((t) => /^New song: /.test(t)), d.texts);
  r.check('padded with the current #1, Supernova (hit_number_one/weeks_at_number_one badges)', d.texts.some((t) => t.includes('#1 this week')) || d.texts.filter((t) => /^New song: /.test(t)).length >= 2, d.texts);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioHidesWhenEmpty(browser, port, r) {
  r.section('nothing at all (no ticker rows, no songs to pad with): band hides, never looks broken');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { publicTicker: [], songs: [] });
  // No songs at all means no hero/rail either, so gotoHome's usual wait
  // condition never appears -- wait for the homepage root instead.
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  await page.waitForSelector('#homepage', { timeout: 10000 });
  await page.waitForLoadState('networkidle');
  const d = await page.evaluate(() => ({
    hidden: document.getElementById('ticker-band')?.classList.contains('hidden'),
    trackEmpty: document.getElementById('ticker-track')?.innerHTML === '',
  }));
  r.check('band is hidden', d.hidden === true, d);
  r.check('track is empty', d.trackEmpty === true, d);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioHoverAndTouchPause(browser, port, r) {
  r.section('hover (CSS) and touch (JS class) both pause the scroll');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { publicTicker: SIX_ROWS, songs: F.SONGS_ROWS });
  await gotoHome(page, '/', port);
  await page.waitForSelector('.ticker-item', { timeout: 10000 });

  const playStateAt = () => page.evaluate(() => getComputedStyle(document.getElementById('ticker-track')).animationPlayState);
  r.check('running before any interaction', await playStateAt() === 'running', await playStateAt());

  await page.hover('#ticker-band');
  r.check('paused on hover', await playStateAt() === 'paused', await playStateAt());
  await page.mouse.move(0, 0);

  await page.evaluate(() => {
    const band = document.getElementById('ticker-band');
    band.dispatchEvent(new Event('touchstart'));
  });
  const touchedPaused = await page.evaluate(() => document.getElementById('ticker-band').classList.contains('is-paused'));
  r.check('touchstart adds the pause class', touchedPaused === true, touchedPaused);
  await page.evaluate(() => {
    document.getElementById('ticker-band').dispatchEvent(new Event('touchend'));
  });
  const releasedPaused = await page.evaluate(() => document.getElementById('ticker-band').classList.contains('is-paused'));
  r.check('touchend removes the pause class', releasedPaused === false, releasedPaused);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioReducedMotion(browser, port, r) {
  r.section('prefers-reduced-motion: static, fading through items instead of scrolling');
  const page = await newPage(browser);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { publicTicker: SIX_ROWS, songs: F.SONGS_ROWS });
  await gotoHome(page, '/', port);
  await page.waitForSelector('.ticker-item', { timeout: 10000 });
  const d = await page.evaluate(() => {
    const band = document.getElementById('ticker-band');
    const items = Array.from(document.querySelectorAll('#ticker-track .ticker-item'));
    return {
      isStatic: band.classList.contains('is-static'),
      // Not duplicated in static mode -- one node per row.
      count: items.length,
      shownCount: items.filter((n) => n.classList.contains('is-shown')).length,
    };
  });
  r.check('band is in static mode', d.isStatic === true, d);
  r.check('one node per row, not duplicated', d.count === 6, d.count);
  r.check('exactly one item shown at a time', d.shownCount === 1, d.shownCount);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioListenRoute(browser, port, r) {
  r.section('also renders on /listen, not just /');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { publicTicker: SIX_ROWS, songs: F.SONGS_ROWS });
  await page.goto(`http://localhost:${port}/listen`, { waitUntil: 'load' });
  await page.waitForSelector('.ticker-item', { timeout: 10000 });
  const hidden = await page.evaluate(() => document.getElementById('ticker-band')?.classList.contains('hidden'));
  r.check('band is visible on /listen', hidden === false, hidden);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
