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
  L.push('— sent by the Laivy Hart report job');
  return { subject, text: L.join('\n') };
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

  async fetch(request, env) {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'PUT' && request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, origin);
    }

    /* --- /upload/avatar: signed-in artists, JWT-authorized ---------------
       Handled BEFORE the UPLOAD_TOKEN check below, because an ordinary artist
       does not have (and must never be given) the admin token. The only key
       this route will ever write is avatars/<sub>/<timestamp>.jpg, where <sub>
       comes from the verified token and not from anything the caller sent, so
       there is no path for one artist to write into another's prefix. */
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

        const max = kind === 'audio' ? AUDIO_MAX_BYTES : COVER_MAX_BYTES;
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

        let key;
        try {
          key = uploadKeyFor(kind, sub, crypto.randomUUID(), ext);
        } catch (e) {
          return json({ error: 'Bad upload target' }, 400, origin);
        }
        try {
          await env.AUDIO_BUCKET.put(key, bytes, { httpMetadata: { contentType: storedType } });
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
