/* ============================================================
   HOME-1 -- "Your Song" in the main nav for everyone (the
   site_settings.your_song_nav_enabled switch, flipped on; SONG-2 already
   built the link itself, gated the same way readContributeSwitch's own
   switch is). Also: a static sweep confirming no user-facing text anywhere
   in the "one pick per week" surfaces still says three/3.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SETTINGS_NAV_ON = [...F.SITE_SETTINGS_ROWS, { key: 'your_song_nav_enabled', value: true }];
const SETTINGS_NAV_OFF = [...F.SITE_SETTINGS_ROWS, { key: 'your_song_nav_enabled', value: false }];

async function gotoHome(page, port) {
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  await page.waitForSelector('#homepage .hero-tile', { timeout: 10000 });
}

export async function run(browser, port) {
  const r = makeReporter('your-song-nav.spec.mjs');
  await scenarioNavSignedOut(browser, port, r);
  await scenarioNavSignedIn(browser, port, r);
  await scenarioNavSwitchOff(browser, port, r);
  scenarioNoWeeklyPickNumber(r);
  return r;
}

async function scenarioNavSignedOut(browser, port, r) {
  r.section('switch on, signed out: "Your Song" is in the nav, links to /your-song');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_NAV_ON, songs: F.SONGS_ROWS });
  await gotoHome(page, port);
  // Two #page-home/#page-listen each render their own #account-slot (one
  // per topbar); only #page-home's is visible on the / route, so scope to
  // it -- the unscoped selector matches both and the hidden one never
  // becomes visible.
  await page.waitForSelector('#page-home .nav-share[href="/your-song"]', { timeout: 10000 });
  const text = await page.evaluate(() => document.querySelector('#page-home .nav-share[href="/your-song"]')?.textContent);
  r.check('"Your Song" link renders in the nav', text === 'Your Song', text);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioNavSignedIn(browser, port, r) {
  r.section('switch on, signed in: "Your Song" is still in the nav');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_NAV_ON, songs: F.SONGS_ROWS, selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await gotoHome(page, port);
  await page.waitForSelector('#page-home .nav-share[href="/your-song"]', { timeout: 10000 });
  const text = await page.evaluate(() => document.querySelector('#page-home .nav-share[href="/your-song"]')?.textContent);
  r.check('"Your Song" link renders in the nav', text === 'Your Song', text);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioNavSwitchOff(browser, port, r) {
  r.section('the switch itself still works: off means absent (production has it on; HOME-1 did not remove the switch)');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_NAV_OFF, songs: F.SONGS_ROWS });
  await gotoHome(page, port);
  await page.waitForLoadState('networkidle');
  const present = await page.evaluate(() => !!document.querySelector('#account-slot .nav-share[href="/your-song"]'));
  r.check('"Your Song" link is absent with the switch off', present === false, present);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

// Static sweep: the specific old three-picks-a-week phrases, by file, must
// all be gone. Narrow and literal on purpose -- a bare grep for "three" or
// "3" catches unrelated things everywhere in this codebase (three loves,
// three fictional artists, three FAQ groups, "3,000 characters left"...).
const FORBIDDEN_PHRASES = [
  { file: 'your-song.html', phrase: 'choose three' },
  { file: 'your-song.html', phrase: 'pick three' },
  { file: 'your-song.html', phrase: "This week's picks" },
  { file: 'middleware.js', phrase: 'choose three' },
  { file: 'admin.html', phrase: 'This week’s picks' },
  { file: 'admin.html', phrase: 'of 3' },
  { file: 'admin.html', phrase: 'more than the usual three' },
];

function scenarioNoWeeklyPickNumber(r) {
  r.section('static sweep: no user-facing text says three/3 about the weekly pick anymore');
  for (const { file, phrase } of FORBIDDEN_PHRASES) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    r.check(`${file} no longer contains "${phrase}"`, !src.includes(phrase), file);
  }
}
