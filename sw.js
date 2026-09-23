/* ============================================================
   Laivy Hart service worker.

   Strategy:
   - HTML/navigations: network-first (so a fresh deploy is shown when
     online; falls back to cache when offline). This prevents getting
     stuck on a stale cached page.
   - Same-origin static assets (CSS/JS/icons/fonts): stale-while-revalidate
     (instant load, refreshed in the background).
   - Cross-origin static (Google Fonts, jsDelivr): stale-while-revalidate.
   - Supabase (REST + Storage/audio): never cached. Always live/streamed.

   Update: bump CACHE_VERSION on each deploy. install -> skipWaiting and
   activate -> clients.claim so the new worker takes over promptly, and old
   caches are purged.
   ============================================================ */
const CACHE_VERSION = 'v88';
const SHELL_CACHE = 'laivy-shell-' + CACHE_VERSION;
const ASSET_CACHE = 'laivy-assets-' + CACHE_VERSION;

const SHELL = [
  'index.html', 'about.html', 'admin.html',
  '/listen',                 // song-page route (rewritten to index.html) — offline shell
  'theme.css', 'config.js', 'pwa.js',
  'songs.json', 'chart.json',
  'manifest.webmanifest',
  'favicon-16.png', 'favicon-32.png', 'favicon-48.png', 'apple-touch-icon.png',
  'icon-192.png', 'icon-512.png', 'maskable-192.png', 'maskable-512.png'
];

// Brand images served as static files from /brand (see brand/README.md).
// Precached into the ASSET cache and kept OUT of SHELL on purpose: cache.addAll
// is atomic, so a single missing or renamed file there would fail the whole
// install and strand every visitor on the previous service worker. These are
// added one at a time and a miss is simply skipped.
// Only the WebP derivatives are precached: they are what the homepage actually
// renders, and all seven together are ~478 KB. The source PNGs beside them are
// ~9.8 MB and are still served as the fallback for a browser that cannot decode
// WebP -- such a browser fetches one on demand and the normal
// stale-while-revalidate path caches it from then on. That applies to the four
// per-theme plates exactly as it always has to banner.png: precaching 6.6 MB of
// PNG that almost nobody fetches, and that covers all four themes when a
// visitor only ever renders the one matching their data-color, would make every
// install pay for it.
// artists.json rides in this tolerant list rather than the atomic SHELL: like
// the brand images it is generated at build time, and a build where it is
// briefly absent must not strand every visitor on the previous worker. The
// artist page's offline fallback reads it. (songs.json/chart.json stay in
// SHELL, where they have always been.)
const BRAND = [
  'artists.json',          // artist directory, read by the /artist fallback
  'brand/banner.webp',     // full banner, wordmark on the glow background, 3:1
  'brand/banner-bg.webp',  // background only, no text, for compositing
  'brand/wordmark.webp',   // transparent wordmark, logo alone
  // Per-theme background plates, named for the data-color keys in COLORS.
  'brand/plate-bordeaux.webp',
  'brand/plate-royal.webp',
  'brand/plate-emerald.webp',
  'brand/plate-gold.webp'
];

const SUPABASE_HOST = 'tshkrghrgokplakktvik.supabase.co';

// Best effort, never fatal: one image per request, failures ignored.
async function precacheBrand() {
  const cache = await caches.open(ASSET_CACHE);
  await Promise.allSettled(BRAND.map((u) => cache.add(u)));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL);     // atomic: the shell has to be complete
    await precacheBrand();         // tolerant: cannot hold the install hostage
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // AUTH BYPASS, checked before anything else can claim the request.
  // /auth/* carries a one-time code in the URL and must never be cached or
  // replayed; /settings is per-account and must never be served from another
  // visitor's cache; every *.supabase.co host (auth, REST, storage) stays live.
  // These are `return`s with no respondWith, so the browser handles them
  // normally over the network.
  if (url.origin === self.location.origin &&
      (url.pathname.startsWith('/auth/') || url.pathname === '/settings')) return;
  if (/(^|\.)supabase\.co$/.test(url.hostname)) return;

  // Supabase REST + Storage (audio): stay live, never cache.
  if (url.hostname === SUPABASE_HOST) return;

  // Google Analytics (gtag.js loader + collect beacons): never cache or
  // intercept. GA must reach Google's servers live, so let these pass through
  // to the network untouched.
  if (url.hostname === 'www.googletagmanager.com' ||
      url.hostname === 'googletagmanager.com' ||
      /(^|\.)google-analytics\.com$/.test(url.hostname) ||
      /(^|\.)analytics\.google\.com$/.test(url.hostname)) return;

  const sameOrigin = url.origin === self.location.origin;
  const isDoc = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  // HTML documents: network-first.
  if (isDoc && sameOrigin) {
    event.respondWith(networkFirstDoc(req, url));
    return;
  }

  // Same-origin static assets: stale-while-revalidate.
  if (sameOrigin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Fonts + CDN: stale-while-revalidate.
  if (/(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname) ||
      url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
  // Everything else: default network handling (no respondWith).
});

// Network-first for navigations. The live network response always goes to the
// user, so an online visitor always gets the correct edge-injected per-song
// Open Graph HTML. IMPORTANT: per-song responses (URLs carrying ?song=...) are
// NEVER written to the cache, so the service worker can never serve one song's
// preview HTML for another song, or a stale preview. Only the canonical
// homepage shell (no query) is cached, and it is what a ?song deep-link falls
// back to when offline (the app then reads ?song from the URL and boots).
async function networkFirstDoc(req, url) {
  try {
    const res = await fetch(req);
    if (!url.searchParams.has('song')) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('index.html', res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    const fallback = await caches.match('index.html');
    if (fallback) return fallback;
    throw err;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || network || fetch(req);
}
