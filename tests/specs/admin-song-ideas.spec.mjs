/* ============================================================
   SONG-1, the admin "Your Song" tab -- exercised against the real
   admin.html with admin_list_song_ideas/admin_week_picks/
   admin_set_song_idea_status stubbed (lib/stub-supabase.mjs). Covers
   filters, the week counter, the three status actions, the release
   picker, and the Copy button -- not the real database (that is verified
   separately, directly against the live project, in an aborting DO block).
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SONG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);

function ideasFixture() {
  return [
    {
      id: 'idea-1', created_at: new Date(Date.now() - 5 * 60000).toISOString(), status: 'received',
      idea_text: 'A song about staying up all night talking.', credit_name: null, is_anonymous: false,
      show_on_board: true, hearts_count: 2, picked_week: null,
      user_id: F.NOVA_ASH, submitter_name: 'Nova Ash', submitter_email: 'nova@example.test',
      released_song_id: null, released_song_title: null,
    },
    {
      id: 'idea-2', created_at: new Date(Date.now() - 20 * 60000).toISOString(), status: 'received',
      idea_text: 'Something about the first snow of the year, anonymously.', credit_name: 'A Friend', is_anonymous: true,
      show_on_board: true, hearts_count: 9, picked_week: null,
      user_id: F.NOVA_ASH, submitter_name: 'Nova Ash', submitter_email: 'nova@example.test',
      released_song_id: null, released_song_title: null,
    },
    {
      id: 'idea-3', created_at: new Date(Date.now() - 2 * 86400000).toISOString(), status: 'released',
      idea_text: 'An old idea that already became a song.', credit_name: null, is_anonymous: false,
      show_on_board: true, hearts_count: 1, picked_week: '2026-09-27',
      user_id: F.NOVA_ASH, submitter_name: 'Nova Ash', submitter_email: 'nova@example.test',
      released_song_id: SONG.id, released_song_title: SONG.title,
    },
  ];
}

async function openYourSong(browser, port, overrides) {
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { isAdmin: true, adminSongIdeas: ideasFixture(), adminWeekPicks: [], ...overrides });
  await signInAs(page, F.SESSION_USERS.LISTENER);
  await page.goto(`http://localhost:${port}/admin.html`, { waitUntil: 'load' });
  await page.waitForSelector('#songideas-btn', { timeout: 10000, state: 'visible' });
  await page.click('#songideas-btn');
  await page.waitForTimeout(400);
  return { page, errors };
}

export async function run(browser, port) {
  const r = makeReporter('admin-song-ideas.spec.mjs');
  await scenarioListAndFilters(browser, port, r);
  await scenarioWeekCounter(browser, port, r);
  await scenarioPickAndStudio(browser, port, r);
  await scenarioReleasePicker(browser, port, r);
  await scenarioCopyButton(browser, port, r);
  return r;
}

async function scenarioListAndFilters(browser, port, r) {
  r.section('Your Song tab: list renders idea text, submitter, credit, anonymous tag, hearts; filters work');
  const { page, errors } = await openYourSong(browser, port);

  const d = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#si-list .si-item'));
    return items.map((el) => ({
      text: el.querySelector('.si-text')?.textContent,
      meta: el.querySelector('.si-meta')?.textContent,
      anonTag: !!el.querySelector('.si-anon-tag'),
    }));
  });
  r.check('default filter is "received" -- only 2 of the 3 fixture rows show', d.length === 2, d.length);
  r.check('first row shows the full idea text', d[0].text === 'A song about staying up all night talking.', d[0].text);
  r.check('first row shows the submitter name and email', d[0].meta.includes('Nova Ash') && d[0].meta.includes('nova@example.test'), d[0].meta);
  r.check('first row shows hearts count', d[0].meta.includes('2'), d[0].meta);
  r.check('non-anonymous row has no anonymous tag', d[0].anonTag === false);
  r.check('the anonymous idea is tagged, even though the admin sees the real submitter', d[1].anonTag === true);
  r.check('the anonymous idea shows its chosen credit name', d[1].meta.includes('A Friend'), d[1].meta);

  await page.click('#si-filters [data-status="released"]');
  await page.waitForTimeout(300);
  const releasedView = await page.evaluate(() => Array.from(document.querySelectorAll('#si-list .si-item')).map((el) => el.querySelector('.si-meta')?.textContent));
  r.check('"Released" filter shows only the released row, with the song title', releasedView.length === 1 && releasedView[0].includes(SONG.title), releasedView);

  await page.click('#si-filters [data-status=""]');
  await page.waitForTimeout(300);
  const allCount = await page.evaluate(() => document.querySelectorAll('#si-list .si-item').length);
  r.check('"All" filter shows all 3 fixture rows', allCount === 3, allCount);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioWeekCounter(browser, port, r) {
  r.section('Your Song tab: the week-picks header counts, with a gentle warning past 3, not a block');
  const { page, errors } = await openYourSong(browser, port, {
    adminWeekPicks: [{ id: 'p1' }, { id: 'p2' }],
  });
  const under = await page.evaluate(() => ({
    text: document.getElementById('si-week-count')?.textContent,
    isOver: document.getElementById('si-week-count')?.classList.contains('is-over'),
  }));
  r.check('shows "2 of 3" and no warning class under the cap', under.text.includes('2') && under.text.includes('3') && under.isOver === false, under);
  await page.close();

  const { page: page2, errors: errors2 } = await openYourSong(browser, port, {
    adminWeekPicks: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }],
  });
  const over = await page2.evaluate(() => ({
    text: document.getElementById('si-week-count')?.textContent,
    isOver: document.getElementById('si-week-count')?.classList.contains('is-over'),
  }));
  r.check('past 3, a gentle warning shows (not a block -- the tab still renders and works)', over.text.includes('4') && over.isOver === true, over);
  r.check('no console/page errors', errors.length === 0 && errors2.length === 0, [...errors, ...errors2].join(' | '));
  await page2.close();
}

async function scenarioPickAndStudio(browser, port, r) {
  r.section('Your Song tab: Pick, In the studio and Not this week move an idea between filters');
  const { page, errors } = await openYourSong(browser, port);

  await page.click('#si-list .si-item:nth-of-type(1) [data-si-pick]');
  await page.waitForTimeout(300);
  const afterPick = await page.evaluate(() => document.querySelectorAll('#si-list .si-item').length);
  r.check('picking an idea drops it out of the "Received" filter', afterPick === 1, afterPick);

  await page.click('#si-filters [data-status="picked"]');
  await page.waitForTimeout(300);
  const pickedRow = await page.evaluate(() => document.querySelector('#si-list .si-item .si-status-tag')?.textContent);
  r.check('it now shows up under "Picked"', pickedRow === 'Picked', pickedRow);

  await page.click('#si-list .si-item [data-si-studio]');
  await page.waitForTimeout(300);
  await page.click('#si-filters [data-status="in_studio"]');
  await page.waitForTimeout(300);
  const studioRow = await page.evaluate(() => document.querySelector('#si-list .si-item .si-status-tag')?.textContent);
  r.check('"In the studio" moves it to that status', studioRow === 'In the studio', studioRow);

  await page.click('#si-list .si-item [data-si-notpicked]');
  await page.waitForTimeout(300);
  await page.click('#si-filters [data-status="not_picked"]');
  await page.waitForTimeout(300);
  const notPickedRow = await page.evaluate(() => document.querySelector('#si-list .si-item .si-status-tag')?.textContent);
  r.check('"Not this week" moves it to that status', notPickedRow === 'Not picked', notPickedRow);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioReleasePicker(browser, port, r) {
  r.section('Your Song tab: Released swaps in a song picker; confirming sends the chosen song');
  const { page, errors } = await openYourSong(browser, port);

  await page.click('#si-list .si-item:nth-of-type(1) [data-si-release]');
  await page.waitForTimeout(200);
  const pickerOptions = await page.evaluate(() => Array.from(document.querySelectorAll('#si-list .si-item:nth-of-type(1) [data-si-release-select] option')).map((o) => o.textContent));
  r.check('the picker lists approved songs, including the fixture song', pickerOptions.some((t) => t.includes(SONG.title)), pickerOptions);

  // Confirming with nothing chosen is refused, not silently accepted.
  await page.evaluate(() => { window.__alerts = []; window.alert = (m) => window.__alerts.push(m); });
  await page.click('#si-list .si-item:nth-of-type(1) [data-si-release-confirm]');
  await page.waitForTimeout(200);
  const noChoice = await page.evaluate(() => window.__alerts.length);
  r.check('confirming with no song chosen is refused', noChoice === 1);

  await page.selectOption('#si-list .si-item:nth-of-type(1) [data-si-release-select]', SONG.id);
  await page.click('#si-list .si-item:nth-of-type(1) [data-si-release-confirm]');
  await page.waitForTimeout(300);

  await page.click('#si-filters [data-status="released"]');
  await page.waitForTimeout(300);
  const released = await page.evaluate(() => document.querySelectorAll('#si-list .si-item').length);
  r.check('the idea now shows up under "Released" (2 total: the fixture one plus this one)', released === 2, released);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioCopyButton(browser, port, r) {
  r.section('Your Song tab: Copy copies the full idea text');
  const { page, errors } = await openYourSong(browser, port);
  const origin = `http://localhost:${port}`;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });

  await page.click('#si-list .si-item:nth-of-type(1) [data-si-copy]');
  await page.waitForTimeout(200);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  r.check('Copy puts the idea text on the clipboard', copied === 'A song about staying up all night talking.', copied);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
