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
  await scenarioFreshAccount(browser, port, r);
  await scenarioReflectionCopy(browser, port, r);
  await scenarioHeartLabelRoom(browser, port, r);
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

  await page.click('.star[data-score="3"]');
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => window.__openModalCalls.length);
  r.check('tapping a star signed-out opens the sign-in modal instead of rating', after === 1, after);

  const bodyText = await page.evaluate(() => document.body.textContent);
  r.check('no "48 hour" wording anywhere on the page', !/48\s*hours?/i.test(bodyText));
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
