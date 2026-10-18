/* ============================================================
   IMG-1: the one place a picture is prepared for upload.

   Every picture upload on the site (contributor song form, admin song
   editor, the avatar on My page) runs its pick through here before
   anything is sent:

     - JPEG, PNG and WebP up to 20 MB. HEIC is tried: it decodes where the
       browser can (Safari), and anywhere else the pick is refused with
       UNSUPPORTED_MESSAGE rather than failing somewhere later.
     - Upright: decoded with createImageBitmap(..., { imageOrientation:
       'from-image' }), so a phone photo's EXIF rotation is applied to the
       pixels themselves.
     - Resized so the longest side is at most `maxSide` (1200 for covers,
       400 for avatars). Never enlarged.
     - Covers keep their own proportions (no crop; the 3:2 cards and the wide
       banner crop at the song's saved focal point, as before). Avatars,
       shown round, are center-cropped square, as they always were.
     - Re-encoded as JPEG at 0.82, stepping to 0.75, 0.68, 0.6 until it is
       under 300 KB. Drawing to a canvas and re-encoding carries no EXIF,
       GPS or any other metadata across.

   scripts/recompress-pictures.mjs applies the same settings with sharp to
   the pictures already in R2. The square 600x600 share copy (og/, PLAY-1)
   is made from the same decoded, upright picture by shareImageFrom().
   ============================================================ */

export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const TARGET_BYTES = 300 * 1024;
export const QUALITY_STEPS = [0.82, 0.75, 0.68, 0.6];
export const COVER_MAX_SIDE = 1200;
export const AVATAR_MAX_SIDE = 400;
export const SHARE_SIZE = 600;
export const SHARE_MAX_BYTES = 200 * 1024;

export const UNSUPPORTED_MESSAGE = "This photo format isn't supported, please choose a JPG or PNG";
export const TOO_BIG_MESSAGE = 'That picture is over 20 MB. Please choose a smaller one.';

const ACCEPTED = /^image\/(jpeg|pjpeg|png|webp|heic|heif)$/i;
const ACCEPTED_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;

export class PictureError extends Error {}

/* Decode upright. Throws PictureError(UNSUPPORTED_MESSAGE) for anything the
   browser cannot decode (HEIC outside Safari, a renamed PDF, ...). */
export async function decodeUpright(file) {
  if (!file) throw new PictureError(UNSUPPORTED_MESSAGE);
  if (file.size > MAX_INPUT_BYTES) throw new PictureError(TOO_BIG_MESSAGE);
  const type = String(file.type || '');
  if (!(ACCEPTED.test(type) || (!type && ACCEPTED_EXT.test(file.name || '')))) {
    throw new PictureError(UNSUPPORTED_MESSAGE);
  }
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    throw new PictureError(UNSUPPORTED_MESSAGE);
  }
}

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';            // JPEG has no alpha: flatten onto white
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  return { c, ctx };
}
const toJpeg = (c, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', q));

async function encodeStepping(c, limit) {
  let blob = null, quality = null;
  for (const q of QUALITY_STEPS) {
    blob = await toJpeg(c, q); quality = q;
    if (blob.size <= limit) break;
  }
  return { blob, quality };
}

/* The size a picture ends up at: longest side capped, never enlarged. */
export function fitSize(w, h, maxSide) {
  const long = Math.max(w, h);
  if (long <= maxSide) return { w, h };
  const k = maxSide / long;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/* opts: { maxSide, square }. Returns
   { blob, width, height, bytes, quality, srcWidth, srcHeight, bitmap }.
   `bitmap` is the decoded upright source, handed back so a caller can make
   the share copy from the same decode (call bitmap.close() when done). */
export async function compressPicture(file, opts) {
  const maxSide = (opts && opts.maxSide) || COVER_MAX_SIDE;
  const square = !!(opts && opts.square);
  const bmp = await decodeUpright(file);
  const W = bmp.width, H = bmp.height;
  let sx = 0, sy = 0, sw = W, sh = H;
  if (square) {
    const side = Math.min(W, H);
    sx = Math.round((W - side) / 2); sy = Math.round((H - side) / 2);
    sw = sh = side;
  }
  let { w, h } = fitSize(sw, sh, maxSide);
  let out = null;
  // Quality first (the brief's steps); only if 0.6 still misses, which a
  // 1200 px JPEG practically never does, shrink and try again.
  for (let attempt = 0; attempt < 4; attempt++) {
    const { c, ctx } = canvasOf(w, h);
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    out = await encodeStepping(c, TARGET_BYTES);
    if (out.blob.size <= TARGET_BYTES) break;
    w = Math.max(1, Math.round(w * 0.85)); h = Math.max(1, Math.round(h * 0.85));
  }
  return { blob: out.blob, width: w, height: h, bytes: out.blob.size, quality: out.quality, srcWidth: W, srcHeight: H, bitmap: bmp };
}

/* PLAY-1's share copy: square 600x600 JPEG under 200 KB, cropped at the
   focal point (fx/fy 0-100; 50/50 is the center). `src` is a decoded
   bitmap from compressPicture, or a File/Blob. */
export async function shareImageFrom(src, fx, fy) {
  const bmp = (src && typeof src.width === 'number' && typeof src.close === 'function') ? src : await decodeUpright(src);
  const W = bmp.width, H = bmp.height, side = Math.min(W, H);
  const cx = (fx == null ? 50 : Number(fx)) / 100 * W, cy = (fy == null ? 50 : Number(fy)) / 100 * H;
  const sx = Math.max(0, Math.min(W - side, cx - side / 2));
  const sy = Math.max(0, Math.min(H - side, cy - side / 2));
  const { c, ctx } = canvasOf(SHARE_SIZE, SHARE_SIZE);
  ctx.drawImage(bmp, sx, sy, side, side, 0, 0, SHARE_SIZE, SHARE_SIZE);
  const { blob } = await encodeStepping(c, SHARE_MAX_BYTES);
  if (blob.size > SHARE_MAX_BYTES) throw new Error('share image too large');
  return blob;
}

/* "Ready, 184 KB" */
export function readyLabel(bytes) {
  return 'Ready, ' + Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

window.laivy = window.laivy || {};
window.laivy.images = { compressPicture, shareImageFrom, decodeUpright, readyLabel, PictureError,
  UNSUPPORTED_MESSAGE, COVER_MAX_SIDE, AVATAR_MAX_SIDE };
