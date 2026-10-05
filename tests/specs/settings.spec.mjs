/* ============================================================
   /settings ("My page") -- ARTIST-3: My songs, My picks, bio (already
   existed; verified here), Following + Unfollow. Always signed in as an
   artist (Nova Ash) unless a scenario says otherwise.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

export async function run(browser, port) {
  const r = makeReporter('settings.spec.mjs');
  await scenarioMySongs(browser, port, r);
  await scenarioMyPicksAddCapUnpublished(browser, port, r);
  await scenarioMyPicksReorder(browser, port, r);
  await scenarioBio(browser, port, r);
  await scenarioFollowing(browser, port, r);
  return r;
}

async function gotoSettings(page, port) {
  await page.goto(`http://localhost:${port}/settings`, { waitUntil: 'load' });
  await page.waitForSelector('.lv-settings', { timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('lv-mysongs-list');
    return el && !/Loading/.test(el.textContent);
  }, { timeout: 10000 });
  await page.waitForTimeout(150);
}

async function scenarioMySongs(browser, port, r) {
  r.section('My songs (all statuses, Edit/Withdraw)');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await signInAs(page, F.SESSION_USERS.NOVA);
  const draftId = 'dddddddd-0000-4000-8000-000000000001';
  const rejectedId = 'dddddddd-0000-4000-8000-000000000002';
  await wireSupabaseStubs(page, {
    selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH],
    songs: [
      ...F.SONGS_ROWS,
      { id: draftId, artist_id: F.NOVA_ASH, title: 'Unfinished Sketch', title_translit: '', status: 'draft', created_at: '2026-05-01T00:00:00+00:00' },
      { id: rejectedId, artist_id: F.NOVA_ASH, title: 'Rough Cut', title_translit: '', status: 'rejected', created_at: '2026-05-02T00:00:00+00:00' },
    ],
    reviews: [{ song_id: rejectedId, decision: 'reject', reason: 'The audio clips at the chorus.', created_at: '2026-05-03T00:00:00+00:00' }],
  });
  await gotoSettings(page, port);

  const d = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#lv-mysongs-list .artist-private-row'));
    return {
      count: rows.length,
      titles: rows.map((row) => row.querySelector('.artist-private-title')?.textContent),
      pills: rows.map((row) => {
        const p = row.querySelector('.artist-private-pill');
        return p && !p.hidden ? p.textContent : null;
      }),
      reasonVisible: !!document.querySelector('.artist-private-reason'),
      editHrefs: rows.map((row) => row.querySelector('.artist-private-act')?.getAttribute('href')),
    };
  });
  r.check('shows all 8 of her songs (6 approved + draft + rejected)', d.count === 8, d.count);
  r.check('Unfinished Sketch shows "Draft" pill', d.pills[d.titles.indexOf('Unfinished Sketch')] === 'Draft', JSON.stringify(d));
  r.check('Rough Cut shows "Needs changes" pill', d.pills[d.titles.indexOf('Rough Cut')] === 'Needs changes', JSON.stringify(d));
  r.check('approved songs show no status pill', d.pills[d.titles.indexOf('Supernova')] === null, JSON.stringify(d));
  r.check('rejection reason expandable', d.reasonVisible === true);
  r.check('each row links to /upload?song=<id> to edit', d.editHrefs.every((h) => /^\/upload\?song=/.test(h || '')), JSON.stringify(d.editHrefs));

  // Withdraw.
  // Withdraw asks for confirm(); headless Chromium auto-dismisses any dialog
  // it isn't told how to handle, which would silently abort the withdraw.
  page.once('dialog', (d) => d.accept());
  await page.click('#lv-mysongs-list [data-withdraw]');
  await page.waitForTimeout(200);
  const afterWithdraw = await page.evaluate(() => {
    const btn = document.querySelector('#lv-mysongs-list [data-withdraw]');
    return { text: btn?.textContent, disabled: btn?.disabled };
  });
  r.check('Withdraw updates its own label', afterWithdraw.text === 'Withdrawn', JSON.stringify(afterWithdraw));

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioMyPicksAddCapUnpublished(browser, port, r) {
  r.section('My picks: add, six-cap refused, unpublished refused');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await signInAs(page, F.SESSION_USERS.NOVA);
  // The stub's own artist_picks POST enforces the real rules (picks_max=6,
  // approved-only) against its in-memory state, so a real 6-then-7th
  // sequence is testable end to end, not just a canned error response.
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  await gotoSettings(page, port);

  const sectionPresent = await page.evaluate(() => !!document.getElementById('lv-mypicks-list'));
  r.check('My picks section renders (artist only)', sectionPresent === true);

  const emptyState = await page.evaluate(() => document.getElementById('lv-mypicks-list')?.textContent);
  r.check('empty-state nudge text', (emptyState || '').includes("Pick up to six songs, yours or anyone's, and say why."), emptyState);

  async function searchAndAdd(title) {
    await page.fill('#lv-pick-search-input', '');
    await page.fill('#lv-pick-search-input', title);
    await page.waitForTimeout(350);
    await page.click('.lv-pick-result');
    await page.waitForTimeout(250);
  }

  // Six real picks, one of them (Borrowed Light) by Sable Ridge -- the
  // stubbed second artist.
  const sixTitles = ['Supernova', 'Quiet Static', 'Low Light', 'Paper Moons', 'Afterglow', 'Borrowed Light'];
  for (const title of sixTitles) await searchAndAdd(title);
  const afterSix = await page.evaluate(() => ({
    count: document.querySelectorAll('#lv-mypicks-list .lv-pick-row').length,
    titles: Array.from(document.querySelectorAll('.lv-pick-title')).map((e) => e.textContent),
    bySable: Array.from(document.querySelectorAll('.lv-pick-by')).some((e) => /Sable Ridge/.test(e.textContent)),
  }));
  r.check('all six picks added and rendered, including Sable Ridge’s song', afterSix.count === 6 && afterSix.titles.includes('Borrowed Light') && afterSix.bySable, JSON.stringify(afterSix));

  // A real seventh attempt -- the stub's own cap check (mirroring
  // artist_picks_guard()) refuses it, surfaced inline.
  await searchAndAdd('Quiet Fire');
  const capped = await page.evaluate(() => ({
    err: document.querySelector('[data-pick-err]')?.textContent,
    hidden: document.querySelector('[data-pick-err]')?.hidden,
    stillSix: document.querySelectorAll('#lv-mypicks-list .lv-pick-row').length,
  }));
  r.check('seventh pick shows the cap message inline and is not added', capped.hidden === false && /up to 6 songs/.test(capped.err || '') && capped.stillSix === 6, JSON.stringify(capped));
  await page.close();

  // Unpublished-song refusal. NOT reachable through the UI's own search (it
  // already filters to status=approved), so this is the trigger's
  // defense-in-depth, exercised by forcing the insert response directly --
  // the same thing a stale/edited request or a direct API call would hit.
  const page3 = await newPage(browser);
  const errors3 = collectErrors(page3);
  await signInAs(page3, F.SESSION_USERS.NOVA);
  await wireSupabaseStubs(page3, {
    selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH],
    artistPicksInsertError: { status: 400, message: 'You can only pick published songs.' },
  });
  await gotoSettings(page3, port);
  await page3.fill('#lv-pick-search-input', 'Afterglow');
  await page3.waitForTimeout(400);
  await page3.click('.lv-pick-result');
  await page3.waitForTimeout(250);
  const unpub = await page3.evaluate(() => ({
    err: document.querySelector('[data-pick-err]')?.textContent,
    hidden: document.querySelector('[data-pick-err]')?.hidden,
  }));
  r.check('unpublished-song pick shows the trigger message inline', unpub.hidden === false && /published songs/.test(unpub.err || ''), JSON.stringify(unpub));
  r.check('no console/page errors', errors.length === 0 && errors3.length === 0, [...errors, ...errors3].join(' | '));
  await page3.close();
}

async function scenarioMyPicksReorder(browser, port, r) {
  r.section('My picks: reorder (no unique-violation flash), remove, notes order on the artist page');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await signInAs(page, F.SESSION_USERS.NOVA);
  const existingPicks = [
    { id: 'eeeeeeee-0000-4000-8000-000000000001', artist_id: F.NOVA_ASH, song_id: F.SONGS.LOW_LIGHT, note: 'First pick.', position: 1,
      songs: { title: 'Low Light', title_translit: '', language: 'English', artist: { display_name: 'Nova Ash', handle: 'nova-ash' } } },
    { id: 'eeeeeeee-0000-4000-8000-000000000002', artist_id: F.NOVA_ASH, song_id: F.SONGS.BORROWED_LIGHT, note: 'Second pick, by a friend.', position: 2,
      songs: { title: 'Borrowed Light', title_translit: '', language: 'English', artist: { display_name: 'Sable Ridge', handle: 'sable-ridge' } } },
  ];
  let swapCalls = [];
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH], artistPicks: existingPicks },
    (name, req) => { if (name === 'rpc:swap_my_pick_positions') swapCalls.push(req.postData()); });
  await gotoSettings(page, port);

  const before = await page.evaluate(() => Array.from(document.querySelectorAll('.lv-pick-title')).map((e) => e.textContent));
  r.check('two picks load in position order', JSON.stringify(before) === JSON.stringify(['Low Light', 'Borrowed Light']), JSON.stringify(before));

  const pageErrorsBeforeSwap = errors.length;
  await page.click('.lv-pick-row:nth-child(2) [data-dir="up"]');
  await page.waitForTimeout(250);
  const swapArgs = swapCalls[0] ? JSON.parse(swapCalls[0]) : null;
  const swappedPositions = swapArgs && [swapArgs.p_pos_a, swapArgs.p_pos_b].sort().join(',') === '1,2';
  r.check('swap_my_pick_positions called with positions 1 and 2', swapCalls.length === 1 && swappedPositions, JSON.stringify(swapArgs));
  r.check('no error/flash thrown by the reorder click', errors.length === pageErrorsBeforeSwap);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();

  // Notes render on the artist page, in position order.
  const page2 = await newPage(browser);
  const errors2 = collectErrors(page2);
  await wireSupabaseStubs(page2, { artistPicks: existingPicks.map((p) => ({ artist_id: F.NOVA_ASH, song_id: p.song_id, note: p.note, position: p.position })) });
  await page2.goto(`http://localhost:${port}/artist/nova-ash`, { waitUntil: 'load' });
  await page2.waitForSelector('.artist-name', { timeout: 10000 });
  await page2.waitForTimeout(500);
  const notes = await page2.evaluate(() => Array.from(document.querySelectorAll('[data-rail="picks"] .pick-note')).map((e) => e.textContent));
  r.check('both notes render on the artist page, in order', notes[0]?.includes('First pick') && notes[1]?.includes('Second pick'), JSON.stringify(notes));
  r.check('no console/page errors (artist page)', errors2.length === 0, errors2.join(' | '));
  await page2.close();
}

async function scenarioBio(browser, port, r) {
  r.section('Bio: save, reload, line breaks render on the artist page');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await signInAs(page, F.SESSION_USERS.NOVA);
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  await gotoSettings(page, port);

  const counterBefore = await page.evaluate(() => document.querySelector('[data-bio-count]')?.textContent);
  r.check('bio counter starts at 0 (no bio set)', counterBefore === '0', counterBefore);

  const bioText = 'Songs about staying up too late.\nWritten in one sitting, mostly.';
  await page.fill('#lv-bio', bioText);
  const counterAfter = await page.evaluate(() => document.querySelector('[data-bio-count]')?.textContent);
  r.check('counter updates live as you type', counterAfter === String(bioText.length), counterAfter);

  let savedPatch = null;
  await page.route(/\/rest\/v1\/artists\?id=eq\./, async (route) => {
    if (route.request().method() === 'PATCH') {
      savedPatch = JSON.parse(route.request().postData() || '{}');
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(F.SELF_ARTIST_ROWS[F.NOVA_ASH]) });
  });
  await page.click('[data-act="save"]');
  await page.waitForTimeout(250);
  r.check('save sends the bio text to artists.update', savedPatch && savedPatch.bio === bioText, JSON.stringify(savedPatch));
  const okShown = await page.evaluate(() => !document.querySelector('[data-ok]')?.hidden);
  r.check('"Saved." confirmation shows', okShown === true);
  await page.close();

  // Rendered with line breaks on the artist page, after a snapshot run would
  // carry it into artists.json -- simulated here by stubbing the live read
  // AND the snapshot with the saved bio already in place.
  const page2 = await newPage(browser);
  const errors2 = collectErrors(page2);
  const novaWithBio = { ...F.ARTISTS_PUBLIC.find((a) => a.id === F.NOVA_ASH), bio: bioText };
  await wireSupabaseStubs(page2, { artistsPublic: [novaWithBio, ...F.ARTISTS_PUBLIC.filter((a) => a.id !== F.NOVA_ASH)] });
  await page2.goto(`http://localhost:${port}/artist/nova-ash`, { waitUntil: 'load' });
  await page2.waitForSelector('.artist-name', { timeout: 10000 });
  const bioHTML = await page2.evaluate(() => document.querySelector('.artist-bio')?.innerHTML);
  r.check('bio renders on the artist page with <br> for the line break', (bioHTML || '').includes('<br>'), bioHTML);
  r.check('no console/page errors', errors.length === 0 && errors2.length === 0, [...errors, ...errors2].join(' | '));
  await page2.close();
}

async function scenarioFollowing(browser, port, r) {
  r.section('Following list + Unfollow');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await signInAs(page, F.SESSION_USERS.NOVA);
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH], artistFollows: F.ARTIST_FOLLOWS_ROWS });
  await gotoSettings(page, port);
  await page.waitForFunction(() => {
    const el = document.getElementById('lv-following-list');
    return el && !/Loading/.test(el.textContent);
  }, { timeout: 10000 });

  const d = await page.evaluate(() => ({
    rows: document.querySelectorAll('.lv-following-row').length,
    name: document.querySelector('.lv-following-name')?.textContent,
    href: document.querySelector('.lv-following-name')?.getAttribute('href'),
  }));
  r.check('Following lists Sable Ridge', d.rows === 1 && d.name === 'Sable Ridge', JSON.stringify(d));
  r.check('links to /artist/sable-ridge', d.href === '/artist/sable-ridge', d.href);

  await page.click('.lv-following-unfollow');
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => ({
    rows: document.querySelectorAll('.lv-following-row').length,
    emptyText: document.getElementById('lv-following-list')?.textContent,
  }));
  r.check('Unfollow removes the row and shows the empty state', after.rows === 0 && /not following anyone yet/.test(after.emptyText || ''), JSON.stringify(after));

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
