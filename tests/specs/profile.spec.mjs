/* ============================================================
   PROFILE-1 -- /u/<handle>, the member profile page every member (not only
   an artist) gets. Client-rendered from member_profile(), stubbed via
   memberProfiles. The server-rendered OG/noindex side of this same route
   is covered in middleware.spec.mjs, not duplicated here.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

export async function run(browser, port) {
  const r = makeReporter('profile.spec.mjs');
  await scenarioPublicProfileSignedOut(browser, port, r);
  await scenarioPrivateProfile(browser, port, r);
  await scenarioShowFollowingOff(browser, port, r);
  await scenarioDedicationsNeverAnonymous(browser, port, r);
  await scenarioBannedWordBioRefused(browser, port, r);
  await scenarioOwnProfileEditButton(browser, port, r);
  await scenarioArtistHandleRedirects(browser, port, r);
  await scenarioUnknownHandle(browser, port, r);
  return r;
}

async function gotoMember(page, port, handle) {
  await page.goto(`http://localhost:${port}/u/${handle}`, { waitUntil: 'load' });
  await page.waitForSelector(
    '#member-root .artist-name, #member-root .artist-missing h1, #artist-root .artist-name',
    { timeout: 10000 },
  );
}

const RICH_PROFILE = {
  handle: 'listener1', is_artist: false, profile_public: true, is_self: false,
  display_name: 'Dana Listener', bio: 'I love a good chorus.',
  avatar_url: null, created_at: '2026-02-01T00:00:00Z',
  stats: { comments: 3, dedications_sent: 1, ideas_made_into_songs: 1 },
  favorites: [
    { song_id: 'song-1', title: 'Supernova', slug: 'supernova-a000', cover_url: null, note: 'My favorite chorus.' },
  ],
  comments: [
    { song_title: 'Supernova', song_slug: 'supernova-a000', body: 'This one gets me every time.', created_at: '2026-02-02T00:00:00Z' },
  ],
  dedications: [
    { code: 'ABCD2345', song_title: 'Supernova', song_slug: 'supernova-a000', created_at: '2026-02-03T00:00:00Z' },
  ],
  ideas: [
    { idea_text: 'A song about the first snow', hearts_count: 4, status: 'released', released_song_title: 'Supernova', released_song_slug: 'supernova-a000' },
  ],
  show_following: true,
  following: [{ handle: 'nova-ash', display_name: 'Nova Ash', avatar_url: null }],
};

async function scenarioPublicProfileSignedOut(browser, port, r) {
  r.section('a public profile renders every section, signed out');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { memberProfiles: { listener1: RICH_PROFILE } });
  await gotoMember(page, port, 'listener1');

  const d = await page.evaluate(() => ({
    name: document.querySelector('#member-root .artist-name')?.textContent,
    handle: document.querySelector('#member-root .artist-handle')?.textContent,
    bio: document.querySelector('#member-root .artist-bio')?.textContent,
    since: document.querySelector('#member-root .member-since')?.textContent,
    stats: Array.from(document.querySelectorAll('#member-root .stat-tile')).map((t) => t.textContent),
    favoritesLink: document.querySelector('#member-root .member-row-song')?.getAttribute('href'),
    commentLink: document.querySelectorAll('#member-root .member-section')[1]?.querySelector('a')?.getAttribute('href'),
    dedicationLink: document.querySelectorAll('#member-root .member-section')[2]?.querySelector('a')?.getAttribute('href'),
    ideaBadge: document.querySelector('#member-root .member-row-meta a')?.textContent,
    followingLink: document.querySelector('#member-root .member-row-artist')?.getAttribute('href'),
    editBtn: !!document.querySelector('#member-root .artist-actions'),
  }));
  r.check('display name in the header', d.name === 'Dana Listener', d.name);
  r.check('@handle shown', d.handle === '@listener1', d.handle);
  r.check('bio shown', d.bio === 'I love a good chorus.', d.bio);
  r.check('"Member since" line', /Member since February 2026/.test(d.since || ''), d.since);
  r.check('stats strip has the three non-zero tiles', d.stats.length === 3, JSON.stringify(d.stats));
  r.check('favorites link to the song', d.favoritesLink === '/song/supernova-a000', d.favoritesLink);
  r.check('recent comment links to the song', d.commentLink === '/song/supernova-a000', d.commentLink);
  r.check('dedication sent links to /d/<code>', d.dedicationLink === '/d/ABCD2345', d.dedicationLink);
  r.check('a released idea says "Made into a song"', d.ideaBadge === 'Made into a song', d.ideaBadge);
  r.check('following links to the artist page', d.followingLink === '/artist/nova-ash', d.followingLink);
  r.check('no Edit profile button for a visitor', d.editBtn === false);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioPrivateProfile(browser, port, r) {
  r.section('a private profile shows only the avatar and display name');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, {
    memberProfiles: {
      private1: {
        handle: 'private1', is_artist: false, profile_public: false, is_self: false,
        display_name: 'Private Person', avatar_url: null,
      },
    },
  });
  await gotoMember(page, port, 'private1');

  const d = await page.evaluate(() => ({
    name: document.querySelector('#member-root .artist-name')?.textContent,
    privateLine: document.querySelector('#member-root .artist-bio')?.textContent,
    hasStats: !!document.querySelector('#member-root .artist-stat-strip'),
    hasAnySection: !!document.querySelector('#member-root .member-section'),
  }));
  r.check('shows the display name', d.name === 'Private Person', d.name);
  r.check('"This profile is private."', d.privateLine === 'This profile is private.', d.privateLine);
  r.check('no stats strip', d.hasStats === false);
  r.check('no other section renders', d.hasAnySection === false);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioShowFollowingOff(browser, port, r) {
  r.section('show_following off hides the Following section');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, {
    memberProfiles: {
      listener2: {
        ...RICH_PROFILE, handle: 'listener2', show_following: false, following: [],
      },
    },
  });
  await gotoMember(page, port, 'listener2');

  const headings = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#member-root .member-section h2')).map((h) => h.textContent));
  r.check('no "Following" heading when the toggle is off', !headings.includes('Following'), JSON.stringify(headings));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioDedicationsNeverAnonymous(browser, port, r) {
  r.section('an anonymous dedication is never counted or shown (member_profile itself already excludes it)');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  // member_profile()'s own query filters `is_anonymous = false` server-side
  // (029_member_profiles.sql) -- an anonymous dedication never reaches this
  // array in the first place, so an empty list here is what that filtering
  // actually looks like from the client's side.
  await wireSupabaseStubs(page, {
    memberProfiles: { listener3: { ...RICH_PROFILE, handle: 'listener3', dedications: [], stats: { ...RICH_PROFILE.stats, dedications_sent: 0 } } },
  });
  await gotoMember(page, port, 'listener3');

  const d = await page.evaluate(() => ({
    headings: Array.from(document.querySelectorAll('#member-root .member-section h2')).map((h) => h.textContent),
    statLabels: Array.from(document.querySelectorAll('#member-root .stat-tile-k')).map((t) => t.textContent),
  }));
  r.check('no "Dedications sent" section when there are none to show', !d.headings.includes('Dedications sent'), JSON.stringify(d.headings));
  r.check('the dedications-sent tile is hidden at 0', !d.statLabels.includes('Dedications sent'), JSON.stringify(d.statLabels));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioBannedWordBioRefused(browser, port, r) {
  r.section('a banned word in the bio is refused, not saved');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await signInAs(page, F.SESSION_USERS.NOVA);
  await wireSupabaseStubs(page, {
    selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH],
    updateMyProfileResult: { status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'That wording is not allowed here. Please rephrase it.', code: 'P0001' }) },
  });
  await page.goto(`http://localhost:${port}/settings`, { waitUntil: 'load' });
  await page.waitForSelector('.lv-settings', { timeout: 10000 });
  await page.fill('#lv-bio', 'some banned wording here');
  await page.click('[data-act="save"]');
  await page.waitForFunction(() => {
    const err = document.querySelector('[data-err]');
    return err && !err.hidden && err.textContent.length > 0;
  }, { timeout: 10000 });

  const d = await page.evaluate(() => ({
    err: document.querySelector('[data-err]')?.textContent,
    okShown: !document.querySelector('[data-ok]')?.hidden,
  }));
  r.check('the server\'s own rejection message is shown inline', d.err === 'That wording is not allowed here. Please rephrase it.', d.err);
  r.check('never shows "Saved." on a refusal', d.okShown === false);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioOwnProfileEditButton(browser, port, r) {
  r.section('your own profile shows an Edit profile button, even if private');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await signInAs(page, F.SESSION_USERS.LISTENER);
  await wireSupabaseStubs(page, {
    memberProfiles: {
      me1: { ...RICH_PROFILE, handle: 'me1', is_self: true, profile_public: false },
    },
  });
  await gotoMember(page, port, 'me1');

  const d = await page.evaluate(() => ({
    editHref: document.querySelector('#member-root .artist-actions a')?.getAttribute('href'),
    // is_self sees everything regardless of profile_public (item 12) -- the
    // private-only branch never applies to your own view.
    hasStats: !!document.querySelector('#member-root .artist-stat-strip'),
  }));
  r.check('"Edit profile" links to /settings', d.editHref === '/settings', d.editHref);
  r.check('your own view still sees the full page even when profile_public is false', d.hasStats === true);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioArtistHandleRedirects(browser, port, r) {
  r.section('an artist\'s own handle redirects to /artist/<handle>');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, {
    memberProfiles: { 'nova-ash': { handle: 'nova-ash', is_artist: true } },
  });
  await gotoMember(page, port, 'nova-ash');
  await page.waitForFunction(() => location.pathname === '/artist/nova-ash', { timeout: 10000 });

  const d = await page.evaluate(() => ({
    pathname: location.pathname,
    name: document.querySelector('#artist-root .artist-name')?.textContent,
    memberHidden: document.getElementById('member-root')?.classList.contains('hidden'),
  }));
  r.check('navigates to the artist\'s own page', d.pathname === '/artist/nova-ash', d.pathname);
  r.check('the artist page actually renders', d.name === 'Nova Ash', d.name);
  r.check('the member route is no longer showing', d.memberHidden === true);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioUnknownHandle(browser, port, r) {
  r.section('an unknown handle shows "Member not found", not a crash');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { memberProfiles: {} });
  await gotoMember(page, port, 'does-not-exist');

  const text = await page.evaluate(() => document.querySelector('#member-root .artist-missing h1')?.textContent);
  r.check('"Member not found"', text === 'Member not found', text);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
