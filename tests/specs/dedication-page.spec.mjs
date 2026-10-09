/* ============================================================
   DED-2 -- the dedication page itself, /d/<code>, client-rendered from
   dedications_public. The server-rendered OG/noindex side of this same
   route is covered in middleware.spec.mjs.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SONG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);

async function gotoDedication(page, port, code) {
  await page.goto(`http://localhost:${port}/d/${code}`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
}

export async function run(browser, port) {
  const r = makeReporter('dedication-page.spec.mjs');
  await scenarioLive(browser, port, r);
  await scenarioAnonymous(browser, port, r);
  await scenarioRemovedOrUnknown(browser, port, r);
  await scenarioPlayButton(browser, port, r);
  await scenarioViewports(browser, port, r);
  return r;
}

async function scenarioLive(browser, port, r) {
  r.section('a live, named dedication renders the hero, occasion, message and sender');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, {
    dedicationsPublic: [{
      code: 'ABCD2345', song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug, cover_url: null,
      recipient_name: 'Mom', occasion: 'birthday', occasion_other: null, message: 'Love you so much!',
      sender_name: 'Tzvi', created_at: new Date().toISOString(),
    }],
  });
  await gotoDedication(page, port, 'ABCD2345');
  const d = await page.evaluate(() => ({
    heading: document.querySelector('.ded-page-for')?.textContent,
    occasion: document.querySelector('.ded-page-occasion')?.textContent,
    message: document.querySelector('.ded-page-message')?.textContent,
    from: document.querySelector('.ded-page-from')?.textContent,
    song: document.querySelector('.ded-page-song')?.textContent,
    songLink: document.querySelector('.ded-page-link')?.getAttribute('href'),
    hasPlay: !!document.getElementById('ded-page-play-btn'),
  }));
  r.check('"For Mom" in the hero', d.heading === 'For Mom', d.heading);
  r.check('hero-style occasion phrase for birthday', d.occasion === 'On their birthday', d.occasion);
  r.check('message shown in quotes', d.message === '“Love you so much!”', d.message);
  r.check('"From Tzvi"', d.from === 'From Tzvi', d.from);
  r.check('song title shown', d.song === SONG.title, d.song);
  r.check('links to the full song page', d.songLink === '/song/' + SONG.slug, d.songLink);
  r.check('a big Play button is present', d.hasPlay === true);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioAnonymous(browser, port, r) {
  r.section('an anonymous dedication shows "From someone", never a name');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, {
    dedicationsPublic: [{
      code: 'ANON1111', song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug, cover_url: null,
      recipient_name: 'Dad', occasion: 'in_memory', occasion_other: null, message: null,
      sender_name: null, created_at: new Date().toISOString(),
    }],
  });
  await gotoDedication(page, port, 'ANON1111');
  const d = await page.evaluate(() => ({
    from: document.querySelector('.ded-page-from')?.textContent,
    occasion: document.querySelector('.ded-page-occasion')?.textContent,
    hasMessage: !!document.querySelector('.ded-page-message'),
  }));
  r.check('"From someone", not a name', d.from === 'From someone', d.from);
  r.check('hero-style phrase for in_memory', d.occasion === 'In memory', d.occasion);
  r.check('no message block when there is no message', d.hasMessage === false);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioRemovedOrUnknown(browser, port, r) {
  r.section('a removed or unknown code shows the kind "no longer available" message with a link home');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  // dedications_public itself never returns a removed row (status='live' is
  // part of its own WHERE clause) -- so "removed" and "unknown" look
  // identical to this page, which is exactly the point: no distinction that
  // would tell a visitor a code used to work.
  await wireSupabaseStubs(page, { dedicationsPublic: [] });
  await gotoDedication(page, port, 'GONE0000');
  const d = await page.evaluate(() => ({
    text: document.querySelector('.ded-page-missing h1')?.textContent,
    homeLink: document.querySelector('.ded-page-missing a')?.getAttribute('href'),
  }));
  r.check('kind "no longer available" message', d.text === 'This dedication is no longer available', d.text);
  r.check('a link home', d.homeLink === '/', d.homeLink);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioPlayButton(browser, port, r) {
  r.section('the Play button plays the song in the site player');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, {
    dedicationsPublic: [{
      code: 'PLAY0001', song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug, cover_url: null,
      recipient_name: 'Mom', occasion: 'birthday', occasion_other: null, message: null,
      sender_name: 'Tzvi', created_at: new Date().toISOString(),
    }],
  });
  await gotoDedication(page, port, 'PLAY0001');
  await page.click('#ded-page-play-btn');
  await page.waitForTimeout(400);
  const d = await page.evaluate(() => ({
    // loadSong() itself rewrites the address to the canonical /song/<slug>
    // once a specific song is loaded on the 'listen' route (syncSongUrl) --
    // that is the same behavior every other "play this song" entry point in
    // the app already has, not something this button does differently.
    pathname: location.pathname,
    listenVisible: !document.getElementById('page-listen').classList.contains('hidden'),
  }));
  r.check('navigates to the song\'s own canonical URL', d.pathname === '/song/' + SONG.slug, d.pathname);
  r.check('the listen/now-playing page is now showing', d.listenVisible === true);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioViewports(browser, port, r) {
  r.section('renders cleanly at 1280 and 390');
  for (const width of [1280, 390]) {
    const page = await newPage(browser, { width, height: 900 });
    const errors = collectErrors(page);
    await wireSupabaseStubs(page, {
      dedicationsPublic: [{
        code: 'WIDE0001', song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug, cover_url: null,
        recipient_name: 'Mom', occasion: 'birthday', occasion_other: null, message: 'A short note.',
        sender_name: 'Tzvi', created_at: new Date().toISOString(),
      }],
    });
    await gotoDedication(page, port, 'WIDE0001');
    const d = await page.evaluate(() => ({
      heroVisible: !!document.querySelector('.ded-page-for'),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    }));
    r.check(`hero renders at ${width}px`, d.heroVisible === true, width);
    r.check(`no horizontal overflow at ${width}px`, d.overflow === false, width);
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}
