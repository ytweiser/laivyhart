/* ============================================================
   SONG-2 -- the Worker's POST /notify/song-idea route. Node-only, no
   browser and no real network: handleSongIdeaNotify() is exercised
   directly against the real worker/src/index.js, the same way
   worker-activity.spec.mjs exercises handleActivityEvent(). The JWKS fetch
   is the one call that is NOT injectable (verifySupabaseJwt always uses
   the real global fetch for it), so it is monkey-patched exactly the way
   that file already does; every other call (the admin check, the data
   reads, the Resend send) goes through the injectable fetchImpl.
   ============================================================ */
import { makeReporter } from '../lib/report.mjs';
import * as W from '../../worker/src/index.js';

function b64url(bytes) {
  const bin = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('binary');
  return Buffer.from(bin, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj) { return b64url(Buffer.from(JSON.stringify(obj))); }

async function makeSignedJwt(sub) {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  jwk.kid = 'test-kid-song-idea';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  const header = { alg: 'ES256', kid: jwk.kid, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub, exp: now + 3600, iat: now };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, new TextEncoder().encode(signingInput),
  );
  const token = `${signingInput}.${b64url(new Uint8Array(sig))}`;
  return { token, jwks: { keys: [jwk] } };
}

function notifyReq(body, token) {
  return new Request('https://worker.test/notify/song-idea', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });
}

function makeCtx() { return { waitUntil() {} }; }

// One dispatcher for every REST/Resend call this route makes, driven by a
// small fixture object so each scenario only overrides what it needs.
function makeFetchImpl(fixture, resendCalls) {
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('/rest/v1/artists?')) {
      return { ok: true, json: async () => (fixture.adminRow ? [fixture.adminRow] : []) };
    }
    if (u.includes('/rest/v1/song_ideas?')) {
      return { ok: true, json: async () => (fixture.idea ? [fixture.idea] : []) };
    }
    if (u.includes('/auth/v1/admin/users/')) {
      return { ok: true, json: async () => (fixture.user || {}) };
    }
    if (u.includes('/rest/v1/songs?')) {
      return { ok: true, json: async () => (fixture.song ? [fixture.song] : []) };
    }
    if (u.includes('api.resend.com')) {
      resendCalls.push(JSON.parse(opts.body));
      return { ok: true, text: async () => '{"id":"email_1"}' };
    }
    throw new Error('unexpected fetch in test: ' + u);
  };
}

async function withStubbedJwks(jwks, fn) {
  W.__resetJwksCacheForTests();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('.well-known/jwks.json')) return { ok: true, json: async () => jwks };
    return realFetch(url);
  };
  try { await fn(); } finally { globalThis.fetch = realFetch; W.__resetJwksCacheForTests(); }
}

export async function run() {
  const r = makeReporter('worker-song-idea-notify.spec.mjs');
  const ADMIN_SUB = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
  const MEMBER_SUB = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';
  const env = { SUPABASE_SERVICE_ROLE_KEY: 'svc', RESEND_API_KEY: 'resend-key' };

  r.section('method must be POST');
  {
    const req = new Request('https://worker.test/notify/song-idea', { method: 'GET' });
    const res = await W.handleSongIdeaNotify(req, env, makeCtx(), async () => { throw new Error('should not fetch'); });
    r.check('405 Method Not Allowed', res.status === 405, res.status);
  }

  r.section('rejects a missing/invalid Authorization token');
  {
    const req = notifyReq({ idea_id: 'cccccccc-0000-4ccc-8ccc-cccccccccc01', event: 'picked' });
    const res = await W.handleSongIdeaNotify(req, env, makeCtx(), async () => { throw new Error('should not fetch'); });
    r.check('401 Unauthorized with no token', res.status === 401, res.status);
  }

  r.section('rejects a verified, non-admin caller');
  {
    const { token, jwks } = await makeSignedJwt(MEMBER_SUB);
    await withStubbedJwks(jwks, async () => {
      const resendCalls = [];
      const fetchImpl = makeFetchImpl({ adminRow: { role: 'artist', status: 'active' } }, resendCalls);
      const res = await W.handleSongIdeaNotify(notifyReq({ idea_id: 'cccccccc-0000-4ccc-8ccc-cccccccccc01', event: 'picked' }, token), env, makeCtx(), fetchImpl);
      const body = await res.json();
      r.check('403 Forbidden for a verified non-admin', res.status === 403, res.status);
      r.check('no email was sent', resendCalls.length === 0, resendCalls.length);
      r.check('error message says admin', /admin/i.test(body.error || ''), body);
    });
  }

  r.section('"picked": sends the right subject, with the idea excerpt, skipped when notify_email is false');
  {
    const { token, jwks } = await makeSignedJwt(ADMIN_SUB);
    await withStubbedJwks(jwks, async () => {
      const resendCalls = [];
      const fetchImpl = makeFetchImpl({
        adminRow: { role: 'admin', status: 'active' },
        idea: { user_id: MEMBER_SUB, idea_text: 'A song about the sea at night.', credit_name: null, is_anonymous: false, notify_email: true, released_song_id: null },
        user: { email: 'member@example.test' },
      }, resendCalls);
      const res = await W.handleSongIdeaNotify(notifyReq({ idea_id: 'cccccccc-0000-4ccc-8ccc-cccccccccc01', event: 'picked' }, token), env, makeCtx(), fetchImpl);
      const body = await res.json();
      r.check('200 ok', res.status === 200, res.status);
      r.check('subject is exactly "Your song idea was picked this week"', body.subject === 'Your song idea was picked this week', body);
      r.check('one email sent, to the submitter', resendCalls.length === 1 && resendCalls[0].to[0] === 'member@example.test', resendCalls[0]);
      r.check('the idea excerpt is in the body', resendCalls[0].text.includes('A song about the sea at night.'), resendCalls[0].text);

      // notify_email: false -> skipped, no email at all.
      const resendCalls2 = [];
      const fetchImpl2 = makeFetchImpl({
        adminRow: { role: 'admin', status: 'active' },
        idea: { user_id: MEMBER_SUB, idea_text: 'Another idea.', credit_name: null, is_anonymous: false, notify_email: false, released_song_id: null },
      }, resendCalls2);
      const res2 = await W.handleSongIdeaNotify(notifyReq({ idea_id: 'cccccccc-0000-4ccc-8ccc-cccccccccc02', event: 'picked' }, token), env, makeCtx(), fetchImpl2);
      const body2 = await res2.json();
      r.check('still 200 ok when notify_email is off', res2.status === 200, res2.status);
      r.check('no email sent when notify_email is false', resendCalls2.length === 0, resendCalls2.length);
    });
  }

  r.section('"released": sends the right subject, with the song link and "Idea by" credit');
  {
    const { token, jwks } = await makeSignedJwt(ADMIN_SUB);
    await withStubbedJwks(jwks, async () => {
      const resendCalls = [];
      const fetchImpl = makeFetchImpl({
        adminRow: { role: 'admin', status: 'active' },
        idea: { user_id: MEMBER_SUB, idea_text: 'A song about the sea at night.', credit_name: null, is_anonymous: false, notify_email: true, released_song_id: 'song-1' },
        user: { email: 'member@example.test' },
        song: { title: 'Night Tide', title_translit: null, slug: 'night-tide-a000', idea_credit: 'A Member' },
      }, resendCalls);
      const res = await W.handleSongIdeaNotify(notifyReq({ idea_id: 'cccccccc-0000-4ccc-8ccc-cccccccccc01', event: 'released' }, token), env, makeCtx(), fetchImpl);
      const body = await res.json();
      r.check('200 ok', res.status === 200, res.status);
      r.check('subject is exactly "Your song is live"', body.subject === 'Your song is live', body);
      r.check('body has the song link', resendCalls[0].text.includes('https://laivyhart.com/song/night-tide-a000'), resendCalls[0].text);
      r.check('body has the "Idea by" credit', resendCalls[0].text.includes('Idea by A Member'), resendCalls[0].text);
      r.check('sent from hello@laivyhart.com', resendCalls[0].from.includes('hello@laivyhart.com'), resendCalls[0].from);
    });
  }

  return r;
}
