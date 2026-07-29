/* ============================================================
   Laivy Hart PWA: register the service worker for app-shell
   offline caching. Loaded (deferred) on every page.
   ============================================================ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (err) {
      console.warn('Service worker registration failed:', err);
    });
  });
}
