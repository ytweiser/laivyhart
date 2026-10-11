/* ============================================================
   HOME-1 -- the homepage "Get involved" box beside the #1 song: three
   equal actions (Upload, Send a song idea, Dedicate a song), replacing the
   single upload invitation that used to be the whole box. Gated by the
   same site_settings.contribute_cta_enabled switch as before. Covers the
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
  const r = makeReporter('homepage-get-involved.spec.mjs');
  await scenarioThreeActionsRender(browser, port, r);
  await scenarioGatedOff(browser, port, r);
  await scenarioDedicateSignedOut(browser, port, r);
  await scenarioDedicateSignedInPicksAndSearches(browser, port, r);
  await scenarioAuthCallbackReopensPicker(browser, port, r);
  return r;
}

async function scenarioThreeActionsRender(browser, port, r) {
  r.section('switch on: three equal actions render, each with an icon');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_CTA_ON, songs: F.SONGS_ROWS });
  await gotoHome(page, '/', port);
  await page.waitForSelector('.gi-action', { timeout: 10000 });
  const d = await page.evaluate(() => {
    const actions = Array.from(document.querySelectorAll('.gi-action'));
    return {
      count: actions.length,
      iconCount: document.querySelectorAll('.gi-action .gi-icon').length,
      uploadLine: document.getElementById('gi-upload')?.querySelector('small')?.textContent,
      ideaHref: document.querySelector('a.gi-action[href="/your-song"]')?.textContent,
      dedicateText: document.getElementById('gi-dedicate')?.textContent,
    };
  });
  r.check('three actions render', d.count === 3, d.count);
  r.check('each action has its own icon', d.iconCount === 3, d.iconCount);
  r.check('Upload keeps "You could be next week\'s #1."', d.uploadLine === "You could be next week's #1.", d.uploadLine);
  r.check('Send a song idea links to /your-song with the right copy', d.ideaHref?.includes('Send a song idea') && d.ideaHref?.includes('We pick one every week and turn it into a song.'), d.ideaHref);
  r.check('Dedicate a song has the right copy', d.dedicateText?.includes('Dedicate a song') && d.dedicateText?.includes('Send a song to someone for any occasion.'), d.dedicateText);
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
  const present = await page.evaluate(() => !!document.querySelector('.get-involved'));
  r.check('Get involved box is absent', present === false, present);
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
