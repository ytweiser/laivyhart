/* ============================================================
   ARTIST-3 Part 2: artist search in the existing search box.

   The prompt's own verification step names "laivy"/"Laivy Hart"/"laivyhart"
   as example queries -- those are the REAL site's artist, not reachable from
   this harness's synthetic fixtures. Exercised here with the equivalent
   fictional queries ("nova"/"Nova Ash"/"nova-ash") against the identical
   matching code (normalizeForSearch + matchingArtists), which is what
   actually needs verifying.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { makeReporter } from '../lib/report.mjs';

export async function run(browser, port) {
  const r = makeReporter('search.spec.mjs');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);

  await page.goto(`http://localhost:${port}/listen`, { waitUntil: 'load' });
  await page.waitForSelector('#search', { timeout: 10000 });

  const placeholder = await page.getAttribute('#search', 'placeholder');
  r.check('placeholder updated', placeholder === 'Search songs, artists, lyrics, tags', placeholder);

  // renderList() runs synchronously off the search box's own 'input' event
  // (only the analytics ping is debounced, 600ms, and never affects the
  // DOM) -- so waiting for the input's value to actually land is the real
  // condition, not a guess at how long rendering takes.
  async function searchFor(q) {
    await page.fill('#search', '');
    await page.fill('#search', q);
    await page.waitForFunction((want) => document.getElementById('search').value === want, q, { timeout: 5000 });
    return page.evaluate(() => ({
      groupPresent: !!document.querySelector('.search-artists'),
      names: Array.from(document.querySelectorAll('.search-artist-name')).map((e) => e.textContent),
      handles: Array.from(document.querySelectorAll('.search-artist-handle')).map((e) => e.textContent),
    }));
  }

  for (const q of ['nova', 'Nova Ash', 'nova-ash']) {
    const d = await searchFor(q);
    r.check(`"${q}" surfaces the Nova Ash artist result`, d.groupPresent && d.names.includes('Nova Ash'), JSON.stringify(d));
  }

  const songOnly = await searchFor('Supernova');
  r.check('a song-title query shows no Artists group', songOnly.groupPresent === false, JSON.stringify(songOnly));

  // Artist result links to the right page and is above the song rows.
  await page.fill('#search', '');
  await page.fill('#search', 'nova');
  await page.waitForFunction(() => document.getElementById('search').value === 'nova', null, { timeout: 5000 });
  const order = await page.evaluate(() => {
    const rows = document.getElementById('rows');
    const group = rows.querySelector('.search-artists');
    const firstRow = rows.querySelector('.row');
    if (!group || !firstRow) return null;
    return group.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING ? 'group-first' : 'row-first';
  });
  r.check('Artists group renders above the song rows', order === 'group-first', order);
  const href = await page.getAttribute('.search-artist-item', 'href');
  r.check('artist result links to /artist/nova-ash', href === '/artist/nova-ash', href);

  // Works with the live read stubbed to fail (falls back to artists.json).
  await page.close();
  const page2 = await newPage(browser);
  const errors2 = collectErrors(page2);
  // Playwright tries the MOST RECENTLY registered matching route first, so
  // the broad stub has to go on BEFORE this specific override, not after --
  // otherwise the broad handler (registered second) would win and this
  // never actually simulates a failure.
  await wireSupabaseStubs(page2);
  await page2.route(/\/rest\/v1\/artists_public/, (route) => route.fulfill({ status: 402, contentType: 'application/json', body: '{"message":"down"}' }));
  const { wireStaticSnapshotStubs } = await import('../lib/stub-static.mjs');
  await wireStaticSnapshotStubs(page2);
  await page2.goto(`http://localhost:${port}/listen`, { waitUntil: 'load' });
  await page2.waitForSelector('#search', { timeout: 10000 });
  await page2.fill('#search', 'nova');
  // The fallback read (artists.json, since the live query is stubbed to
  // fail) is the thing actually worth waiting on here, not just the input
  // event -- wait for the real result the check below expects.
  await page2.waitForFunction(
    () => Array.from(document.querySelectorAll('.search-artist-name')).some((e) => e.textContent === 'Nova Ash'),
    null, { timeout: 5000 },
  ).catch(() => {}); // let the check below fail with a clear message if it never shows up
  const fallback = await page2.evaluate(() => Array.from(document.querySelectorAll('.search-artist-name')).map((e) => e.textContent));
  r.check('search works from artists.json when the live read fails', fallback.includes('Nova Ash'), JSON.stringify(fallback));
  r.check('no console/page errors (fallback case)', errors2.length === 0, errors2.join(' | '));

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page2.close();
  return r;
}
