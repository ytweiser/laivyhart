/* ============================================================
   LISTEN-1 -- every route gets the site's top nav (logo linking home,
   Home, Songs, About, Upload/Your Song/account via #account-slot) and the
   ticker band above it: /artist/:handle and /d/:code had neither; /settings
   and /upload had no header at all either. /, /listen and /song/:slug
   already had their own (unchanged). about.html, terms.html, privacy.html,
   /your-song and /your-song/ideas already had the full nav (static pages,
   confirmed by reading them -- no gap there, so no new coverage needed).

   Also covers item 2: the /listen list header swap (Radio + Mood radio
   left/first and prominent, Songs/Playlists right/quieter) at 1280 and 390.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SONG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);
const ARTIST_HANDLE = 'nova-ash';

export async function run(browser, port) {
  const r = makeReporter('site-header.spec.mjs');
  await scenarioArtistHeader(browser, port, r);
  await scenarioDedicationHeader(browser, port, r);
  await scenarioSettingsHeader(browser, port, r);
  await scenarioUploadHeader(browser, port, r);
  await scenarioHomeListenKeepOwnHeader(browser, port, r);
  await scenarioRadioTabsOrder(browser, port, r);
  return r;
}

// Shared shape every headerless-route scenario checks: #route-header
// visible with the nav, the ticker band also visible, and Home actually
// navigates (not just an href that looks right).
async function checkRouteHeader(page, r, label) {
  await page.waitForSelector('#route-header:not(.hidden)', { timeout: 10000 });
  const d = await page.evaluate(() => {
    const header = document.getElementById('route-header');
    return {
      hasLogo: !!header.querySelector('a.logo'),
      navLinks: Array.from(header.querySelectorAll('.site-nav > a')).map((a) => a.textContent),
      hasAccountSlot: !!header.querySelector('#account-slot'),
      tickerVisible: !document.getElementById('ticker-band')?.classList.contains('hidden'),
    };
  });
  r.check(`${label}: header has the logo`, d.hasLogo, d);
  r.check(`${label}: nav has Home, Songs, About`, d.navLinks.includes('Home') && d.navLinks.includes('Songs') && d.navLinks.includes('About'), d.navLinks);
  r.check(`${label}: has an account slot (Upload/Your Song/sign-in render into it)`, d.hasAccountSlot, d);
  r.check(`${label}: the ticker band also shows here`, d.tickerVisible, d);

  // /settings and /upload auto-open the sign-in modal when signed out,
  // which covers the page -- close it first so Home is actually clickable,
  // same as a real visitor would dismiss it.
  const modalOpen = await page.evaluate(() => {
    const m = document.querySelector('.lv-modal-backdrop');
    return !!(m && !m.hidden);
  });
  if (modalOpen) {
    await page.click('.lv-modal-backdrop .lv-modal-x');
    await page.waitForFunction(() => document.querySelector('.lv-modal-backdrop')?.hidden === true, { timeout: 10000 });
  }

  // Home actually works, not just looks right.
  await page.click('#route-header a[data-nav="home"]');
  await page.waitForSelector('#page-home:not(.hidden)', { timeout: 10000 });
  const onHome = await page.evaluate(() => location.pathname === '/');
  r.check(`${label}: Home link actually navigates home`, onHome, onHome);
}

async function scenarioArtistHeader(browser, port, r) {
  r.section('/artist/:handle: the shared header and ticker, with a working Home link');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { songs: F.SONGS_ROWS });
  await page.goto(`http://localhost:${port}/artist/${ARTIST_HANDLE}`, { waitUntil: 'load' });
  await page.waitForSelector('.artist-wrap .artist-name', { timeout: 10000 });
  await checkRouteHeader(page, r, 'artist');
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioDedicationHeader(browser, port, r) {
  r.section('/d/:code: the shared header and ticker, with a working Home link');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, {
    dedicationsPublic: [{
      code: 'HEAD0001', song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug, cover_url: null,
      recipient_name: 'Mom', occasion: 'birthday', occasion_other: null, message: 'Love you!',
      sender_name: 'Tzvi', created_at: new Date().toISOString(),
    }],
  });
  await page.goto(`http://localhost:${port}/d/HEAD0001`, { waitUntil: 'load' });
  await page.waitForSelector('.ded-page-headline', { timeout: 10000 });
  await checkRouteHeader(page, r, 'dedication');
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioSettingsHeader(browser, port, r) {
  r.section('/settings: the shared header and ticker show even signed out (while the page itself asks you to sign in)');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await page.goto(`http://localhost:${port}/settings`, { waitUntil: 'load' });
  await page.waitForSelector('.lv-settings', { timeout: 10000 });
  await checkRouteHeader(page, r, 'settings');
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioUploadHeader(browser, port, r) {
  r.section('/upload: the shared header and ticker show even signed out');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await page.goto(`http://localhost:${port}/upload`, { waitUntil: 'load' });
  await page.waitForSelector('.upload-wrap', { timeout: 10000 });
  await checkRouteHeader(page, r, 'upload');
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioHomeListenKeepOwnHeader(browser, port, r) {
  r.section('/ and /listen keep their own header -- #route-header never doubles up there');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  await page.waitForSelector('#homepage .hero-tile', { timeout: 10000 });
  const homeHidden = await page.evaluate(() => document.getElementById('route-header')?.classList.contains('hidden'));
  r.check('#route-header stays hidden on /', homeHidden === true, homeHidden);

  await page.goto(`http://localhost:${port}/listen`, { waitUntil: 'load' });
  await page.waitForSelector('.tab', { timeout: 10000 });
  const listenHidden = await page.evaluate(() => document.getElementById('route-header')?.classList.contains('hidden'));
  r.check('#route-header stays hidden on /listen', listenHidden === true, listenHidden);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioRadioTabsOrder(browser, port, r) {
  r.section('/listen list header: Radio + Mood radio left/first and prominent, Songs/Playlists right/quieter, at 1280 and 390');
  for (const width of [1280, 390]) {
    const page = await newPage(browser, { width, height: 1000 });
    const errors = collectErrors(page);
    await wireSupabaseStubs(page);
    await page.goto(`http://localhost:${port}/listen`, { waitUntil: 'load' });
    await page.waitForSelector('.tab', { timeout: 10000 });

    const d = await page.evaluate(() => {
      const radio = document.getElementById('radio-btn').getBoundingClientRect();
      const mood = document.getElementById('mood-radio-btn').getBoundingClientRect();
      const songsTab = document.getElementById('tab-songs').getBoundingClientRect();
      const radioStyle = getComputedStyle(document.getElementById('radio-btn'));
      const tabStyle = getComputedStyle(document.getElementById('tab-songs'));
      return {
        radioLeft: radio.left, moodLeft: mood.left, songsTop: songsTab.top, radioTop: radio.top,
        songsLeft: songsTab.left,
        radioBg: radioStyle.backgroundImage !== 'none' || radioStyle.backgroundColor !== 'rgba(0, 0, 0, 0)',
        radioColor: radioStyle.color,
        tabColor: tabStyle.color,
      };
    });
    if (width === 1280) {
      r.check(`[${width}px] Radio sits left of the Songs tab`, d.radioLeft < d.songsLeft, d);
      r.check(`[${width}px] Mood radio sits left of the Songs tab too`, d.moodLeft < d.songsLeft, d);
    } else {
      // At 390 the groups wrap to two lines -- "first" means above, not left.
      r.check(`[${width}px] Radio sits above (comes before) the Songs tab`, d.radioTop < d.songsTop, d);
    }
    r.check(`[${width}px] Radio is filled (an accent background), the prominent one`, d.radioBg, d);
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}
