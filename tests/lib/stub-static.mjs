/* ============================================================
   Stubs the build-time static snapshot files (songs.json, artists.json,
   channels.json, settings.json) with the committed fixtures, so the
   outage-fallback scenario degrades to KNOWN synthetic data rather than
   whatever happens to be committed in the real repo's songs.json/artists.json
   at the moment the harness runs. Only the outage scenario needs this (every
   other scenario's live Supabase stubs answer first and these files are
   never fetched) but it is harmless to wire everywhere.
   ============================================================ */
import * as F from '../fixtures.mjs';

export async function wireStaticSnapshotStubs(page) {
  const j = (body) => JSON.stringify(body);
  await page.route(/\/songs\.json(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: j(F.SONGS_ROWS) }));
  await page.route(/\/artists\.json(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: j(F.ARTISTS_JSON_ROWS) }));
  await page.route(/\/channels\.json(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: j(F.CHANNELS_ROWS) }));
  await page.route(/\/settings\.json(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: j(F.SITE_SETTINGS_ROWS) }));
  await page.route(/\/chart\.json(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: j({ chart_date: '2026-02-16', entries: [] }) }));
}
