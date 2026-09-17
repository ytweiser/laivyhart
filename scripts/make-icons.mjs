#!/usr/bin/env node
/* ============================================================
   Regenerate the favicons, the app icons, and the share image from the brand
   artwork in /brand. This is a ONE-OFF tool, not part of the Vercel build
   (that only runs snapshot-songs.mjs): run it by hand when the artwork changes,
   and commit the PNGs it writes.

     npm i sharp        # not a repo dependency; install ad hoc
     node scripts/make-icons.mjs

   The icon is the V-heart mark alone, cropped out of brand/wordmark.png. The
   full wordmark is illegible at 16px, and the mark is the memorable part.

   The crop is not a plain rectangle: the "I" of LAI and the "Y" of YHART reach
   into the mark's bounding box BELOW the letter line (y283), so both bottom
   corners are punched out. Above that line the box holds only the mark, so the
   top-left swash and the right lobe stay whole. Measured from the artwork:
     - letters occupy y >= 283; the mark spans y 105..584
     - the "I" ends at x 619; the mark's own ink at letter height starts at x 674
     - the "Y" begins at x ~995; the mark's right lobe reaches x 1031 above it
   ============================================================ */
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { statSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (f) => join(root, f);

const BOX     = { left: 543, top: 105, width: 489, height: 480 };  // the whole V-heart
const PUNCH_L = { left: 0,   top: 178, width: 128, height: 302 };  // the "I", x 543..670
const PUNCH_R = { left: 452, top: 178, width: 37,  height: 302 };  // the "Y", x 995..1031

const DARK  = { r: 0x14, g: 0x08, b: 0x10, alpha: 1 };   // manifest background_color
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

const hole = (w, h) =>
  sharp({ create: { width: w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .png().toBuffer();

async function markBuffer() {
  const base = await sharp(R('brand/wordmark.png')).extract(BOX).ensureAlpha().png().toBuffer();
  const punched = await sharp(base).composite([
    { input: await hole(PUNCH_L.width, PUNCH_L.height), left: PUNCH_L.left, top: PUNCH_L.top, blend: 'dest-out' },
    { input: await hole(PUNCH_R.width, PUNCH_R.height), left: PUNCH_R.left, top: PUNCH_R.top, blend: 'dest-out' },
  ]).png().toBuffer();
  return sharp(punched).trim({ threshold: 1 }).png().toBuffer();   // drop the transparent margin
}

// cover = how much of the square the mark spans. Maskable icons stay well
// inside the 80% safe circle; the rest sit close to the edge.
async function icon(mark, size, cover, bg, out) {
  const scaled = await sharp(mark).resize(Math.round(size * cover), Math.round(size * cover),
    { fit: 'contain', background: CLEAR }).png().toBuffer();
  const s = await sharp(scaled).metadata();
  await sharp({ create: { width: size, height: size, channels: 4, background: bg } })
    .composite([{ input: scaled, left: Math.round((size - s.width) / 2), top: Math.round((size - s.height) / 2) }])
    .png({ compressionLevel: 9 }).toFile(R(out));
  console.log(`  ${out.padEnd(22)} ${size}x${size}  mark ${Math.round(cover * 100)}%  ${bg.alpha ? 'dark' : 'transparent'}`);
}

const mark = await markBuffer();
const mm = await sharp(mark).metadata();
console.log(`mark cropped from brand/wordmark.png: ${mm.width}x${mm.height}`);

await icon(mark, 16,  0.96, CLEAR, 'favicon-16.png');
await icon(mark, 32,  0.96, CLEAR, 'favicon-32.png');
await icon(mark, 48,  0.96, CLEAR, 'favicon-48.png');
await icon(mark, 180, 0.80, DARK,  'apple-touch-icon.png');   // iOS has no transparency
await icon(mark, 192, 0.94, CLEAR, 'icon-192.png');
await icon(mark, 512, 0.94, CLEAR, 'icon-512.png');
await icon(mark, 192, 0.60, DARK,  'maskable-192.png');       // inside the maskable safe zone
await icon(mark, 512, 0.60, DARK,  'maskable-512.png');

// Share card: the FULL banner letterboxed into 1200x630 on the artwork's own
// black, so a 1.91:1 card cannot crop the ends off the wordmark.
const bandH = Math.round(1200 * 724 / 2171);
const band = await sharp(R('brand/banner.png')).resize(1200, bandH).toBuffer();
await sharp({ create: { width: 1200, height: 630, channels: 3, background: { r: 6, g: 4, b: 6 } } })
  .composite([{ input: band, left: 0, top: Math.round((630 - bandH) / 2) }])
  .png({ compressionLevel: 9, effort: 10 }).toFile(R('og-image.png'));
console.log(`  og-image.png           1200x630  banner at 1200x${bandH}, letterboxed  ` +
  `(${(statSync(R('og-image.png')).size / 1024).toFixed(0)} KB)`);
