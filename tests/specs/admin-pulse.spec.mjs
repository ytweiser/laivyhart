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
const PULSE_FEED = [
  {
    id: 1, created_at: new Date(Date.now() - 2 * 60000).toISOString(), event_type: 'play_start',
    song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug,
    user_id: null, display_name: 'Visitor', email: null,
    device_id: VISITOR_DEVICE, device_short: VISITOR_DEVICE.slice(0, 8),
    city: 'Haifa', region: null, country: 'IL', page: null, meta: {},
  },
  {
    id: 2, created_at: new Date(Date.now() - 5 * 60000).toISOString(), event_type: 'heart',
    song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug,
    user_id: F.NOVA_ASH, display_name: 'Nova Ash', email: 'nova@example.test',
    device_id: 'dev-nova-bbbb2222', device_short: 'dev-nova',
    city: 'Atlanta', region: null, country: 'US', page: null, meta: {},
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
  events: [{ id: 9, created_at: new Date().toISOString(), event_type: 'play_start', song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug, city: 'Atlanta', region: null, country: 'US', page: null, meta: {} }],
};
const PULSE_VISITOR = {
  device_id: VISITOR_DEVICE, display_name: 'Visitor',
  totals: { plays: 4, completes: 1, hearts: 0 },
  events: [{ id: 10, created_at: new Date().toISOString(), event_type: 'play_start', song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug, city: 'Haifa', region: null, country: 'IL', page: null, meta: {} }],
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
  await page.waitForTimeout(400);
  return { page, errors };
}

export async function run(browser, port) {
  const r = makeReporter('admin-pulse.spec.mjs');
  await scenarioOverview(browser, port, r);
  await scenarioSongDrilldown(browser, port, r);
  await scenarioMemberDrilldown(browser, port, r);
  await scenarioVisitorDrilldown(browser, port, r);
  return r;
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
  await page.waitForTimeout(300);
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
  await page.waitForTimeout(300);
  const backAt = await page.evaluate(() => !!document.getElementById('pulse-tiles'));
  r.check('back link returns to the Pulse overview', backAt === true);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioMemberDrilldown(browser, port, r) {
  r.section('clicking a member opens their history (pulse_member by user_id)');
  const { page, errors } = await openAdminPulse(browser, port);
  await page.click('#pulse-top-listeners .pll-name[data-pulse-open="member"]');
  await page.waitForTimeout(300);
  const d = await page.evaluate(() => document.getElementById('pulse-member-body')?.textContent || '');
  r.check('shows the member\'s name and email', d.includes('Nova Ash') && d.includes('nova@example.test'), d);
  r.check('shows their totals', d.includes('6') && d.includes('3'), d); // plays, completes from the fixture
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioVisitorDrilldown(browser, port, r) {
  r.section('clicking a visitor opens their device history (pulse_member by device_id)');
  const { page, errors } = await openAdminPulse(browser, port, { pulseMember: PULSE_VISITOR });
  await page.click('#pulse-top-listeners .pll-name[data-pulse-open="visitor"]');
  await page.waitForTimeout(300);
  const d = await page.evaluate(() => document.getElementById('pulse-member-body')?.textContent || '');
  r.check('shows "Visitor" (no name, no email, no device id leaked into the heading)', d.includes('Visitor') && !d.includes('nova@example.test'), d);
  r.check('shows their play count', d.includes('4'), d);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
