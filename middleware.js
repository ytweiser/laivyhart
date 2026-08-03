/* ============================================================
   Laivy Hart - Vercel Edge Middleware: per-song link previews.

   Social and messaging crawlers (WhatsApp, iMessage, Facebook, X,
   LinkedIn) do NOT run JavaScript, so they only see the static index.html
   Open Graph tags. This middleware runs at the edge for the homepage and,
   when the URL carries ?song=<id>, looks the song up in Supabase (public
   read-only anon key) and rewrites the OG + Twitter tags in the served
   HTML so each shared link previews with that song's title, transliteration,
   and cover art. Requests without ?song are passed through untouched.

   It uses only Web-standard APIs (fetch, URL, Response) so no npm install
   or package.json is needed for this static site.
   ============================================================ */

export const config = {
  // Only run on the homepage path. Static assets, admin.html, about.html,
  // and /index.html itself are never intercepted (so there is no fetch loop).
  matcher: '/',
};

// These are the PUBLIC publishable values (identical to config.js) and are
// safe to expose. They can be overridden with Vercel env vars if you prefer.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://tshkrghrgokplakktvik.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_nvhaOpLWBxZxo7X7tRtCWw_QhQ82dV4';
const DEFAULT_OG_IMAGE = 'https://laivyhart.com/og-image.png';

function escapeAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Replace a single <meta ...> tag's content, leaving the rest of the tag intact.
function setMeta(html, attr, key, value) {
  const re = new RegExp('(<meta ' + attr + '="' + key + '" content=")[^"]*(">)');
  return html.replace(re, (m, p1, p2) => p1 + value + p2);
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const id = url.searchParams.get('song');

  // No ?song -> let Vercel serve the static homepage with its default tags.
  if (!id) return;

  let song = null;
  try {
    const api = SUPABASE_URL + '/rest/v1/songs?id=eq.' + encodeURIComponent(id) +
      '&select=title,title_translit,cover_url&limit=1';
    const r = await fetch(api, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
    });
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length) song = rows[0];
    }
  } catch (e) {
    // fall through to default tags on any lookup failure
  }

  // Unknown/invalid song id -> default tags.
  if (!song || !song.title) return;

  // Fetch the raw static homepage HTML to rewrite (matcher '/' never matches
  // '/index.html', so this does not re-enter the middleware).
  let html;
  try {
    const res = await fetch(new URL('/index.html', request.url));
    if (!res.ok) return;
    html = await res.text();
  } catch (e) {
    return;
  }

  const title = escapeAttr(song.title);
  const desc = escapeAttr(song.title_translit || 'Original songs. Sometimes stories, sometimes prayers.');
  const hasCover = song.cover_url && /^https?:\/\//i.test(song.cover_url);
  // Crawlers (WhatsApp especially) silently drop large og:images, and the raw
  // covers are multi-megabyte PNGs. Serve a small resized JPEG through the
  // wsrv.nl image CDN so the preview actually renders. The default og-image is
  // already small, so it is used directly.
  const image = hasCover
    ? 'https://wsrv.nl/?url=' + encodeURIComponent(song.cover_url) + '&w=1200&output=jpg&q=80'
    : DEFAULT_OG_IMAGE;
  const imageAttr = escapeAttr(image);
  // Canonical host: middleware runs on www (the bare domain 308-redirects here).
  const pageUrl = escapeAttr('https://www.laivyhart.com/?song=' + id);

  html = setMeta(html, 'property', 'og:title', title);
  html = setMeta(html, 'property', 'og:description', desc);
  html = setMeta(html, 'property', 'og:url', pageUrl);
  html = setMeta(html, 'property', 'og:image', imageAttr);
  html = setMeta(html, 'name', 'twitter:title', title);
  html = setMeta(html, 'name', 'twitter:description', desc);
  html = setMeta(html, 'name', 'twitter:image', imageAttr);
  html = html.replace(/<title>[^<]*<\/title>/, () => '<title>' + title + '</title>');
  // The static 1200x630 dimensions describe the default og-image only. wsrv keeps
  // each cover's own aspect ratio, so drop the hints for covers to avoid lying.
  if (hasCover) {
    html = html
      .replace(/\s*<meta property="og:image:width" content="[^"]*">/, '')
      .replace(/\s*<meta property="og:image:height" content="[^"]*">/, '');
  }

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Per-song URL is unique, so the CDN caches each song separately; keep it
      // fresh-ish so title/cover edits propagate. Marker header aids testing.
      'cache-control': 'public, s-maxage=300, stale-while-revalidate=86400',
      'x-laivy-og': 'song',
    },
  });
}
