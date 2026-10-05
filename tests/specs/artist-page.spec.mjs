/* ============================================================
   /artist/:handle -- ARTIST-2 + ARTIST-3 behavior, against the committed
   synthetic fixtures (tests/fixtures.mjs). Anonymous-visitor and
   third-party-signed-in-visitor scenarios; owner scenarios (My page) live
   in settings.spec.mjs.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs, SUPA_HOST } from '../lib/stub-supabase.mjs';
import { wireStaticSnapshotStubs } from '../lib/stub-static.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const PORT = 8743;
const HEBREW_RE = /[֐-׿]/;

export async function run(browser, port) {
  const PORT = port;
  const r = makeReporter('artist-page.spec.mjs');
  await scenarioRealData(browser, PORT, r);
  await scenarioOwnerView(browser, PORT, r);
  await scenarioFollowSignedOut(browser, PORT, r);
  await scenarioFollowThirdParty(browser, PORT, r);
  await scenarioRichCase(browser, PORT, r);
  await scenarioEmptyArtist(browser, PORT, r);
  await scenarioWidths(browser, PORT, r);
  await scenarioOutageFallback(browser, PORT, r);
  return r;
}

async function gotoArtist(page, port, handle) {
  await page.goto(`http://localhost:${port}/artist/${handle}`, { waitUntil: 'load' });
  await page.waitForSelector('.artist-wrap .artist-name', { timeout: 10000 });
  await page.waitForTimeout(700); // progressive rows (comments/recommendations)
}

async function scenarioRealData(browser, port, r) {
  r.section('real data (nova-ash) + ARTIST-3 cleanup');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await gotoArtist(page, port, 'nova-ash');

  const d = await page.evaluate(() => ({
    name: document.querySelector('.artist-name')?.textContent,
    moodChips: document.querySelectorAll('.artist-mood-chips .mood-chip').length,
    statTiles: Array.from(document.querySelectorAll('.stat-tile-n')).map((e) => e.textContent),
    trophyHeading: document.getElementById('trophy-h')?.textContent,
    ownerToolsPresent: !!document.querySelector('.artist-owner-tools'),
    privateSectionPresent: !!document.querySelector('.artist-private'),
    honorsHeading: document.querySelector('[data-rail="honors"] .rail-title-h')?.textContent,
    honorsCount: document.querySelectorAll('[data-rail="honors"] .rail-item').length,
    honorsTitles: Array.from(document.querySelectorAll('[data-rail="honors"] .rail-title')).map((e) => e.textContent),
    successCount: document.querySelectorAll('[data-rail="success"] .rail-item').length,
    catalogCount: document.querySelectorAll('.catalog-grid .rail-item').length,
    catalogHeading: document.querySelector('.catalog-head .rail-title-h')?.textContent,
    noArtistNameOnHonors: document.querySelectorAll('[data-rail="honors"] .rail-item .artist-link').length,
    noArtistNameOnSuccess: document.querySelectorAll('[data-rail="success"] .rail-item .artist-link').length,
    noArtistNameOnCatalog: document.querySelectorAll('.catalog-grid .rail-item .artist-link').length,
    rootText: document.querySelector('.artist-wrap')?.textContent || '',
  }));

  r.check('name renders', d.name === 'Nova Ash', d.name);
  r.check('3 mood chips (inspire-me/move-me/wind-me-down)', d.moodChips === 3, d.moodChips);
  r.check('stats strip renders', d.statTiles.length === 5, JSON.stringify(d.statTiles));

  // ARTIST-3 step 4: two sections, two different headings.
  r.check('Trophy case heading renamed', d.trophyHeading === 'Trophy case', d.trophyHeading);
  r.check('Honors rail heading stays "Honors"', d.honorsHeading === 'Honors', d.honorsHeading);

  // ARTIST-3 step 3: owner tools / private list fully gone from the artist page.
  r.check('no "Your published songs" owner-tools section', d.ownerToolsPresent === false);
  r.check('no "Not yet public" private section', d.privateSectionPresent === false);

  // ARTIST-3 step 10: Honors threshold. Quiet Static (weeks_on_chart=2, below
  // the threshold of 4, no other permanent badge) and the Hebrew-title song
  // (only LIVE badges) must both be excluded.
  r.check('Honors has exactly 3 qualifying songs', d.honorsCount === 3, d.honorsCount);
  r.check('Quiet Static excluded (below weeks_on_chart threshold)', !d.honorsTitles.includes('Quiet Static'), JSON.stringify(d.honorsTitles));
  r.check('Quiet Night (Hebrew, live-badges-only) excluded', !d.honorsTitles.includes('לילה שקט'), JSON.stringify(d.honorsTitles));
  r.check('Supernova included (outright badges)', d.honorsTitles.includes('Supernova'), JSON.stringify(d.honorsTitles));
  r.check('Low Light included (best_words)', d.honorsTitles.includes('Low Light'), JSON.stringify(d.honorsTitles));
  r.check('Paper Moons included (was_most_loved)', d.honorsTitles.includes('Paper Moons'), JSON.stringify(d.honorsTitles));

  r.check('Success has 2 qualifying songs (Supernova, Paper Moons)', d.successCount === 2, d.successCount);
  r.check('Catalog has all 6 songs', d.catalogCount === 6, d.catalogCount);
  r.check('Catalog heading has no Hebrew span', d.catalogHeading === 'Catalog', d.catalogHeading);

  // ARTIST-3 step 6: no artist name on Honors/Success/Catalog cards.
  r.check('no artist-link on Honors cards', d.noArtistNameOnHonors === 0, d.noArtistNameOnHonors);
  r.check('no artist-link on Success cards', d.noArtistNameOnSuccess === 0, d.noArtistNameOnSuccess);
  r.check('no artist-link on Catalog cards', d.noArtistNameOnCatalog === 0, d.noArtistNameOnCatalog);

  // ARTIST-3 step 5: no Hebrew LABELS anywhere on the page, only CONTENT
  // (the Hebrew song title, "Laila Shaket" is its transliteration which is
  // Latin -- the real title "לילה שקט" is content and SHOULD still appear).
  // Matched word-by-word (a bare Unicode-range regex breaks on the space
  // inside "לילה שקט"), so check each word is one of the title's own words,
  // not that the whole phrase appears exactly once -- it legitimately
  // appears twice (once as the row title, once again as the no-cover
  // fallback art's plate text, same as any English-titled song would).
  const labelHebrewSuspects = (d.rootText.match(/[֐-׿]+/g) || []);
  const allowedWords = new Set('לילה שקט'.split(' '));
  r.check('any Hebrew text on the page is the song title content only', labelHebrewSuspects.length > 0 && labelHebrewSuspects.every((w) => allowedWords.has(w)), JSON.stringify(labelHebrewSuspects));

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioOwnerView(browser, port, r) {
  r.section('owner view: "Edit page" link, "N followers" with no button');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await signInAs(page, F.SESSION_USERS.NOVA);
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  await gotoArtist(page, port, 'nova-ash');

  const d = await page.evaluate(() => ({
    editPageHref: document.querySelector('.artist-actions a[href="/settings"]')?.getAttribute('href'),
    followButtonPresent: !!document.getElementById('artist-follow-btn'),
    followCount: document.getElementById('artist-follow-count')?.textContent,
  }));
  r.check('"Edit page" link to /settings present for the owner', d.editPageHref === '/settings', d.editPageHref);
  r.check('no Follow button on your own page', d.followButtonPresent === false);
  r.check('"N followers" shown in its place', (d.followCount || '').startsWith('12'), d.followCount);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioFollowSignedOut(browser, port, r) {
  r.section('Follow: signed out opens sign-in, next=same page');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await gotoArtist(page, port, 'nova-ash');

  const before = await page.evaluate(() => ({
    hasButton: !!document.getElementById('artist-follow-btn'),
    modalHidden: document.querySelector('.lv-modal-backdrop')?.hidden,
  }));
  r.check('Follow button present for a signed-out visitor', before.hasButton === true);

  await page.click('#artist-follow-btn');
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => {
    const modal = document.querySelector('.lv-modal-backdrop');
    return { modalHidden: modal ? modal.hidden : 'MISSING', stillNotFollowing: document.getElementById('artist-follow-btn')?.dataset.following };
  });
  r.check('clicking Follow signed-out opens the sign-in modal', after.modalHidden === false, JSON.stringify(after));
  r.check('no optimistic state change before signing in', after.stillNotFollowing === 'false', after.stillNotFollowing);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioFollowThirdParty(browser, port, r) {
  r.section('Follow: a signed-in third party (not the owner)');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await signInAs(page, F.SESSION_USERS.LISTENER);
  await wireSupabaseStubs(page, { selfArtistRow: null }); // the listener has no artists row
  await gotoArtist(page, port, 'nova-ash');

  const initial = await page.evaluate(() => ({
    text: document.getElementById('artist-follow-btn')?.textContent,
    following: document.getElementById('artist-follow-btn')?.dataset.following,
    count: document.getElementById('artist-follow-count')?.textContent,
  }));
  r.check('starts as "Follow", not following', initial.text === 'Follow' && initial.following === 'false', JSON.stringify(initial));
  r.check('follower count shown (12)', (initial.count || '').startsWith('12'), initial.count);

  await page.click('#artist-follow-btn');
  await page.waitForTimeout(250);
  const toggled = await page.evaluate(() => ({
    text: document.getElementById('artist-follow-btn')?.textContent,
    following: document.getElementById('artist-follow-btn')?.dataset.following,
    count: document.getElementById('artist-follow-count')?.textContent,
  }));
  r.check('optimistic toggle to "Following"', toggled.text === 'Following' && toggled.following === 'true', JSON.stringify(toggled));
  r.check('count incremented (13)', (toggled.count || '').startsWith('13'), toggled.count);

  // Error path: self-follow / daily-limit message, shown inline, and the
  // button reverts. We don't need a SEPARATE page nav -- just re-click with
  // the RPC now stubbed to fail, proving the inline-error + revert path.
  await page.close();

  const page2 = await newPage(browser);
  const errors2 = collectErrors(page2);
  await signInAs(page2, F.SESSION_USERS.LISTENER);
  await wireSupabaseStubs(page2, {
    selfArtistRow: null,
    followArtistResult: { status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'You can follow or unfollow at most 60 artists per day.', code: 'P0001' }) },
  });
  await gotoArtist(page2, port, 'nova-ash');
  await page2.click('#artist-follow-btn');
  await page2.waitForTimeout(250);
  const errored = await page2.evaluate(() => ({
    errText: document.getElementById('artist-follow-err')?.textContent,
    errHidden: document.getElementById('artist-follow-err')?.hidden,
    reverted: document.getElementById('artist-follow-btn')?.dataset.following,
  }));
  r.check('daily-limit message shown inline', errored.errHidden === false && /at most 60/.test(errored.errText || ''), JSON.stringify(errored));
  r.check('button reverted to Follow on error', errored.reverted === 'false', errored.reverted);

  r.check('no console/page errors (success case)', errors.length === 0, errors.join(' | '));
  r.check('no console/page errors (error case)', errors2.length === 0, errors2.join(' | '));
  await page2.close();
}

async function scenarioRichCase(browser, port, r) {
  r.section('rich case: picks (incl. a second artist), 3 comments, try-these');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, {
    artistPicks: [
      { artist_id: F.NOVA_ASH, song_id: F.SONGS.LOW_LIGHT, note: 'This one still gets me every time.', position: 1 },
      { artist_id: F.NOVA_ASH, song_id: F.SONGS.BORROWED_LIGHT, note: 'A friend’s song I can’t stop playing.', position: 2 },
    ],
    comments: F.COMMENTS_ROWS, // already 3 in the committed fixture
    recommend: [
      { song_id: F.SONGS.BORROWED_LIGHT, score: 5, top_channels: ['inspire-me', 'move-me'] },
      { song_id: F.SONGS.QUIET_FIRE, score: 3, top_channels: ['inspire-me'] },
    ],
  });
  await gotoArtist(page, port, 'nova-ash');

  const d = await page.evaluate(() => {
    const picks = Array.from(document.querySelectorAll('[data-rail="picks"] .pick-item'));
    return {
      picksCount: picks.length,
      pick1Note: picks[0]?.querySelector('.pick-note')?.textContent,
      pick2By: picks[1]?.querySelector('.rail-sub')?.textContent,
      listenersHidden: document.getElementById('artist-listeners')?.hidden,
      listenerCount: document.querySelectorAll('.listener-item').length,
      anonWho: Array.from(document.querySelectorAll('.listener-who')).map((e) => e.textContent),
      tryTheseHidden: document.getElementById('artist-try-these')?.hidden,
      tryTheseCount: document.querySelectorAll('[data-rail="try_these"] .rail-item').length,
    };
  });
  r.check('Picks has 2 cards (one own, one by Sable Ridge)', d.picksCount === 2, d.picksCount);
  r.check('own pick note renders', (d.pick1Note || '').includes('still gets me'), d.pick1Note);
  r.check('other-artist pick shows "by Sable Ridge"', (d.pick2By || '').includes('Sable Ridge'), d.pick2By);
  r.check('Listeners visible with 3 comments', d.listenersHidden === false && d.listenerCount === 3, JSON.stringify(d));
  r.check('anonymous comment falls back to "A listener"', d.anonWho.includes('A listener'), JSON.stringify(d.anonWho));
  r.check('Try These visible with 2 cards', d.tryTheseHidden === false && d.tryTheseCount === 2, JSON.stringify(d));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioEmptyArtist(browser, port, r) {
  r.section('empty artist: one song, nothing earned');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await gotoArtist(page, port, 'brand-new-artist');

  const d = await page.evaluate(() => ({
    name: document.querySelector('.artist-name')?.textContent,
    statTiles: Array.from(document.querySelectorAll('.stat-tile-n')).map((e) => e.textContent),
    catalogCount: document.querySelectorAll('.catalog-grid .rail-item').length,
    trophyPresent: !!document.querySelector('.trophy-case'),
    honorsPresent: !!document.querySelector('[data-rail="honors"]'),
    successPresent: !!document.querySelector('[data-rail="success"]'),
    picksPresent: !!document.querySelector('[data-rail="picks"]'),
    followBtnText: document.getElementById('artist-follow-btn')?.textContent,
    followCount: document.getElementById('artist-follow-count')?.textContent,
    bodyBroken: (document.querySelector('.artist-wrap')?.textContent || '').match(/undefined|NaN/),
  }));
  r.check('header renders', d.name === 'Brand New Artist', d.name);
  r.check('stats strip renders with zeros', JSON.stringify(d.statTiles) === JSON.stringify(['1', '0', '0', '0', 'Since Oct 2026']), JSON.stringify(d.statTiles));
  r.check('catalog has the one song', d.catalogCount === 1, d.catalogCount);
  r.check('Trophy case absent', d.trophyPresent === false);
  r.check('Honors absent', d.honorsPresent === false);
  r.check('Success absent', d.successPresent === false);
  r.check('Picks absent', d.picksPresent === false);
  r.check('Follow button still renders (0 followers)', d.followBtnText === 'Follow' && (d.followCount || '').startsWith('0'), JSON.stringify(d));
  r.check('nothing renders "undefined"/"NaN"', !d.bodyBroken, d.bodyBroken);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioWidths(browser, port, r) {
  r.section('widths 1280/1024/760/390');
  const page = await newPage(browser);
  await wireSupabaseStubs(page);
  await gotoArtist(page, port, 'nova-ash');

  for (const width of [1280, 1024, 760, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(120);
    const d = await page.evaluate(() => {
      const wraps = Array.from(document.querySelectorAll('#artist-root .rail-scroll-wrap'));
      return {
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        railsScrollable: wraps.map((w) => {
          const sc = w.querySelector('.rail-scroll');
          return sc ? sc.scrollWidth > sc.clientWidth + 1 : null;
        }),
      };
    });
    r.check(`${width}px: no horizontal overflow`, d.overflow === false, `scrollWidth=${d.scrollWidth} clientWidth=${d.clientWidth}`);
    // NOT "every rail scrolls" -- a rail whose few cards already fit the
    // viewport legitimately has nothing to scroll (true at 1280px for this
    // harness's small 2-6-card fixture rails; that's a fixture-size fact,
    // not a layout bug). The real signal is at the narrowest width, where
    // even a short rail should outgrow the screen.
    if (width === 390) {
      const scrollable = d.railsScrollable.filter((v) => v !== null);
      r.check(`${width}px: at least one rail scrolls (overflow-x wiring works)`, scrollable.some(Boolean), JSON.stringify(d.railsScrollable));
    }
  }
  await page.close();
}

async function scenarioOutageFallback(browser, port, r) {
  r.section('Supabase outage (HTTP 402): snapshot fallback');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await page.route(`https://${SUPA_HOST}/**`, (route) => route.fulfill({ status: 402, contentType: 'application/json', body: '{"message":"Project paused"}' }));
  // The static *.json files themselves are stubbed to the committed fixtures
  // too, so this scenario's expectations don't depend on whatever the real
  // repo's songs.json/artists.json happen to contain right now.
  await wireStaticSnapshotStubs(page);
  await gotoArtist(page, port, 'nova-ash');

  const d = await page.evaluate(() => ({
    name: document.querySelector('.artist-name')?.textContent,
    statTiles: Array.from(document.querySelectorAll('.stat-tile-n')).map((e) => e.textContent),
    catalogCount: document.querySelectorAll('.catalog-grid .rail-item').length,
    honorsCount: document.querySelectorAll('[data-rail="honors"] .rail-item').length,
    successCount: document.querySelectorAll('[data-rail="success"] .rail-item').length,
    listenersHidden: document.getElementById('artist-listeners')?.hidden,
    tryTheseHidden: document.getElementById('artist-try-these')?.hidden,
  }));
  r.check('renders from songs.json/artists.json despite total outage', d.name === 'Nova Ash', d.name);
  r.check('stats strip from artists.json', JSON.stringify(d.statTiles) === JSON.stringify(['6', '9', '30', '2', 'Since Feb 2026']), JSON.stringify(d.statTiles));
  r.check('catalog from songs.json (6 songs)', d.catalogCount === 6, d.catalogCount);
  r.check('Honors from artists.json honors[] + songs.json badges', d.honorsCount === 3, d.honorsCount);
  r.check('Success from songs.json embedded milestones', d.successCount === 2, d.successCount);
  r.check('Listeners hidden (no snapshot fallback)', d.listenersHidden === true);
  r.check('Try These hidden (live-only)', d.tryTheseHidden === true);
  r.check('no console/page errors despite the outage', errors.length === 0, errors.join(' | '));
  await page.close();
}
