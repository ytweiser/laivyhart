/* ============================================================
   LISTEN-1 -- the now-playing panel's reordered layout: everything acted
   on (progress, prev/play/next, heart+stars, Dedicate+Share, Dedications
   strip) sits above the lyrics now, and the lyrics no longer live in their
   own fixed-height, internally-scrolling box -- the whole page scrolls as
   one, so the controls and the comments are never trapped above or behind
   a scroll area.

   PLAYER-5: the cover is the player. The progress bar, prev/play/next and
   Sleep live in a control bar inside the bottom of the cover (no row under
   it any more); the titles sit in its top corners; a tap anywhere on the
   cover plays/pauses and flashes the new state; the old tap-to-enlarge
   lightbox is gone. Songs get a stubbed silent WAV so play and seek are real.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SONG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);
const SLUG = SONG.slug;
const HE_SONG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.QUIET_NIGHT_HE);

const AUDIO_HOST = 'audio.test';
function silentWav(secs) {
  const rate = 8000, n = Math.round(rate * secs);
  const b = Buffer.alloc(44 + n, 0x80);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}
const WAV = silentWav(60);
const AUDIO_SONGS = F.SONGS_ROWS.map((s) => ({ ...s, audio_url: `https://${AUDIO_HOST}/${s.id}.wav` }));
async function playerPage(browser, viewport) {
  const page = await newPage(browser, viewport);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { songs: AUDIO_SONGS });
  // Answer Range requests (206) like a real file host, or Chromium cannot seek.
  await page.route(`**://${AUDIO_HOST}/**`, (r) => {
    const m = /bytes=(\d+)-(\d*)/.exec(r.request().headers().range || '');
    if (!m) return r.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'Accept-Ranges': 'bytes' }, body: WAV });
    const start = Number(m[1]), end = m[2] ? Math.min(Number(m[2]), WAV.length - 1) : WAV.length - 1;
    return r.fulfill({ status: 206, contentType: 'audio/wav', body: WAV.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${WAV.length}` } });
  });
  return { page, errors };
}
async function gotoSlug(page, port, slug) {
  await page.goto(`http://localhost:${port}/song/${slug}`, { waitUntil: 'load' });
  await page.waitForFunction(() => currentIdx !== null && !document.getElementById('now-banner').classList.contains('hidden'), null, { timeout: 10000 });
}
const barShown = (page) => page.evaluate(() => getComputedStyle(document.getElementById('now-bar')).visibility === 'visible');

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
  await scenarioCoverTitles(browser, port, r);
  await scenarioCoverControls(browser, port, r);
  await scenarioCoverKeyboardAndA11y(browser, port, r);
  await scenarioFlashTiming(browser, port, r);
  return r;
}

async function scenarioDomOrder(browser, port, r) {
  r.section('everything acted on sits above the lyrics, in order: the cover player (titles, progress, prev/play/next, Sleep), artist+Follow, Your thoughts matter (Dedicate+Share, heart, words, music, comment box), Dedications strip, THEN lyrics, THEN comments');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await gotoSong(page, port);

  const d = await page.evaluate(() => {
    const ids = [
      'now-banner', 'now-artist', 'now-idea-credit',
      'loves', 'dedications-strip', 'lyrics-wrap', 'engage',
    ];
    const banner = document.getElementById('now-banner');
    const inCover = ['now-banner-en', 'scrub', 'prev-btn', 'play-btn', 'next-btn', 't-elapsed', 't-total', 'sleep-btn']
      .every((id) => { const el = document.getElementById(id); return !!el && banner.contains(el); });
    // The old row under the cover, the thumb+titles line, and the lightbox.
    const oldGone = !document.querySelector('.transport, .scrub-row, .tbtn, input.scrub, .now-topline, .now-banner-zoom, .lightbox')
      && !['t-remaining', 'now-topline', 'now-thumb', 'lightbox'].some((id) => document.getElementById(id));
    const nodes = ids.map((id) => document.getElementById(id));
    // Document order via compareDocumentPosition: every consecutive pair
    // must have the first PRECEDING the second.
    const inOrder = nodes.every((n, i) => {
      if (i === 0 || !n || !nodes[i - 1]) return true;
      return !!(nodes[i - 1].compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    // RATE-2: Dedicate + Share ride in the block's own heading row.
    const reactInBlock = document.getElementById('loves').contains(document.getElementById('dock-react'));
    // Heart before the words/music ratings within the block.
    const loves = document.getElementById('loves');
    const lovesRow = loves.querySelector('.vrow-love');
    const ratingRows = loves.querySelector('#rating-rows');
    const heartBeforeStars = !!(lovesRow && ratingRows && (lovesRow.compareDocumentPosition(ratingRows) & Node.DOCUMENT_POSITION_FOLLOWING));
    // Visually too, not just in the DOM -- each section strictly below the
    // one before it.
    const rowIds = ['now-banner', 'now-artist', 'loves', 'lyrics-wrap', 'engage'];
    const tops = rowIds.map((id) => document.getElementById(id).getBoundingClientRect().top);
    const visuallyInOrder = tops.every((t, i) => i === 0 || t > tops[i - 1]);
    return {
      allIdsFound: nodes.every((n) => !!n),
      reactInBlock,
      inCover,
      oldGone,
      inOrder,
      heartBeforeStars,
      visuallyInOrder,
      tops,
    };
  });
  r.check('every section is present', d.allIdsFound, d);
  r.check('the titles, progress, time, prev/play/next and Sleep are all inside the cover', d.inCover, d);
  r.check('the old controls row under the cover, the thumb line and the lightbox are gone', d.oldGone, d);
  r.check('document order matches the prompt\'s list exactly', d.inOrder, d);
  r.check('within "Your thoughts matter": the heart first, the words/music ratings after', d.heartBeforeStars, d);
  r.check('Dedicate + Share sit in that block\'s heading row', d.reactInBlock, d);
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

/* Titles in the top corners: English top left, Hebrew top right (RTL,
   right-aligned), each at most ~45% wide and two lines, never touching each
   other or the bar; one title alone at the top left. A light/dark-proof
   scrim runs along the top edge, and the titles do not fade with the bar. */
async function scenarioCoverTitles(browser, port, r) {
  r.section('PLAYER-5: titles in the cover\'s top corners (1280 and 380 px, both skins)');
  for (const width of [1280, 380]) {
    for (const theme of ['dark', 'light']) {
      const { page, errors } = await playerPage(browser, { width, height: 900 });
      await page.addInitScript((t) => { try { localStorage.setItem('laivy-theme', t); } catch (e) {} }, theme);
      for (const [slug, kind] of [[HE_SONG.slug, 'Hebrew + English'], [HE_SONG.slug, 'long titles'], [SLUG, 'English only']]) {
        await gotoSlug(page, port, slug);
        await page.evaluate(() => { if (!audioEl.paused) audioEl.pause(); });
        if (kind === 'long titles') {
          await page.evaluate(() => {
            const s = SONGS[currentIdx];
            s.title = 'שיר ארוך מאוד עם הרבה מילים שלא נגמרות אף פעם בכלל';
            s.title_translit = 'A Very Long English Title That Keeps Going And Going Past Two Lines';
            renderNow();
          });
        }
        await page.mouse.move(0, 0);
        const d = await page.evaluate(() => {
          const box = (el) => el.getBoundingClientRect();
          const cover = box(document.getElementById('now-banner'));
          const en = document.getElementById('now-banner-en'), he = document.getElementById('now-banner-he');
          const bar = box(document.querySelector('.now-bar-row'));
          const seek = box(document.getElementById('scrub-track'));
          const lines = (el) => Math.round(box(el).height / parseFloat(getComputedStyle(el).lineHeight));
          const shown = (el) => !el.hidden && getComputedStyle(el).display !== 'none';
          const out = { coverW: cover.width, enShown: shown(en), heShown: shown(he), enText: en.textContent, heText: he.textContent };
          if (out.enShown) {
            const b = box(en);
            Object.assign(out, { enLeft: b.left - cover.left, enTop: b.top - cover.top, enRight: b.right, enBottom: b.bottom, enW: b.width, enLines: lines(en),
              enItalic: getComputedStyle(en).fontStyle });
          }
          if (out.heShown) {
            const b = box(he), cs = getComputedStyle(he);
            Object.assign(out, { heRightGap: cover.right - b.right, heTop: b.top - cover.top, heLeft: b.left, heBottom: b.bottom, heW: b.width, heLines: lines(he),
              heDir: cs.direction, heAlign: cs.textAlign, heLang: he.getAttribute('lang') });
          }
          const scrim = getComputedStyle(document.getElementById('now-banner'), '::before');
          out.scrim = scrim.backgroundImage;
          out.barTop = Math.min(bar.top, seek.top - 20);
          out.titlesOpacity = getComputedStyle(document.getElementById('now-banner-titles')).opacity;
          out.pageW = document.scrollingElement.scrollWidth; out.vw = window.innerWidth;
          return out;
        });
        const tag = `[${width}px ${theme}, ${kind}]`;
        if (kind === 'English only') {
          r.check(`${tag} one title, top left; the right corner empty`, d.enShown && !d.heShown && d.enText === 'Supernova' && d.enLeft < 40 && d.enTop < 30, JSON.stringify(d));
        } else {
          r.check(`${tag} English at the top left, Hebrew at the top right`, d.enShown && d.heShown && d.enLeft < 40 && d.enTop < 30
            && d.heRightGap < 40 && d.heTop < 30, JSON.stringify(d));
          r.check(`${tag} Hebrew right-to-left and right-aligned; English in the italic serif`,
            d.heDir === 'rtl' && (d.heAlign === 'right' || d.heAlign === 'start') && d.heLang === 'he' && d.enItalic === 'italic', JSON.stringify(d));
          r.check(`${tag} no overlap between the two titles`, d.enRight <= d.heLeft, JSON.stringify(d));
          r.check(`${tag} each title at most ~45% of the cover, two lines at most`,
            d.enW <= d.coverW * 0.45 + 1 && d.heW <= d.coverW * 0.45 + 1 && d.enLines <= 2 && d.heLines <= 2, JSON.stringify(d));
        }
        r.check(`${tag} titles clear of the control bar`, Math.max(d.enBottom || 0, d.heBottom || 0) <= d.barTop, JSON.stringify(d));
        r.check(`${tag} a dark scrim along the top edge`, /linear-gradient/.test(d.scrim) && /rgba\(8, 4, 8, 0\.7/.test(d.scrim), d.scrim);
        r.check(`${tag} no sideways scrolling`, d.pageW <= d.vw, JSON.stringify(d));
      }
      // The titles stay while the bar fades away during play.
      await page.evaluate(() => audioEl.play());
      await page.waitForFunction(() => !audioEl.paused, null, { timeout: 5000 });
      await page.mouse.move(0, 0);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('now-bar')).visibility === 'hidden', null, { timeout: 5000 });
      r.check(`[${width}px ${theme}] playing, bar hidden: the titles are still fully shown`, await page.evaluate(() =>
        getComputedStyle(document.getElementById('now-banner-titles')).opacity === '1'
          && getComputedStyle(document.getElementById('now-banner-en')).visibility === 'visible'));
      r.check('no console/page errors', errors.length === 0, errors.join(' | '));
      await page.close();
    }
  }
}

/* Tap to play/pause with the flash; the bar's own controls never also
   toggle; previous, next, seek and Sleep work from the bar; the bar shows
   while paused, on hover, and for ~3s after a touch; nothing enlarges. */
async function scenarioCoverControls(browser, port, r) {
  for (const width of [1280, 380]) {
    r.section(`PLAYER-5: the cover's controls (${width} px)`);
    const { page, errors } = await playerPage(browser, { width, height: 900 });
    await gotoSlug(page, port, SLUG);
    await page.evaluate(() => { if (!audioEl.paused) audioEl.pause(); });
    await page.waitForFunction(() => audioEl.paused && document.getElementById('now-banner').classList.contains('is-paused'), null, { timeout: 5000 });
    await page.mouse.move(0, 0);
    r.check('paused: the bar is up without hovering', await barShown(page));

    await page.click('#now-tap');
    await page.waitForFunction(() => !audioEl.paused, null, { timeout: 5000 });
    let st = await page.evaluate(() => ({ go: document.getElementById('now-flash').classList.contains('go'),
      icon: document.getElementById('now-flash').innerHTML, label: document.getElementById('play-btn').getAttribute('aria-label'),
      paused: document.getElementById('now-banner').classList.contains('is-paused'), mini: document.getElementById('mini-play').textContent }));
    r.check('a tap on the cover plays, and the big icon flashes the play symbol', st.go && /M8 5\.2/.test(st.icon), JSON.stringify(st));
    r.check('...every indicator in sync: bar button says Pause, mini-player shows pause', st.label === 'Pause' && !st.paused && st.mini === '❚❚', JSON.stringify(st));
    r.check('nothing enlarged: no lightbox, no scroll lock', await page.evaluate(() =>
      !document.querySelector('.lightbox, #lightbox, .lightbox-img') && document.body.style.overflow === ''));
    await page.click('#now-tap', { position: { x: 30, y: 20 } });   // the top-left corner, over the English title
    await page.waitForFunction(() => audioEl.paused, null, { timeout: 5000 });
    st = await page.evaluate(() => ({ icon: document.getElementById('now-flash').innerHTML, label: document.getElementById('play-btn').getAttribute('aria-label') }));
    r.check('a tap anywhere (even on a title) pauses and flashes the pause symbol', /rect/.test(st.icon) && st.label === 'Play', JSON.stringify(st));

    // Playing, pointer away: the bar goes; hover brings it back.
    await page.click('#play-btn');
    await page.waitForFunction(() => !audioEl.paused, null, { timeout: 5000 });
    r.check('the bar\'s play button plays (and does not also toggle through the cover)', await page.evaluate(() => !audioEl.paused));
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.getElementById('now-banner').classList.remove('show-bar'));
    await page.waitForFunction(() => getComputedStyle(document.getElementById('now-bar')).visibility === 'hidden', null, { timeout: 5000 });
    r.check('playing with the pointer away: the bar is hidden', !(await barShown(page)));
    await page.hover('#now-tap');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('now-bar')).visibility === 'visible', null, { timeout: 5000 });
    r.check('hover brings the bar up', await barShown(page));

    // Seek: a tap at the middle of the track jumps there; a drag follows.
    const tr = await page.evaluate(() => { const b = document.getElementById('scrub-track').getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, w: b.width }; });
    const seekH = await page.evaluate(() => document.getElementById('scrub').getBoundingClientRect().height);
    r.check('the seek touch area is at least 44 px tall', seekH >= 44, seekH);
    await page.mouse.click(tr.x + tr.w * 0.5, tr.y);
    let t = await page.evaluate(() => ({ t: audioEl.currentTime, paused: audioEl.paused, txt: document.querySelector('.now-bar-time').textContent }));
    r.check('a tap on the track seeks to that point (~0:30 of 1:00)', Math.abs(t.t - 30) < 1.5, JSON.stringify(t));
    r.check('...without also pausing', !t.paused, JSON.stringify(t));
    r.check('...and the time reads elapsed / total', /^0:(29|30|31) \/ 1:00$/.test(t.txt), t.txt);
    await page.mouse.move(tr.x + tr.w * 0.2, tr.y);
    await page.mouse.down();
    await page.mouse.move(tr.x + tr.w * 0.5, tr.y, { steps: 4 });
    await page.mouse.move(tr.x + tr.w * 0.75, tr.y, { steps: 4 });
    await page.mouse.up();
    t = await page.evaluate(() => ({ t: audioEl.currentTime, paused: audioEl.paused, v: document.getElementById('scrub').getAttribute('aria-valuenow') }));
    r.check('a drag along the track follows to where it is let go (~0:45)', Math.abs(t.t - 45) < 1.5 && !t.paused, JSON.stringify(t));

    // Next and previous from the bar, still playing, no cover toggle.
    const before = await page.evaluate(() => SONGS[currentIdx].id);
    await page.hover('#now-tap');
    await page.click('#next-btn');
    await page.waitForFunction((id) => SONGS[currentIdx].id !== id, before, { timeout: 5000 });
    r.check('Next moves to another song', true);
    await page.hover('#now-tap');
    await page.click('#prev-btn');
    await page.waitForFunction((id) => SONGS[currentIdx].id === id || audioEl.currentTime < 1, before, { timeout: 5000 });
    r.check('Previous goes back', true);

    // Sleep from the bar opens the same menu.
    await page.hover('#now-tap');
    await page.click('#sleep-btn');
    await page.waitForFunction(() => !document.getElementById('sleep-panel').hidden, null, { timeout: 5000 });
    r.check('the moon opens the Sleep menu', await page.evaluate(() => document.getElementById('sleep-btn').getAttribute('aria-expanded') === 'true'));
    await page.keyboard.press('Escape');

    // A touch: the bar comes up for about 3 seconds.
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      const b = document.getElementById('now-banner');
      b.classList.remove('show-bar');
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    });
    r.check('a touch on the cover brings the bar up', await page.evaluate(() => document.getElementById('now-banner').classList.contains('show-bar')));
    await page.waitForFunction(() => !document.getElementById('now-banner').classList.contains('show-bar'), null, { timeout: 4500 });
    r.check('...and it goes again after about 3 seconds', true);
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}

async function scenarioCoverKeyboardAndA11y(browser, port, r) {
  r.section('PLAYER-5: keyboard and screen readers');
  const { page, errors } = await playerPage(browser);
  await gotoSlug(page, port, SLUG);
  await page.evaluate(() => { if (!audioEl.paused) audioEl.pause(); });
  await page.waitForFunction(() => audioEl.paused, null, { timeout: 5000 });
  await page.focus('#now-tap');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !audioEl.paused, null, { timeout: 5000 });
  r.check('Space on the focused cover plays (with the flash)', await page.evaluate(() => document.getElementById('now-flash').classList.contains('go')));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => audioEl.paused, null, { timeout: 5000 });
  r.check('Enter on the focused cover pauses', true);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !audioEl.paused, null, { timeout: 5000 });
  await page.mouse.move(0, 0);
  r.check('playing, keyboard focus on the cover keeps the bar up', await barShown(page));

  // Tab order: the cover, then the slider, prev, play, next, Sleep.
  const order = [];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => document.activeElement.id));
  }
  r.check('Tab walks the bar: seek, Previous, Play/Pause, Next, Sleep', JSON.stringify(order) === JSON.stringify(['scrub', 'prev-btn', 'play-btn', 'next-btn', 'sleep-btn']), JSON.stringify(order));
  r.check('a visible focus ring on the bar controls', await page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement);
    return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2;
  }));
  const a = await page.evaluate(() => {
    const lab = (id) => document.getElementById(id).getAttribute('aria-label');
    const s = document.getElementById('scrub');
    return { prev: lab('prev-btn'), play: lab('play-btn'), next: lab('next-btn'), sleep: lab('sleep-btn'), tap: lab('now-tap'),
      role: s.getAttribute('role'), seekLabel: lab('scrub'), text: s.getAttribute('aria-valuetext'), tabindex: s.tabIndex,
      min: s.getAttribute('aria-valuemin'), max: s.getAttribute('aria-valuemax'), now: s.getAttribute('aria-valuenow') };
  });
  r.check('labels: Previous, Pause (while playing), Next, Sleep timer; the cover says Play or pause',
    a.prev === 'Previous' && a.play === 'Pause' && a.next === 'Next' && a.sleep === 'Sleep timer' && a.tap === 'Play or pause', JSON.stringify(a));
  r.check('the progress bar is a focusable slider with value text', a.role === 'slider' && a.seekLabel === 'Seek' && a.tabindex === 0
    && a.min === '0' && a.max === '100' && /^\d+:\d\d of 1:00$/.test(a.text), JSON.stringify(a));
  await page.focus('#scrub');
  const t0 = await page.evaluate(() => audioEl.currentTime);
  await page.keyboard.press('ArrowRight');
  const t1 = await page.evaluate(() => audioEl.currentTime);
  r.check('Arrow Right on the slider skips ahead ~5s, and Space there does not pause', t1 - t0 > 4 && t1 - t0 < 6.5, JSON.stringify({ t0, t1 }));
  await page.keyboard.press('Space');
  r.check('...(still playing after Space on the slider)', await page.evaluate(() => !audioEl.paused));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* PLAYER-6: the flash lasts --flash-ms (1200ms): on at once, scales up a
   touch, holds at full opacity for the first ~600ms, fades over the last
   ~600ms, then is cleared. A tap mid-flash restarts it with the new state's
   icon; it never blocks taps. Reduced motion: the same timing, no scaling. */
async function scenarioFlashTiming(browser, port, r) {
  for (const [width, motion] of [[1280, 'no-preference'], [380, 'no-preference'], [380, 'reduce']]) {
    const tag = `[${width}px${motion === 'reduce' ? ', reduced motion' : ''}]`;
    r.section(`PLAYER-6: flash timing ${tag}`);
    const { page, errors } = await playerPage(browser, { width, height: 900 });
    await page.emulateMedia({ reducedMotion: motion });
    await gotoSlug(page, port, SLUG);
    await page.evaluate(() => { if (!audioEl.paused) audioEl.pause(); });
    await page.waitForFunction(() => audioEl.paused, null, { timeout: 5000 });
    // Tap, then sample the icon every frame for 1.6s.
    const tl = await page.evaluate(() => new Promise((res) => {
      const f = document.getElementById('now-flash');
      document.getElementById('now-tap').click();
      const t0 = performance.now(), out = [];
      const tick = () => {
        const t = performance.now() - t0, cs = getComputedStyle(f);
        const m = /matrix\(([\d.]+)/.exec(cs.transform);
        out.push({ t, o: parseFloat(cs.opacity), sc: m ? parseFloat(m[1]) : 1, icon: f.innerHTML.includes('M8 5.2') ? 'play' : f.innerHTML ? 'pause' : '' });
        if (t < 1600) requestAnimationFrame(tick); else res({ out, playing: !audioEl.paused, ms: getComputedStyle(f).getPropertyValue('--flash-ms').trim() });
      };
      requestAnimationFrame(tick);
    }));
    const at = (a, b) => tl.out.filter((x) => x.t >= a && x.t <= b);
    const first = tl.out[0];
    r.check(`${tag} one tunable duration: --flash-ms is 1200ms`, tl.ms === '1200ms', tl.ms);
    r.check(`${tag} appears at once, with the play icon`, first.o >= 0.95 && first.icon === 'play' && tl.playing, JSON.stringify(first));
    r.check(`${tag} holds at full opacity through ~550ms`, at(0, 550).every((x) => x.o >= 0.99), JSON.stringify(at(0, 550).map((x) => [Math.round(x.t), x.o])));
    r.check(`${tag} still visible at ~1000ms, fading`, at(950, 1050).every((x) => x.o > 0.05 && x.o < 0.99), JSON.stringify(at(950, 1050).map((x) => [Math.round(x.t), x.o])));
    r.check(`${tag} gone by ~1300ms and the icon cleared`, at(1300, 1600).every((x) => x.o === 0 && x.icon === ''), JSON.stringify(at(1250, 1600).map((x) => [Math.round(x.t), x.o, x.icon])));
    if (motion === 'reduce') {
      r.check(`${tag} a plain fade: no scaling at all`, tl.out.every((x) => x.sc === 1), JSON.stringify(tl.out.slice(0, 5)));
    } else {
      const sc = at(0, 1250).map((x) => x.sc);
      r.check(`${tag} scales up slightly (never more than ~10%)`, sc[0] < 1 && Math.max(...sc) > 1 && Math.max(...sc) <= 1.1 && Math.min(...sc) >= 0.85, JSON.stringify(sc.slice(0, 4).concat(sc.slice(-2))));
    }
    // Rapid taps through the cover, mid-flash: each restarts with the right icon.
    const rapid = [];
    for (let i = 0; i < 5; i++) {
      await page.click('#now-tap');
      await page.waitForTimeout(120);
      rapid.push(await page.evaluate(() => {
        const f = document.getElementById('now-flash');
        return { paused: audioEl.paused, icon: f.innerHTML.includes('M8 5.2') ? 'play' : f.innerHTML ? 'pause' : '', o: parseFloat(getComputedStyle(f).opacity) };
      }));
    }
    r.check(`${tag} rapid taps all land (the flash never blocks a tap) and the icon always matches the new state`,
      rapid.every((x, i) => x.paused === (i % 2 === 0) && x.icon === (x.paused ? 'pause' : 'play') && x.o >= 0.99), JSON.stringify(rapid));
    await page.waitForTimeout(1350);
    r.check(`${tag} after the last tap the icon is gone, nothing left behind`, await page.evaluate(() => {
      const f = document.getElementById('now-flash');
      return f.innerHTML === '' && !f.classList.contains('go') && parseFloat(getComputedStyle(f).opacity) === 0;
    }));
    r.check(`${tag} the control bar timer is untouched (3s after a touch)`, /setTimeout\(\(\) => banner\.classList\.remove\('show-bar'\), 3000\)/.test(
      await page.evaluate(() => [...document.scripts].map((s) => s.textContent).join('\n'))));
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}
