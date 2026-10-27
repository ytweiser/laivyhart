/* ============================================================
   Laivy Hart audio upload Worker.

   Accepts an authenticated PUT/POST with a file body and a filename, writes
   the file to the R2 bucket bound as AUDIO_BUCKET, and returns the public
   URL. This lets admin.html upload new song audio straight to Cloudflare R2
   so new songs never touch Supabase Storage.

   Auth: the client must send `Authorization: Bearer <UPLOAD_TOKEN>` (or the
   raw token). UPLOAD_TOKEN is an encrypted Worker secret, never in code.

   Filename: `?filename=<name>` query param, or an `X-Filename` header.
   Content-Type: taken from the request, defaulting to audio/mpeg.

   Returns: { url, filename } where url is the public r2.dev URL with the
   filename percent-encoded.

   SECOND ROUTE, added in 1A-3: POST /upload/avatar. That one is NOT authorized
   by UPLOAD_TOKEN -- it is for ordinary signed-in artists, who must never hold
   the admin token. It verifies a Supabase-issued access token against the
   project's public JWKS and writes only to avatars/<sub>/. See the block above
   it for the details.
   ============================================================ */

import { resolveDisplayLocation } from './geo.js';

const PUBLIC_BASE = 'https://pub-75904c6ec4a240bbaa60162b9258ba52.r2.dev';

// Origins allowed to call this Worker from a browser. Any localhost/127.0.0.1
// port is also allowed so admin.html works when served locally for testing.
const ALLOWED_ORIGINS = [
  'https://laivyhart.com',
  'https://www.laivyhart.com',
];

function allowedOrigin(origin) {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return origin;
  } catch (e) { /* not a valid origin */ }
  return null;
}

function corsHeaders(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Filename',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  const allowed = allowedOrigin(origin);
  if (allowed) h['Access-Control-Allow-Origin'] = allowed;
  return h;
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// Length-safe, constant-time-ish token comparison so we don't leak length via
// early return timing more than necessary.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ============================================================
   Supabase access-token verification (for /upload/avatar).

   This project issues ES256 tokens and publishes a JWKS, so the Worker needs
   NO new secret -- the verification key is public by design. HS256 is handled
   too, from a SUPABASE_JWT_SECRET secret, purely so this keeps working if the
   project is ever moved back to a shared-secret key; it is not used today.

   The JWKS is cached in module scope for the life of the isolate, with a TTL,
   and re-fetched once on an unrecognised kid so a key rotation recovers without
   a redeploy.
   ============================================================ */
const JWKS_URL = 'https://tshkrghrgokplakktvik.supabase.co/auth/v1/.well-known/jwks.json';
const JWKS_TTL_MS = 10 * 60 * 1000;
let jwksCache = { keys: null, at: 0 };

export function __resetJwksCacheForTests() { jwksCache = { keys: null, at: 0 }; }

async function getJwks(force) {
  const fresh = jwksCache.keys && (Date.now() - jwksCache.at) < JWKS_TTL_MS;
  if (fresh && !force) return jwksCache.keys;
  const res = await fetch(JWKS_URL, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error('JWKS HTTP ' + res.status);
  const body = await res.json();
  if (!body || !Array.isArray(body.keys)) throw new Error('JWKS malformed');
  jwksCache = { keys: body.keys, at: Date.now() };
  return body.keys;
}

function b64urlToBytes(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToJson(str) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(str)));
}

/* Returns the `sub` claim, or throws. Verifies signature, exp and nbf. */
export async function verifySupabaseJwt(token, env) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h64, p64, s64] = parts;

  let header, payload;
  try { header = b64urlToJson(h64); payload = b64urlToJson(p64); }
  catch (e) { throw new Error('unreadable token'); }

  const data = new TextEncoder().encode(h64 + '.' + p64);
  const sig = b64urlToBytes(s64);
  let ok = false;

  if (header.alg === 'ES256') {
    // The JWS signature is raw r||s, which is exactly what WebCrypto wants.
    let keys = await getJwks(false);
    let jwk = keys.find((k) => k.kid === header.kid) || null;
    if (!jwk) {                       // possible rotation: refetch once
      keys = await getJwks(true);
      jwk = keys.find((k) => k.kid === header.kid) || null;
    }
    if (!jwk) throw new Error('unknown key');
    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
    );
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data);
  } else if (header.alg === 'HS256') {
    if (!env.SUPABASE_JWT_SECRET) throw new Error('HS256 token but no secret configured');
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    ok = await crypto.subtle.verify('HMAC', key, sig, data);
  } else {
    throw new Error('unsupported alg');
  }

  if (!ok) throw new Error('bad signature');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp <= now) throw new Error('expired');
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) throw new Error('not yet valid');
  if (!payload.sub || !/^[0-9a-f-]{36}$/i.test(payload.sub)) throw new Error('no subject');
  return payload.sub;
}

const AVATAR_MAX_BYTES = 512 * 1024;

/* ============================================================
   1B-1: contributor media routes.

   Same JWT verification as /upload/avatar, same guarantee: the key is built
   from the VERIFIED `sub` and a server-generated uuid, never from anything the
   caller sent, so a contributor's write cannot leave their own prefix no
   matter what they put in the request.

   The admin's UPLOAD_TOKEN route is untouched and still writes wherever the
   admin asks. Both land in the same R2 bucket under distinct prefixes.

   SEED LIMITS -- adjust freely, they are one edit each:
     audio  20 MB, content-type in AUDIO_TYPES
     cover  512 KB, always stored as image/jpeg (the client compresses first,
            exactly as the avatar route already assumes)
   ============================================================ */
export const AUDIO_MAX_BYTES = 20 * 1024 * 1024;
export const COVER_MAX_BYTES = 512 * 1024;

// Extension comes from the verified content-type, never from a caller filename.
export const AUDIO_TYPES = {
  'audio/mpeg': 'mp3',
  'audio/mp4':  'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav':  'wav',
};

export function audioExtFor(contentType) {
  const base = String(contentType || '').split(';')[0].trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(AUDIO_TYPES, base) ? AUDIO_TYPES[base] : null;
}

/* The only place an upload key is ever constructed. `sub` is the verified JWT
   subject; `id` is generated here. Neither can contain a slash or a dot-dot,
   but both are re-validated anyway -- a key is the one thing worth checking
   twice, since a bad one writes into somebody else's folder. */
export function uploadKeyFor(kind, sub, id, ext) {
  if (!/^[0-9a-f-]{36}$/i.test(String(sub || ''))) throw new Error('bad subject');
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw new Error('bad id');
  if (!/^[a-z0-9]{2,4}$/.test(String(ext || ''))) throw new Error('bad extension');
  const prefix = kind === 'audio' ? 'songs' : 'covers';
  const key = `${prefix}/${sub}/${id}.${ext}`;
  if (key.includes('..') || key.split('/').length !== 3) throw new Error('bad key');
  return key;
}

/* PLAY-1: the share-sized cover link previews use, og/<song-id>.jpg (a
   600x600 JPEG the upload form makes in the browser). Sent to the same
   /upload/cover route with ?og_for=<song-id>. Unlike a cover, its key is the
   song id rather than the caller's own prefix (middleware.js and
   snapshot-songs.mjs find it by id), so the write is allowed only when the
   service-role lookup confirms that song's artist_id is the verified `sub`. */
export const OG_MAX_BYTES = 200 * 1024;
export function ogKeyFor(songId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(songId || ''))) throw new Error('bad song id');
  return `og/${String(songId).toLowerCase()}.jpg`;
}
export async function songOwnedBy(songId, sub, env, fetchImpl = fetch) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return false;
  try {
    const res = await fetchImpl(SUPABASE_URL + '/rest/v1/songs?select=artist_id&id=eq.' + encodeURIComponent(songId), {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY },
    });
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length === 1 && rows[0].artist_id === sub;
  } catch (e) {
    return false;
  }
}

/* ============================================================
   ACT-1: activity ingest (POST /event).

   Accepts a small batch of client-side events and inserts them into
   activity_events (sql/020) through the REST API using the SERVICE ROLE key
   -- the one secret this Worker already holds for the daily report, reused
   here rather than adding a second. The key never leaves this file.

   Identity: an Authorization Bearer token, if present, is verified with the
   SAME JWKS code /upload/avatar already uses, and `user_id` comes ONLY from
   that verified `sub`. A user_id in the request body is never read. An
   invalid or missing token is not an error -- the batch is just recorded
   anonymous, tied to the device_id the caller sent instead.

   Location: request.cf (city/region/country) ONLY. The client IP and
   CF-Connecting-IP are never read, stored, or logged here, by design --
   search this file for "ip" and there is nothing to find.

   Never blocks on errors: a malformed batch, an unknown event type, or a
   failed insert all still end in a quick 204. Analytics is not a feature
   that gets to break the page that feeds it.
   ============================================================ */
export const ACTIVITY_EVENT_TYPES = [
  'page_view', 'play_start', 'play_25', 'play_50', 'play_75', 'play_complete',
  'heart', 'unheart', 'rate', 'comment', 'follow', 'unfollow', 'share', 'search',
  'sign_in', 'sign_up', 'upload_submit', 'dedication', 'idea_submit', 'idea_heart',
  'profile_view', 'sleep_timer_set', 'sleep_timer_fired',
];
const ACTIVITY_EVENT_TYPE_SET = new Set(ACTIVITY_EVENT_TYPES);

export const ACTIVITY_MAX_EVENTS = 25;
export const ACTIVITY_MAX_BYTES = 16 * 1024;
const ACTIVITY_META_MAX_KEYS = 10;
const ACTIVITY_STRING_MAX = 200;
const ACTIVITY_SEARCH_QUERY_MAX = 100;
const ACTIVITY_UUID_RE = /^[0-9a-f-]{36}$/i;

/* Keeps meta flat, small, and string-safe. Anything that is not a string,
   number, boolean or null is dropped rather than stored -- there is no
   nested-object or array shape a caller needs here, and accepting one would
   let an arbitrarily large value through a cap written for strings. */
export function trimMeta(meta) {
  const out = {};
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return out;
  const keys = Object.keys(meta).slice(0, ACTIVITY_META_MAX_KEYS);
  for (const k of keys) {
    let v = meta[k];
    if (typeof v === 'string') {
      const cap = k === 'query' ? ACTIVITY_SEARCH_QUERY_MAX : ACTIVITY_STRING_MAX;
      v = v.slice(0, cap);
    } else if (!(typeof v === 'number' || typeof v === 'boolean' || v === null)) {
      continue; // nested object/array/undefined: dropped, not stored
    }
    out[k] = v;
  }
  return out;
}

/* One raw event from the client -> a row-shaped object, or null if the type
   is not one of the allowed ones. Unknown types are DROPPED, not errors, so
   an older cached page sending a retired type never fails a whole batch. */
export function sanitizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type;
  if (typeof type !== 'string' || !ACTIVITY_EVENT_TYPE_SET.has(type)) return null;
  const song_id = typeof raw.song_id === 'string' && ACTIVITY_UUID_RE.test(raw.song_id) ? raw.song_id : null;
  const artist_id = typeof raw.artist_id === 'string' && ACTIVITY_UUID_RE.test(raw.artist_id) ? raw.artist_id : null;
  const page = typeof raw.page === 'string' ? raw.page.slice(0, ACTIVITY_STRING_MAX) : null;
  return { event_type: type, song_id, artist_id, page, meta: trimMeta(raw.meta) };
}

/* The full handler, pulled out of fetch() so tests can call it directly with
   a stub fetchImpl instead of standing up a real Worker + real Supabase. */
export async function handleActivityEvent(request, env, ctx, fetchImpl = fetch) {
  const origin = request.headers.get('Origin');
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);

  // Identity, verified -- never trusted from the body. An invalid or absent
  // token simply leaves user_id null; that is not a failure of this request.
  let userId = null;
  const hdr = request.headers.get('Authorization') || '';
  const jwt = hdr.startsWith('Bearer ') ? hdr.slice(7) : hdr;
  if (jwt) {
    try { userId = await verifySupabaseJwt(jwt, env); }
    catch (e) { userId = null; }
  }

  const empty204 = () => new Response(null, { status: 204, headers: corsHeaders(origin) });

  // Measure what actually arrived, not a header someone can lie about, and
  // reject an oversized body outright rather than parsing it.
  let bytes;
  try { bytes = new Uint8Array(await request.arrayBuffer()); }
  catch (e) { return empty204(); }
  if (bytes.byteLength === 0 || bytes.byteLength > ACTIVITY_MAX_BYTES) return empty204();

  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch (e) { return empty204(); }
  if (!body || typeof body !== 'object') return empty204();

  const device_id = typeof body.device_id === 'string' ? body.device_id.slice(0, 200) : null;
  const session_id = typeof body.session_id === 'string' ? body.session_id.slice(0, 200) : null;
  if (!device_id || !Array.isArray(body.events) || !body.events.length) return empty204();

  // Location from request.cf ONLY. No IP, ever -- see the block comment above.
  const cf = request.cf || {};
  const city = typeof cf.city === 'string' ? cf.city : null;
  const region = typeof cf.region === 'string' ? cf.region : null;
  const country = typeof cf.country === 'string' ? cf.country : null;
  // HOME-1: a decent-size city (population >= 100,000) safe to say out loud
  // in the public ticker, derived from cf.latitude/cf.longitude -- never
  // the raw coordinates themselves, which resolveDisplayLocation() never
  // returns. city/region/country above are unchanged and still exist only
  // for the owner's own Pulse dashboard.
  const { display_city, display_country } = resolveDisplayLocation(cf);

  const rows = [];
  for (const raw of body.events.slice(0, ACTIVITY_MAX_EVENTS)) {
    const ev = sanitizeEvent(raw);
    if (!ev) continue; // unknown type or malformed: dropped, not an error
    rows.push({
      user_id: userId,
      device_id,
      session_id,
      event_type: ev.event_type,
      song_id: ev.song_id,
      artist_id: ev.artist_id,
      meta: ev.meta,
      page: ev.page,
      city, region, country,
      display_city, display_country,
    });
  }

  if (rows.length) {
    // FIX-4: a missing secret is not silence -- it is a clear line in
    // `wrangler tail`, same as the daily report already does for the same key.
    if (!env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('activity insert skipped: SUPABASE_SERVICE_ROLE_KEY is not set');
    } else {
      const insert = (async () => {
        try {
          const res = await fetchImpl(SUPABASE_URL + '/rest/v1/activity_events', {
            method: 'POST',
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify(rows),
          });
          // FIX-4: fetch only REJECTS on a network-level failure, never on a
          // non-2xx response -- a bad column, a wrong/expired key, or an RLS
          // rejection all came back as a resolved response with an error
          // status, and the old .catch()-only version never saw any of them.
          // No IP, no tokens in this line, only the REST status and body.
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            console.error('activity insert failed:', res.status, text.slice(0, 500));
          }
        } catch (e) {
          console.error('activity insert failed:', e && e.message);
        }
      })();
      // Never block the response on the insert: respond 204 now, let the write
      // finish in the background. ctx is absent in a direct unit-test call, so
      // this falls back to awaiting it there instead of losing the write.
      if (ctx && ctx.waitUntil) ctx.waitUntil(insert); else await insert;
    }
  }

  return empty204();
}

/* ============================================================
   1B-3: the daily report.

   Two ways in, one pipeline:
     scheduled()      — the 03:00 UTC cron. Calls build_daily_report() with the
                        SERVICE ROLE key (a Wrangler secret, never in the repo)
                        and mails the result through Resend.
     POST /report/send — the admin's "send me today's report now" button. It
                        verifies the caller's Supabase JWT and then calls the
                        RPC with THAT token, not the service key: the function
                        guards is_admin() itself, so a non-admin session is
                        refused by the database and the service key is never
                        spent on a request that came from a browser.

   ALWAYS SENDS. An empty day is a one-line email, so silence can never be
   mistaken for "the job broke".
   ============================================================ */
const SUPABASE_URL = 'https://tshkrghrgokplakktvik.supabase.co';
const REPORT_TO = 'hello@laivyhart.com';
const REPORT_FROM = 'Laivy Hart <hello@laivyhart.com>';

export async function fetchDailyReport(bearer, env, fetchImpl = fetch) {
  // apikey is the anon/publishable key for routing; Authorization carries
  // whoever is actually asking (service role for the cron, the admin's own
  // session for the button).
  const apikey = env.SUPABASE_ANON_KEY || bearer;
  const res = await fetchImpl(SUPABASE_URL + '/rest/v1/rpc/build_daily_report', {
    method: 'POST',
    headers: {
      apikey,
      Authorization: 'Bearer ' + bearer,
      'Content-Type': 'application/json',
      Prefer: 'params=single-object',
    },
    body: '{}',
  });
  const text = await res.text();
  if (!res.ok) throw new Error('report RPC HTTP ' + res.status + ': ' + text.slice(0, 200));
  return JSON.parse(text);
}

const fmtWhen = (iso) => {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch (e) { return String(iso || ''); }
};

/* Plain text on purpose: it has to read cleanly in every mail client, and the
   owner reads it on a phone at six in the morning. */
export function formatReport(r) {
  const n = (x) => Number(x || 0);
  const signups = n(r.signups && r.signups.count);
  const queue = n(r.review_queue && r.review_queue.count);
  const comments = n(r.pending_comments);
  const tags = Array.isArray(r.proposed_tags_new) ? r.proposed_tags_new : [];
  const an = r.anomalies || {};
  const capList = Array.isArray(an.submitters_at_or_over_cap) ? an.submitters_at_or_over_cap : [];
  const young = an.ratings_from_young_accounts || { count: 0, songs: [] };
  const chart = (r.chart && Array.isArray(r.chart.top10)) ? r.chart.top10 : [];

  const subject = `Laivy Hart daily: ${signups} new, ${queue} to review`;
  const quiet = signups === 0 && queue === 0 && comments === 0 && tags.length === 0
             && capList.length === 0 && n(young.count) === 0;

  const L = [];
  L.push(`Laivy Hart — last 24 hours, to ${fmtWhen(r.generated_at)} (Jerusalem)`);
  L.push('');
  if (quiet) {
    L.push('Nothing waiting: no new sign-ups, nothing to review, no pending comments, no anomalies.');
  } else {
    L.push(`New sign-ups: ${signups}`);
    for (const a of (r.signups && r.signups.list) || []) {
      L.push(`  - ${a.name || '(no name)'} @${a.handle || '?'}  ${fmtWhen(a.created_at)}`);
    }
    L.push('');
    L.push(`Review queue: ${queue}`);
    for (const s of (r.review_queue && r.review_queue.list) || []) {
      L.push(`  - "${s.title}" by @${s.artist || '?'}  submitted ${fmtWhen(s.submitted_at)}`);
    }
    L.push('');
    L.push(`Pending comments: ${comments}`);
    L.push('');
    L.push(`Proposed tags not yet in the vocabulary: ${tags.length ? tags.join(', ') : 'none'}`);
    L.push('');
    L.push('Anomalies');
    if (!capList.length) L.push(`  - No account at or over the ${an.submissions_cap || '?'}/day submission cap.`);
    for (const c of capList) {
      L.push(`  - @${c.handle}: ${c.submissions_24h} submissions in 24h${c.over_cap ? '  ** OVER CAP — the guard should have stopped this **' : ' (at cap)'}`);
    }
    L.push(`  - Ratings from accounts younger than 7 days: ${n(young.count)}`
      + (n(young.count) ? `  (${(young.songs || []).join(', ')})` : ''));
  }
  L.push('');
  L.push(`Chart (${r.chart && r.chart.chart_date ? r.chart.chart_date : 'no snapshot yet'})`);
  for (const c of chart) L.push(`  ${String(c.rank).padStart(2)}. ${c.title}`);
  L.push('');
  L.push(formatYesterday(r.yesterday));
  L.push('');
  L.push(formatSongIdeas(r.song_ideas));
  L.push('');
  L.push('sent by the Laivy Hart report job');
  return { subject, text: L.join('\n') };
}

/* SONG-1: build_daily_report()'s own `song_ideas` key (sql/024_song_ideas.sql).
   waiting_to_pick is a queue depth, not a 24-hour count -- it answers "how
   many are sitting there right now", same as the review queue above. */
function formatSongIdeas(si) {
  si = si || {};
  const n = (x) => Number(x || 0);
  const list = Array.isArray(si.list) ? si.list : [];
  const L = [];
  L.push(`Song ideas yesterday: ${n(si.count)}`);
  for (const i of list) {
    L.push(`  - "${i.excerpt}" (${i.credit || 'Anonymous'})`);
  }
  L.push(`Waiting to pick: ${n(si.waiting_to_pick)}`);
  return L.join('\n');
}

/* ACT-2: "Yesterday on Laivy Hart", from build_daily_report()'s own
   `yesterday` key (sql/021_pulse.sql). Unlike the rest of this report, these
   are raw numbers, not positions -- the Pulse feature's whole point is to
   show the owner what actually happened, and this email is theirs alone. */
function formatYesterday(y) {
  y = y || {};
  const n = (x) => Number(x || 0);
  const L = [];
  L.push(`Yesterday on Laivy Hart (${y.date || 'unknown date'})`);
  L.push(`  Listeners: ${n(y.listeners)}  ·  Members active: ${n(y.members_active)}  ·  New members: ${n(y.new_members)}`);
  L.push(`  Plays: ${n(y.plays)}  ·  Completion rate: ${n(y.completion_rate)}%`);
  const songs = Array.isArray(y.top_songs) ? y.top_songs : [];
  L.push(`  Top songs: ${songs.length ? songs.map((s) => `${s.title} (${n(s.plays)})`).join(', ') : 'none'}`);
  const cities = Array.isArray(y.top_cities) ? y.top_cities : [];
  L.push(`  Top cities: ${cities.length ? cities.map((c) => `${c.city} (${n(c.n)})`).join(', ') : 'none'}`);
  return L.join('\n');
}

export async function sendReportEmail(env, subject, text, fetchImpl = fetch) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: REPORT_FROM, to: [REPORT_TO], subject, text }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error('Resend HTTP ' + res.status + ': ' + body.slice(0, 200));
  return body;
}

export async function runDailyReport(bearer, env, fetchImpl = fetch) {
  const data = await fetchDailyReport(bearer, env, fetchImpl);
  const { subject, text } = formatReport(data);
  await sendReportEmail(env, subject, text, fetchImpl);
  return { subject, queue: data.review_queue && data.review_queue.count, signups: data.signups && data.signups.count };
}

/* ============================================================
   SONG-2: POST /notify/song-idea.

   Admin-only. Given an idea id and an event ("picked" or "released"), reads
   the idea and the submitter's email with the service role, and -- only
   when notify_email is true -- sends a short email through Resend. The
   admin tab calls this right after Pick and Released; see admin.html.

   Identity is verified the same way every other admin-only Worker route
   verifies it (the JWKS code above), but the admin CHECK itself uses the
   service role directly against public.artists rather than calling the
   is_admin() RPC with the caller's own token (the /report/send pattern):
   this route already needs the service role for the data reads below (the
   submitter's email is not something anon/authenticated can ever read),
   so one credential does both the admin check and the data read, instead
   of mixing two. is_admin() itself resolves auth.uid() from whichever JWT
   makes the REST call, which would be null under the service role's own
   token -- so this checks the verified `sub` directly instead, the exact
   same role='admin' and status='active' test is_admin() makes.
   ============================================================ */
export function formatSongIdeaNotification(event, data) {
  data = data || {};
  if (event === 'picked') {
    return {
      subject: 'Your song idea was picked this week',
      text: `Hi,\n\nGood news! Your song idea was picked this week:\n\n"${data.excerpt || ''}"\n\n`
          + `We're turning it into a real song now. We'll email you again the moment it's released.\n\n`
          + `The Laivy Hart team`,
    };
  }
  const link = 'https://laivyhart.com/song/' + (data.songSlug || '');
  return {
    subject: 'Your song is live',
    text: `Hi,\n\nYour song is live! "${data.songTitle || ''}" is now on Laivy Hart, credited as `
        + `"Idea by ${data.credit || 'Anonymous'}".\n\nListen here: ${link}\n\nThe Laivy Hart team`,
  };
}

export async function sendSongIdeaEmail(env, to, subject, text, fetchImpl = fetch) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: REPORT_FROM, to: [to], subject, text }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error('Resend HTTP ' + res.status + ': ' + body.slice(0, 200));
  return body;
}

export async function handleSongIdeaNotify(request, env, ctx, fetchImpl = fetch) {
  const origin = request.headers.get('Origin');
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);

  const hdr = request.headers.get('Authorization') || '';
  const jwt = hdr.startsWith('Bearer ') ? hdr.slice(7) : hdr;
  let sub;
  try { sub = await verifySupabaseJwt(jwt, env); }
  catch (e) { return json({ error: 'Unauthorized: ' + (e && e.message) }, 401, origin); }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('song-idea notify: SUPABASE_SERVICE_ROLE_KEY not set');
    return json({ error: 'Service role key not configured' }, 500, origin);
  }
  const svcHeaders = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY };

  let adminRow;
  try {
    const res = await fetchImpl(SUPABASE_URL + '/rest/v1/artists?select=role,status&id=eq.' + sub, { headers: svcHeaders });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rows = await res.json();
    adminRow = Array.isArray(rows) ? rows[0] : null;
  } catch (e) {
    console.error('song-idea notify: admin check failed', sub, e && e.message);
    return json({ error: 'Could not verify admin status' }, 502, origin);
  }
  if (!adminRow || adminRow.role !== 'admin' || adminRow.status !== 'active') {
    return json({ error: 'Only an admin can send this notification' }, 403, origin);
  }

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400, origin); }
  const ideaId = body && body.idea_id;
  const event = body && body.event;
  if (typeof ideaId !== 'string' || !/^[0-9a-f-]{36}$/i.test(ideaId)) {
    return json({ error: 'Missing or invalid idea_id' }, 400, origin);
  }
  if (event !== 'picked' && event !== 'released') {
    return json({ error: 'event must be "picked" or "released"' }, 400, origin);
  }

  let idea;
  try {
    const res = await fetchImpl(
      SUPABASE_URL + '/rest/v1/song_ideas?select=user_id,idea_text,credit_name,is_anonymous,notify_email,released_song_id&id=eq.' + ideaId,
      { headers: svcHeaders },
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rows = await res.json();
    idea = Array.isArray(rows) ? rows[0] : null;
  } catch (e) {
    console.error('song-idea notify: could not read idea', ideaId, e && e.message);
    return json({ error: 'Could not read that idea' }, 502, origin);
  }
  if (!idea) return json({ error: 'Idea not found' }, 404, origin);
  if (!idea.notify_email) return json({ ok: true, skipped: 'notify_email is off' }, 200, origin);

  let email;
  try {
    const res = await fetchImpl(SUPABASE_URL + '/auth/v1/admin/users/' + idea.user_id, { headers: svcHeaders });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const u = await res.json();
    email = u && u.email;
  } catch (e) {
    console.error('song-idea notify: could not read submitter email', idea.user_id, e && e.message);
    return json({ error: 'Could not read the submitter email' }, 502, origin);
  }
  if (!email) return json({ error: 'Submitter has no email on file' }, 502, origin);

  const data = { excerpt: (idea.idea_text || '').slice(0, 160) };
  if (event === 'released') {
    let song;
    try {
      const res = await fetchImpl(
        SUPABASE_URL + '/rest/v1/songs?select=title,title_translit,slug,idea_credit&id=eq.' + idea.released_song_id,
        { headers: svcHeaders },
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rows = await res.json();
      song = Array.isArray(rows) ? rows[0] : null;
    } catch (e) {
      console.error('song-idea notify: could not read the released song', idea.released_song_id, e && e.message);
      return json({ error: 'Could not read the released song' }, 502, origin);
    }
    if (!song) return json({ error: 'Released song not found' }, 404, origin);
    data.songTitle = song.title_translit || song.title;
    data.songSlug = song.slug;
    data.credit = song.idea_credit || (idea.is_anonymous ? 'Anonymous' : (idea.credit_name || 'Anonymous'));
  }

  const { subject, text } = formatSongIdeaNotification(event, data);
  try {
    await sendSongIdeaEmail(env, email, subject, text, fetchImpl);
  } catch (e) {
    console.error('song-idea notify: send failed', ideaId, event, e && e.message);
    return json({ error: 'Email send failed: ' + (e && e.message) }, 502, origin);
  }
  return json({ ok: true, subject }, 200, origin);
}

/* ============================================================
   SEND-1: POST /dedication/email -- email a dedication to the person it is
   for, once. And GET/POST /unsubscribe -- that person's way out.

   Signed-in senders only (the same JWKS check as the upload routes). Every
   rule lives in the database, in claim_dedication_email() (sql/031): the
   caller must own the dedication, the address must look like one, it must
   not be on email_suppressions, and the limits (5 per sender per day, 1 per
   sender to an address per 7 days, 3 per address per 7 days from everyone)
   must allow it. Only then does this route send ONE email through Resend,
   and finish_dedication_email() records sent or failed. A blocked or failed
   send never touches the dedication itself; the sender is told plainly and
   offered WhatsApp and Copy link instead. No open or click tracking: plain
   links, no pixels.
   ============================================================ */
const SITE = 'https://laivyhart.com';
const WORKER_ORIGIN = 'https://laivyhart-audio-upload.ytweiser-399.workers.dev';
const DEDICATION_FROM = 'Laivy Hart <hello@laivyhart.com>';
const DEDICATION_REPLY_TO = 'hello@laivyhart.com';
export const DEDICATION_SUBJECT = 'A song was dedicated to you';

// The same check sql/031's dedication_email_valid() makes, and the browser.
export function dedicationEmailValid(email) {
  const e = String(email || '').trim().toLowerCase();
  return e.length > 0 && e.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
}
// "n***@gmail.com": the first character of the name, the domain in full.
export function maskEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return '***';
  return e[0] + '***' + e.slice(at);
}

/* The occasion line, the same phrase table as index.html's DED_OCCASION
   `line` (and middleware.js's copy): a third copy because this runtime has
   no shared module with either. dedication-send.spec.mjs checks that all
   three agree for every occasion. */
const DED_LINE = {
  birthday: (n) => `A birthday song for ${n}`,
  engagement: (n) => `A song for ${n}'s engagement`,
  wedding: (n) => `A wedding song for ${n}`,
  anniversary: (n) => `An anniversary song for ${n}`,
  bar_mitzvah: (n) => `A Bar Mitzvah song for ${n}`,
  bat_mitzvah: (n) => `A Bat Mitzvah song for ${n}`,
  new_baby: (n) => `A song to welcome ${n}`,
  bris: (n) => `A song for ${n}'s bris`,
  upsherin: (n) => `A song for ${n}'s upsherin`,
  graduation: (n) => `A graduation song for ${n}`,
  siyum: (n) => `A song for ${n}'s siyum`,
  new_job: (n) => `A song for ${n}'s new job`,
  new_home: (n) => `A song for ${n}'s new home`,
  aliyah: (n) => `A song for ${n}'s aliyah`,
  retirement: (n) => `A song for ${n}'s retirement`,
  refuah_shleimah: (n) => `A song wishing ${n} a refuah shleimah`,
  encouragement: (n) => `A song to lift ${n}'s spirits`,
  thank_you: (n) => `A thank-you song for ${n}`,
  in_memory: (n) => `A song in memory of ${n}`,
  just_because: (n) => `A song for ${n}, just because`,
};
export function dedicationLine(occasion, name, other) {
  if (occasion === 'other') {
    const t = String(other || '').trim().replace(/[.!?]+$/, '');
    return t ? `A song for ${name}: ${t}` : `A song for ${name}`;
  }
  const fn = DED_LINE[occasion];
  return fn ? fn(name) : `A song for ${name}`;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function b64urlEncode(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const bin = atob(String(str || '').replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
/* The unsubscribe link is signed so nobody can suppress an address by
   guessing URLs. The key is derived from the service-role secret this
   Worker already holds (domain-separated by the prefix); no new secret. */
async function unsubscribeSig(email, env) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode('laivyhart-unsubscribe:' + (env.SUPABASE_SERVICE_ROLE_KEY || '')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(email).toLowerCase()));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function unsubscribeUrl(email, env) {
  const e = String(email).toLowerCase();
  return WORKER_ORIGIN + '/unsubscribe?e=' + b64urlEncode(e) + '&s=' + (await unsubscribeSig(e, env));
}

// d: what claim_dedication_email() returned.
export async function buildDedicationEmail(d, to, env) {
  const sender = d.sender_name || 'Someone';
  const line = dedicationLine(d.occasion, d.recipient_name, d.occasion_other);
  const link = SITE + '/d/' + encodeURIComponent(d.code);
  const unsub = await unsubscribeUrl(to, env);
  const cover = d.cover_url && /^https?:\/\//i.test(d.cover_url)
    ? 'https://wsrv.nl/?url=' + encodeURIComponent(d.cover_url) + '&w=480&h=480&fit=cover&output=jpg&q=80'
    : null;
  const footer = 'Laivy Hart sent this one email for the person who dedicated the song. '
    + 'We won\'t email you again unless someone else dedicates a song to you.';
  const text = [
    `Hi ${d.recipient_name},`,
    '',
    `${sender} dedicated a song to you. ${line}.`,
    d.message ? `\n"${d.message}"\n` : '',
    `The song: ${d.song_title}`,
    '',
    `Listen to your song: ${link}`,
    '',
    '--',
    footer,
    `Unsubscribe: ${unsub}`,
    'hello@laivyhart.com',
  ].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f6f2ea;font-family:Georgia,'Times New Roman',serif;color:#2a1018;">
<div style="max-width:520px;margin:0 auto;padding:28px 22px;">
  <p style="font-size:17px;margin:0 0 14px;">Hi ${escHtml(d.recipient_name)},</p>
  <p style="font-size:19px;line-height:1.45;margin:0 0 6px;"><strong>${escHtml(sender)}</strong> dedicated a song to you.</p>
  <p style="font-size:16px;line-height:1.45;margin:0 0 16px;color:#5a3a44;">${escHtml(line)}.</p>
  ${d.message ? `<p style="font-size:17px;line-height:1.55;font-style:italic;margin:0 0 18px;padding-left:12px;border-left:3px solid #c9a24a;">&ldquo;${escHtml(d.message)}&rdquo;</p>` : ''}
  ${cover ? `<img src="${escHtml(cover)}" width="240" height="240" alt="${escHtml(d.song_title)} cover art" style="display:block;width:240px;height:240px;border-radius:12px;margin:0 0 10px;">` : ''}
  <p style="font-size:16px;margin:0 0 20px;">${escHtml(d.song_title)}</p>
  <p style="margin:0 0 30px;"><a href="${escHtml(link)}" style="display:inline-block;background:#8A2546;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:16px;padding:13px 24px;border-radius:999px;">Listen to your song</a></p>
  <p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#7a6470;margin:0;">${escHtml(footer)}<br>
  <a href="${escHtml(unsub)}" style="color:#7a6470;">Unsubscribe</a> &middot; <a href="mailto:hello@laivyhart.com" style="color:#7a6470;">hello@laivyhart.com</a></p>
</div></body></html>`;
  return { subject: DEDICATION_SUBJECT, text, html, link, unsubscribe: unsub };
}

// What the sender sees for each outcome.
export const DEDICATION_EMAIL_MESSAGES = {
  suppressed: 'We couldn\'t email them, but you can send them the link instead.',
  sender_daily: 'You\'ve sent 5 dedication emails today, the most we send in a day. Your dedication is saved: send it on WhatsApp or copy the link instead.',
  same_address_week: 'You already emailed this address a dedication this week. Your dedication is saved: send it on WhatsApp or copy the link instead.',
  address_week: 'We can\'t email this address again this week. Your dedication is saved: send it on WhatsApp or copy the link instead.',
  failed: 'We couldn\'t send that email just now. Your dedication is saved: send it on WhatsApp or copy the link instead.',
  already_sent: 'This dedication has already been emailed.',
  invalid: 'That doesn\'t look like an email address.',
};

export async function handleDedicationEmail(request, env, ctx, fetchImpl = fetch) {
  const origin = request.headers.get('Origin');
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);
  const hdr = request.headers.get('Authorization') || '';
  const jwt = hdr.startsWith('Bearer ') ? hdr.slice(7) : hdr;
  let sub;
  try { sub = await verifySupabaseJwt(jwt, env); }
  catch (e) { return json({ error: 'Unauthorized: ' + (e && e.message) }, 401, origin); }

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400, origin); }
  const code = body && typeof body.code === 'string' ? body.code.trim() : '';
  const email = body && typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!/^[A-Z0-9]{6,12}$/.test(code)) return json({ error: 'Missing or invalid dedication code' }, 400, origin);
  if (!dedicationEmailValid(email)) {
    return json({ status: 'invalid', message: DEDICATION_EMAIL_MESSAGES.invalid }, 400, origin);
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('dedication email: SUPABASE_SERVICE_ROLE_KEY not set');
    return json({ error: 'Service role key not configured' }, 500, origin);
  }
  const svc = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };
  const rpc = async (name, args) => {
    const res = await fetchImpl(SUPABASE_URL + '/rest/v1/rpc/' + name, { method: 'POST', headers: svc, body: JSON.stringify(args) });
    if (!res.ok) throw new Error(name + ' HTTP ' + res.status);
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  };

  let claim;
  try { claim = await rpc('claim_dedication_email', { p_code: code, p_sender: sub, p_email: email }); }
  catch (e) {
    console.error('dedication email: claim failed', code, e && e.message);
    return json({ status: 'failed', message: DEDICATION_EMAIL_MESSAGES.failed }, 502, origin);
  }
  const status = claim && claim.status;
  if (status === 'not_found') return json({ error: 'Dedication not found' }, 404, origin);
  if (status === 'not_owner') return json({ error: 'That dedication is not yours' }, 403, origin);
  if (status === 'invalid') return json({ status, message: DEDICATION_EMAIL_MESSAGES.invalid }, 400, origin);
  if (status === 'already_sent') return json({ status, message: DEDICATION_EMAIL_MESSAGES.already_sent }, 409, origin);
  if (status === 'suppressed') return json({ status, message: DEDICATION_EMAIL_MESSAGES.suppressed }, 200, origin);
  if (status === 'rate_limited') {
    return json({ status, limit: claim.limit, message: DEDICATION_EMAIL_MESSAGES[claim.limit] || DEDICATION_EMAIL_MESSAGES.address_week }, 429, origin);
  }
  if (status !== 'ok') return json({ status: 'failed', message: DEDICATION_EMAIL_MESSAGES.failed }, 502, origin);

  let sent = false;
  try {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
    const msg = await buildDedicationEmail(claim, email, env);
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: DEDICATION_FROM, to: [email], reply_to: DEDICATION_REPLY_TO,
        subject: msg.subject, text: msg.text, html: msg.html,
        headers: { 'List-Unsubscribe': '<' + msg.unsubscribe + '>' },
      }),
    });
    if (!res.ok) throw new Error('Resend HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
    sent = true;
  } catch (e) {
    console.error('dedication email: send failed', code, e && e.message);
  }
  try { await rpc('finish_dedication_email', { p_code: code, p_status: sent ? 'sent' : 'failed' }); }
  catch (e) { console.error('dedication email: could not record the outcome', code, e && e.message); }
  if (!sent) return json({ status: 'failed', message: DEDICATION_EMAIL_MESSAGES.failed }, 502, origin);
  return json({ status: 'sent', masked: maskEmail(email) }, 200, origin);
}

function unsubscribePage(title, bodyHtml) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escHtml(title)} | Laivy Hart</title>
<style>body{margin:0;background:#f6f2ea;color:#2a1018;font-family:Georgia,'Times New Roman',serif}
main{max-width:30rem;margin:0 auto;padding:3rem 1.4rem;text-align:center}h1{font-size:1.5rem;font-weight:600}
p{font-size:1.05rem;line-height:1.55}button{font:600 1rem Arial,Helvetica,sans-serif;min-height:48px;padding:0 1.6rem;
border:0;border-radius:999px;background:#8A2546;color:#fff;cursor:pointer}a{color:#8A2546}</style></head>
<body><main><h1>${escHtml(title)}</h1>${bodyHtml}<p><a href="${SITE}">Laivy Hart</a> &middot; <a href="mailto:hello@laivyhart.com">hello@laivyhart.com</a></p></main></body></html>`,
  { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/* GET shows one confirming button; POST (that button) does the write. A
   GET never writes, so a mail scanner opening the link cannot unsubscribe
   anyone by itself. */
export async function handleUnsubscribe(request, env, ctx, fetchImpl = fetch) {
  const url = new URL(request.url);
  let email = '';
  try { email = b64urlDecode(url.searchParams.get('e')).toLowerCase(); } catch (e) { email = ''; }
  const sig = url.searchParams.get('s') || '';
  const good = dedicationEmailValid(email) && env.SUPABASE_SERVICE_ROLE_KEY
    && safeEqual(sig, await unsubscribeSig(email, env));
  if (!good) {
    return unsubscribePage('This link does not work', '<p>The unsubscribe link looks incomplete. Write to us and we will take care of it.</p>');
  }
  if (request.method === 'GET') {
    return unsubscribePage('Stop dedication emails?',
      `<p>Tap below and Laivy Hart will never email ${escHtml(maskEmail(email))} about a dedication again.</p>
       <form method="post"><button type="submit">Yes, stop these emails</button></form>`);
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const res = await fetchImpl(SUPABASE_URL + '/rest/v1/rpc/suppress_dedication_email', {
      method: 'POST',
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_email: email }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (e) {
    console.error('unsubscribe: could not record', e && e.message);
    return unsubscribePage('Something went wrong', '<p>We could not save that just now. Please try again in a minute, or write to us.</p>');
  }
  return unsubscribePage('Done', `<p>We won't email ${escHtml(maskEmail(email))} about dedications again.</p>`);
}

export default {
  /* The 03:00 UTC cron (06:00 Jerusalem). See wrangler.toml [triggers]. */
  async scheduled(event, env, ctx) {
    if (!env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('daily report: SUPABASE_SERVICE_ROLE_KEY not set; skipping');
      return;
    }
    ctx.waitUntil(runDailyReport(env.SUPABASE_SERVICE_ROLE_KEY, env)
      .then((r) => console.log('daily report sent:', r.subject))
      .catch((e) => console.error('daily report failed:', e && e.message)));
  },

  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    /* --- /event: activity ingest. No admin token, no artist JWT required --
       an anonymous visitor logs activity too. Checked before the PUT/POST
       method gate below (which would otherwise also accept PUT here) and
       before the UPLOAD_TOKEN gate, for the same reason /upload/avatar is. */
    if (new URL(request.url).pathname === '/event') {
      return handleActivityEvent(request, env, ctx);
    }

    /* --- SEND-1: the dedication email and its unsubscribe page. Before the
       method gate: /unsubscribe answers a GET (the confirming page). --- */
    if (new URL(request.url).pathname === '/unsubscribe') {
      return handleUnsubscribe(request, env, ctx);
    }
    if (new URL(request.url).pathname === '/dedication/email') {
      return handleDedicationEmail(request, env, ctx);
    }

    if (request.method !== 'PUT' && request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, origin);
    }

    /* --- /upload/avatar: any signed-in member, JWT-authorized ------------
       PROFILE-1: checked this route and found it never actually restricted
       to artists -- verifySupabaseJwt() alone decides who may call it, with
       no is_artist/role check anywhere below. The comment above used to say
       "artists" because that was the only kind of member with a page to put
       an avatar on; now every member has one (/u/<handle>), so the comment
       is corrected to match the code, which needs no change itself.
       Handled BEFORE the UPLOAD_TOKEN check below, because an ordinary
       member does not have (and must never be given) the admin token. The
       only key this route will ever write is avatars/<sub>/<timestamp>.jpg,
       where <sub> comes from the verified token and not from anything the
       caller sent, so there is no path for one member to write into
       another's prefix. */
    if (new URL(request.url).pathname === '/upload/avatar') {
      if (request.method !== 'POST' && request.method !== 'PUT') {
        return json({ error: 'Method not allowed' }, 405, origin);
      }
      const hdr = request.headers.get('Authorization') || '';
      const jwt = hdr.startsWith('Bearer ') ? hdr.slice(7) : hdr;
      let sub;
      try {
        sub = await verifySupabaseJwt(jwt, env);
      } catch (e) {
        return json({ error: 'Unauthorized: ' + (e && e.message) }, 401, origin);
      }

      if (!request.body) return json({ error: 'Empty body' }, 400, origin);
      const declared = Number(request.headers.get('Content-Length') || 0);
      if (declared && declared > AVATAR_MAX_BYTES) {
        return json({ error: 'Image too large' }, 413, origin);
      }
      // Content-Length can be absent or wrong, so measure what actually arrived.
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength === 0) return json({ error: 'Empty body' }, 400, origin);
      if (bytes.byteLength > AVATAR_MAX_BYTES) {
        return json({ error: 'Image too large' }, 413, origin);
      }

      const key = `avatars/${sub}/${Date.now()}.jpg`;
      try {
        await env.AUDIO_BUCKET.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
      } catch (e) {
        return json({ error: 'Upload failed: ' + (e && e.message) }, 500, origin);
      }
      return json({ url: PUBLIC_BASE + '/' + key, key }, 200, origin);
    }

    /* --- /report/send: the admin's on-demand report. JWT-verified here, and
       then the RPC is called with the admin's OWN token so the database's
       is_admin() guard is what actually authorizes it. --- */
    if (new URL(request.url).pathname === '/report/send') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);
      const hdr = request.headers.get('Authorization') || '';
      const jwt = hdr.startsWith('Bearer ') ? hdr.slice(7) : hdr;
      try { await verifySupabaseJwt(jwt, env); }
      catch (e) { return json({ error: 'Unauthorized: ' + (e && e.message) }, 401, origin); }
      try {
        const r = await runDailyReport(jwt, env);
        return json({ ok: true, subject: r.subject }, 200, origin);
      } catch (e) {
        const m = (e && e.message) || 'failed';
        // The database's own refusal for a non-admin comes back as a 403,
        // everything else as a 502 so the admin sees which side failed.
        return json({ error: m }, /Only an admin/.test(m) ? 403 : 502, origin);
      }
    }

    /* --- /notify/song-idea: the admin's Pick/Released email (SONG-2). --- */
    if (new URL(request.url).pathname === '/notify/song-idea') {
      return handleSongIdeaNotify(request, env, ctx);
    }

    /* --- /upload/audio and /upload/cover: contributors, JWT-authorized ---
       Placed with the avatar route, BEFORE the UPLOAD_TOKEN gate, for the same
       reason: a contributor does not have the admin token and must not. */
    {
      const path = new URL(request.url).pathname;
      const kind = path === '/upload/audio' ? 'audio'
                 : path === '/upload/cover' ? 'cover' : null;
      if (kind) {
        const hdr = request.headers.get('Authorization') || '';
        const jwt = hdr.startsWith('Bearer ') ? hdr.slice(7) : hdr;
        let sub;
        try {
          sub = await verifySupabaseJwt(jwt, env);
        } catch (e) {
          return json({ error: 'Unauthorized: ' + (e && e.message) }, 401, origin);
        }

        const ogFor = kind === 'cover' ? new URL(request.url).searchParams.get('og_for') : null;
        let ogKey = null;
        if (ogFor != null) {
          try { ogKey = ogKeyFor(ogFor); } catch (e) { return json({ error: 'Bad song id' }, 400, origin); }
          if (!(await songOwnedBy(ogFor, sub, env))) return json({ error: 'Not your song' }, 403, origin);
        }

        const max = kind === 'audio' ? AUDIO_MAX_BYTES : (ogKey ? OG_MAX_BYTES : COVER_MAX_BYTES);
        const declared = Number(request.headers.get('Content-Length') || 0);
        if (declared && declared > max) {
          return json({ error: kind === 'audio' ? 'Audio too large' : 'Image too large' }, 413, origin);
        }

        let ext = 'jpg';
        let storedType = 'image/jpeg';
        if (kind === 'audio') {
          ext = audioExtFor(request.headers.get('Content-Type'));
          if (!ext) {
            return json({ error: 'Unsupported audio type. Send MP3, M4A or WAV.' }, 415, origin);
          }
          storedType = String(request.headers.get('Content-Type')).split(';')[0].trim().toLowerCase();
        }

        if (!request.body) return json({ error: 'Empty body' }, 400, origin);
        // Content-Length can be absent or a lie, so measure what arrived.
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength === 0) return json({ error: 'Empty body' }, 400, origin);
        if (bytes.byteLength > max) {
          return json({ error: kind === 'audio' ? 'Audio too large' : 'Image too large' }, 413, origin);
        }

        let key = ogKey;
        if (!key) {
          try {
            key = uploadKeyFor(kind, sub, crypto.randomUUID(), ext);
          } catch (e) {
            return json({ error: 'Bad upload target' }, 400, origin);
          }
        }
        try {
          await env.AUDIO_BUCKET.put(key, bytes, {
            httpMetadata: ogKey ? { contentType: 'image/jpeg', cacheControl: 'public, max-age=86400' } : { contentType: storedType },
          });
        } catch (e) {
          return json({ error: 'Upload failed: ' + (e && e.message) }, 500, origin);
        }
        return json({ url: PUBLIC_BASE + '/' + key, key }, 200, origin);
      }
    }

    // --- Auth (shared by /publish and the admin upload route) ---
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (!env.UPLOAD_TOKEN || !safeEqual(token, env.UPLOAD_TOKEN)) {
      return json({ error: 'Unauthorized' }, 401, origin);
    }

    const url = new URL(request.url);

    // --- Publish: trigger a Vercel redeploy via the stored deploy hook. ---
    // The deploy rebuilds the site, which regenerates songs.json from the live
    // database (see vercel.json buildCommand). The hook URL is a Worker secret.
    if (url.pathname === '/publish') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, origin);
      if (!env.DEPLOY_HOOK_URL) return json({ error: 'Deploy hook not configured' }, 500, origin);
      try {
        const hookRes = await fetch(env.DEPLOY_HOOK_URL, { method: 'POST' });
        if (!hookRes.ok) return json({ error: 'Deploy hook failed: HTTP ' + hookRes.status }, 502, origin);
        let job = null;
        try { const j = await hookRes.json(); job = (j && j.job && j.job.id) || null; } catch (e) { /* non-JSON is fine */ }
        return json({ ok: true, job }, 200, origin);
      } catch (e) {
        return json({ error: 'Deploy hook error: ' + (e && e.message) }, 502, origin);
      }
    }

    // --- Filename (upload route) ---
    let filename = (url.searchParams.get('filename') || request.headers.get('X-Filename') || '').trim();
    if (!filename) return json({ error: 'Missing filename' }, 400, origin);
    // filename is a single name, never a path (folders go via ?folder=).
    if (filename.includes('/') || filename.includes('..')) {
      return json({ error: 'Invalid filename' }, 400, origin);
    }

    // --- Optional folder/prefix (e.g. "covers"); a single simple segment. ---
    let folder = (url.searchParams.get('folder') || '').trim().replace(/^\/+|\/+$/g, '');
    if (folder && !/^[a-zA-Z0-9_-]+$/.test(folder)) {
      return json({ error: 'Invalid folder' }, 400, origin);
    }
    const key = folder ? folder + '/' + filename : filename;

    if (!request.body) return json({ error: 'Empty body' }, 400, origin);

    const contentType = request.headers.get('Content-Type') || 'audio/mpeg';

    try {
      await env.AUDIO_BUCKET.put(key, request.body, {
        httpMetadata: { contentType },
      });
    } catch (e) {
      return json({ error: 'Upload failed: ' + (e && e.message) }, 500, origin);
    }

    // The R2 key is the raw path; the public URL percent-encodes the filename
    // (spaces -> %20, parentheses left literal), matching the existing files.
    const publicUrl = PUBLIC_BASE + '/' + (folder ? folder + '/' : '') + encodeURIComponent(filename);
    return json({ url: publicUrl, key }, 200, origin);
  },
};
