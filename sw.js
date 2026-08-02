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
const CACHE_VERSION = 'v15';
const SHELL_CACHE = 'laivy-shell-' + CACHE_VERSION;
const ASSET_CACHE = 'laivy-assets-' + CACHE_VERSION;

const SHELL = [
  'index.html', 'about.html', 'admin.html',
  'theme.css', 'config.js', 'pwa.js',
  'manifest.webmanifest',
  'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png',
  'icon-192.png', 'icon-512.png', 'maskable-192.png', 'maskable-512.png'
];

const SUPABASE_HOST = 'tshkrghrgokplakktvik.supabase.co';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
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

  // Supabase REST + Storage (audio): stay live, never cache.
  if (url.hostname === SUPABASE_HOST) return;

  const sameOrigin = url.origin === self.location.origin;
  const isDoc = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  // HTML documents: network-first.
  if (isDoc && sameOrigin) {
    event.respondWith(networkFirst(req));
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

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    const cache = await caches.open(SHELL_CACHE);
    cache.put(req, res.clone());
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
