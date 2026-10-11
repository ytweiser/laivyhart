/* ============================================================
   SONG-2 -- "Idea by [name]" on the song page (index.html), under the
   artist line: links to the credited member's profile when the credit
   name exactly matches a real artist (artists_public), plain text
   otherwise, and always plain text for "Anonymous".
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SONG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);

async function gotoSongWithCredit(page, port, idea_credit) {
  const songs = F.SONGS_ROWS.map((s) => (s.id === SONG.id ? { ...s, idea_credit } : s));
  await wireSupabaseStubs(page, { songs });
  await page.goto(`http://localhost:${port}/song/${SONG.slug}`, { waitUntil: 'load' });
  await page.waitForSelector('#now-artist .now-artist-row', { timeout: 10000 });
  await page.waitForTimeout(300);
}

export async function run(browser, port) {
  const r = makeReporter('idea-credit.spec.mjs');
  await scenarioLinksToRealProfile(browser, port, r);
  await scenarioAnonymousNeverLinks(browser, port, r);
  await scenarioNoMatchStaysPlainText(browser, port, r);
  await scenarioHiddenWhenNoCredit(browser, port, r);
  return r;
}

async function scenarioLinksToRealProfile(browser, port, r) {
  r.section('a credit name that exactly matches a real artist links to their profile');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await gotoSongWithCredit(page, port, 'Nova Ash');
  await page.waitForTimeout(250);
  const d = await page.evaluate(() => {
    const el = document.getElementById('now-idea-credit');
    const a = el.querySelector('a');
    return { visible: !el.classList.contains('hidden'), text: el.textContent, href: a && a.getAttribute('href'), linkText: a && a.textContent };
  });
  r.check('the line is visible', d.visible === true);
  r.check('reads "Idea by Nova Ash"', d.text === 'Idea by Nova Ash', d.text);
  r.check('links to /artist/nova-ash', d.href === '/artist/nova-ash', d.href);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioAnonymousNeverLinks(browser, port, r) {
  r.section('"Anonymous" is always plain text, never a link, never even looked up');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  // The page itself already calls artists_public for the song's OWNING
  // artist (attribution line, follow widget) regardless of this feature --
  // so the real check is not "zero calls", it's "never one asking about the
  // credit name specifically" (a display_name filter).
  let displayNameLookups = 0;
  await wireSupabaseStubs(page, { songs: F.SONGS_ROWS.map((s) => (s.id === SONG.id ? { ...s, idea_credit: 'Anonymous' } : s)) }, (name, req) => {
    if (name === 'artistsPublic' && new URL(req.url()).searchParams.has('display_name')) displayNameLookups++;
  });
  await page.goto(`http://localhost:${port}/song/${SONG.slug}`, { waitUntil: 'load' });
  await page.waitForSelector('#now-artist .now-artist-row', { timeout: 10000 });
  await page.waitForTimeout(300);
  const d = await page.evaluate(() => {
    const el = document.getElementById('now-idea-credit');
    return { text: el.textContent, hasLink: !!el.querySelector('a') };
  });
  r.check('reads "Idea by Anonymous"', d.text === 'Idea by Anonymous', d.text);
  r.check('never a link', d.hasLink === false);
  r.check('never looks up a profile by the credit name for "Anonymous"', displayNameLookups === 0, displayNameLookups);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioNoMatchStaysPlainText(browser, port, r) {
  r.section('a custom credit name with no matching profile stays plain text');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await gotoSongWithCredit(page, port, 'A Family Friend');
  await page.waitForTimeout(300);
  const d = await page.evaluate(() => {
    const el = document.getElementById('now-idea-credit');
    return { text: el.textContent, hasLink: !!el.querySelector('a') };
  });
  r.check('reads "Idea by A Family Friend"', d.text === 'Idea by A Family Friend', d.text);
  r.check('stays plain text (no matching profile)', d.hasLink === false);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioHiddenWhenNoCredit(browser, port, r) {
  r.section('a song with no idea credit shows nothing at all');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { songs: F.SONGS_ROWS });
  await page.goto(`http://localhost:${port}/song/${SONG.slug}`, { waitUntil: 'load' });
  await page.waitForSelector('#now-artist .now-artist-row', { timeout: 10000 });
  await page.waitForTimeout(250);
  const hidden = await page.evaluate(() => document.getElementById('now-idea-credit').classList.contains('hidden'));
  r.check('the line is hidden', hidden === true);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
