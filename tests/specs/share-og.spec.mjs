/* ============================================================
   PLAY-1 -- WhatsApp shows the song's cover, never the logo.

   Runs middleware.js's real default export (the whole request path, not
   just decide()) in Node, with the shell fetch and the live Supabase reads
   stubbed -- no network. For several songs and a dedication, under a
   WhatsApp user agent, a phone browser and no user agent at all: exactly one
   og:image, pointing at that song's og/ file, with the full 600x600 JPEG tag
   set and a matching twitter card. The homepage keeps the logo; an artist
   keeps their avatar.
   ============================================================ */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OG = 'https://pub-75904c6ec4a240bbaa60162b9258ba52.r2.dev/og/';
const UAS = {
  whatsapp: 'WhatsApp/2.23.20.0 A',
  phone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  none: null,
};

const all = (html, re) => [...html.matchAll(re)].map((m) => m[1]);
const metaP = (html, p) => all(html, new RegExp('<meta property="' + p.replace(/:/g, '\\:') + '" content="([^"]*)">', 'g'));
const metaN = (html, n) => all(html, new RegExp('<meta name="' + n.replace(/:/g, '\\:') + '" content="([^"]*)">', 'g'));
const unesc = (s) => String(s || '').replace(/&amp;/g, '&');

export async function run() {
  const r = makeReporter('share-og.spec.mjs');
  const scratch = mkdtempSync(join(tmpdir(), 'laivy-og-test-'));
  const realFetch = globalThis.fetch;
  try {
    // Snapshot: most songs carry og_image (as snapshot-songs.mjs writes it
    // after a HEAD), one has a cover but no confirmed share file yet, one has
    // neither cover nor share file.
    const rows = F.SONGS_ROWS.map((s) => {
      if (s.id === F.SONGS.AFTERGLOW) return { ...s, cover_url: 'https://example.com/afterglow.png', cover_focus_x: 30, cover_focus_y: 60 };
      if (s.id === F.SONGS.FIRST_LIGHT) return { ...s, cover_url: null };
      return { ...s, cover_url: 'https://example.com/' + s.slug + '.png', og_image: OG + s.id + '.jpg' };
    });
    writeFileSync(join(scratch, 'songs.json'), JSON.stringify(rows));
    writeFileSync(join(scratch, 'artists.json'), JSON.stringify(F.ARTISTS_JSON_ROWS.map((a) => a.handle === 'sable-ridge'
      ? { ...a, avatar: 'https://example.com/sable.jpg' } : a)));
    const original = readFileSync(join(ROOT, 'middleware.js'), 'utf8');
    const shimmed = original
      .replace("import SONGS from './songs.json';", `import SONGS from '${join(scratch, 'songs.json')}' with { type: 'json' };`)
      .replace("import ARTISTS from './artists.json';", `import ARTISTS from '${join(scratch, 'artists.json')}' with { type: 'json' };`);
    const mwPath = join(scratch, 'middleware-shim.mjs');
    writeFileSync(mwPath, shimmed);
    const mw = await import(mwPath);
    const shell = readFileSync(join(ROOT, 'index.html'), 'utf8');

    r.check('the shell itself carries exactly one og:image (the logo)', metaP(shell, 'og:image').length === 1);
    r.check('middleware.js has no user-agent check anywhere', !/user-agent|userAgent|isBot|crawler\s*\(/i.test(original.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));

    const dedRow = {
      code: 'WAPP0001', song_id: F.SONGS.SUPERNOVA, song_title: 'Supernova', song_slug: 'supernova-a000',
      cover_url: 'https://example.com/supernova-a000.png', recipient_name: 'Mom', occasion: 'birthday',
      occasion_other: null, message: 'Happy birthday!', sender_name: 'Tzvi', created_at: new Date().toISOString(),
    };
    const liveSong = {
      id: 'f0000000-0000-4000-8000-000000000001', slug: 'brand-new-song-f000', title: 'Brand New Song', status: 'approved',
      cover_url: 'https://example.com/brand-new.png', cover_focus_x: 50, cover_focus_y: 50, language: 'English',
      artist: { handle: 'nova-ash', display_name: 'Nova Ash', avatar_url: null },
    };
    globalThis.fetch = async (input, init) => {
      const url = String(input && input.url ? input.url : input);
      if (url.endsWith('/index.html')) return new Response(shell, { status: 200, headers: { 'content-type': 'text/html' } });
      // SHOW-1: /d/<code> reads one dedication by its code (POST rpc).
      if (url.includes('/rest/v1/rpc/dedication_by_code')) {
        const code = JSON.parse((init && init.body) || '{}').p_code;
        return new Response(JSON.stringify(code === 'WAPP0001' ? [dedRow] : []), { status: 200 });
      }
      if (url.includes('/rest/v1/songs')) return new Response(JSON.stringify(url.includes('slug=eq.brand-new-song-f000') ? [liveSong] : []), { status: 200 });
      return new Response('not stubbed: ' + url, { status: 599 });
    };

    const get = async (path, ua) => {
      const headers = ua ? { 'user-agent': ua } : {};
      const res = await mw.default(new Request('https://laivyhart.com' + path, { headers }));
      return res;
    };
    const checkOg = (label, html, wantImage, wantAlt) => {
      const imgs = metaP(html, 'og:image').map(unesc);
      r.check(`${label}: exactly one og:image`, imgs.length === 1, JSON.stringify(imgs));
      r.check(`${label}: og:image is the song's share image`, imgs[0] === wantImage, imgs[0]);
      r.check(`${label}: never the logo`, !/<meta[^>]*og-image\.png/.test(html));
      r.check(`${label}: secure_url, type, 600x600, alt`,
        unesc(metaP(html, 'og:image:secure_url')[0]) === wantImage
          && metaP(html, 'og:image:type').join() === 'image/jpeg'
          && metaP(html, 'og:image:width').join() === '600' && metaP(html, 'og:image:height').join() === '600'
          && metaP(html, 'og:image:alt').join() === wantAlt,
        JSON.stringify({ s: metaP(html, 'og:image:secure_url'), t: metaP(html, 'og:image:type'), w: metaP(html, 'og:image:width'), h: metaP(html, 'og:image:height'), a: metaP(html, 'og:image:alt') }));
      r.check(`${label}: twitter summary_large_image with the same image`,
        metaN(html, 'twitter:card').join() === 'summary_large_image' && metaN(html, 'twitter:image').length === 1
          && unesc(metaN(html, 'twitter:image')[0]) === wantImage, JSON.stringify(metaN(html, 'twitter:image')));
    };

    r.section('song pages, three user agents');
    for (const id of [F.SONGS.SUPERNOVA, F.SONGS.QUIET_NIGHT_HE, F.SONGS.BORROWED_LIGHT]) {
      const s = rows.find((x) => x.id === id);
      for (const [uaName, ua] of Object.entries(UAS)) {
        const res = await get('/song/' + encodeURIComponent(s.slug), ua);
        const html = await res.text();
        r.check(`/song/${s.slug} [${uaName}]: 200 rendered`, res.status === 200 && res.headers.get('x-laivy-og') === 'song', res.status);
        checkOg(`/song/${s.slug} [${uaName}]`, html, OG + s.id + '.jpg', s.title);
        r.check(`/song/${s.slug} [${uaName}]: still the full app shell for people`, html.includes('id="audio-el"') && html.includes('<section id="ssr" hidden>'));
      }
    }

    r.section('fallbacks: no confirmed share file yet');
    {
      const html = await (await get('/song/afterglow-a000', UAS.whatsapp)).text();
      const img = unesc(metaP(html, 'og:image')[0]);
      r.check('cover without a confirmed og file -> a square 600x600 crop of the cover, at its focal point',
        img.startsWith('https://wsrv.nl/?url=' + encodeURIComponent('https://example.com/afterglow.png')) && img.includes('&w=600&h=600&fit=cover')
          && img.includes('fpx=0.30') && img.includes('fpy=0.60') && img.includes('output=jpg'), img);
      r.check('...and still exactly one og:image', metaP(html, 'og:image').length === 1);
      const html2 = await (await get('/song/first-light-c000', UAS.whatsapp)).text();
      r.check('no cover at all -> its og/ theme plate, never the logo', unesc(metaP(html2, 'og:image')[0]) === OG + F.SONGS.FIRST_LIGHT + '.jpg' && !/<meta[^>]*og-image\.png/.test(html2), metaP(html2, 'og:image')[0]);
    }

    r.section('a song approved after the last deploy (not in songs.json yet)');
    {
      const res = await get('/song/brand-new-song-f000', UAS.whatsapp);
      const html = await res.text();
      r.check('rendered from a live lookup, not the bare shell', res.headers.get('x-laivy-og') === 'song', res.headers.get('x-laivy-og'));
      r.check('its cover, not the logo', metaP(html, 'og:image').length === 1 && !/<meta[^>]*og-image\.png/.test(html) && unesc(metaP(html, 'og:image')[0]).includes(encodeURIComponent('https://example.com/brand-new.png')), metaP(html, 'og:image')[0]);
    }

    r.section('/song/<id> and the legacy /?song=<id> both land on /song/<slug>');
    {
      const res = await get('/song/' + F.SONGS.SUPERNOVA, UAS.whatsapp);
      r.check('/song/<id> -> 301 /song/<slug>', res.status === 301 && res.headers.get('location') === '/song/supernova-a000', res.status + ' ' + res.headers.get('location'));
      const res2 = await get('/?song=' + F.SONGS.SUPERNOVA, UAS.whatsapp);
      r.check('/?song=<id> -> 301 /song/<slug>', res2.status === 301 && res2.headers.get('location') === '/song/supernova-a000');
    }

    r.section('dedication pages, three user agents');
    for (const [uaName, ua] of Object.entries(UAS)) {
      const res = await get('/d/WAPP0001', ua);
      const html = await res.text();
      r.check(`/d/WAPP0001 [${uaName}]: rendered`, res.status === 200 && res.headers.get('x-laivy-og') === 'dedication');
      checkOg(`/d/WAPP0001 [${uaName}]`, html, OG + F.SONGS.SUPERNOVA + '.jpg', 'Supernova');
    }

    r.section('non-song pages keep theirs');
    {
      const home = await (await get('/', UAS.whatsapp)).text();
      r.check('homepage keeps the logo', metaP(home, 'og:image').length === 1 && metaP(home, 'og:image')[0] === 'https://laivyhart.com/og-image.png', metaP(home, 'og:image').join());
      const artist = await (await get('/artist/sable-ridge', UAS.whatsapp)).text();
      const ai = unesc(metaP(artist, 'og:image')[0]);
      r.check('artist page keeps the avatar', metaP(artist, 'og:image').length === 1 && ai.includes(encodeURIComponent('https://example.com/sable.jpg')), ai);
    }
  } finally {
    globalThis.fetch = realFetch;
    rmSync(scratch, { recursive: true, force: true });
  }
  return r;
}
