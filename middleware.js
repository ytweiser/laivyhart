/* ============================================================
   Laivy Hart — Vercel Edge Middleware: crawlable song and artist pages.

   Social and messaging crawlers (WhatsApp, iMessage, Facebook, X, LinkedIn)
   and search engines do NOT run JavaScript. Without this they see the generic
   index.html shell for every URL on the site. This runs at the edge, looks the
   song or artist up in the committed snapshots, and rewrites the served HTML:
   a real <title>, description, canonical, OG/Twitter tags, a hidden static
   body carrying the lyrics, and JSON-LD.

   Four route families:
     /?song=<id>       legacy link  -> 301 to /song/<slug>
     /song/<slug>      full render + MusicRecording JSON-LD
     /artist/<handle>  full render + MusicGroup JSON-LD
     /                 description + canonical only

   DATA: the two build-time snapshots, imported so the edge function carries
   them and no request does a second round trip. At 37 songs this is a few
   hundred KB and entirely fine; when the catalogue reaches the thousands, swap
   the two lookups for a per-slug Supabase REST fetch (the anon key already sits
   in this file) and keep everything else.

   NO SECRETS. Only the publishable values, identical to config.js. The service
   role key must never appear here.

   DEFENSIVE THROUGHOUT: every path is wrapped so that a malformed snapshot, a
   missing field or a failed shell fetch falls through to the untouched shell.
   A page that renders beats a 500.
   ============================================================ */

import SONGS from './songs.json';
import ARTISTS from './artists.json';

export const config = {
  // Middleware runs before rewrites, so these are the real request paths.
  // index.html, songs.json and every static asset are deliberately absent, so
  // the internal fetches below cannot re-enter this function.
  matcher: ['/', '/song/:path*', '/artist/:path*'],
};

const SITE = 'https://www.laivyhart.com';
const SITE_NAME = 'Laivy Hart';
const DEFAULT_OG_IMAGE = 'https://laivyhart.com/og-image.png';
const DEFAULT_DESC = 'Original songs. Sometimes stories, sometimes prayers.';

/* Crawlers (WhatsApp especially) silently drop large og:images, and the raw
   covers are multi-megabyte PNGs. This is the same wsrv.nl transform the site
   has used since that bug was fixed; og:image must never be the raw object. */
function cdnImage(url, w) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return 'https://wsrv.nl/?url=' + encodeURIComponent(url) + '&w=' + w + '&output=jpg&q=80';
}

function escAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// First sentence of a note, flattened and capped, for meta description.
function firstSentence(text, cap) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  let out = m ? m[1] : flat;
  if (out.length > cap) out = out.slice(0, cap - 1).replace(/\s+\S*$/, '') + '…';
  return out;
}

// Seconds -> ISO-8601 duration, which is what schema.org expects.
function isoDuration(secs) {
  const n = Number(secs);
  if (!isFinite(n) || n <= 0) return null;
  const m = Math.floor(n / 60), s = Math.round(n % 60);
  return 'PT' + (m ? m + 'M' : '') + s + 'S';
}

// Replace a meta tag's content in place, leaving the rest of the tag alone.
function setMeta(html, attr, key, value) {
  const re = new RegExp('(<meta ' + attr + '="' + key + '" content=")[^"]*(">)');
  return html.replace(re, (m, p1, p2) => p1 + value + p2);
}

/* index.html carries no description and no canonical, so those two have to be
   inserted rather than replaced. Replace when present, insert before </head>
   otherwise, so this stays correct if they are added to the shell later. */
function upsertMeta(html, attr, key, value) {
  const re = new RegExp('<meta ' + attr + '="' + key + '" content="[^"]*">');
  const tag = '<meta ' + attr + '="' + key + '" content="' + value + '">';
  return re.test(html) ? html.replace(re, tag) : html.replace('</head>', tag + '\n</head>');
}
function upsertCanonical(html, href) {
  const tag = '<link rel="canonical" href="' + href + '">';
  return /<link rel="canonical"[^>]*>/.test(html)
    ? html.replace(/<link rel="canonical"[^>]*>/, tag)
    : html.replace('</head>', tag + '\n</head>');
}
function setTitle(html, title) {
  return html.replace(/<title>[^<]*<\/title>/, () => '<title>' + title + '</title>');
}
function addNoindex(html) {
  return html.replace('</head>', '<meta name="robots" content="noindex">\n</head>');
}
function addJsonLd(html, obj) {
  // </ inside a JSON string would close the script element early.
  const json = JSON.stringify(obj).replace(/</g, '\\u003c');
  return html.replace('</head>', '<script type="application/ld+json">' + json + '</script>\n</head>');
}

/* The static body. hidden, so it never affects layout or paint; the app strips
   #ssr on boot. This is what a crawler actually reads. */
function injectSsr(html, inner) {
  const block = '<section id="ssr" hidden>' + inner + '</section>';
  // Before the app's first real container, falling back to right after <body>.
  if (html.includes('<div class="app')) return html.replace('<div class="app', block + '\n<div class="app');
  return html.replace(/(<body[^>]*>)/, (m) => m + '\n' + block);
}

const isHebrew = (s) => /[֐-׿]/.test(String(s || ''));

/* ---------------- lookups ---------------- */

function songBySlug(slug) {
  if (!slug) return null;
  const want = String(slug).toLowerCase();
  return SONGS.find((s) => s && s.slug && String(s.slug).toLowerCase() === want) || null;
}
function songById(id) {
  if (!id) return null;
  return SONGS.find((s) => s && s.id === id) || null;
}
function artistByHandle(handle) {
  if (!handle) return null;
  const want = String(handle).toLowerCase();
  return ARTISTS.find((a) => a && a.handle && String(a.handle).toLowerCase() === want) || null;
}
function songsOfArtist(a) {
  return SONGS.filter((s) => s && (s.artist_id === a.id || (s.artist && s.artist.handle === a.handle)));
}

/* ---------------- renderers ---------------- */

function renderSong(html, song) {
  const artist = song.artist || null;
  const artistName = artist ? (artist.name || artist.handle) : SITE_NAME;
  const canonical = SITE + '/song/' + encodeURIComponent(song.slug);
  const heading = song.title || song.title_translit || 'Untitled';
  const pageTitle = heading + ', by ' + artistName;
  const desc = firstSentence(song.about, 160) || 'An original song on ' + SITE_NAME + '.';
  const image = cdnImage(song.cover_url, 1200) || DEFAULT_OG_IMAGE;
  const lang = song.language === 'English' ? 'en' : 'he';

  html = setTitle(html, escAttr(pageTitle + ' | ' + SITE_NAME));
  html = upsertMeta(html, 'name', 'description', escAttr(desc));
  html = upsertCanonical(html, escAttr(canonical));
  html = setMeta(html, 'property', 'og:title', escAttr(pageTitle));
  html = setMeta(html, 'property', 'og:description', escAttr(desc));
  html = setMeta(html, 'property', 'og:url', escAttr(canonical));
  html = setMeta(html, 'property', 'og:image', escAttr(image));
  html = setMeta(html, 'property', 'og:type', 'music.song');
  html = setMeta(html, 'name', 'twitter:title', escAttr(pageTitle));
  html = setMeta(html, 'name', 'twitter:description', escAttr(desc));
  html = setMeta(html, 'name', 'twitter:image', escAttr(image));
  html = setMeta(html, 'name', 'twitter:card', 'summary_large_image');
  // wsrv keeps each cover's own aspect ratio, so the shell's 1200x630 hints
  // would be a lie for a cover. They describe the default og-image only.
  if (song.cover_url) {
    html = html
      .replace(/\s*<meta property="og:image:width" content="[^"]*">/, '')
      .replace(/\s*<meta property="og:image:height" content="[^"]*">/, '');
  }

  const titleDir = isHebrew(song.title) ? ' dir="rtl" lang="he"' : ' lang="en"';
  let body = '<h1' + titleDir + '>' + escHtml(song.title) + '</h1>';
  if (song.title_translit) body += '<p lang="en" dir="ltr">' + escHtml(song.title_translit) + '</p>';
  body += '<p>by ' + (artist
    ? '<a href="/artist/' + escAttr(artist.handle) + '">' + escHtml(artistName) + '</a>'
    : escHtml(artistName)) + '</p>';
  if (song.about) body += '<p>' + escHtml(song.about) + '</p>';
  if (song.lyrics_original) {
    body += '<div' + (isHebrew(song.lyrics_original) ? ' lang="he" dir="rtl"' : ' lang="en" dir="ltr"') + '>'
          + escHtml(song.lyrics_original).replace(/\n/g, '<br>') + '</div>';
  }
  if (song.lyrics_translation) {
    body += '<div lang="en" dir="ltr">' + escHtml(song.lyrics_translation).replace(/\n/g, '<br>') + '</div>';
  }
  html = injectSsr(html, body);

  // Only fields we actually have. Omitted beats null.
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'MusicRecording',
    name: song.title,
    url: canonical,
    inLanguage: lang,
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE + '/' },
  };
  if (artist) {
    ld.byArtist = { '@type': 'MusicGroup', name: artistName, url: SITE + '/artist/' + artist.handle };
  }
  if (song.cover_url) ld.image = image;
  if (song.about) ld.description = desc;
  const published = song.reviewed_at || song.created_at;
  if (published) ld.datePublished = String(published).slice(0, 10);
  const dur = isoDuration(song.duration_seconds != null ? song.duration_seconds : song.length_seconds);
  if (dur) ld.duration = dur;
  if (song.lyrics_original) {
    ld.recordingOf = {
      '@type': 'MusicComposition',
      name: song.title,
      lyrics: { '@type': 'CreativeWork', text: song.lyrics_original },
    };
  }
  return addJsonLd(html, ld);
}

function renderArtist(html, artist) {
  const name = artist.name || artist.handle;
  const canonical = SITE + '/artist/' + encodeURIComponent(artist.handle);
  const desc = firstSentence(artist.bio, 160) || 'Original songs on ' + SITE_NAME + '.';
  const image = cdnImage(artist.avatar, 1200) || DEFAULT_OG_IMAGE;
  const mine = songsOfArtist(artist);

  html = setTitle(html, escAttr(name + ' | ' + SITE_NAME));
  html = upsertMeta(html, 'name', 'description', escAttr(desc));
  html = upsertCanonical(html, escAttr(canonical));
  html = setMeta(html, 'property', 'og:title', escAttr(name + ' | ' + SITE_NAME));
  html = setMeta(html, 'property', 'og:description', escAttr(desc));
  html = setMeta(html, 'property', 'og:url', escAttr(canonical));
  html = setMeta(html, 'property', 'og:image', escAttr(image));
  html = setMeta(html, 'property', 'og:type', 'profile');
  html = setMeta(html, 'name', 'twitter:title', escAttr(name + ' | ' + SITE_NAME));
  html = setMeta(html, 'name', 'twitter:description', escAttr(desc));
  html = setMeta(html, 'name', 'twitter:image', escAttr(image));
  html = setMeta(html, 'name', 'twitter:card', 'summary_large_image');
  if (artist.avatar) {
    html = html
      .replace(/\s*<meta property="og:image:width" content="[^"]*">/, '')
      .replace(/\s*<meta property="og:image:height" content="[^"]*">/, '');
  }

  let body = '<h1>' + escHtml(name) + '</h1>';
  if (artist.name_he) body += '<p lang="he" dir="rtl">' + escHtml(artist.name_he) + '</p>';
  if (artist.bio) body += '<p>' + escHtml(artist.bio).replace(/\n/g, '<br>') + '</p>';
  if (mine.length) {
    body += '<ul>' + mine.map((s) =>
      '<li><a href="/song/' + escAttr(s.slug || '') + '">' + escHtml(s.title || s.title_translit || '') + '</a></li>'
    ).join('') + '</ul>';
  }
  html = injectSsr(html, body);

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'MusicGroup',
    name,
    url: canonical,
    description: desc,
  };
  if (artist.avatar) ld.image = image;
  if (mine.length) {
    ld.track = mine.map((s) => ({
      '@type': 'MusicRecording',
      name: s.title,
      url: SITE + '/song/' + s.slug,
    }));
  }
  return addJsonLd(html, ld);
}

function renderHome(html) {
  html = upsertMeta(html, 'name', 'description', escAttr(DEFAULT_DESC));
  return upsertCanonical(html, SITE + '/');
}

/* ------------------------------------------------------------
   The routing decision, split out from the request plumbing so it can be
   exercised directly in tests without a Vercel runtime.
   Returns { kind: 'redirect', location } | { kind: 'render', fn } | null.
   ------------------------------------------------------------ */
export function decide(pathname, searchParams) {
  // Legacy share link. Everything already sent to WhatsApp keeps landing.
  if (pathname === '/') {
    const id = searchParams && searchParams.get('song');
    if (id) {
      const song = songById(id);
      if (song && song.status === 'approved' && song.slug) {
        return { kind: 'redirect', location: '/song/' + encodeURIComponent(song.slug) };
      }
      return { kind: 'redirect', location: '/' };
    }
    return { kind: 'render', fn: renderHome, tag: 'home' };
  }

  let m = /^\/song\/([^/]+)\/?$/.exec(pathname);
  if (m) {
    let slug; try { slug = decodeURIComponent(m[1]); } catch (e) { slug = m[1]; }
    const song = songBySlug(slug);
    if (!song || song.status !== 'approved') {
      return { kind: 'render', fn: addNoindex, tag: 'song-404' };
    }
    return { kind: 'render', fn: (h) => renderSong(h, song), tag: 'song' };
  }

  m = /^\/artist\/([^/]+)\/?$/.exec(pathname);
  if (m) {
    let handle; try { handle = decodeURIComponent(m[1]); } catch (e) { handle = m[1]; }
    const artist = artistByHandle(handle);
    // Absent from artists.json means unknown, suspended or deleted. All three
    // should be noindex, and all three get there without extra logic.
    if (!artist) return { kind: 'render', fn: addNoindex, tag: 'artist-404' };
    return { kind: 'render', fn: (h) => renderArtist(h, artist), tag: 'artist' };
  }

  return null;
}

export default async function middleware(request) {
  let url;
  try { url = new URL(request.url); } catch (e) { return; }

  let plan = null;
  try { plan = decide(url.pathname, url.searchParams); }
  catch (e) { return; }                       // malformed snapshot: serve the shell
  if (!plan) return;

  if (plan.kind === 'redirect') {
    return new Response(null, {
      status: 301,
      headers: { location: plan.location, 'cache-control': 'public, s-maxage=86400' },
    });
  }

  let html;
  try {
    const res = await fetch(new URL('/index.html', request.url));
    if (!res.ok) return;
    html = await res.text();
  } catch (e) { return; }

  try { html = plan.fn(html); }
  catch (e) { /* serve the shell unmodified rather than failing the request */ }

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, s-maxage=300, stale-while-revalidate=86400',
      'x-laivy-og': plan.tag,
    },
  });
}
