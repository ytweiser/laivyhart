/* ============================================================
   HOME-2 -- the homepage "Show some Hart" box beside the #1 song (HOME-1's
   "Get involved"): two actions, "Dedicate a song" and "Send us your song
   idea", under the subline "Two ways to put your heart into the music."
   Gated by the same site_settings.contribute_cta_enabled switch as before.
   Upload left the box and stays reachable elsewhere. Covers the
   "Dedicate a song" picker flow signed in and signed out, including the
   signed-out -> sign in -> straight back into the picker round trip via
   /auth/callback.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SONG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);
const SETTINGS_CTA_ON = [...F.SITE_SETTINGS_ROWS, { key: 'contribute_cta_enabled', value: true }];
const SETTINGS_CTA_OFF = F.SITE_SETTINGS_ROWS; // contribute_cta_enabled: false is already the fixture default

async function gotoHome(page, url, port) {
  await page.goto(`http://localhost:${port}${url}`, { waitUntil: 'load' });
  await page.waitForSelector('#homepage .hero-tile', { timeout: 10000 });
}

export async function run(browser, port) {
  const r = makeReporter('homepage-show-some-hart.spec.mjs');
  await scenarioBoxRenders(browser, port, r);
  await scenarioSkinsAndWidths(browser, port, r);
  await scenarioGatedOff(browser, port, r);
  await scenarioDedicateSignedOut(browser, port, r);
  await scenarioDedicateSignedInPicksAndSearches(browser, port, r);
  await scenarioAuthCallbackReopensPicker(browser, port, r);
  return r;
}

async function scenarioBoxRenders(browser, port, r) {
  r.section('switch on: "Show some Hart", its subline, and the two actions with their icons');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_CTA_ON, songs: F.SONGS_ROWS });
  await gotoHome(page, '/', port);
  await page.waitForSelector('.gi-action', { timeout: 10000 });
  const d = await page.evaluate(() => {
    const box = document.querySelector('.hero-callout.show-some-hart');
    const actions = Array.from(document.querySelectorAll('.gi-action'));
    const parts = (el) => el && { strong: el.querySelector('strong')?.textContent, small: el.querySelector('small')?.textContent };
    return {
      heading: box?.querySelector('#hero-callout-h')?.textContent,
      labelledBy: box?.getAttribute('aria-labelledby'),
      sub: box?.querySelector('.hero-callout-sub')?.textContent,
      count: actions.length,
      iconCount: document.querySelectorAll('.gi-action .gi-icon').length,
      first: parts(actions[0]), second: parts(actions[1]),
      firstIsDedicate: actions[0]?.id === 'gi-dedicate',
      ideaHref: actions[1]?.getAttribute('href'),
      upload: !!document.getElementById('gi-upload'),
      oldWording: /get involved/i.test(document.body.innerText),
    };
  });
  r.check('heading reads "Show some Hart" (Hart with an a)', d.heading === 'Show some Hart', d.heading);
  r.check('the box is labelled by that heading', d.labelledBy === 'hero-callout-h');
  r.check('subline reads "Two ways to put your heart into the music." (heart with an e)', d.sub === 'Two ways to put your heart into the music.', d.sub);
  r.check('exactly two actions, each with its icon', d.count === 2 && d.iconCount === 2, JSON.stringify(d));
  r.check('first: "Dedicate a song" / "to someone who deserves it"', d.firstIsDedicate && d.first?.strong === 'Dedicate a song' && d.first?.small === 'to someone who deserves it', JSON.stringify(d.first));
  r.check('second: "Send us your song idea" / "your idea, our music", linking to /your-song',
    d.second?.strong === 'Send us your song idea' && d.second?.small === 'your idea, our music' && d.ideaHref === '/your-song', JSON.stringify(d.second));
  r.check('the upload action is no longer in this box', d.upload === false);
  r.check('"Get involved" appears nowhere on the page', d.oldWording === false);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioGatedOff(browser, port, r) {
  r.section('switch off: the whole box is absent, exactly as before (HOME-1 kept the existing gate)');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_CTA_OFF, songs: F.SONGS_ROWS });
  await gotoHome(page, '/', port);
  await page.waitForLoadState('networkidle');
  const present = await page.evaluate(() => !!document.querySelector('.show-some-hart'));
  r.check('Show some Hart box is absent', present === false, present);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioDedicateSignedOut(browser, port, r) {
  r.section('Dedicate a song, signed out: sign-in modal opens with the right reason and next, no picker');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_CTA_ON, songs: F.SONGS_ROWS });
  await gotoHome(page, '/', port);
  await page.waitForSelector('#gi-dedicate', { timeout: 10000 });
  await page.evaluate(() => {
    window.__openModalCalls = [];
    const orig = window.laivy.accountUI.openModal;
    window.laivy.accountUI.openModal = (opts) => { window.__openModalCalls.push(opts); return orig(opts); };
  });
  await page.click('#gi-dedicate');
  await page.waitForFunction(() => window.__openModalCalls.length > 0, { timeout: 10000 });
  const d = await page.evaluate(() => ({
    calls: window.__openModalCalls,
    pickerHidden: document.getElementById('dedicate-picker-overlay')?.classList.contains('hidden'),
  }));
  r.check('sign-in modal opens, picker stays closed', d.pickerHidden === true && d.calls.length === 1, d);
  r.check('reason is "Sign in to dedicate a song"', d.calls[0] && d.calls[0].reason === 'Sign in to dedicate a song', d.calls[0]);
  r.check('next carries the dedicate marker, back to the homepage', d.calls[0] && d.calls[0].next === '/?dedicate=1', d.calls[0]);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioDedicateSignedInPicksAndSearches(browser, port, r) {
  r.section('Dedicate a song, signed in: picker opens, search and Popular work, picking hands off to the dedicate sheet');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_CTA_ON, songs: F.SONGS_ROWS, selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await gotoHome(page, '/', port);
  await page.waitForSelector('#gi-dedicate', { timeout: 10000 });
  await page.click('#gi-dedicate');
  await page.waitForSelector('#dedicate-picker-overlay:not(.hidden)', { timeout: 10000 });

  const initial = await page.evaluate(() => Array.from(document.querySelectorAll('#dedicate-picker-list .pick')).length);
  r.check('the picker lists songs (Recent tab, default)', initial > 0, initial);

  await page.click('#dedicate-picker-tabs [data-tab="popular"]');
  const afterPopular = await page.evaluate(() => Array.from(document.querySelectorAll('#dedicate-picker-list .pick')).length);
  r.check('Popular tab still lists songs', afterPopular > 0, afterPopular);

  await page.fill('#dedicate-picker-search', SONG.title);
  await page.waitForFunction((title) => {
    const picks = Array.from(document.querySelectorAll('#dedicate-picker-list .pick-title'));
    return picks.length > 0 && picks.every((p) => p.textContent.includes(title));
  }, SONG.title, { timeout: 10000 });

  await page.click('#dedicate-picker-list .pick');
  await page.waitForSelector('#dedicate-modal:not([hidden])', { timeout: 10000 });
  const d = await page.evaluate(() => ({
    pickerHidden: document.getElementById('dedicate-picker-overlay')?.classList.contains('hidden'),
    songTitle: document.getElementById('dedicate-song-title')?.textContent,
  }));
  r.check('picker closes once a song is chosen', d.pickerHidden === true, d);
  r.check('the dedicate sheet opens for the chosen song', d.songTitle === (SONG.title || SONG.title_translit), d.songTitle);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioAuthCallbackReopensPicker(browser, port, r) {
  r.section('signed out -> sign in -> straight back into the picker (the /auth/callback round trip)');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_CTA_ON, songs: F.SONGS_ROWS, selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  // Simulates the magic-link/OAuth tab landing on /auth/callback already
  // signed in (supabase-js restores the session synchronously on load, the
  // same way the real redirect does once the exchange has completed).
  await signInAs(page, F.SESSION_USERS.NOVA);
  await page.goto(`http://localhost:${port}/auth/callback?next=${encodeURIComponent('/?dedicate=1')}`, { waitUntil: 'load' });
  await page.waitForSelector('#dedicate-picker-overlay:not(.hidden)', { timeout: 10000 });
  const d = await page.evaluate(() => ({
    path: location.pathname,
    search: location.search,
    onHome: !document.getElementById('page-home').classList.contains('hidden'),
  }));
  r.check('lands on the homepage', d.path === '/' && d.onHome === true, d);
  r.check('the dedicate=1 marker is cleaned out of the address', d.search === '', d.search);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* Every skin, both lightings, at a 375 px phone and at 1280: the heading
   never breaks inside "Show some Hart" awkwardly (one line, or two with
   "Hart" never stranded alone mid-name -- i.e. no line is a lone "some"),
   and every piece of text in the box reads at 4.5:1 or better on the box. */
async function scenarioSkinsAndWidths(browser, port, r) {
  r.section('four skins x light/dark, at 375 px and 1280 px: heading wraps sensibly, text is readable');
  for (const width of [375, 1280]) {
    const page = await newPage(browser, { width, height: 900 });
    const errors = collectErrors(page);
    await wireSupabaseStubs(page, { siteSettings: SETTINGS_CTA_ON, songs: F.SONGS_ROWS });
    await gotoHome(page, '/', port);
    await page.waitForSelector('.show-some-hart .gi-action', { timeout: 10000 });
    for (const color of ['bordeaux', 'emerald', 'royal', 'gold']) {
      for (const theme of ['dark', 'light']) {
        const d = await page.evaluate(({ color, theme }) => {
          document.documentElement.setAttribute('data-color', color);
          document.documentElement.setAttribute('data-theme', theme);
          const box = document.querySelector('.show-some-hart');
          const h = box.querySelector('#hero-callout-h');
          // Which words sit on which line.
          const words = [];
          const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const re = /\S+/g; let m;
            while ((m = re.exec(node.data))) {
              const range = document.createRange(); range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
              const rects = range.getClientRects();
              words.push({ w: m[0], top: Math.round(rects[0].top), pieces: rects.length });
            }
          }
          const lines = [...new Set(words.map((x) => x.top))].map((t) => words.filter((x) => x.top === t).map((x) => x.w).join(' '));
          const parse = (str) => str.match(/[\d.]+/g).map(Number);
          const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
          const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
          const bg = parse(getComputedStyle(box).backgroundColor);
          const texts = { heading: h, sub: box.querySelector('.hero-callout-sub') };
          box.querySelectorAll('.gi-text strong').forEach((el, i) => { texts['action' + (i + 1)] = el; });
          box.querySelectorAll('.gi-text small').forEach((el, i) => { texts['line' + (i + 1)] = el; });
          const contrast = {};
          for (const [k, el] of Object.entries(texts)) contrast[k] = Math.round(ratio(parse(getComputedStyle(el).color), bg) * 100) / 100;
          const icon = Math.round(ratio(parse(getComputedStyle(box.querySelector('.gi-icon')).color), bg) * 100) / 100;
          const br = box.getBoundingClientRect();
          return { lines, splitWord: words.some((x) => x.pieces > 1), contrast, icon, fits: br.left >= 0 && br.right <= window.innerWidth + 0.5 };
        }, { color, theme });
        const tag = `[${width}px ${color}/${theme}]`;
        const sensible = d.lines.length === 1 || (d.lines.length === 2 && !d.splitWord && d.lines.every((l) => l !== 'some' && l !== 'Show'));
        r.check(`${tag} heading wraps sensibly: ${d.lines.map((l) => '"' + l + '"').join(' / ')}`, sensible, JSON.stringify(d.lines));
        const low = Object.entries(d.contrast).filter(([, v]) => v < 4.5);
        r.check(`${tag} all text 4.5:1+ (lowest ${Math.min(...Object.values(d.contrast))})`, low.length === 0, JSON.stringify(low));
        r.check(`${tag} icons 3:1+ (${d.icon})`, d.icon >= 3, d.icon);
        r.check(`${tag} the box fits the screen`, d.fits);
      }
    }
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}
