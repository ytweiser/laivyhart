/* ============================================================
   POLISH-1 -- the 48-hour rating age gate is gone (removed server-side in
   sql/019_remove_rating_age_gate.sql; verified directly against the real
   Supabase project in an aborting DO block, not here). This harness checks
   what's left for the frontend to get right: a signed-in account, however
   new, sees active stars; signed-out still gets the sign-in prompt; the
   "New accounts can rate after 48 hours." message is gone from the page
   entirely; and the comment box copy. Also covers the heart button's
   touch target and count at 390px (POLISH-1 item 6).

   RATE-2: the stars and the heart circle are brand V's now (.vbtn in a
   .vrow, .love-btn with its V); the behaviour checked here is unchanged.
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
  await scenarioCommentCopy(browser, port, r);
  await scenarioHeartLabelRoom(browser, port, r);
  await scenarioHeartState(browser, port, r);
  return r;
}

async function gotoSong(page, port, slug) {
  await page.goto(`http://localhost:${port}/song/${slug}`, { waitUntil: 'load' });
  await page.waitForSelector('#now-artist .now-artist-row', { timeout: 10000 });
  // paintRatings() has run (it appends #rating-msg last) -- the real
  // condition every scenario below actually needs before reading a star
  // or a row's locked state.
  await page.waitForSelector('#rating-rows .vrow', { timeout: 10000 });
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
    const row = document.querySelector('#rating-rows .vrow');
    return {
      locked: row ? row.classList.contains('is-locked') : null,
      note: document.getElementById('thoughts-note')?.textContent,
    };
  });
  r.check('rating row is locked when signed out', before.locked === true);
  r.check('the note under the rows says "Sign in to rate"', /Sign in to rate$/.test(before.note || ''), before.note);

  await page.click('.vbtn[data-facet="words"][data-score="3"]');
  await page.waitForFunction(() => window.__openModalCalls && window.__openModalCalls.length > 0, { timeout: 10000 });
  const after = await page.evaluate(() => ({
    calls: window.__openModalCalls,
    filled: document.querySelectorAll('.vrow[data-facet="words"] .vbtn.is-on').length,
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

  await page.focus('.vbtn[data-facet="music"][data-score="2"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__openModalCalls && window.__openModalCalls.length > 0, { timeout: 10000 });
  const d = await page.evaluate(() => ({
    calls: window.__openModalCalls.length,
    filled: document.querySelectorAll('.vrow[data-facet="music"] .vbtn.is-on').length,
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
  // The sign-in event can resolve after the first (signed-out-looking) paint;
  // the words row un-locking is the real signal that the repaint it triggers
  // (see index.html's own laivy:auth listener on paintRatings) has happened.
  await page.waitForFunction(() => {
    const row = document.querySelector('.vrow[data-facet="words"]');
    return row && !row.classList.contains('is-locked');
  }, { timeout: 10000 });

  const before = await page.evaluate(() => {
    const row = document.querySelector('.vrow[data-facet="words"]');
    return {
      locked: row ? row.classList.contains('is-locked') : null,
      starCount: row ? row.querySelectorAll('.vbtn').length : 0,
    };
  });
  r.check('rating row is NOT locked for a brand-new signed-in account', before.locked === false);
  r.check('stars render (not withheld for a new account)', before.starCount === 5, before.starCount);

  await page.click('.vbtn[data-facet="words"][data-score="4"]');
  await page.waitForFunction(() => {
    return document.querySelectorAll('.vrow[data-facet="words"] .vbtn.is-on').length === 4;
  }, { timeout: 10000 });
  const after = await page.evaluate(() => {
    const filled = document.querySelectorAll('.vrow[data-facet="words"] .vbtn.is-on').length;
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
  await page.waitForFunction(() => {
    const row = document.querySelector('.vrow[data-facet="music"]');
    return row && !row.classList.contains('is-locked');
  }, { timeout: 10000 });

  await page.click('.vbtn[data-facet="music"][data-score="5"]');
  // rate_song() is rejected and the optimistic fill reverted, then the
  // server's own message shown -- the message actually appearing is the
  // real signal that round trip (and the revert) has finished.
  await page.waitForFunction(() => {
    const msg = document.getElementById('rating-msg');
    return msg && msg.hidden === false && msg.textContent.length > 0;
  }, { timeout: 10000 });
  const after = await page.evaluate(() => {
    const msg = document.getElementById('rating-msg');
    return {
      filled: document.querySelectorAll('.vrow[data-facet="music"] .vbtn.is-on').length,
      msgHidden: msg ? msg.hidden : null,
      msgText: msg ? msg.textContent : null,
      msgBad: msg ? msg.classList.contains('is-bad') : null,
    };
  });
  r.check('stars revert to unrated (0 filled) after the server rejects it', after.filled === 0, after.filled);
  r.check('the server\'s own message is shown', after.msgText === 'You cannot rate your own song.', after.msgText);
  r.check('shown as an error', after.msgBad === true);
  r.check('message is visible', after.msgHidden === false);

  // index.html's own auto-dismiss timer (ratingMessage(), 5000ms) -- polled
  // for rather than slept past, so this returns as soon as it actually
  // clears instead of always waiting the full 5s+, and still times out
  // loudly if it never does.
  await page.waitForFunction(() => document.getElementById('rating-msg')?.hidden === true, { timeout: 7000 });
  const cleared = await page.evaluate(() => document.getElementById('rating-msg')?.hidden);
  r.check('the message clears itself after a few seconds', cleared === true);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioCommentCopy(browser, port, r) {
  r.section('comment box copy (RATE-2: "reflection" is "comment" now)');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await gotoSong(page, port, SLUG);
  const d = await page.evaluate(() => ({
    placeholder: document.getElementById('comment-body').placeholder,
    help: document.querySelector('.comment-help')?.textContent,
    button: document.getElementById('comment-submit').textContent,
    listHeading: document.querySelector('#comments-wrap .comments-h')?.textContent,
  }));
  r.check('placeholder "Write a comment..."', d.placeholder === 'Write a comment...', d.placeholder);
  r.check('helper "A single line is plenty."', d.help === 'A single line is plenty.', d.help);
  r.check('button "Post comment"', d.button === 'Post comment', d.button);
  r.check('the list is headed "Comments"', d.listHeading === 'Comments', d.listHeading);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioHeartLabelRoom(browser, port, r) {
  r.section('390px: the heart is a full-size touch target, its count beside the V');
  const page = await newPage(browser, { width: 390, height: 800 });
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await gotoSong(page, port, SLUG);

  const d = await page.evaluate(() => {
    const b = document.querySelector('.love-btn').getBoundingClientRect();
    const v = document.querySelector('.love-btn .v-off').getBoundingClientRect();
    const c = document.querySelector('.love-btn .love-count').getBoundingClientRect();
    return { w: b.width, h: b.height, vW: v.width, countRightOfV: c.left >= v.right, countInside: c.right <= b.right };
  });
  r.check('at least 44px tall and 36px wide', d.h >= 44 && d.w >= 36, d);
  r.check('the V is ~28px on a phone', Math.abs(d.vW - 28) < 1, d);
  r.check('the count sits beside the V, inside the button', d.countRightOfV && d.countInside, d);
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
  r.check('a fresh device starts with the V as an outline, not filled', before.on === false, before);
  r.check('aria-pressed is false to match', before.pressed === 'false', before.pressed);
  const startCount = Number(before.count);

  await page.click('.love-btn[data-love="song"]');
  await page.waitForFunction(() => document.querySelector('.love-btn[data-love="song"]').classList.contains('on'), { timeout: 10000 });
  const afterTap = await page.evaluate(() => {
    const btn = document.querySelector('.love-btn[data-love="song"]');
    return {
      on: btn.classList.contains('on'),
      pressed: btn.getAttribute('aria-pressed'),
      count: Number(btn.querySelector('.love-count')?.textContent),
    };
  });
  r.check('tapping fills the V', afterTap.on === true);
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
