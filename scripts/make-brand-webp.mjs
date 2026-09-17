#!/usr/bin/env node
/* ============================================================
   Build WebP display derivatives of the brand artwork.

   The PNGs in /brand stay exactly as delivered: they are the SOURCE files and
   the fallback the homepage serves to any browser that cannot do WebP. These
   derivatives are what the homepage actually shows, at display width rather
   than full artwork width, which is where nearly all of the saving comes from.

   One-off tool, not part of the Vercel build. Run it when the artwork changes
   and commit what it writes:

     npm i sharp        # not a repo dependency; install ad hoc
     node scripts/make-brand-webp.mjs

   Widths: the banner and its background plate render full-bleed in a content
   column that tops out near 1100 CSS px, so 1600 covers a 2x display at common
   widths without carrying the full 2171. The wordmark is only used in the
   narrow composition at 80% of a phone-width banner, so 1200 is already
   generous. Quality is highest on the banner, which carries the gold lettering
   and has to stay crisp; the background plate is a smooth gradient that
   compresses further without showing it.
   ============================================================ */
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { statSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kb = (p) => (statSync(p).size / 1024).toFixed(0);

const JOBS = [
  { name: 'banner',    width: 1600, quality: 88 },                        // gold lettering: keep it crisp
  { name: 'banner-bg', width: 1600, quality: 82 },                        // smooth gradient
  { name: 'wordmark',  width: 1200, quality: 85, alphaQuality: 92 },      // keeps its alpha channel
];

let before = 0, after = 0;
for (const j of JOBS) {
  const src = join(root, 'brand', j.name + '.png');
  const out = join(root, 'brand', j.name + '.webp');
  const meta = await sharp(src).metadata();
  const opts = { quality: j.quality, effort: 6, smartSubsample: true };
  if (j.alphaQuality) opts.alphaQuality = j.alphaQuality;
  await sharp(src).resize({ width: j.width }).webp(opts).toFile(out);
  const o = await sharp(out).metadata();
  before += statSync(src).size;
  after += statSync(out).size;
  console.log(
    `${(j.name + '.png').padEnd(17)} ${String(meta.width).padStart(4)}px ${kb(src).padStart(5)} KB` +
    `   ->   ${(j.name + '.webp').padEnd(18)} ${String(o.width).padStart(4)}px ${kb(out).padStart(4)} KB` +
    `   q${j.quality}${o.hasAlpha ? '  alpha kept' : ''}`);
}
console.log(`\ntotal  ${(before / 1024 / 1024).toFixed(2)} MB  ->  ${(after / 1024).toFixed(0)} KB` +
  `   (${(after / before * 100).toFixed(1)}% of the originals)`);
