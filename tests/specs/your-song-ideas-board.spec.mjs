/* ============================================================
   SONG-2 -- the idea board, /your-song/ideas: cards (idea text, credit,
   hearts, "Made into a song" when released), the Newest/Most hearted tabs,
   signed-out heart opens sign-in, signed-in heart toggles, and no user id
   ever appears in the DOM (song_ideas_board itself carries none).
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SONG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);

function boardFixture() {
  return [
    {
      id: 'idea-newest', idea_text: 'A song about staying up all night talking.', credit: 'Nova Ash',
      hearts_count: 2, status: 'received', created_at: new Date(Date.now() - 5 * 60000).toISOString(), released_song_slug: null,
    },
    {
      id: 'idea-most-hearted', idea_text: 'Something about the first snow of the year.', credit: 'A Friend',
      hearts_count: 9, status: 'received', created_at: new Date(Date.now() - 2 * 86400000).toISOString(), released_song_slug: null,
    },
    {
      id: 'idea-released', idea_text: 'An idea that already became a song.', credit: 'Anonymous',
      hearts_count: 1, status: 'released', created_at: new Date(Date.now() - 5 * 86400000).toISOString(), released_song_slug: SONG.slug,
    },
  ];
}

async function gotoBoard(page, port) {
  await page.goto(`http://localhost:${port}/your-song/ideas`, { waitUntil: 'load' });
  await page.waitForSelector('.yi-card', { timeout: 10000 });
}

export async function run(browser, port) {
  const r = makeReporter('your-song-ideas-board.spec.mjs');
  await scenarioCardsRenderAndNoUserIds(browser, port, r);
  await scenarioTabsReorder(browser, port, r);
  await scenarioHeartSignedOut(browser, port, r);
  await scenarioHeartSignedIn(browser, port, r);
  return r;
}

async function scenarioCardsRenderAndNoUserIds(browser, port, r) {
  r.section('cards render idea text, credit, hearts, and "Made into a song" when released');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { songIdeasBoard: boardFixture() });
  await gotoBoard(page, port);

  const d = await page.evaluate(() => ({
    count: document.querySelectorAll('.yi-card').length,
    html: document.getElementById('yi-list').innerHTML,
    firstCredit: document.querySelector('.yi-card .yi-credit')?.textContent,
    madeLinks: Array.from(document.querySelectorAll('.yi-made')).map((a) => a.getAttribute('href')),
  }));
  r.check('three cards render', d.count === 3, d.count);
  r.check('a credit shows', d.firstCredit === 'Nova Ash', d.firstCredit);
  r.check('"Made into a song" links to the real song page for the released one', d.madeLinks.includes('/song/' + SONG.slug), d.madeLinks);
  r.check('no raw uuid-shaped user id anywhere in the list markup', !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(d.html.replace(/idea-[a-z-]+/g, '')), d.html);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioTabsReorder(browser, port, r) {
  r.section('Newest / Most hearted tabs change the order');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { songIdeasBoard: boardFixture() });
  await gotoBoard(page, port);

  const newestOrder = await page.evaluate(() => Array.from(document.querySelectorAll('.yi-card')).map((c) => c.dataset.ideaId));
  r.check('"Newest" is the default tab, most recent first', newestOrder[0] === 'idea-newest', newestOrder);

  await page.click('#yi-tabs [data-sort="most_hearted"]');
  await page.waitForFunction(() => document.querySelector('.yi-card')?.dataset.ideaId === 'idea-most-hearted', { timeout: 10000 });
  const heartedOrder = await page.evaluate(() => Array.from(document.querySelectorAll('.yi-card')).map((c) => c.dataset.ideaId));
  r.check('"Most hearted" reorders by hearts_count desc', heartedOrder[0] === 'idea-most-hearted', heartedOrder);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioHeartSignedOut(browser, port, r) {
  r.section('signed out: the heart button opens sign-in instead of hearting');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { songIdeasBoard: boardFixture() });
  await gotoBoard(page, port);

  await page.evaluate(() => {
    window.__openModalCalls = [];
    const orig = window.laivy.accountUI.openModal;
    window.laivy.accountUI.openModal = (opts) => { window.__openModalCalls.push(opts); return orig(opts); };
  });
  await page.click('.yi-card[data-idea-id="idea-newest"] [data-yi-heart]');
  await page.waitForFunction(() => window.__openModalCalls && window.__openModalCalls.length > 0, { timeout: 10000 });
  const d = await page.evaluate(() => ({
    calls: window.__openModalCalls,
    count: document.querySelector('.yi-card[data-idea-id="idea-newest"] [data-yi-count]')?.textContent,
  }));
  r.check('sign-in modal opens with the right reason', d.calls.length === 1 && d.calls[0].reason === 'Sign in to heart a song idea', d.calls);
  r.check('the heart count does not change', d.count === '2', d.count);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioHeartSignedIn(browser, port, r) {
  r.section('signed in: hearting toggles the count and the filled state, and remembers it on reload');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { songIdeasBoard: boardFixture(), selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await gotoBoard(page, port);

  const card = '.yi-card[data-idea-id="idea-newest"]';
  await page.click(`${card} [data-yi-heart]`);
  await page.waitForFunction((sel) => document.querySelector(`${sel} [data-yi-count]`)?.textContent === '3', card, { timeout: 10000 });
  const on = await page.evaluate((sel) => ({
    count: document.querySelector(`${sel} [data-yi-count]`).textContent,
    isOn: document.querySelector(`${sel} [data-yi-heart]`).classList.contains('is-on'),
  }), card);
  r.check('hearting increments the count', on.count === '3', on.count);
  r.check('the heart shows filled', on.isOn === true, on.isOn);

  await page.click(`${card} [data-yi-heart]`);
  await page.waitForFunction((sel) => document.querySelector(`${sel} [data-yi-count]`)?.textContent === '2', card, { timeout: 10000 });
  const off = await page.evaluate((sel) => ({
    count: document.querySelector(`${sel} [data-yi-count]`).textContent,
    isOn: document.querySelector(`${sel} [data-yi-heart]`).classList.contains('is-on'),
  }), card);
  r.check('un-hearting decrements it back', off.count === '2', off.count);
  r.check('the heart is outline again', off.isOn === false, off.isOn);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
