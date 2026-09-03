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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'PUT' && request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, origin);
    }

    // --- Auth ---
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (!env.UPLOAD_TOKEN || !safeEqual(token, env.UPLOAD_TOKEN)) {
      return json({ error: 'Unauthorized' }, 401, origin);
    }

    // --- Filename ---
    const url = new URL(request.url);
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
