/* ============================================================
   POLISH-1 -- the 48-hour rating age gate is gone (removed server-side in
   sql/019_remove_rating_age_gate.sql; verified directly against the real
   Supabase project in an aborting DO block, not here). This harness checks
   what's left for the frontend to get right: a signed-in account, however
   new, sees active stars; signed-out still gets the sign-in prompt; the
   "New accounts can rate after 48 hours." message is gone from the page
   entirely; and the reflection copy fix. Also covers the heart button's
   label/count spacing at 390px (POLISH-1 item 6).
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SLUG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA).slug; // 'supernova-a000', by Nova Ash

export async function run(browser, port) {
  const r = makeReporter('rating.spec.mjs');
  await scenarioSignedOut(browser, port, r);
  await scenarioSignedOutKeyboard(browser, port, r);
  await scenarioFreshAccount(browser, port, r);
  await scenarioRateError(browser, port, r);
  await scenarioReflectionCopy(browser, port, r);
  await scenarioHeartLabelRoom(browser, port, r);
  await scenarioHeartState(browser, port, r);
  return r;
}

async function gotoSong(page, port, slug) {
  await page.goto(`http://localhost:${port}/song/${slug}`, { waitUntil: 'load' });
  await page.waitForSelector('#now-artist .now-artist-row', { timeout: 10000 });
  await page.waitForTimeout(300);
}

async function scenarioSignedOut(browser, port, r) {
  r.section('song page, signed out: stars show the sign-in prompt, not an age-gate message');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await gotoSong(page, port, SLUG);

  await page.evaluate(() => {
    window.__openModalCalls = [];
    const orig = window.laivy.accountUI.openModal;
    window.laivy.accountUI.openModal = (opts) => { window.__openModalCalls.push(opts); return orig(opts); };
  });

  const before = await page.evaluate(() => {
    const row = document.querySelector('.rating-row');
    return {
      locked: row ? row.classList.contains('is-locked') : null,
      note: row ? row.querySelector('.rating-note')?.textContent : null,
    };
  });
  r.check('rating row is locked when signed out', before.locked === true);
  r.check('note says "Sign in to rate"', before.note === 'Sign in to rate', before.note);

  await page.click('.star[data-facet="words"][data-score="3"]');
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => ({
    calls: window.__openModalCalls,
    filled: Array.from(document.querySelectorAll('.rating-row[data-facet="words"] .star svg'))
      .filter((svg) => svg.classList.contains('is-on')).length,
  }));
  r.check('tapping a star signed-out opens the sign-in modal instead of rating', after.calls.length === 1, after.calls);
  r.check('FIX-3: the modal is told why, in one line', after.calls[0] && after.calls[0].reason === 'Sign in to rate the words and the music', after.calls[0]);
  r.check('FIX-3: the modal is told to return to this same page', after.calls[0] && after.calls[0].next === '/song/' + SLUG, after.calls[0]);
  r.check('FIX-3: no star visually fills -- the click left the row exactly as it was', after.filled === 0, after.filled);

  const bodyText = await page.evaluate(() => document.body.textContent);
  r.check('no "48 hour" wording anywhere on the page', !/48\s*hours?/i.test(bodyText));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioSignedOutKeyboard(browser, port, r) {
  r.section('song page, signed out: keyboard activation (Enter on a focused star) behaves the same as a click');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await gotoSong(page, port, SLUG);
  await page.evaluate(() => {
    window.__openModalCalls = [];
    const orig = window.laivy.accountUI.openModal;
    window.laivy.accountUI.openModal = (opts) => { window.__openModalCalls.push(opts); return orig(opts); };
  });

  await page.focus('.star[data-facet="music"][data-score="2"]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  const d = await page.evaluate(() => ({
    calls: window.__openModalCalls.length,
    filled: Array.from(document.querySelectorAll('.rating-row[data-facet="music"] .star svg'))
      .filter((svg) => svg.classList.contains('is-on')).length,
  }));
  r.check('Enter on a focused star opens the sign-in modal', d.calls === 1, d.calls);
  r.check('no star fills from keyboard activation either', d.filled === 0, d.filled);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioFreshAccount(browser, port, r) {
  r.section('song page, signed in one minute after creating the account: stars are active and ratable');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await signInAs(page, { ...F.SESSION_USERS.LISTENER, createdAt: new Date(Date.now() - 60000) });
  await gotoSong(page, port, SLUG);
  await page.waitForTimeout(200);

  const before = await page.evaluate(() => {
    const row = document.querySelector('.rating-row[data-facet="words"]');
    return {
      locked: row ? row.classList.contains('is-locked') : null,
      starCount: row ? row.querySelectorAll('.star').length : 0,
    };
  });
  r.check('rating row is NOT locked for a brand-new signed-in account', before.locked === false);
  r.check('stars render (not withheld for a new account)', before.starCount === 5, before.starCount);

  await page.click('.star[data-facet="words"][data-score="4"]');
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => {
    const stars = Array.from(document.querySelectorAll('.rating-row[data-facet="words"] .star'));
    const filled = stars.filter((b) => b.querySelector('svg').classList.contains('is-on')).length;
    const msg = document.getElementById('rating-msg');
    return { filled, msgHidden: msg ? msg.hidden : null, msgText: msg ? msg.textContent : null };
  });
  r.check('4 stars are filled after rating 4 (no age-gate rejection)', after.filled === 4, after.filled);
  r.check('no error message shown', after.msgHidden === true, after.msgText);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function clearNoTrack(page) {
  await page.addInitScript(() => { try { localStorage.removeItem('laivy-no-track'); } catch (e) {} });
}

async function scenarioRateError(browser, port, r) {
  r.section('FIX-3: signed in, rate_song rejects -- stars revert, the message shows then clears itself');
  const page = await newPage(browser);
  // The RPC must actually fire to exercise the error path, so no-track is
  // cleared here, same as activity.spec.mjs does for its own positive-path
  // checks; every OTHER scenario in this file keeps the harness default.
  await clearNoTrack(page);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, {
    rateSongResult: { status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'You cannot rate your own song.', code: 'P0001' }) },
  });
  await signInAs(page, { ...F.SESSION_USERS.LISTENER, createdAt: new Date(Date.now() - 60000) });
  await gotoSong(page, port, SLUG);
  await page.waitForTimeout(200);

  await page.click('.star[data-facet="music"][data-score="5"]');
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => {
    const stars = Array.from(document.querySelectorAll('.rating-row[data-facet="music"] .star svg'));
    const msg = document.getElementById('rating-msg');
    return {
      filled: stars.filter((svg) => svg.classList.contains('is-on')).length,
      msgHidden: msg ? msg.hidden : null,
      msgText: msg ? msg.textContent : null,
      msgBad: msg ? msg.classList.contains('is-bad') : null,
    };
  });
  r.check('stars revert to unrated (0 filled) after the server rejects it', after.filled === 0, after.filled);
  r.check('the server\'s own message is shown', after.msgText === 'You cannot rate your own song.', after.msgText);
  r.check('shown as an error', after.msgBad === true);
  r.check('message is visible', after.msgHidden === false);

  await page.waitForTimeout(5200); // the auto-dismiss timer (5s)
  const cleared = await page.evaluate(() => document.getElementById('rating-msg')?.hidden);
  r.check('the message clears itself after a few seconds', cleared === true);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioReflectionCopy(browser, port, r) {
  r.section('reflection invite copy');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await gotoSong(page, port, SLUG);
  const text = await page.evaluate(() => document.querySelector('.reflect-sub')?.textContent);
  r.check(
    'reflection line reads "Did this song stir something in you? ..."',
    text === 'Did this song stir something in you? Leave a few words. A single line is plenty.',
    text
  );
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioHeartLabelRoom(browser, port, r) {
  r.section('390px: the heart label and count have room, not touching the focus outline');
  const page = await newPage(browser, { width: 390, height: 800 });
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await gotoSong(page, port, SLUG);

  const d = await page.evaluate(() => {
    const btn = document.querySelector('.love-btn');
    const label = document.querySelector('.love-label');
    const count = document.querySelector('.love-count');
    const b = btn.getBoundingClientRect();
    const l = label.getBoundingClientRect();
    const c = count.getBoundingClientRect();
    const OUTLINE_OFFSET = 3; // .love-btn:focus-visible's outline-offset in theme CSS
    return {
      // Room between the label/count box and where the focus outline is
      // drawn (the button's own border box, pushed out by outline-offset).
      leftRoom: l.left - b.left + OUTLINE_OFFSET,
      rightRoom: b.right - c.right + OUTLINE_OFFSET,
      bottomRoom: b.bottom - c.bottom + OUTLINE_OFFSET,
    };
  });
  r.check('label has room from the outline on the left', d.leftRoom >= 6, d.leftRoom);
  r.check('count has room from the outline on the right', d.rightRoom >= 6, d.rightRoom);
  r.check('count has room from the outline at the bottom', d.bottomRoom >= 6, d.bottomRoom);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioHeartState(browser, port, r) {
  r.section('FIX-3: the heart shows this device\'s own state, not a default-on look');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await gotoSong(page, port, SLUG);

  const before = await page.evaluate(() => {
    const btn = document.querySelector('.love-btn[data-love="song"]');
    return {
      on: btn.classList.contains('on'),
      pressed: btn.getAttribute('aria-pressed'),
      count: btn.querySelector('.love-count')?.textContent,
    };
  });
  r.check('a fresh device starts with the heart as an outline, not filled', before.on === false, before);
  r.check('aria-pressed is false to match', before.pressed === 'false', before.pressed);
  const startCount = Number(before.count);

  await page.click('.love-btn[data-love="song"]');
  await page.waitForTimeout(150);
  const afterTap = await page.evaluate(() => {
    const btn = document.querySelector('.love-btn[data-love="song"]');
    return {
      on: btn.classList.contains('on'),
      pressed: btn.getAttribute('aria-pressed'),
      count: Number(btn.querySelector('.love-count')?.textContent),
    };
  });
  r.check('tapping fills the heart', afterTap.on === true);
  r.check('aria-pressed flips to true', afterTap.pressed === 'true');
  r.check('the count goes up by one, the same total shown either way', afterTap.count === startCount + 1, afterTap.count);

  // Survives a reload: the liked state lives in this browser's localStorage.
  await gotoSong(page, port, SLUG);
  const afterReload = await page.evaluate(() => {
    const btn = document.querySelector('.love-btn[data-love="song"]');
    return { on: btn.classList.contains('on'), pressed: btn.getAttribute('aria-pressed') };
  });
  r.check('still filled after a reload', afterReload.on === true);
  r.check('aria-pressed still true after a reload', afterReload.pressed === 'true');
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
