import { shareImageFrom } from './image-compress.js';

/* ============================================================
   Shared media helpers.

   Shared by admin.html (through window.laivy.media) and js/upload.js
   (imported directly). Picture compression itself lives in
   js/image-compress.js (IMG-1).
   ============================================================ */

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

/* PLAY-1: the share-sized cover link previews use (WhatsApp first):
   a square 600x600 JPEG under 200 KB, stored at og/<song-id>.jpg.
   `source` is the cover (a File/Blob) or null for a coverless song, which
   gets its theme plate: the same gradient and title the app paints for
   coverless songs (index.html genArtStyle/defaultCoverHTML), in the default
   royal color, never the logo. scripts/make-og-images.mjs is the Node twin
   used for the backfill. fx/fy: the cover's focal point, 0-100. */
export const SHARE_SIZE = 600;
export const SHARE_MAX_BYTES = 200 * 1024;
const PLATE = { a0: 216, aSpan: 44, b0: 224, bSpan: 40, s1: 60, s2: 56, l1: 48, l2: 44 };
function plateHash(s) {
  let h = 0; s = s || 'laivy';
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}
function drawPlate(ctx, song) {
  const N = SHARE_SIZE, cfg = PLATE;
  const h = plateHash(song.title || song.title_translit || song.id);
  const a = cfg.a0 + (h % cfg.aSpan), b = cfg.b0 + ((h >> 3) % cfg.bSpan);
  const x1 = 12 + (h % 55), y1 = 12 + ((h >> 2) % 55);
  const x2 = 45 + ((h >> 4) % 50), y2 = 40 + ((h >> 5) % 55);
  const base = ctx.createLinearGradient(0, 0, N, N);
  base.addColorStop(0, `hsl(${(a + b) >> 1},45%,20%)`); base.addColorStop(1, `hsl(${a},42%,12%)`);
  ctx.fillStyle = base; ctx.fillRect(0, 0, N, N);
  const blob = (cx, cy, r, hue, s, l) => {
    const g = ctx.createRadialGradient(cx * N / 100, cy * N / 100, 0, cx * N / 100, cy * N / 100, r * N);
    g.addColorStop(0, `hsla(${hue},${s}%,${l}%,1)`); g.addColorStop(0.7, `hsla(${hue},${s}%,${l}%,0)`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);
  };
  blob(x2, y2, 0.55, b, cfg.s2, cfg.l2);
  blob(x1, y1, 0.6, a, cfg.s1, cfg.l1);

  const heb = /[֐-׿]/.test(song.title || '');
  const title = (heb ? song.title : (song.title || song.title_translit)) || '';
  const sub = heb ? (song.title_translit || '') : '';
  const words = title.trim().split(/\s+/);
  const lines = []; let cur = '';
  for (const w of words) {
    if (!cur) cur = w; else if ((cur + ' ' + w).length <= 16) cur += ' ' + w; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > 4) { lines.length = 4; lines[3] = lines[3].replace(/\s*\S*$/, '') + '…'; }
  const fs = lines.length > 2 ? 58 : 70, lh = fs * 1.18;
  let y = (N - (lines.length * lh + (sub ? 56 : 0))) / 2 + fs * 0.9;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 2;
  ctx.direction = heb ? 'rtl' : 'ltr';
  ctx.font = `600 ${fs}px ${heb ? "'Frank Ruhl Libre', serif" : "'Fraunces', Georgia, serif"}`;
  for (const l of lines) { ctx.fillText(l, N / 2, y); y += lh; }
  if (sub) {
    ctx.direction = 'ltr';
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.font = `italic 34px 'Fraunces', Georgia, serif`;
    ctx.fillText(sub, N / 2, y + 14);
  }
}
export async function makeShareImage(source, song, fx, fy) {
  // IMG-1: a picture goes through the shared helper (upright, same decode
  // the main compression uses); only the coverless plate is drawn here.
  if (source) return shareImageFrom(source, fx, fy);
  const N = SHARE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = N; canvas.height = N;
  const ctx = canvas.getContext('2d');
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
  drawPlate(ctx, song || {});
  for (const q of [0.82, 0.74, 0.66, 0.58, 0.5]) {
    const b = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', q));
    if (b && b.size <= SHARE_MAX_BYTES) return b;
  }
  throw new Error('share image too large');
}

window.laivy = window.laivy || {};
window.laivy.media = { readAudioDuration, makeShareImage };
