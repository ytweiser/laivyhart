/* ============================================================
   ACT-1, Part B -- the Worker's POST /event route. Node-only, no browser
   and no real network: handleActivityEvent() and verifySupabaseJwt() are
   exercised directly against the real worker/src/index.js, exactly as
   middleware.spec.mjs exercises the real middleware.js. A stub fetchImpl
   stands in for the REST insert; a locally generated ECDSA key stands in
   for the real JWKS so the token-verification path is exercised without
   a network call.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../lib/report.mjs';
import * as W from '../../worker/src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const EXPECTED_ROW_KEYS = [
  'artist_id', 'city', 'country', 'device_id', 'event_type', 'meta',
  'page', 'region', 'session_id', 'song_id', 'user_id',
].sort();

function postEvent({ body, headers } = {}) {
  return new Request('https://worker.test/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function makeCtx() {
  const waited = [];
  return { waited, waitUntil(p) { waited.push(p); } };
}

function b64url(bytes) {
  const bin = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('binary');
  return Buffer.from(bin, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj) { return b64url(Buffer.from(JSON.stringify(obj))); }

async function makeSignedJwt(sub) {
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  jwk.kid = 'test-kid-1';
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  const header = { alg: 'ES256', kid: jwk.kid, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub, exp: now + 3600, iat: now };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, new TextEncoder().encode(signingInput)
  );
  const token = `${signingInput}.${b64url(new Uint8Array(sig))}`;
  return { token, jwks: { keys: [jwk] } };
}

export async function run() {
  const r = makeReporter('worker-activity.spec.mjs');

  // --- static: the IP is never even read, let alone stored -----------------
  r.section('no IP field anywhere in the source');
  const src = readFileSync(join(ROOT, 'worker', 'src', 'index.js'), 'utf8');
  // Headers/properties actually READ, not the words in a comment explaining
  // that they are not read -- this file's own doc comment names them.
  r.check('CF-Connecting-IP header is never read', !/headers\.get\(\s*['"]cf-connecting-ip['"]/i.test(src));
  r.check('X-Forwarded-For header is never read', !/headers\.get\(\s*['"]x-forwarded-for['"]/i.test(src));
  r.check('no bare ".ip" property read off request.cf', !/\bcf\.ip\b/i.test(src));

  // --- validation: caps, unknown types dropped, shape --------------------
  r.section('validation: caps and dropped types');
  {
    const env = { SUPABASE_SERVICE_ROLE_KEY: 'svc' };
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true, text: async () => '[]' }; };
    const ctx = makeCtx();

    const req = postEvent({
      body: {
        device_id: 'device-1', session_id: 'session-1',
        events: [
          { type: 'page_view', page: '/listen' },
          { type: 'not_a_real_type', page: '/should-be-dropped' },
          { type: 'search', meta: { query: 'x'.repeat(500), a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11 } },
        ],
      },
    });
    const res = await W.handleActivityEvent(req, env, ctx, fetchImpl);
    await Promise.all(ctx.waited);
    r.check('responds 204', res.status === 204, res.status);
    r.check('exactly one insert call (one batch)', calls.length === 1, calls.length);
    const rows = JSON.parse(calls[0].opts.body);
    r.check('unknown type dropped, known types kept (2 of 3 rows)', rows.length === 2, rows.length);
    r.check('row shape has exactly the expected columns, nothing extra (no ip)',
      JSON.stringify(Object.keys(rows[0]).sort()) === JSON.stringify(EXPECTED_ROW_KEYS),
      Object.keys(rows[0]).sort().join(','));
    const searchRow = rows.find((x) => x.event_type === 'search');
    r.check('search query capped at 100 chars', searchRow.meta.query.length === 100, searchRow.meta.query.length);
    r.check('meta capped at 10 keys', Object.keys(searchRow.meta).length === 10, Object.keys(searchRow.meta).length);
    r.check('anonymous: user_id is null with no Authorization header', rows[0].user_id === null);
  }

  // --- caps: too many events in one batch is truncated, not rejected ------
  r.section('more than 25 events in one request: truncated, not rejected');
  {
    const env = { SUPABASE_SERVICE_ROLE_KEY: 'svc' };
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true, text: async () => '[]' }; };
    const ctx = makeCtx();
    const events = Array.from({ length: 40 }, () => ({ type: 'page_view', page: '/listen' }));
    const req = postEvent({ body: { device_id: 'device-2', session_id: 's', events } });
    const res = await W.handleActivityEvent(req, env, ctx, fetchImpl);
    await Promise.all(ctx.waited);
    r.check('responds 204', res.status === 204, res.status);
    const rows = JSON.parse(calls[0].opts.body);
    r.check('capped at 25 events', rows.length === 25, rows.length);
  }

  // --- caps: an oversized body is dropped outright, quickly, no insert ----
  r.section('a body over 16 KB is dropped, not parsed or inserted');
  {
    const env = { SUPABASE_SERVICE_ROLE_KEY: 'svc' };
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true, text: async () => '[]' }; };
    const ctx = makeCtx();
    const hugeQuery = 'q'.repeat(20 * 1024);
    const req = postEvent({ body: { device_id: 'device-3', session_id: 's', events: [{ type: 'search', meta: { query: hugeQuery } }] } });
    const res = await W.handleActivityEvent(req, env, ctx, fetchImpl);
    await Promise.all(ctx.waited);
    r.check('responds 204 (never blocks on errors)', res.status === 204, res.status);
    r.check('no insert attempted for an oversized body', calls.length === 0, calls.length);
  }

  // --- malformed input never errors, always a quick 204 -------------------
  r.section('malformed input still gets a quick 204');
  {
    const env = { SUPABASE_SERVICE_ROLE_KEY: 'svc' };
    const ctx = makeCtx();
    const notJson = postEvent({ body: 'not json at all' });
    const res1 = await W.handleActivityEvent(notJson, env, ctx, async () => ({ ok: true, text: async () => '[]' }));
    r.check('invalid JSON body -> 204', res1.status === 204, res1.status);

    const noDevice = postEvent({ body: { session_id: 's', events: [{ type: 'page_view' }] } });
    const res2 = await W.handleActivityEvent(noDevice, env, ctx, async () => ({ ok: true, text: async () => '[]' }));
    r.check('missing device_id -> 204, not a 400', res2.status === 204, res2.status);
  }

  // --- token verification path: valid token -> real user_id ---------------
  r.section('a valid Authorization token sets user_id from the verified sub');
  {
    const sub = '11111111-2222-4333-8444-555555555555';
    const { token, jwks } = await makeSignedJwt(sub);
    W.__resetJwksCacheForTests();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('.well-known/jwks.json')) {
        return { ok: true, json: async () => jwks };
      }
      return realFetch(url);
    };
    try {
      const env = { SUPABASE_SERVICE_ROLE_KEY: 'svc' };
      const calls = [];
      const insertFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, text: async () => '[]' }; };
      const ctx = makeCtx();
      const req = postEvent({
        body: { device_id: 'device-4', session_id: 's', events: [{ type: 'heart', song_id: null }] },
        headers: { Authorization: 'Bearer ' + token },
      });
      const res = await W.handleActivityEvent(req, env, ctx, insertFetch);
      await Promise.all(ctx.waited);
      r.check('responds 204', res.status === 204, res.status);
      const rows = JSON.parse(calls[0].opts.body);
      r.check('user_id is the verified sub, not anything from the body', rows[0].user_id === sub, rows[0].user_id);
    } finally {
      globalThis.fetch = realFetch;
      W.__resetJwksCacheForTests();
    }
  }

  // --- token verification path: invalid token -> anonymous, not an error --
  r.section('an invalid Authorization token records the events as anonymous');
  {
    W.__resetJwksCacheForTests();
    const env = { SUPABASE_SERVICE_ROLE_KEY: 'svc' };
    const calls = [];
    const insertFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, text: async () => '[]' }; };
    const ctx = makeCtx();
    const req = postEvent({
      body: { device_id: 'device-5', session_id: 's', events: [{ type: 'page_view' }] },
      headers: { Authorization: 'Bearer not.a.real.jwt' },
    });
    const res = await W.handleActivityEvent(req, env, ctx, insertFetch);
    await Promise.all(ctx.waited);
    r.check('responds 204, not 401', res.status === 204, res.status);
    const rows = JSON.parse(calls[0].opts.body);
    r.check('user_id falls back to anonymous (null)', rows[0].user_id === null, rows[0].user_id);
  }

  return r;
}
