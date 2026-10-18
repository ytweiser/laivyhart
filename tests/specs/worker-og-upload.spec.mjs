/* ============================================================
   PLAY-1 -- the Worker's share-image upload: POST /upload/cover?og_for=<id>.

   Run against the real worker/src/index.js in Node, with an HS256 test
   token, an in-memory R2 bucket and a stubbed service-role ownership
   lookup. No network. The key is og/<song-id>.jpg (not the caller's own
   prefix), so the write must only happen for the caller's own song.
   ============================================================ */
import { createHmac } from 'node:crypto';
import { makeReporter } from '../lib/report.mjs';
import { loadWorker } from '../lib/load-worker.mjs';

const SECRET = 'test-secret-play-1';
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SONG = 'a0000000-0000-4000-8000-000000000001';

const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function hsToken(sub) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 600 }));
  const s = b64u(createHmac('sha256', SECRET).update(h + '.' + p).digest());
  return `${h}.${p}.${s}`;
}

export async function run() {
  const r = makeReporter('worker-og-upload.spec.mjs');
  const worker = await loadWorker();
  const puts = [];
  const env = {
    SUPABASE_JWT_SECRET: SECRET,
    SUPABASE_SERVICE_ROLE_KEY: 'svc-test',
    AUDIO_BUCKET: { put: async (key, body, opts) => { puts.push({ key, size: body.byteLength, opts }); } },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/rest/v1/songs?select=artist_id')) {
      return new Response(JSON.stringify(u.includes('id=eq.' + SONG) ? [{ artist_id: OWNER }] : []), { status: 200 });
    }
    return new Response('not stubbed', { status: 599 });
  };
  const post = (qs, sub, bytes) => worker.default.fetch(new Request('https://w.test/upload/cover' + qs, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + hsToken(sub), 'Content-Type': 'image/jpeg', Origin: 'http://localhost:8000' },
    body: new Uint8Array(bytes || 1000),
  }), env, { waitUntil() {} });

  try {
    r.check('ogKeyFor builds og/<song-id>.jpg', worker.ogKeyFor(SONG) === `og/${SONG}.jpg`);
    let threw = false; try { worker.ogKeyFor('../x'); } catch (e) { threw = true; }
    r.check('ogKeyFor refuses anything but a uuid', threw);

    let res = await post('?og_for=' + SONG, OWNER);
    let body = await res.json();
    r.check('the song\'s own artist: 200, written to og/<song-id>.jpg', res.status === 200 && puts.length === 1 && puts[0].key === `og/${SONG}.jpg`, JSON.stringify({ s: res.status, body, puts }));
    r.check('stored as image/jpeg with a cache header', puts[0] && puts[0].opts.httpMetadata.contentType === 'image/jpeg' && /max-age/.test(puts[0].opts.httpMetadata.cacheControl || ''));
    r.check('returns the public og URL', body.url === `https://pub-75904c6ec4a240bbaa60162b9258ba52.r2.dev/og/${SONG}.jpg`, body.url);

    res = await post('?og_for=' + SONG, OTHER);
    r.check('someone else\'s song: 403, nothing written', res.status === 403 && puts.length === 1, res.status);
    res = await post('?og_for=../../covers/x', OWNER);
    r.check('a non-uuid og_for: 400, nothing written', res.status === 400 && puts.length === 1, res.status);
    res = await post('?og_for=' + SONG, OWNER, 210 * 1024);
    r.check('over 200 KB: 413, nothing written', res.status === 413 && puts.length === 1, res.status);

    res = await post('', OWNER);
    body = await res.json();
    r.check('a plain cover upload is unchanged (covers/<sub>/<uuid>.jpg)', res.status === 200 && puts.length === 2 && /^covers\/11111111-1111-4111-8111-111111111111\/[0-9a-f-]{36}\.jpg$/.test(puts[1].key), puts[1] && puts[1].key);
  } finally {
    globalThis.fetch = realFetch;
  }
  return r;
}
