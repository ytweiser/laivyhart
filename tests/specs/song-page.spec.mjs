/* ============================================================
   FOLLOW-2 -- the compact Follow pill on the song page / now-playing row.

   /song/:slug and /listen share ONE client renderer (renderNow(), writing
   into #now-artist) -- confirmed by reading index.html directly -- so there
   is only one DOM location to test, not two. These scenarios exercise it
   through /song/:slug, the canonical URL.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SLUG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA).slug; // 'supernova-a000', by Nova Ash

export async function run(browser, port) {
  const r = makeReporter('song-page.spec.mjs');
  await scenarioSignedOut(browser, port, r);
  await scenarioFollowToggle(browser, port, r);
  await scenarioArtistPageReflects(browser, port, r);
  await scenarioOwnSong(browser, port, r);
  await scenarioDailyLimitError(browser, port, r);
  await scenarioNoLayoutShift(browser, port, r);
  await scenarioNarrowViewport(browser, port, r);
  return r;
}

async function gotoSong(page, port, slug) {
  await page.goto(`http://localhost:${port}/song/${slug}`, { waitUntil: 'load' });
  await page.waitForSelector('#now-artist .now-artist-row', { timeout: 10000 });
  await page.waitForTimeout(300); // the compact pill mounts after initial paint
}

async function spyOpenModal(page) {
  await page.evaluate(() => {
    window.__openModalCalls = [];
    const orig = window.laivy.accountUI.openModal;
    window.laivy.accountUI.openModal = (opts) => { window.__openModalCalls.push(opts); return orig(opts); };
  });
}

async function scenarioSignedOut(browser, port, r) {
  r.section('song page, signed out: Follow opens sign-in with next=this page');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await gotoSong(page, port, SLUG);
  await spyOpenModal(page);

  const before = await page.evaluate(() => ({
    hasPill: !!document.querySelector('#now-artist [data-follow-btn]'),
    text: document.querySelector('#now-artist [data-follow-btn]')?.textContent,
  }));
  r.check('compact Follow pill present beside the artist name', before.hasPill === true);
  r.check('starts as "Follow"', before.text === 'Follow', before.text);

  await page.click('#now-artist [data-follow-btn]');
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => {
    const modal = document.querySelector('.lv-modal-backdrop');
    return {
      modalHidden: modal ? modal.hidden : 'MISSING',
      next: window.__openModalCalls[0]?.next,
      stillNotFollowing: document.querySelector('#now-artist [data-follow-btn]')?.dataset.following,
    };
  });
  r.check('clicking Follow signed-out opens the sign-in modal', after.modalHidden === false, JSON.stringify(after));
  r.check('sign-in asked to return to this same song page', after.next === `/song/${SLUG}`, after.next);
  r.check('no optimistic state change before signing in', after.stillNotFollowing === 'false', after.stillNotFollowing);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioFollowToggle(browser, port, r) {
  r.section('song page, signed in: follow then unfollow, in step with now-playing');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await signInAs(page, F.SESSION_USERS.LISTENER);
  await wireSupabaseStubs(page, { selfArtistRow: null });
  await gotoSong(page, port, SLUG);

  const initial = await page.evaluate(() => ({
    text: document.querySelector('#now-artist [data-follow-btn]')?.textContent,
    following: document.querySelector('#now-artist [data-follow-btn]')?.dataset.following,
  }));
  r.check('starts as "Follow", not following', initial.text === 'Follow' && initial.following === 'false', JSON.stringify(initial));

  await page.click('#now-artist [data-follow-btn]');
  await page.waitForTimeout(200);
  const followed = await page.evaluate(() => ({
    text: document.querySelector('#now-artist [data-follow-btn]')?.textContent,
    following: document.querySelector('#now-artist [data-follow-btn]')?.dataset.following,
  }));
  r.check('optimistic toggle to "Following"', followed.text === 'Following' && followed.following === 'true', JSON.stringify(followed));

  await page.click('#now-artist [data-follow-btn]');
  await page.waitForTimeout(200);
  const unfollowed = await page.evaluate(() => ({
    text: document.querySelector('#now-artist [data-follow-btn]')?.textContent,
    following: document.querySelector('#now-artist [data-follow-btn]')?.dataset.following,
  }));
  r.check('toggles back to "Follow" on unfollow', unfollowed.text === 'Follow' && unfollowed.following === 'false', JSON.stringify(unfollowed));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioArtistPageReflects(browser, port, r) {
  r.section('follow from the song page, then land on the artist page');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await signInAs(page, F.SESSION_USERS.LISTENER);
  await wireSupabaseStubs(page, { selfArtistRow: null });
  await gotoSong(page, port, SLUG);

  await page.click('#now-artist [data-follow-btn]');
  await page.waitForTimeout(200);

  // Client-side navigation (the artist-link row is intercepted, no reload --
  // confirmed in index.html), so the in-memory followed-ids cache carries
  // over, same as a real visitor browsing within one session would see.
  await page.click('#now-artist a.artist-link');
  await page.waitForSelector('.artist-wrap .artist-name', { timeout: 10000 });
  await page.waitForTimeout(400);

  const d = await page.evaluate(() => ({
    name: document.querySelector('.artist-name')?.textContent,
    following: document.querySelector('#artist-follow-slot [data-follow-btn]')?.dataset.following,
    text: document.querySelector('#artist-follow-slot [data-follow-btn]')?.textContent,
  }));
  r.check('landed on Nova Ash\'s artist page', d.name === 'Nova Ash', d.name);
  r.check('artist page shows "Following" after following from the song page', d.following === 'true' && d.text === 'Following', JSON.stringify(d));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioOwnSong(browser, port, r) {
  r.section('own song: no Follow button at all');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await signInAs(page, F.SESSION_USERS.NOVA);
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  await gotoSong(page, port, SLUG); // Supernova is Nova Ash's own song

  const d = await page.evaluate(() => ({
    hasPill: !!document.querySelector('#now-artist [data-follow-btn]'),
    slotEmpty: document.querySelector('#now-artist [data-follow-slot]') === null,
  }));
  r.check('no Follow button on your own song', d.hasPill === false, JSON.stringify(d));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioDailyLimitError(browser, port, r) {
  r.section('daily-limit error renders inline and reverts (stubbed)');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await signInAs(page, F.SESSION_USERS.LISTENER);
  await wireSupabaseStubs(page, {
    selfArtistRow: null,
    followArtistResult: { status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'You can follow or unfollow at most 60 artists per day.', code: 'P0001' }) },
  });
  await gotoSong(page, port, SLUG);

  await page.click('#now-artist [data-follow-btn]');
  await page.waitForTimeout(250);
  const d = await page.evaluate(() => ({
    errText: document.querySelector('#now-artist [data-follow-err]')?.textContent,
    errHidden: document.querySelector('#now-artist [data-follow-err]')?.hidden,
    reverted: document.querySelector('#now-artist [data-follow-btn]')?.dataset.following,
  }));
  r.check('daily-limit message shown inline', d.errHidden === false && /at most 60/.test(d.errText || ''), JSON.stringify(d));
  r.check('button reverted to Follow on error', d.reverted === 'false', d.reverted);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioNoLayoutShift(browser, port, r) {
  r.section('no layout shift while the pill mounts after load');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await signInAs(page, F.SESSION_USERS.LISTENER);
  await wireSupabaseStubs(page, { selfArtistRow: null });

  await page.goto(`http://localhost:${port}/song/${SLUG}`, { waitUntil: 'load' });
  await page.waitForSelector('#now-artist .now-artist-row', { timeout: 10000 });
  // Measured right after the row exists but almost certainly before the
  // async follow-widget fetch has resolved -- the slot's reserved min-width
  // (theme.css .follow-pill-slot) is what should keep this stable.
  const early = await page.evaluate(() => {
    const r = document.getElementById('now-badges').getBoundingClientRect();
    return { top: r.top, left: r.left };
  });
  await page.waitForTimeout(500); // widget fully settled
  const settled = await page.evaluate(() => {
    const r = document.getElementById('now-badges').getBoundingClientRect();
    return { top: r.top, left: r.left };
  });
  r.check('badge row does not move once the Follow pill finishes mounting', early.top === settled.top && early.left === settled.left, JSON.stringify({ early, settled }));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioNarrowViewport(browser, port, r) {
  r.section('390px: nothing overflows with the pill visible');
  const page = await newPage(browser, { width: 390, height: 800 });
  const errors = collectErrors(page);
  await signInAs(page, F.SESSION_USERS.LISTENER);
  await wireSupabaseStubs(page, { selfArtistRow: null });
  await gotoSong(page, port, SLUG);

  const d = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    pillVisible: !!document.querySelector('#now-artist [data-follow-btn]'),
  }));
  r.check('Follow pill renders at 390px', d.pillVisible === true);
  r.check('no horizontal overflow at 390px', d.overflow === false, `scrollWidth=${d.scrollWidth} clientWidth=${d.clientWidth}`);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
