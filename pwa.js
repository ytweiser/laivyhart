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

/* ============================================================
   Install prompt (Android/Chrome/Edge), iOS add-to-home hint,
   and native share. All optional: only wires up elements that
   exist on the page, and shows nothing when already installed.
   ============================================================ */
(function () {
  var isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  function toast(msg) {
    var t = document.getElementById('laivy-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'laivy-toast';
      t.className = 'laivy-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  /* ---- Share ---- */
  var shareBtn = document.getElementById('share-btn');
  if (shareBtn) {
    var shareData = {
      title: 'Laivy Hart',
      text: 'Original songs. Sometimes stories, sometimes prayers.',
      url: 'https://laivyhart.com'
    };
    shareBtn.addEventListener('click', function () {
      if (navigator.share) {
        navigator.share(shareData).catch(function () { /* user cancelled */ });
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(shareData.url)
          .then(function () { toast('Link copied'); })
          .catch(function () { window.prompt('Copy this link:', shareData.url); });
      } else {
        window.prompt('Copy this link:', shareData.url);
      }
    });
  }

  /* ---- Install (beforeinstallprompt) ---- */
  var installBtn = document.getElementById('install-btn');
  var deferredPrompt = null;
  if (installBtn && !isStandalone) {
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      installBtn.hidden = false;
    });
    installBtn.addEventListener('click', function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(function () {
        deferredPrompt = null;
        installBtn.hidden = true;
      });
    });
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      installBtn.hidden = true;
    });
  }

  /* ---- iOS add-to-home-screen hint ---- */
  var iosHint = document.getElementById('ios-hint');
  if (iosHint && !isStandalone) {
    var ua = window.navigator.userAgent || '';
    var isIOS = /iPad|iPhone|iPod/.test(ua) ||
      (ua.indexOf('Macintosh') > -1 && 'ontouchend' in document);
    var dismissed = false;
    try { dismissed = localStorage.getItem('laivy-ios-hint') === 'dismissed'; } catch (e) {}
    if (isIOS && !dismissed) {
      iosHint.hidden = false;
      var close = iosHint.querySelector('.ios-hint-close');
      if (close) close.addEventListener('click', function () {
        iosHint.hidden = true;
        try { localStorage.setItem('laivy-ios-hint', 'dismissed'); } catch (e) {}
      });
    }
  }
})();
