/* ============================================================
   ACT-1, Part C -- js/activity.js, exercised through the real app code via
   the real song page. Mirrors stub-supabase.mjs's approach: intercept the
   one network call that would otherwise leave the sandbox (POST /event,
   stub-activity.mjs) and inspect what the real client code actually sent.

   On laivy-no-track: every OTHER spec in this harness runs with it set (see
   lib/browser.mjs), and that is also activity.js's own default-safe state --
   a call to window.laivy.activity.log() is a no-op whenever it is set, same
   as laivyTrack(). To prove the OPPOSITE (that queueing and flushing work at
   all, and that play milestones fire), a few scenarios below deliberately
   clear that one flag for themselves via their own addInitScript, which runs
   after (and so overrides) the one lib/browser.mjs already added. Nothing
   here ever leaves the sandbox regardless: stub-activity.mjs intercepts the
   endpoint either way, and Supabase is stubbed as always.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { wireActivityStub } from '../lib/stub-activity.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SLUG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA).slug;

async function clearNoTrack(page) {
  await page.addInitScript(() => { try { localStorage.removeItem('laivy-no-track'); } catch (e) {} });
}
async function setGPC(page) {
  await page.addInitScript(() => {
    try { Object.defineProperty(window.navigator, 'globalPrivacyControl', { value: true, configurable: true }); } catch (e) {}
  });
}
async function gotoSong(page, port) {
  await page.goto(`http://localhost:${port}/song/${SLUG}`, { waitUntil: 'load' });
  await page.waitForSelector('#now-artist .now-artist-row', { timeout: 10000 });
  await page.waitForTimeout(300);
}
// Real decoded audio never loads here (r2.dev is blocked, and the fixture
// song carries no audio_url anyway) -- the milestone logic only cares about
// .duration/.currentTime/event dispatch, so this fakes exactly those, the
// same technique used to confirm the approach works before writing this spec.
async function fakeAudio(page) {
  await page.evaluate(() => {
    const el = document.getElementById('audio-el');
    Object.defineProperty(el, 'duration', { value: 200, configurable: true });
    Object.defineProperty(el, 'currentTime', { value: 0, writable: true, configurable: true });
    if (typeof SONGS !== 'undefined' && typeof currentIdx === 'number' && SONGS[currentIdx]) {
      SONGS[currentIdx].audio = 'data:audio/mpeg;base64,AA==';
    }
  });
}
async function forceFlush(page) {
  await page.evaluate(() => window.laivy && window.laivy.activity && window.laivy.activity.flush(false));
  await page.waitForTimeout(50);
}

export async function run(browser, port) {
  const r = makeReporter('activity.spec.mjs');
  await scenarioNoTrackSendsNothing(browser, port, r);
  await scenarioGPCSendsNothing(browser, port, r);
  await scenarioGPCFalseStillSends(browser, port, r);
  await scenarioQueueAndFlushShape(browser, port, r);
  await scenarioPlayMilestonesOnceEach(browser, port, r);
  await scenarioBeaconContentType(browser, port, r);
  await scenarioEndpointUrl(r);
  return r;
}

async function scenarioNoTrackSendsNothing(browser, port, r) {
  r.section('laivy-no-track set (this harness\'s own default): nothing is ever sent');
  const page = await newPage(browser); // leaves laivy-no-track = '1', the default
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  const calls = await wireActivityStub(page);
  await gotoSong(page, port);
  await page.evaluate(() => window.laivy.activity.log('heart', { song_id: 'x' }));
  await forceFlush(page);
  r.check('no /event call with no-track set', calls.length === 0, calls.length);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioGPCSendsNothing(browser, port, r) {
  r.section('Global Privacy Control set (no-track cleared): still nothing is sent');
  const page = await newPage(browser);
  await clearNoTrack(page);
  await setGPC(page);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  const calls = await wireActivityStub(page);
  await gotoSong(page, port);
  const gpcSeen = await page.evaluate(() => navigator.globalPrivacyControl === true);
  r.check('GPC is actually on for this page', gpcSeen === true);
  await page.evaluate(() => window.laivy.activity.log('heart', { song_id: 'x' }));
  await forceFlush(page);
  r.check('no /event call with GPC on, even though no-track is off', calls.length === 0, calls.length);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioGPCFalseStillSends(browser, port, r) {
  r.section('FIX-4: GPC present but false (not the bare existence of the property) still sends -- Chrome incognito does not set it at all, but this guards the stricter case too');
  const page = await newPage(browser);
  await clearNoTrack(page);
  await page.addInitScript(() => {
    try { Object.defineProperty(window.navigator, 'globalPrivacyControl', { value: false, configurable: true }); } catch (e) {}
  });
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  const calls = await wireActivityStub(page);
  await gotoSong(page, port);
  const gpcSeen = await page.evaluate(() => navigator.globalPrivacyControl);
  r.check('globalPrivacyControl is present and false, not merely absent', gpcSeen === false, gpcSeen);
  await page.evaluate(() => window.laivy.activity.log('heart', { song_id: 'x' }));
  await forceFlush(page);
  r.check('the event still sends -- the check is === true, not "in navigator"', calls.length === 1, calls.length);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioQueueAndFlushShape(browser, port, r) {
  r.section('no-track cleared: events queue and flush with the right shape');
  const page = await newPage(browser);
  await clearNoTrack(page);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  const calls = await wireActivityStub(page);
  await gotoSong(page, port);

  // The heart (an authenticated-irrelevant, signed-out-allowed action).
  await page.click('.love-btn[data-love="song"]');
  // Search is debounced 600ms to the final query (the existing GA debounce
  // this reuses) -- type, then wait past it, then force the flush rather
  // than wait out the real 10s timer.
  await page.fill('#search', 'supernova');
  await page.waitForTimeout(700);
  await forceFlush(page);

  r.check('at least one /event call was made', calls.length >= 1, calls.length);
  const allEvents = calls.flatMap((c) => (c.body && c.body.events) || []);
  const allTypes = allEvents.map((e) => e.type);
  r.check('heart was queued', allTypes.includes('heart'), allTypes);
  r.check('search was queued (debounced to the final query)', allTypes.includes('search'), allTypes);

  const first = calls[0].body;
  r.check('device_id is a non-empty string', typeof first.device_id === 'string' && first.device_id.length > 0, first.device_id);
  r.check('session_id is a non-empty string', typeof first.session_id === 'string' && first.session_id.length > 0, first.session_id);
  r.check('events is an array', Array.isArray(first.events));

  const searchEvent = allEvents.find((e) => e.type === 'search');
  r.check('search meta carries the query and a result count', !!searchEvent && searchEvent.meta && searchEvent.meta.query === 'supernova' && typeof searchEvent.meta.results === 'number', JSON.stringify(searchEvent));
  r.check('no Authorization header while signed out', !calls.some((c) => c.headers.authorization), calls.map((c) => c.headers.authorization));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioPlayMilestonesOnceEach(browser, port, r) {
  r.section('play milestones fire once each per play, not on seek spam');
  const page = await newPage(browser);
  await clearNoTrack(page);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  const calls = await wireActivityStub(page);
  await gotoSong(page, port);
  await fakeAudio(page);

  await page.evaluate(() => document.getElementById('audio-el').dispatchEvent(new Event('play')));
  await forceFlush(page);

  // "Seek spam" inside the same bracket: three timeupdates at 30%, none of
  // them should fire 50 or 75, and 25 must not re-fire on the later two.
  for (const frac of [0.30, 0.31, 0.32]) {
    await page.evaluate((f) => {
      const el = document.getElementById('audio-el');
      el.currentTime = f * el.duration;
      el.dispatchEvent(new Event('timeupdate'));
    }, frac);
  }
  await forceFlush(page);

  // A real seek straight to 95%: 50 and 75 should now fire, each once.
  await page.evaluate(() => {
    const el = document.getElementById('audio-el');
    el.currentTime = 0.95 * el.duration;
    el.dispatchEvent(new Event('timeupdate'));
    el.dispatchEvent(new Event('timeupdate')); // a second tick at the same frac: still just once each
  });
  await forceFlush(page);

  await page.evaluate(() => document.getElementById('audio-el').dispatchEvent(new Event('ended')));
  await forceFlush(page);

  const allEvents = calls.flatMap((c) => (c.body && c.body.events) || []);
  const countOf = (t) => allEvents.filter((e) => e.type === t).length;
  r.check('play_start fired exactly once', countOf('play_start') === 1, countOf('play_start'));
  r.check('play_25 fired exactly once (not on repeated 30% ticks)', countOf('play_25') === 1, countOf('play_25'));
  r.check('play_50 fired exactly once (not on the repeated 95% tick)', countOf('play_50') === 1, countOf('play_50'));
  r.check('play_75 fired exactly once', countOf('play_75') === 1, countOf('play_75'));
  r.check('play_complete fired exactly once', countOf('play_complete') === 1, countOf('play_complete'));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioBeaconContentType(browser, port, r) {
  r.section('FIX-4: the pagehide beacon is sent as text/plain, never application/json');
  const page = await newPage(browser);
  await clearNoTrack(page);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  const calls = await wireActivityStub(page);
  await gotoSong(page, port);

  await page.evaluate(() => window.laivy.activity.log('heart', { song_id: 'x' }));
  // Exercises the real sendBeacon call path (urgent=true), exactly as the
  // real pagehide listener does -- not the fetch+keepalive path.
  await page.evaluate(() => window.laivy.activity.flush(true));
  await page.waitForTimeout(200);

  r.check('the beacon reached the endpoint', calls.length === 1, calls.length);
  r.check(
    'sent as text/plain, not application/json (a JSON content type is not CORS-safelisted and sendBeacon cannot preflight)',
    calls[0] && calls[0].headers['content-type'] === 'text/plain',
    calls[0] && calls[0].headers['content-type']
  );
  r.check('the body is still valid JSON underneath the text/plain label', !!(calls[0] && calls[0].body && Array.isArray(calls[0].body.events)), calls[0] && calls[0].body);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioEndpointUrl(r) {
  r.section('FIX-4: the endpoint is the real deployed Worker, not a placeholder or localhost');
  const src = readFileSync(join(ROOT, 'js', 'activity.js'), 'utf8');
  const m = src.match(/const ENDPOINT = '([^']+)'/);
  r.check('ENDPOINT constant is present', !!m, src.slice(0, 200));
  const url = m && m[1];
  r.check('points at the real laivyhart-audio-upload Worker', url === 'https://laivyhart-audio-upload.ytweiser-399.workers.dev/event', url);
  r.check('not localhost or a placeholder', !/localhost|127\.0\.0\.1|YOUR_|example\.com|TODO/i.test(url || ''), url);
}
