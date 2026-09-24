/* ============================================================
   Shared media helpers.

   These two were written for admin.html and now serve the contributor upload
   form as well, so they live here as the single copy rather than being
   reimplemented. admin.html loads this module and calls through
   window.laivy.media; js/upload.js imports it directly.
   ============================================================ */

/* Downscale + re-encode to JPEG. Transparency is flattened onto white first,
   because a PNG with alpha otherwise encodes to black in JPEG. */
export function compressImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type || '')) { reject(new Error('not an image')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) { reject(new Error('no dimensions')); return; }
      if (w > maxDim || h > maxDim) {
        if (w >= h) { h = Math.round(h * maxDim / w); w = maxDim; }
        else { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

/* Duration in whole seconds, or null. Best effort by design: a null just means
   the MusicRecording JSON-LD omits duration. Never hangs a save -- there is a
   15s backstop. Accepts a Blob (a freshly chosen file) or a URL string. */
export function readAudioDuration(src) {
  return new Promise((resolve) => {
    let url = null, el = null, done = false;
    const finish = (v) => {
      if (done) return; done = true;
      try { if (url) URL.revokeObjectURL(url); } catch (e) {}
      try { if (el) { el.removeAttribute('src'); el.load(); } } catch (e) {}
      resolve(v);
    };
    try {
      el = document.createElement('audio');
      el.preload = 'metadata';
      el.addEventListener('loadedmetadata', () => {
        const d = Number(el.duration);
        finish(isFinite(d) && d > 0 ? Math.round(d) : null);
      });
      el.addEventListener('error', () => finish(null));
      if (src instanceof Blob) { url = URL.createObjectURL(src); el.src = url; }
      else if (typeof src === 'string' && src) { el.crossOrigin = 'anonymous'; el.src = src; }
      else { finish(null); return; }
      setTimeout(() => finish(null), 15000);
    } catch (e) { finish(null); }
  });
}

window.laivy = window.laivy || {};
window.laivy.media = { compressImage, readAudioDuration };
