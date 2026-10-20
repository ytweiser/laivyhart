/* ============================================================
   LISTEN-1 -- the now-playing panel's reordered layout: everything acted
   on (progress, prev/play/next, heart+stars, Dedicate+Share, Dedications
   strip) sits above the lyrics now, and the lyrics no longer live in their
   own fixed-height, internally-scrolling box -- the whole page scrolls as
   one, so the controls and the comments are never trapped above or behind
   a scroll area.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SONG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);
const SLUG = SONG.slug;

async function gotoSong(page, port) {
  await page.goto(`http://localhost:${port}/song/${SLUG}`, { waitUntil: 'load' });
  await page.waitForSelector('#now-artist .now-artist-row', { timeout: 10000 });
  await page.waitForSelector('#now-dedicate-btn', { state: 'visible', timeout: 10000 });
}

export async function run(browser, port) {
  const r = makeReporter('now-playing-layout.spec.mjs');
  await scenarioDomOrder(browser, port, r);
  await scenarioNoInnerScroll(browser, port, r);
  await scenarioPageScrollReachesComments(browser, port, r);
  await scenarioLangToggleWithLyricsHeading(browser, port, r);
  return r;
}

async function scenarioDomOrder(browser, port, r) {
  r.section('everything acted on sits above the lyrics, in order: title/artist+Follow, progress, prev/play/next, heart+stars, Dedicate+Share, Dedications strip, THEN lyrics, THEN comments');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await gotoSong(page, port);

  const d = await page.evaluate(() => {
    const ids = [
      'now-topline', 'now-artist', 'now-idea-credit', 'scrub', 'prev-btn', 'play-btn', 'next-btn',
      'loves', 'dock-react', 'dedications-strip', 'lyrics-wrap', 'engage',
    ];
    const nodes = ids.map((id) => document.getElementById(id));
    // Document order via compareDocumentPosition: every consecutive pair
    // must have the first PRECEDING the second.
    const inOrder = nodes.every((n, i) => {
      if (i === 0 || !n || !nodes[i - 1]) return true;
      return !!(nodes[i - 1].compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    // Heart before the words/music stars within .loves specifically.
    const loves = document.getElementById('loves');
    const lovesRow = loves.querySelector('.loves-row');
    const ratingRows = loves.querySelector('#rating-rows');
    const heartBeforeStars = !!(lovesRow && ratingRows && (lovesRow.compareDocumentPosition(ratingRows) & Node.DOCUMENT_POSITION_FOLLOWING));
    // Visually too, not just in the DOM -- each section strictly below the
    // one before it. Row-level markers only (prev/play/next share one row
    // by design, so checking inside .transport would be the wrong test).
    const rowIds = ['now-topline', 'now-artist', 'scrub', 'loves', 'dock-react', 'lyrics-wrap', 'engage'];
    const tops = rowIds.map((id) => document.getElementById(id).getBoundingClientRect().top);
    const visuallyInOrder = tops.every((t, i) => i === 0 || t > tops[i - 1]);
    return {
      allIdsFound: nodes.every((n) => !!n),
      inOrder,
      heartBeforeStars,
      visuallyInOrder,
      tops,
    };
  });
  r.check('every section is present', d.allIdsFound, d);
  r.check('document order matches the prompt\'s list exactly', d.inOrder, d);
  r.check('within the loves: heart first, words/music stars after', d.heartBeforeStars, d);
  r.check('visually too -- each section sits strictly below the one before it', d.visuallyInOrder, d.tops);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioNoInnerScroll(browser, port, r) {
  r.section('lyrics are no longer a bounded, internally-scrolling box');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await gotoSong(page, port);

  const d = await page.evaluate(() => {
    const wrap = document.getElementById('lyrics-wrap');
    const scroll = document.getElementById('lyrics-scroll');
    const wrapStyle = getComputedStyle(wrap);
    const scrollStyle = getComputedStyle(scroll);
    return {
      wrapOverflowY: wrapStyle.overflowY,
      wrapHeight: wrapStyle.height,
      scrollOverflowY: scrollStyle.overflowY,
      resizeHandleExists: !!document.getElementById('lyrics-resize'),
      wrapHasInlineHeight: !!wrap.style.height,
    };
  });
  r.check('the lyrics wrap does not clip/scroll internally', d.wrapOverflowY === 'visible', d);
  r.check('the inner lyrics-scroll div does not clip/scroll internally either', d.scrollOverflowY === 'visible', d);
  r.check('no JS-set fixed height on the lyrics box', d.wrapHasInlineHeight === false, d);
  r.check('the old drag-resize handle is gone entirely', d.resizeHandleExists === false, d);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioPageScrollReachesComments(browser, port, r) {
  r.section('the whole page scrolls as one -- the comments are reachable, and nothing between the top and them has its own vertical scroller');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { comments: [{ id: 'c1', song_id: SONG.id, name: 'A Listener', city: '', body: 'Beautiful song.', created_at: new Date().toISOString() }] });
  await gotoSong(page, port);
  await page.waitForSelector('.comments-list .comment-item, #comments-wrap:not(.hidden)', { timeout: 10000 });

  await page.evaluate(() => {
    const el = document.getElementById('comments-wrap') || document.getElementById('panel-feed');
    el.scrollIntoView({ block: 'end' });
  });
  const after = await page.evaluate(() => {
    const el = document.getElementById('comments-wrap') || document.getElementById('panel-feed');
    const r = el.getBoundingClientRect();
    return { top: r.top, scrolledPage: window.scrollY > 0, inViewport: r.top >= 0 && r.top <= window.innerHeight };
  });
  r.check('the comments area is reachable within the viewport', after.inViewport, after);

  // No element between the top of .panel.now and the comments has its own
  // vertical scroller that could trap the controls above it.
  const scrollers = await page.evaluate(() => {
    const panel = document.querySelector('.panel.now');
    const offenders = [];
    panel.querySelectorAll('*').forEach((el) => {
      const s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
        offenders.push(el.id || el.className);
      }
    });
    return offenders;
  });
  r.check('no element inside the now-playing panel has its own vertical scroller', scrollers.length === 0, scrollers);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioLangToggleWithLyricsHeading(browser, port, r) {
  r.section('the English-translation toggle sits with the lyrics heading');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await gotoSong(page, port);
  const together = await page.evaluate(() => {
    const head = document.querySelector('.lyrics-head');
    return !!(head && head.querySelector('#lyrics-lang-btn') && head.querySelector('.lbl'));
  });
  r.check('lyrics-lang-btn and the "Lyrics" label are in the same .lyrics-head', together);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
