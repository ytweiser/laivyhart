/* ============================================================
   middleware.js (Vercel Edge Middleware) -- tested directly in Node against
   `decide()`, no browser involved. Exercises the real middleware.js file,
   pointed at the committed synthetic fixtures via two small generated
   shims (Node 22 requires an explicit `with { type: 'json' }` attribute for
   a static JSON import that this repo's own bundler target does not need,
   so the shims add just that -- no logic is changed).
   ============================================================ */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEBREW_RE = /[֐-׿]/;

export async function run() {
  const r = makeReporter('middleware.spec.mjs');
  const scratch = mkdtempSync(join(tmpdir(), 'laivy-mw-test-'));
  try {
    writeFileSync(join(scratch, 'songs.json'), JSON.stringify(F.SONGS_ROWS));
    writeFileSync(join(scratch, 'artists.json'), JSON.stringify(F.ARTISTS_JSON_ROWS));

    const original = readFileSync(join(ROOT, 'middleware.js'), 'utf8');
    const shimmed = original
      .replace("import SONGS from './songs.json';", `import SONGS from '${join(scratch, 'songs.json')}' with { type: 'json' };`)
      .replace("import ARTISTS from './artists.json';", `import ARTISTS from '${join(scratch, 'artists.json')}' with { type: 'json' };`);
    const mwPath = join(scratch, 'middleware-shim.mjs');
    writeFileSync(mwPath, shimmed);

    const { decide } = await import(mwPath);
    const shell = readFileSync(join(ROOT, 'index.html'), 'utf8');

    const plan = await decide('/artist/nova-ash', new URLSearchParams());
    r.check('decide() renders the artist route', plan && plan.kind === 'render' && plan.tag === 'artist', JSON.stringify(plan && { kind: plan.kind, tag: plan.tag }));
    const html = plan.fn(shell);

    const desc = (html.match(/<meta name="description" content="([^"]*)">/) || [])[1];
    const ld = JSON.parse((html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [, '{}'])[1]);
    const ssr = (html.match(/<section id="ssr" hidden>([\s\S]*?)<\/section>/) || [, ''])[1];

    r.check('title includes the artist name', /Nova Ash/.test((html.match(/<title>([^<]*)<\/title>/) || [])[1] || ''));
    r.check('description falls back sensibly (no bio set)', desc === 'Original songs on Laivy Hart.', desc);
    r.check('JSON-LD is a MusicGroup with a track list', ld['@type'] === 'MusicGroup' && Array.isArray(ld.track) && ld.track.length === 6, JSON.stringify(ld['@type']));

    // ARTIST-3 step 14/16: follower_count flows into the SSR body.
    r.check('SSR body shows follower count', /12 followers/.test(ssr), ssr.slice(0, 400));
    // ARTIST-2 step 14 (still true): mood chips + stats strip + trophy shelf.
    r.check('SSR body shows mood chips', /\/listen\?channel=inspire-me/.test(ssr));
    r.check('SSR body shows the stats', /6 songs/.test(ssr) && /9 weeks on the chart/.test(ssr) && /30 hearts/.test(ssr));
    r.check('SSR body shows the trophy tally', /Hit #1: 1 song/.test(ssr), ssr.match(/Hit #1[^<]*/)?.[0]);

    // ARTIST-3 step 5: no Hebrew LABELS in the server-rendered HTML either --
    // the one Hebrew run that's allowed is "לילה שקט", the CONTENT title of
    // the Quiet Night song in the <ul> of links, not a developer-authored label.
    const labelHebrew = (ssr.match(/[֐-׿]+\s*[֐-׿]*/g) || []);
    r.check('Hebrew in the SSR body is only the one song-title content', labelHebrew.join(' ').trim() === 'לילה שקט', JSON.stringify(labelHebrew));

    // Bio flows into description/JSON-LD/body once set (ARTIST-3 step 25).
    // Node's ESM loader caches a JSON import by its literal specifier path,
    // so re-using the same path would NOT pick up the rewritten file -- a
    // fresh artists.json path (and a fresh shim importing it) is required.
    const withBio = F.ARTISTS_JSON_ROWS.map((a) => a.id === F.NOVA_ASH ? { ...a, bio: 'Songs about staying up too late.\nWritten in one sitting.' } : a);
    const artistsWithBioPath = join(scratch, 'artists-with-bio.json');
    writeFileSync(artistsWithBioPath, JSON.stringify(withBio));
    const shimmed2 = original
      .replace("import SONGS from './songs.json';", `import SONGS from '${join(scratch, 'songs.json')}' with { type: 'json' };`)
      .replace("import ARTISTS from './artists.json';", `import ARTISTS from '${artistsWithBioPath}' with { type: 'json' };`);
    const mwPath3 = join(scratch, 'middleware-shim-bio.mjs');
    writeFileSync(mwPath3, shimmed2);
    const { decide: decide3 } = await import(mwPath3);
    const html3 = (await decide3('/artist/nova-ash', new URLSearchParams())).fn(shell);
    const desc3 = (html3.match(/<meta name="description" content="([^"]*)">/) || [])[1];
    const ssr3 = (html3.match(/<section id="ssr" hidden>([\s\S]*?)<\/section>/) || [, ''])[1];
    r.check('description uses the bio once set', desc3 === 'Songs about staying up too late.', desc3);
    r.check('SSR body renders the bio with a <br> for the line break', ssr3.includes('<p>Songs about staying up too late.<br>Written in one sitting.</p>'), ssr3.slice(0, 300));

    r.check('unknown handle -> noindex, no crash', JSON.stringify((await (async () => {
      const p = await decide3('/artist/does-not-exist', new URLSearchParams());
      return { kind: p.kind, tag: p.tag };
    })())) === JSON.stringify({ kind: 'render', tag: 'artist-404' }));
    r.check('home route unaffected', (await decide3('/', new URLSearchParams())).tag === 'home');

    // ---- DED-2: /d/<code>, the one route with no build-time snapshot --
    // it fetches dedications_public live, so a stub fetchImpl stands in. ----
    const namedFetch = async () => ({
      ok: true,
      json: async () => ([{
        code: 'ABCD2345', song_id: 'song-1', song_title: 'Supernova', song_slug: 'supernova-a000',
        cover_url: 'https://example.com/cover.jpg', recipient_name: 'Mom', occasion: 'birthday',
        occasion_other: null, message: 'Love you so much, happy birthday to the best mom!',
        sender_name: 'Tzvi', created_at: new Date().toISOString(),
      }]),
    });
    const namedPlan = await decide('/d/ABCD2345', new URLSearchParams(), namedFetch);
    r.check('renders (not a redirect) for a live dedication', namedPlan.kind === 'render' && namedPlan.tag === 'dedication', JSON.stringify(namedPlan));
    const namedHtml = namedPlan.fn(shell);
    r.check('title is "A song for Mom | Laivy Hart"', (namedHtml.match(/<title>([^<]*)<\/title>/) || [])[1] === 'A song for Mom | Laivy Hart', (namedHtml.match(/<title>([^<]*)<\/title>/) || [])[1]);
    r.check('og:title matches', (namedHtml.match(/<meta property="og:title" content="([^"]*)">/) || [])[1] === 'A song for Mom', namedHtml.match(/og:title[^>]*/)?.[0]);
    r.check('og:description carries the occasion and the start of the message', /On their birthday.*Love you so much/.test((namedHtml.match(/<meta property="og:description" content="([^"]*)">/) || [])[1] || ''), (namedHtml.match(/<meta property="og:description" content="([^"]*)">/) || [])[1]);
    r.check('og:image uses the cover via the wsrv.nl transform', (namedHtml.match(/<meta property="og:image" content="([^"]*)">/) || [])[1]?.includes('wsrv.nl'), (namedHtml.match(/<meta property="og:image" content="([^"]*)">/) || [])[1]);
    r.check('noindex is present (dedication pages are personal)', /name="robots" content="noindex"/.test(namedHtml));
    const namedSsr = (namedHtml.match(/<section id="ssr" hidden>([\s\S]*?)<\/section>/) || [, ''])[1];
    r.check('SSR body shows the real sender name', /From Tzvi/.test(namedSsr), namedSsr);

    const anonFetch = async () => ({
      ok: true,
      json: async () => ([{
        code: 'ANON1111', song_id: 'song-1', song_title: 'Supernova', song_slug: 'supernova-a000',
        cover_url: null, recipient_name: 'Dad', occasion: 'in_memory', occasion_other: null,
        message: null, sender_name: null, created_at: new Date().toISOString(),
      }]),
    });
    const anonPlan = await decide('/d/ANON1111', new URLSearchParams(), anonFetch);
    const anonHtml = anonPlan.fn(shell);
    const anonSsr = (anonHtml.match(/<section id="ssr" hidden>([\s\S]*?)<\/section>/) || [, ''])[1];
    r.check('anonymous: no sender name anywhere in the rendered HTML', !/Tzvi/.test(anonHtml) && /From someone/.test(anonSsr), anonSsr);
    r.check('still noindex', /name="robots" content="noindex"/.test(anonHtml));

    const missingFetch = async () => ({ ok: true, json: async () => [] });
    const missingPlan = await decide('/d/NOPE0000', new URLSearchParams(), missingFetch);
    r.check('an unknown (or removed -- dedications_public hides those identically) code -> noindex, not a crash', missingPlan.kind === 'render' && missingPlan.tag === 'dedication-404', JSON.stringify(missingPlan));
    const missingHtml = missingPlan.fn(shell);
    r.check('noindex on the missing-dedication shell too', /name="robots" content="noindex"/.test(missingHtml));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return r;
}
