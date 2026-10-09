/* ============================================================
   ACT-2, Part D -- the public Pulse box on the homepage. Covers the switch
   (site_settings.pulse_public_enabled) and the admin-only ?preview=pulse
   override, and that nothing is fetched when neither applies.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SONG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);
const PUBLIC_PULSE_ROWS = [
  { event_type: 'play_start', song_title: SONG.title, song_slug: SONG.slug, cover_url: null, city: 'Atlanta', country: 'US', minutes_ago: 3 },
  { event_type: 'heart', song_title: 'Asking for 1', song_slug: 'asking-for-1', cover_url: null, city: 'Haifa', country: 'IL', minutes_ago: 11 },
];
const ADMIN_SELF_ROW = { ...F.SELF_ARTIST_ROWS[F.NOVA_ASH], role: 'admin' };
const SETTINGS_ON = [...F.SITE_SETTINGS_ROWS, { key: 'pulse_public_enabled', value: true }];
const SETTINGS_OFF = [...F.SITE_SETTINGS_ROWS, { key: 'pulse_public_enabled', value: false }];

async function gotoHome(page, url, port) {
  await page.goto(`http://localhost:${port}${url}`, { waitUntil: 'load' });
  await page.waitForSelector('#homepage .rail-item, #homepage .hero-tile', { timeout: 10000 });
  await page.waitForTimeout(400);
}

export async function run(browser, port) {
  const r = makeReporter('homepage-pulse.spec.mjs');
  await scenarioOffNoFetch(browser, port, r);
  await scenarioOnRendersItems(browser, port, r);
  await scenarioPreviewAsAdmin(browser, port, r);
  await scenarioPreviewAsNonAdmin(browser, port, r);
  return r;
}

async function scenarioOffNoFetch(browser, port, r) {
  r.section('switch off, no preview: absent, and public_pulse is never called');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  let publicPulseCalled = false;
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_OFF, publicPulse: PUBLIC_PULSE_ROWS }, (name) => {
    if (name === 'rpc:public_pulse') publicPulseCalled = true;
  });
  await gotoHome(page, '/', port);
  const present = await page.evaluate(() => !!document.querySelector('.pulse-box'));
  r.check('Pulse box is absent from the homepage', present === false);
  r.check('public_pulse was never fetched', publicPulseCalled === false);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioOnRendersItems(browser, port, r) {
  r.section('switch on: present, and renders lines from public_pulse');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_ON, publicPulse: PUBLIC_PULSE_ROWS });
  await gotoHome(page, '/', port);
  await page.waitForTimeout(300);
  const d = await page.evaluate(() => ({
    present: !!document.querySelector('.pulse-box'),
    text: document.getElementById('pulse-box-list')?.textContent || '',
    thumbCount: document.querySelectorAll('.pulse-box-thumb').length,
  }));
  r.check('Pulse box is present', d.present === true);
  r.check('shows a "just played" line with the city/country and song', /Atlanta, US/.test(d.text) && d.text.includes(SONG.title) && /just played/.test(d.text), d.text);
  r.check('shows a "just hearted" line', /Haifa, IL/.test(d.text) && d.text.includes('Asking for 1') && /just hearted/.test(d.text), d.text);
  r.check('cover thumbnails render, one per line', d.thumbCount === 2, d.thumbCount);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioPreviewAsAdmin(browser, port, r) {
  r.section('switch off, ?preview=pulse, signed in as admin: present');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_OFF, publicPulse: PUBLIC_PULSE_ROWS, selfArtistRow: ADMIN_SELF_ROW });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await gotoHome(page, '/?preview=pulse', port);
  await page.waitForTimeout(500); // auth resolves after first paint; the box appears on the laivy:auth re-render
  const present = await page.evaluate(() => !!document.querySelector('.pulse-box'));
  r.check('Pulse box is present for an admin with the preview flag, even with the switch off', present === true);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioPreviewAsNonAdmin(browser, port, r) {
  r.section('switch off, ?preview=pulse, signed in as a non-admin: absent');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_OFF, publicPulse: PUBLIC_PULSE_ROWS, selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await gotoHome(page, '/?preview=pulse', port);
  await page.waitForTimeout(500);
  const present = await page.evaluate(() => !!document.querySelector('.pulse-box'));
  r.check('Pulse box stays absent for a signed-in non-admin, even with the preview flag', present === false);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
