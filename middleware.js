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
  matcher: ['/', '/song/:path*', '/artist/:path*', '/d/:path*', '/u/:path*', '/your-song'],
};

const SITE = 'https://laivyhart.com';
const SITE_NAME = 'Laivy Hart';
const DEFAULT_OG_IMAGE = 'https://laivyhart.com/og-image.png';
const DEFAULT_DESC = 'Original songs. Sometimes stories, sometimes prayers.';

// DED-2: /d/<code> is not in either build-time snapshot -- a dedication can
// be created at any moment, independent of a deploy -- so this is the one
// route that reads live from Supabase instead. Publishable values only,
// identical to config.js; the service role key must never appear here.
const DED_SUPABASE_URL = 'https://tshkrghrgokplakktvik.supabase.co';
const DED_SUPABASE_ANON_KEY = 'sb_publishable_nvhaOpLWBxZxo7X7tRtCWw_QhQ82dV4';

/* Crawlers (WhatsApp especially) silently drop large og:images, and the raw
   covers are multi-megabyte PNGs. This is the same wsrv.nl transform the site
   has used since that bug was fixed; og:image must never be the raw object. */
function cdnImage(url, w) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return 'https://wsrv.nl/?url=' + encodeURIComponent(url) + '&w=' + w + '&output=jpg&q=80';
}

/* PLAY-1: every song's share preview is its own cover, never the logo.
   og/<song-id>.jpg in R2 is a square 600x600 JPEG under 200 KB, made for
   exactly this (scripts/make-og-images.mjs, the upload form, the admin);
   songs.json carries it as og_image only once a HEAD confirmed the file
   exists. Fallback, for a cover whose share file is not confirmed yet: a
   square 600x600 wsrv crop of the cover, so the size hints below stay true.
   No user-agent check anywhere in this file: WhatsApp, a phone browser and a
   request with no user agent all get the same tags; people still get the
   normal app, because the app boots on top of this same HTML. */
const OG_BASE = 'https://pub-75904c6ec4a240bbaa60162b9258ba52.r2.dev/og/';
const OG_SIZE = 600;
function squareCdn(url, fx, fy) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  let out = 'https://wsrv.nl/?url=' + encodeURIComponent(url) + '&w=' + OG_SIZE + '&h=' + OG_SIZE + '&fit=cover';
  if (fx != null && fy != null && isFinite(fx) && isFinite(fy)) {
    out += '&a=focal&fpx=' + (Number(fx) / 100).toFixed(2) + '&fpy=' + (Number(fy) / 100).toFixed(2);
  }
  return out + '&output=jpg&q=80';
}
function songOgImage(song) {
  if (!song) return null;
  if (song.og_image) return song.og_image;
  return squareCdn(song.cover_url, song.cover_focus_x, song.cover_focus_y)
    || (song.id ? OG_BASE + encodeURIComponent(song.id) + '.jpg' : null);
}
/* Exactly one og:image on the page: drop every og:image* tag the shell
   carries (the logo and its 1200x630 hints) and write the full set for this
   image, plus the matching twitter tags. */
function setOgImage(html, image, alt) {
  html = html.replace(/\s*<meta property="og:image(?::[a-z_]+)?" content="[^"]*">/g, '');
  html = html.replace(/\s*<meta name="twitter:image(?::alt)?" content="[^"]*">/g, '');
  const block = [
    '<meta property="og:image" content="' + escAttr(image) + '">',
    '<meta property="og:image:secure_url" content="' + escAttr(image) + '">',
    '<meta property="og:image:type" content="image/jpeg">',
    '<meta property="og:image:width" content="' + OG_SIZE + '">',
    '<meta property="og:image:height" content="' + OG_SIZE + '">',
    '<meta property="og:image:alt" content="' + escAttr(alt) + '">',
    '<meta name="twitter:image" content="' + escAttr(image) + '">',
    '<meta name="twitter:image:alt" content="' + escAttr(alt) + '">',
  ].join('\n');
  html = /<meta name="twitter:card"[^>]*>/.test(html)
    ? html.replace(/<meta name="twitter:card"[^>]*>/, (m) => block + '\n' + m)
    : html.replace('</head>', block + '\n</head>');
  return setMeta(html, 'name', 'twitter:card', 'summary_large_image');
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

// ARTIST-2: EARNED-only, same six badges and same phrasing as index.html's
// own TROPHY_LABELS (BADGE-3) -- kept as a second copy rather than a shared
// import because this file and index.html load in different runtimes
// (edge function vs. browser) with no shared module between them, the same
// reason js/supabase-client.js's own header gives for why config duplicates.
const TROPHY_LABELS = {
  hit_number_one: (n) => `Hit #1: ${n} song${n === 1 ? '' : 's'}`,
  weeks_at_number_one: (n) => `${n} week${n === 1 ? '' : 's'} at #1`,
  weeks_on_chart: (n) => `${n} week${n === 1 ? '' : 's'} on the chart`,
  best_words: (n) => `Best words: ${n} song${n === 1 ? '' : 's'}`,
  best_music: (n) => `Best music: ${n} song${n === 1 ? '' : 's'}`,
  was_most_loved: (n) => `Was most loved: ${n} song${n === 1 ? '' : 's'}`,
  idea_made_into_song: (n) => n === 1 ? 'Idea made into a song' : `${n} ideas made into songs`,
};

// "Sep 2026" from a plain "YYYY-MM-DD" -- artist_stats' `since` column, as
// snapshot-songs.mjs writes it into artists.json.
function monthYear(dateStr) {
  const d = new Date(String(dateStr || '').slice(0, 10) + 'T00:00:00Z');
  return isFinite(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : null;
}

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
  // songs.json embeds the live shape { handle, display_name, avatar_url } (HERO-2).
  const artistName = artist ? (artist.display_name || artist.handle) : SITE_NAME;
  const canonical = SITE + '/song/' + encodeURIComponent(song.slug);
  const heading = song.title || song.title_translit || 'Untitled';
  const pageTitle = heading + ', by ' + artistName;
  const desc = firstSentence(song.about, 160) || 'An original song on ' + SITE_NAME + '.';
  const image = songOgImage(song);
  const lang = song.language === 'English' ? 'en' : 'he';

  html = setTitle(html, escAttr(pageTitle + ' | ' + SITE_NAME));
  html = upsertMeta(html, 'name', 'description', escAttr(desc));
  html = upsertCanonical(html, escAttr(canonical));
  html = setMeta(html, 'property', 'og:title', escAttr(pageTitle));
  html = setMeta(html, 'property', 'og:description', escAttr(desc));
  html = setMeta(html, 'property', 'og:url', escAttr(canonical));
  html = setMeta(html, 'property', 'og:type', 'music.song');
  html = setMeta(html, 'name', 'twitter:title', escAttr(pageTitle));
  html = setMeta(html, 'name', 'twitter:description', escAttr(desc));
  html = setOgImage(html, image, heading);

  const titleDir = isHebrew(song.title) ? ' dir="rtl" lang="he"' : ' lang="en"';
  let body = '<h1' + titleDir + '>' + escHtml(song.title) + '</h1>';
  if (song.title_translit) body += '<p lang="en" dir="ltr">' + escHtml(song.title_translit) + '</p>';
  body += '<p>by ' + (artist
    ? '<a href="/artist/' + escAttr(artist.handle) + '">' + escHtml(artistName) + '</a>'
    : escHtml(artistName)) + '</p>';
  if (song.about) body += '<p>' + escHtml(song.about) + '</p>';
  // SONG-1: songs.idea_credit, set once at release. "Anonymous" when the
  // submitter asked to stay anonymous, same wording the client uses.
  if (song.idea_credit) body += '<p>Idea by ' + escHtml(song.idea_credit) + '</p>';
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
  ld.image = image;
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

  // ARTIST-2: mood chips, the stats strip, and the trophy shelf -- the three
  // pieces that sit above the fold on the client render, so a crawler (and
  // anyone with JS off) sees the same thing a visitor's first paint does.
  // Honors/Success/Picks/Catalog/Listeners/Try-these stay client-only: they
  // are either live-only (recommendations, comments) or simply not worth a
  // crawler's attention the way the header and the trophy case are.
  if (artist.mood_chips && artist.mood_chips.length) {
    body += '<ul>' + artist.mood_chips.map((c) =>
      '<li><a href="/listen?channel=' + escAttr(c.id) + '">' + escHtml(c.title) + '</a></li>',
    ).join('') + '</ul>';
  }
  if (artist.stats) {
    const st = artist.stats;
    const since = monthYear(st.since);
    body += '<ul>'
      + '<li>' + (st.songs || 0) + ' songs</li>'
      + '<li>' + (st.weeks_on_chart || 0) + ' weeks on the chart</li>'
      + '<li>' + (st.hearts || 0) + ' hearts</li>'
      + '<li>' + (st.comments || 0) + ' comments</li>'
      + (since ? '<li>Since ' + since + '</li>' : '')
      + '</ul>';
  }
  // ARTIST-3 step 16: there is no Follow button here (no JS, no auth to
  // check), so the count is the only thing that CAN render -- the same
  // treatment the client gives the owner's own page.
  {
    const n = artist.follower_count || 0;
    body += '<p>' + n + ' ' + (n === 1 ? 'follower' : 'followers') + '</p>';
  }
  if (artist.badges && artist.badges.length) {
    const trophies = artist.badges.map((b) => {
      const fn = TROPHY_LABELS[b.badge];
      const n = b.value == null ? 0 : b.value;
      return (fn && n >= 1) ? '<li>' + escHtml(fn(n)) + '</li>' : '';
    }).join('');
    if (trophies) body += '<ul>' + trophies + '</ul>';
  }

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

/* SONG-2: /your-song is its own static page (your-song.html, not
   index.html), rewritten by vercel.json -- see shellPath on its plan below,
   and the one spot in the default export that reads it, for why this is the
   one route that does NOT fetch /index.html as its shell. The copy here
   matches the page's own hero/subline exactly, so a share preview reads the
   same thing the page says. */
const YOUR_SONG_TITLE = 'Your idea. Our music.';
const YOUR_SONG_DESC = 'Send us your song idea. Every week we choose one and turn it into a real song, with your name on it.';
function renderYourSong(html) {
  const canonical = SITE + '/your-song';
  html = setTitle(html, escAttr(YOUR_SONG_TITLE + ' | ' + SITE_NAME));
  html = upsertMeta(html, 'name', 'description', escAttr(YOUR_SONG_DESC));
  html = upsertCanonical(html, escAttr(canonical));
  html = setMeta(html, 'property', 'og:title', escAttr(YOUR_SONG_TITLE));
  html = setMeta(html, 'property', 'og:description', escAttr(YOUR_SONG_DESC));
  html = setMeta(html, 'property', 'og:url', escAttr(canonical));
  return html;
}

/* DED-3: the same canonical headline/line table index.html keeps
   (duplicated: separate edge runtime, no shared module, same reasoning as
   TROPHY_LABELS above). bar_bat_mitzvah is absent on purpose -- see that
   file's own comment; a row written before DED-3 would fall through to the
   generic fallback below rather than crash. */
const DED_OCCASION = {
  birthday: (n) => ({ headline: `Happy birthday, ${n}`, line: `A birthday song for ${n}` }),
  engagement: (n) => ({ headline: `Mazel tov, ${n}`, line: `A song for ${n}'s engagement` }),
  wedding: (n) => ({ headline: `Mazel tov, ${n}`, line: `A wedding song for ${n}` }),
  anniversary: (n) => ({ headline: `Happy anniversary, ${n}`, line: `An anniversary song for ${n}` }),
  bar_mitzvah: (n) => ({ headline: `Mazel tov, ${n}`, line: `A Bar Mitzvah song for ${n}` }),
  bat_mitzvah: (n) => ({ headline: `Mazel tov, ${n}`, line: `A Bat Mitzvah song for ${n}` }),
  new_baby: (n) => ({ headline: `Welcome to the world, ${n}`, line: `A song to welcome ${n}` }),
  bris: (n) => ({ headline: `Mazel tov, ${n}`, line: `A song for ${n}'s bris` }),
  upsherin: (n) => ({ headline: `Mazel tov, ${n}`, line: `A song for ${n}'s upsherin` }),
  graduation: (n) => ({ headline: `Congratulations, ${n}`, line: `A graduation song for ${n}` }),
  siyum: (n) => ({ headline: `Mazel tov, ${n}`, line: `A song for ${n}'s siyum` }),
  new_job: (n) => ({ headline: `Congratulations, ${n}`, line: `A song for ${n}'s new job` }),
  new_home: (n) => ({ headline: `Mazel tov, ${n}`, line: `A song for ${n}'s new home` }),
  aliyah: (n) => ({ headline: `Welcome home, ${n}`, line: `A song for ${n}'s aliyah` }),
  retirement: (n) => ({ headline: `Congratulations, ${n}`, line: `A song for ${n}'s retirement` }),
  refuah_shleimah: (n) => ({ headline: `Refuah shleimah, ${n}`, line: `A song wishing ${n} a refuah shleimah` }),
  encouragement: (n) => ({ headline: `Stay strong, ${n}`, line: `A song to lift ${n}'s spirits` }),
  thank_you: (n) => ({ headline: `Thank you, ${n}`, line: `A thank-you song for ${n}` }),
  in_memory: (n) => ({ headline: `In loving memory of ${n}`, line: `A song in memory of ${n}` }),
  just_because: (n) => ({ headline: `This one's for you, ${n}`, line: `A song for ${n}, just because` }),
};
function dedHeadline(occasion, name) {
  const fn = DED_OCCASION[occasion];
  return fn ? fn(name).headline : `This one's for you, ${name}`;
}
function dedLine(occasion, name, occasionOther) {
  // LISTEN-1: same reasoning as index.html's copy of this table -- trim a
  // trailing ./!/? from the free-typed text so this line never carries its
  // own terminal punctuation into renderDedication()'s "line + '. ...'"
  // concatenation below (an empty box must not leave a bare ": .", and
  // user-typed punctuation must not double up into "..").
  if (occasion === 'other') {
    const t = (occasionOther || '').trim().replace(/[.!?]+$/, '');
    return t ? 'A song for ' + name + ': ' + t : 'A song for ' + name;
  }
  const fn = DED_OCCASION[occasion];
  return fn ? fn(name).line : 'A song for ' + name;
}
function dedSenderLine(occasion, senderName) {
  // sender_name is already null for an anonymous sender -- dedication_by_code
  // nulls it itself -- so there is no separate "anonymous" flag to check here.
  if (occasion === 'in_memory') {
    return senderName ? 'Dedicated by ' + senderName : 'Dedicated by someone who cares';
  }
  return senderName ? 'With love, ' + senderName : 'With love, from someone who cares';
}

// SHOW-1: dedication_by_code() (sql/032, anon-callable): one live
// dedication by its code, whether or not its sender chose to show it on the
// site -- the link is how the person it is for opens it, preview included.
// Its columns are the page's own: never user_id, device_id, meta or any
// email column. fetchImpl is injectable so this is testable without a real
// network call.
async function fetchDedication(code, fetchImpl) {
  if (!code) return null;
  try {
    const url = DED_SUPABASE_URL + '/rest/v1/rpc/dedication_by_code';
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { apikey: DED_SUPABASE_ANON_KEY, Authorization: 'Bearer ' + DED_SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_code: code }),
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (e) {
    return null;
  }
}

/* Personal and ephemeral: noindex always, regardless of status -- and so
   regardless of show_publicly (SHOW-1): a private one is noindex like every
   other. Anonymous stays anonymous here on purpose -- sender_name is already
   null for those rows (dedication_by_code itself nulls it), so there is
   nothing to show even if this function wanted to. */
function renderDedication(html, d) {
  const canonical = SITE + '/d/' + encodeURIComponent(d.code);
  const headline = dedHeadline(d.occasion, d.recipient_name);
  const line = dedLine(d.occasion, d.recipient_name, d.occasion_other);
  const senderLine = dedSenderLine(d.occasion, d.sender_name);
  const snippet = d.message ? firstSentence(d.message, 120) : '';
  const desc = line + (snippet ? ': "' + snippet + '"' : '') + '. A dedication on ' + SITE_NAME + '.';
  // PLAY-1: the dedicated song's own share cover, never the logo.
  const song = songById(d.song_id);
  const image = (song && songOgImage(song))
    || squareCdn(d.cover_url)
    || OG_BASE + encodeURIComponent(d.song_id || '') + '.jpg';
  const alt = d.song_title || (song && song.title) || headline;

  html = setTitle(html, escAttr(headline + ' | ' + SITE_NAME));
  html = upsertMeta(html, 'name', 'description', escAttr(desc));
  html = upsertCanonical(html, escAttr(canonical));
  html = setMeta(html, 'property', 'og:title', escAttr(headline));
  html = setMeta(html, 'property', 'og:description', escAttr(desc));
  html = setMeta(html, 'property', 'og:url', escAttr(canonical));
  html = setMeta(html, 'property', 'og:type', 'website');
  html = setMeta(html, 'name', 'twitter:title', escAttr(headline));
  html = setMeta(html, 'name', 'twitter:description', escAttr(desc));
  html = setOgImage(html, image, alt);

  let body = '<h1>' + escHtml(headline) + '</h1>';
  body += '<p>' + escHtml(line) + '</p>';
  if (d.message) body += '<p>&ldquo;' + escHtml(d.message) + '&rdquo;</p>';
  body += '<p>' + escHtml(senderLine) + '</p>';
  if (d.song_title) {
    body += '<p><a href="/song/' + escAttr(d.song_slug || '') + '">' + escHtml(d.song_title) + '</a></p>';
  }
  html = injectSsr(html, body);

  // Dedication pages are personal, not catalog content: never indexed,
  // live or removed alike.
  return addNoindex(html);
}

/* PLAY-1: a song approved since the last deploy is not in songs.json yet, and
   used to fall through to the bare shell -- whose og:image is the logo. Look
   it up live instead (same anon key, same pattern as fetchDedication), by
   slug, or by id for a /song/<id> link. Approved only. */
async function fetchSongLive(key, fetchImpl) {
  if (!key) return null;
  try {
    const col = /^[0-9a-f-]{36}$/i.test(key) ? 'id' : 'slug';
    const url = DED_SUPABASE_URL + '/rest/v1/songs'
      + '?' + col + '=eq.' + encodeURIComponent(key) + '&status=eq.approved'
      + '&select=id,slug,title,title_translit,about,language,cover_url,cover_focus_x,cover_focus_y,status,'
      + 'lyrics_original,lyrics_translation,idea_credit,reviewed_at,created_at,duration_seconds,length_seconds,'
      + 'artist:artists_public!songs_artist_id_fkey(handle,display_name,avatar_url)';
    const res = await fetchImpl(url, { headers: { apikey: DED_SUPABASE_ANON_KEY } });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (e) {
    return null;
  }
}

// PROFILE-1: /u/<handle> has no build-time snapshot -- every member, not
// only artists with an approved song, needs one -- so this live-fetches
// member_profile() over REST exactly the way fetchDedication() above does
// for /d/<code>: same anon key, a POST to the RPC endpoint since this is a
// function call rather than a view select, same injectable fetchImpl.
async function fetchMemberProfile(handle, fetchImpl) {
  if (!handle) return null;
  try {
    const url = DED_SUPABASE_URL + '/rest/v1/rpc/member_profile';
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        apikey: DED_SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + DED_SUPABASE_ANON_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ p_handle: handle }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

/* Profiles are never indexed (item 17) -- noindex always, public or private
   alike. The anon key this file carries means the function never sees a
   viewer, so is_self is always false here; a private profile's own minimal
   shape (profile_public:false) carries only handle/is_artist/display_name/
   avatar_url, which is exactly item 11's "avatar, display name, and 'This
   profile is private.'" -- nothing else to check before falling back to
   that branch. */
function renderMemberProfile(html, p) {
  const canonical = SITE + '/u/' + encodeURIComponent(p.handle);
  const name = p.display_name || p.handle;
  const image = cdnImage(p.avatar_url, 1200) || DEFAULT_OG_IMAGE;

  html = setTitle(html, escAttr(name + ' | ' + SITE_NAME));
  html = upsertCanonical(html, escAttr(canonical));
  html = setMeta(html, 'property', 'og:title', escAttr(name));
  html = setMeta(html, 'property', 'og:url', escAttr(canonical));
  html = setMeta(html, 'property', 'og:image', escAttr(image));
  html = setMeta(html, 'property', 'og:type', 'profile');
  html = setMeta(html, 'name', 'twitter:title', escAttr(name));
  html = setMeta(html, 'name', 'twitter:image', escAttr(image));
  html = setMeta(html, 'name', 'twitter:card', 'summary_large_image');
  if (p.avatar_url) {
    html = html
      .replace(/\s*<meta property="og:image:width" content="[^"]*">/, '')
      .replace(/\s*<meta property="og:image:height" content="[^"]*">/, '');
  }

  if (p.profile_public === false) {
    const privateDesc = 'This profile is private.';
    html = upsertMeta(html, 'name', 'description', escAttr(privateDesc));
    html = setMeta(html, 'property', 'og:description', escAttr(privateDesc));
    html = setMeta(html, 'name', 'twitter:description', escAttr(privateDesc));
    html = injectSsr(html, '<h1>' + escHtml(name) + '</h1><p>' + privateDesc + '</p>');
    return addNoindex(html);
  }

  const desc = firstSentence(p.bio, 160) || 'A member of ' + SITE_NAME + '.';
  html = upsertMeta(html, 'name', 'description', escAttr(desc));
  html = setMeta(html, 'property', 'og:description', escAttr(desc));
  html = setMeta(html, 'name', 'twitter:description', escAttr(desc));

  let body = '<h1>' + escHtml(name) + '</h1>';
  if (p.bio) body += '<p>' + escHtml(p.bio).replace(/\n/g, '<br>') + '</p>';
  html = injectSsr(html, body);
  return addNoindex(html);
}

/* ------------------------------------------------------------
   The routing decision, split out from the request plumbing so it can be
   exercised directly in tests without a Vercel runtime.
   Returns { kind: 'redirect', location } | { kind: 'render', fn } | null.

   async because of one route: /d/<code> has no build-time snapshot to read
   synchronously, so it fetches dedication_by_code() live. Every other route
   still resolves synchronously underneath; awaiting a non-promise is a
   no-op, so this is not a behavior change for them. fetchImpl is injectable
   so a test never needs a real network call.
   ------------------------------------------------------------ */
export async function decide(pathname, searchParams, fetchImpl = fetch) {
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

  if (pathname === '/your-song') {
    return { kind: 'render', fn: renderYourSong, tag: 'your-song', shellPath: '/your-song.html' };
  }

  let m = /^\/song\/([^/]+)\/?$/.exec(pathname);
  if (m) {
    let slug; try { slug = decodeURIComponent(m[1]); } catch (e) { slug = m[1]; }
    let song = songBySlug(slug);
    // /song/<id> (a share from a song with no slug yet): 301 to its slug.
    const byId = !song && songById(slug);
    if (byId && byId.slug && byId.status === 'approved') {
      return { kind: 'redirect', location: '/song/' + encodeURIComponent(byId.slug) };
    }
    if (!song) {
      const live = await fetchSongLive(slug, fetchImpl);
      if (live && live.slug && live.slug.toLowerCase() !== String(slug).toLowerCase()) {
        return { kind: 'redirect', location: '/song/' + encodeURIComponent(live.slug) };
      }
      if (live) song = live;
    }
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

  m = /^\/d\/([^/]+)\/?$/.exec(pathname);
  if (m) {
    let code; try { code = decodeURIComponent(m[1]); } catch (e) { code = m[1]; }
    const dedication = await fetchDedication(code, fetchImpl);
    // Unknown or removed (dedication_by_code only ever returns a live one
    // for an approved song) -- noindex, same as any other 404 here.
    if (!dedication) return { kind: 'render', fn: addNoindex, tag: 'dedication-404' };
    return { kind: 'render', fn: (h) => renderDedication(h, dedication), tag: 'dedication' };
  }

  m = /^\/u\/([^/]+)\/?$/.exec(pathname);
  if (m) {
    let handle; try { handle = decodeURIComponent(m[1]); } catch (e) { handle = m[1]; }
    const profile = await fetchMemberProfile(handle, fetchImpl);
    // Unknown, suspended or deleted -- noindex, same as any other 404 here.
    if (!profile) return { kind: 'render', fn: addNoindex, tag: 'member-404' };
    // Item 1: an artist's own handle redirects to the page they already
    // have, rather than a second page at /u/ rendering nothing useful.
    if (profile.is_artist) {
      return { kind: 'redirect', location: '/artist/' + encodeURIComponent(profile.handle) };
    }
    return { kind: 'render', fn: (h) => renderMemberProfile(h, profile), tag: 'member' };
  }

  return null;
}

export default async function middleware(request) {
  let url;
  try { url = new URL(request.url); } catch (e) { return; }

  let plan = null;
  try { plan = await decide(url.pathname, url.searchParams); }
  catch (e) { return; }                       // malformed snapshot: serve the shell
  if (!plan) return;

  if (plan.kind === 'redirect') {
    return new Response(null, {
      status: 301,
      headers: { location: plan.location, 'cache-control': 'public, s-maxage=86400' },
    });
  }

  // Every route rewrites to /index.html except /your-song (its plan says so
  // explicitly via shellPath) -- fetching the wrong shell would silently
  // serve the jukebox app's own markup at another page's URL.
  let html;
  try {
    const res = await fetch(new URL(plan.shellPath || '/index.html', request.url));
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
