/* ============================================================
   ACT-2, Part B -- the admin Pulse tab, exercised against the real
   admin.html with every pulse_* RPC stubbed (lib/stub-supabase.mjs).
   Covers tiles/feed/top-lists rendering, and the song/member/visitor
   drilldowns, from fixture data -- not the real database (that is verified
   separately, directly against the live project, in an aborting DO block).
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SONG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);
const VISITOR_DEVICE = 'dev-visitor-aaaa1111';

const PULSE_SUMMARY = {
  listeners: 12, members_active: 4, new_members: 2, plays: 20, completes: 8, completion_rate: 40.0,
  hearts: 5, ratings: 3, comments: 2, follows: 1, shares: 1, searches: 2,
  top_songs: [{ song_id: SONG.id, title: SONG.title, slug: SONG.slug, plays: 10, completes: 4, completion_rate: 40.0 }],
  top_cities: [{ city: 'Atlanta', n: 7 }, { city: 'Haifa', n: 5 }],
};
// PULSE-2: pulse_feed now returns one row per LISTEN (a play_start plus
// whatever progress followed it, folded into furthest_pct), not one row
// per raw event -- play_25/50/75/play_complete never arrive as their own
// rows at all. Two separate listens of the same song (ids 1 and 3) are two
// distinct rows, each with its own furthest_pct, exactly as two actual
// plays would come back from the real pulse_feed().
const PULSE_FEED = [
  {
    id: 1, created_at: new Date(Date.now() - 2 * 60000).toISOString(), event_type: 'play_start',
    song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug,
    user_id: null, display_name: 'Visitor', email: null,
    device_id: VISITOR_DEVICE, device_short: VISITOR_DEVICE.slice(0, 8),
    city: 'Haifa', region: null, country: 'IL', page: null, meta: {}, furthest_pct: 100,
  },
  {
    id: 2, created_at: new Date(Date.now() - 5 * 60000).toISOString(), event_type: 'heart',
    song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug,
    user_id: F.NOVA_ASH, display_name: 'Nova Ash', email: 'nova@example.test',
    device_id: 'dev-nova-bbbb2222', device_short: 'dev-nova',
    city: 'Atlanta', region: null, country: 'US', page: null, meta: {}, furthest_pct: null,
  },
  {
    id: 3, created_at: new Date(Date.now() - 20 * 60000).toISOString(), event_type: 'play_start',
    song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug,
    user_id: null, display_name: 'Visitor', email: null,
    device_id: VISITOR_DEVICE, device_short: VISITOR_DEVICE.slice(0, 8),
    city: 'Haifa', region: null, country: 'IL', page: null, meta: {}, furthest_pct: 50,
  },
];
const PULSE_TOP_LISTENERS = [
  { kind: 'member', user_id: F.NOVA_ASH, device_id: null, display_name: 'Nova Ash', plays: 6, completes: 3, hearts: 2, last_city: 'Atlanta', last_seen: new Date().toISOString() },
  { kind: 'visitor', user_id: null, device_id: VISITOR_DEVICE, display_name: 'Visitor', plays: 4, completes: 1, hearts: 0, last_city: 'Haifa', last_seen: new Date().toISOString() },
];
const PULSE_RETENTION = [
  { week_start: '2026-09-21', new_devices: 10, devices_retained_next_week: 3, device_retention_pct: 30.0, new_members: 4, members_retained_next_week: 2, member_retention_pct: 50.0 },
];
const PULSE_SONG = {
  song_id: SONG.id,
  funnel: { start: 10, p25: 8, p50: 6, p75: 4, complete: 3 },
  hearts: 5, ratings: 2,
  cities: [{ city: 'Atlanta', n: 6 }, { city: 'Haifa', n: 4 }],
  listeners: { members: [{ user_id: F.NOVA_ASH, display_name: 'Nova Ash' }], visitor_count: 3 },
};
const PULSE_MEMBER = {
  user_id: F.NOVA_ASH, display_name: 'Nova Ash', email: 'nova@example.test',
  totals: { plays: 6, completes: 3, hearts: 2, ratings: 1, comments: 0, follows: 0 },
  events: [{ id: 9, created_at: new Date().toISOString(), event_type: 'play_start', song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug, city: 'Atlanta', region: null, country: 'US', page: null, meta: {}, furthest_pct: 100 }],
};
const PULSE_VISITOR = {
  device_id: VISITOR_DEVICE, display_name: 'Visitor',
  totals: { plays: 4, completes: 1, hearts: 0 },
  events: [{ id: 10, created_at: new Date().toISOString(), event_type: 'play_start', song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug, city: 'Haifa', region: null, country: 'IL', page: null, meta: {}, furthest_pct: 50 }],
};

async function openAdminPulse(browser, port, overrides) {
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, {
    isAdmin: true,
    pulseSummary: PULSE_SUMMARY, pulseFeed: PULSE_FEED, pulseTopListeners: PULSE_TOP_LISTENERS,
    pulseRetention: PULSE_RETENTION, pulseSong: PULSE_SONG, pulseMember: PULSE_MEMBER,
    ...overrides,
  });
  await signInAs(page, F.SESSION_USERS.LISTENER);
  await page.goto(`http://localhost:${port}/admin.html`, { waitUntil: 'load' });
  await page.waitForSelector('#pulse-btn', { timeout: 10000, state: 'visible' });
  await page.click('#pulse-btn');
  await page.waitForSelector('#pulse-tiles .pulse-tile', { timeout: 10000 });
  return { page, errors };
}

export async function run(browser, port) {
  const r = makeReporter('admin-pulse.spec.mjs');
  await scenarioProgressLabel(browser, port, r);
  await scenarioOverview(browser, port, r);
  await scenarioSongDrilldown(browser, port, r);
  await scenarioMemberDrilldown(browser, port, r);
  await scenarioVisitorDrilldown(browser, port, r);
  return r;
}

async function scenarioProgressLabel(browser, port, r) {
  r.section('PULSE-2: pulseProgressLabel/pulseFeedVerbHTML, every branch');
  const { page, errors } = await openAdminPulse(browser, port);
  const d = await page.evaluate(() => ({
    p100: pulseProgressLabel(100),
    p75: pulseProgressLabel(75),
    p50: pulseProgressLabel(50),
    p25: pulseProgressLabel(25),
    pNull: pulseProgressLabel(null),
    pUndefined: pulseProgressLabel(undefined),
    pLow: pulseProgressLabel(10),
    verbPlay: pulseFeedVerbHTML({ event_type: 'play_start', furthest_pct: 75 }),
    verbHeart: pulseFeedVerbHTML({ event_type: 'heart', furthest_pct: null }),
  }));
  r.check('100 -> "finished"', d.p100 === 'finished', d.p100);
  r.check('75 -> "listened to 75%"', d.p75 === 'listened to 75%', d.p75);
  r.check('50 -> "listened to 50%"', d.p50 === 'listened to 50%', d.p50);
  r.check('25 -> "listened to 25%"', d.p25 === 'listened to 25%', d.p25);
  r.check('null -> "started" (less than 25%)', d.pNull === 'started', d.pNull);
  r.check('undefined -> "started"', d.pUndefined === 'started', d.pUndefined);
  r.check('under 25 (10) -> "started"', d.pLow === 'started', d.pLow);
  r.check('a play_start gets the verb plus the progress clause', d.verbPlay === 'played &middot; listened to 75%', d.verbPlay);
  r.check('a non-play event (heart) gets only its own verb, no progress clause', d.verbHeart === 'hearted', d.verbHeart);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioOverview(browser, port, r) {
  r.section('Pulse overview: tiles, feed lines, top lists, retention');
  const { page, errors } = await openAdminPulse(browser, port);

  const d = await page.evaluate(() => ({
    tileCount: document.querySelectorAll('#pulse-tiles .pulse-tile').length,
    firstTileN: document.querySelector('#pulse-tiles .pulse-tile-n')?.textContent,
    feedText: document.getElementById('pulse-feed-list')?.textContent || '',
    topSongsText: document.getElementById('pulse-top-songs')?.textContent || '',
    topListenersText: document.getElementById('pulse-top-listeners')?.textContent || '',
    topCitiesText: document.getElementById('pulse-top-cities')?.textContent || '',
    retentionRows: document.querySelectorAll('#pulse-retention tbody tr').length,
  }));
  r.check('11 summary tiles render', d.tileCount === 11, d.tileCount);
  r.check('first tile shows the listeners number', d.firstTileN === '12', d.firstTileN);
  r.check('feed line reads like "Visitor in Haifa, IL played Supernova"', /Visitor/.test(d.feedText) && /Haifa, IL/.test(d.feedText) && new RegExp(SONG.title).test(d.feedText), d.feedText);
  r.check('feed line for the member shows their name, not "Visitor"', /Nova Ash/.test(d.feedText) && /hearted/.test(d.feedText), d.feedText);
  // PULSE-2: one line per listen, "finished"/"listened to N%", never the
  // old "kept listening to" text, and two separate listens of the same
  // song render as two distinct lines, not merged into one.
  r.check('a listen that reached 100% reads "finished", not "kept listening"', /finished/.test(d.feedText), d.feedText);
  r.check('a listen that reached 50% reads "listened to 50%"', /listened to 50%/.test(d.feedText), d.feedText);
  r.check('"kept listening to" never appears anywhere in the feed', !/kept listening/.test(d.feedText), d.feedText);
  const feedLineCount = await page.evaluate(() => document.querySelectorAll('#pulse-feed-list .pulse-feed-item').length);
  r.check('two separate listens of the same song render as two distinct lines (3 fixture rows, 3 lines)', feedLineCount === 3, feedLineCount);
  r.check('top songs lists the song with its completion rate', d.topSongsText.includes(SONG.title) && d.topSongsText.includes('40'), d.topSongsText);
  r.check('top listeners lists both the member and the visitor', /Nova Ash/.test(d.topListenersText) && /Visitor/.test(d.topListenersText), d.topListenersText);
  r.check('top cities lists Atlanta and Haifa', /Atlanta/.test(d.topCitiesText) && /Haifa/.test(d.topCitiesText), d.topCitiesText);
  r.check('retention table has one row', d.retentionRows === 1, d.retentionRows);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioSongDrilldown(browser, port, r) {
  r.section('clicking a song opens its drilldown (pulse_song)');
  const { page, errors } = await openAdminPulse(browser, port);
  await page.click('#pulse-top-songs .pll-name');
  await page.waitForSelector('.pulse-funnel', { timeout: 10000 });
  const d = await page.evaluate(() => ({
    hasFunnel: !!document.querySelector('.pulse-funnel'),
    bodyText: document.getElementById('pulse-song-body')?.textContent || '',
    hasBack: !!document.getElementById('pulse-back'),
  }));
  r.check('funnel renders', d.hasFunnel === true);
  r.check('funnel shows the start/complete counts', d.bodyText.includes('10') && d.bodyText.includes('3'), d.bodyText);
  r.check('shows the member who listened', d.bodyText.includes('Nova Ash'), d.bodyText);
  r.check('has a back link to Pulse', d.hasBack === true);

  // Back goes to the overview, not a dead end.
  await page.click('#pulse-back');
  await page.waitForSelector('#pulse-tiles .pulse-tile', { timeout: 10000 });
  const backAt = await page.evaluate(() => !!document.getElementById('pulse-tiles'));
  r.check('back link returns to the Pulse overview', backAt === true);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioMemberDrilldown(browser, port, r) {
  r.section('clicking a member opens their history (pulse_member by user_id)');
  const { page, errors } = await openAdminPulse(browser, port);
  await page.click('#pulse-top-listeners .pll-name[data-pulse-open="member"]');
  // Not just "any non-empty text" -- the "Loading..." placeholder already
  // satisfies that before the real data arrives. Wait for an actual tile.
  await page.waitForSelector('#pulse-member-body .pulse-tile', { timeout: 10000 });
  const d = await page.evaluate(() => document.getElementById('pulse-member-body')?.textContent || '');
  r.check('shows the member\'s name and email', d.includes('Nova Ash') && d.includes('nova@example.test'), d);
  r.check('shows their totals', d.includes('6') && d.includes('3'), d); // plays, completes from the fixture
  // PULSE-2: the history list is the same "one row per listen" grouping,
  // so this history line also reads "finished", not "kept listening".
  r.check('history shows "finished" for a listen that reached 100%, same as the live feed', /finished/.test(d), d);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioVisitorDrilldown(browser, port, r) {
  r.section('clicking a visitor opens their device history (pulse_member by device_id)');
  const { page, errors } = await openAdminPulse(browser, port, { pulseMember: PULSE_VISITOR });
  await page.click('#pulse-top-listeners .pll-name[data-pulse-open="visitor"]');
  await page.waitForSelector('#pulse-member-body .pulse-tile', { timeout: 10000 });
  const d = await page.evaluate(() => document.getElementById('pulse-member-body')?.textContent || '');
  r.check('shows "Visitor" (no name, no email, no device id leaked into the heading)', d.includes('Visitor') && !d.includes('nova@example.test'), d);
  r.check('shows their play count', d.includes('4'), d);
  r.check('history shows "listened to 50%" for that visitor\'s listen', /listened to 50%/.test(d), d);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
