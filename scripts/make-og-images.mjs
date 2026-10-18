#!/usr/bin/env node
/* ============================================================
   PLAY-1: share-sized covers for WhatsApp (and every other link preview).

   For every approved song, writes og/<song-id>.jpg: a square 600x600 JPEG
   under 200 KB, cropped around the cover's focal point (cover_focus_x/y, the
   same point the app crops to). A song with no cover gets its theme plate
   instead -- the same generative gradient and title the app paints for
   coverless songs (index.html genArtStyle + defaultCoverHTML), in the site's
   default royal color -- never the Laivy Hart logo.

   node scripts/make-og-images.mjs                 # render into ./og-out, report
   node scripts/make-og-images.mjs --upload        # ...and put each into R2 (wrangler)
   node scripts/make-og-images.mjs --only <id,id>  # just these songs
   node scripts/make-og-images.mjs --out <dir>     # render somewhere else

   sharp comes from worker/node_modules (already installed there for
   wrangler); there is no root package.json to add it to. Upload uses the
   logged-in wrangler from worker/, so no token lives in this file. Reads
   songs with the publishable key from config.js, exactly like
   snapshot-songs.mjs. After a backfill, Publish (or any deploy) refreshes
   songs.json so middleware.js picks up each song's og_image.
   ============================================================ */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'worker', 'package.json'));
const sharp = require('sharp');

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const OUT = resolve(arg('--out') || join(root, 'og-out'));
const ONLY = arg('--only') ? new Set(arg('--only').split(',')) : null;
const UPLOAD = flag('--upload');

export const SIZE = 600;
export const MAX_BYTES = 200 * 1024;
const BUCKET = 'laivyhart-audio';

/* ---------------- the theme plate (coverless songs) ---------------- */
// Same constants as index.html's ART_THEMES.royal / hashStr / genArtStyle.
const ROYAL = { a0: 216, aSpan: 44, b0: 224, bSpan: 40, s1: 60, s2: 56, l1: 48, l2: 44 };
function hashStr(s) {
  let h = 0; s = s || 'laivy';
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}
function hsl(h, s, l) { return `hsl(${h},${s}%,${l}%)`; }
const xml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isHebrew = (t) => /[֐-׿]/.test(String(t || ''));

function wrap(text, perLine, maxLines) {
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= perLine) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s*\S*$/, '') + '…';
    return kept;
  }
  return lines;
}

export function plateSvg(song) {
  const seed = song.title || song.title_translit || song.id;
  const cfg = ROYAL, h = hashStr(seed);
  const a = cfg.a0 + (h % cfg.aSpan);
  const b = cfg.b0 + ((h >> 3) % cfg.bSpan);
  const x1 = 12 + (h % 55), y1 = 12 + ((h >> 2) % 55);
  const x2 = 45 + ((h >> 4) % 50), y2 = 40 + ((h >> 5) % 55);
  const c1 = hsl(a, cfg.s1, cfg.l1), c2 = hsl(b, cfg.s2, cfg.l2);
  const base1 = hsl((a + b) >> 1, 45, 20), base2 = hsl(a, 42, 12);

  const heb = isHebrew(song.title);
  const title = (heb ? song.title : (song.title || song.title_translit)) || '';
  const sub = heb ? (song.title_translit || '') : '';
  const lines = wrap(title, 16, 4);
  const fs = lines.length > 2 ? 58 : 70, lh = fs * 1.18;
  const block = lines.length * lh + (sub ? 56 : 0);
  let y = (SIZE - block) / 2 + fs * 0.9;
  const font = heb ? "'Frank Ruhl Libre','FreeSerif','DejaVu Serif',serif" : "'Fraunces','Georgia','DejaVu Serif',serif";
  const tspans = lines.map((l) => {
    const t = `<text x="300" y="${y.toFixed(1)}" text-anchor="middle" font-family="${font}" font-size="${fs}" font-weight="600" fill="#fff" filter="url(#sh)"${heb ? ' direction="rtl"' : ''}>${xml(l)}</text>`;
    y += lh;
    return t;
  }).join('');
  const subEl = sub
    ? `<text x="300" y="${(y + 14).toFixed(1)}" text-anchor="middle" font-family="'Fraunces','Georgia','DejaVu Serif',serif" font-style="italic" font-size="34" fill="rgba(255,255,255,0.82)" filter="url(#sh)">${xml(sub)}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${base1}"/><stop offset="1" stop-color="${base2}"/></linearGradient>
    <radialGradient id="g1" cx="${x1}%" cy="${y1}%" r="60%"><stop offset="0" stop-color="${c1}"/><stop offset="0.7" stop-color="${c1}" stop-opacity="0"/></radialGradient>
    <radialGradient id="g2" cx="${x2}%" cy="${y2}%" r="55%"><stop offset="0" stop-color="${c2}"/><stop offset="0.7" stop-color="${c2}" stop-opacity="0"/></radialGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="6" flood-color="#000" flood-opacity="0.45"/></filter>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#base)"/>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#g2)"/>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#g1)"/>
  ${tspans}${subEl}
</svg>`;
}

/* ---------------- encode ---------------- */
async function encodeUnder(pipelineFactory) {
  for (const q of [82, 76, 70, 64, 58, 50]) {
    const buf = await pipelineFactory().jpeg({ quality: q, mozjpeg: true, chromaSubsampling: '4:2:0' }).toBuffer();
    if (buf.length <= MAX_BYTES) return { buf, q };
  }
  throw new Error('could not get under 200 KB');
}

export async function coverToOg(input, fx, fy) {
  const img = sharp(input, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  // rotate() honours EXIF; width/height here are pre-rotation, so swap when needed.
  const swap = meta.orientation && meta.orientation >= 5;
  const W = swap ? meta.height : meta.width, H = swap ? meta.width : meta.height;
  const side = Math.min(W, H);
  const cx = (fx == null ? 50 : Number(fx)) / 100 * W;
  const cy = (fy == null ? 50 : Number(fy)) / 100 * H;
  const left = Math.round(Math.max(0, Math.min(W - side, cx - side / 2)));
  const top = Math.round(Math.max(0, Math.min(H - side, cy - side / 2)));
  const rotated = await sharp(input, { failOn: 'none' }).rotate().toBuffer();
  return encodeUnder(() => sharp(rotated)
    .extract({ left, top, width: side, height: side })
    .resize(SIZE, SIZE)
    .flatten({ background: '#ffffff' }));
}

export async function plateToOg(song) {
  const png = await sharp(Buffer.from(plateSvg(song))).png().toBuffer();
  return encodeUnder(() => sharp(png).resize(SIZE, SIZE));
}

/* ---------------- main ---------------- */
async function main() {
  const cfg = readFileSync(join(root, 'config.js'), 'utf8');
  const url = cfg.match(/SUPABASE_URL:\s*"([^"]+)"/)?.[1];
  const key = cfg.match(/SUPABASE_ANON_KEY:\s*"([^"]+)"/)?.[1];
  const res = await fetch(`${url}/rest/v1/songs?select=id,slug,title,title_translit,cover_url,cover_focus_x,cover_focus_y,status&status=eq.approved&order=title`,
    { headers: { apikey: key } });
  if (!res.ok) throw new Error('Supabase returned HTTP ' + res.status);
  let songs = await res.json();
  if (ONLY) songs = songs.filter((s) => ONLY.has(s.id) || ONLY.has(s.slug));
  mkdirSync(OUT, { recursive: true });

  const report = [];
  for (const s of songs) {
    let out, src = 'plate', srcBytes = null, srcDims = null;
    try {
      if (s.cover_url) {
        const r = await fetch(s.cover_url);
        if (!r.ok) throw new Error('cover HTTP ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        const m = await sharp(buf).metadata();
        srcBytes = buf.length; srcDims = `${m.width}x${m.height}`;
        out = await coverToOg(buf, s.cover_focus_x, s.cover_focus_y);
        src = 'cover';
      } else {
        out = await plateToOg(s);
      }
    } catch (e) {
      console.error(`[og] ${s.slug}: ${e.message}`);
      report.push({ slug: s.slug, error: e.message });
      continue;
    }
    const file = join(OUT, s.id + '.jpg');
    writeFileSync(file, out.buf);
    const m = await sharp(out.buf).metadata();
    report.push({ id: s.id, slug: s.slug, src, srcBytes, srcDims, bytes: out.buf.length, q: out.q, dims: `${m.width}x${m.height}`, file });
  }

  for (const r of report) {
    if (r.error) { console.log(`FAIL  ${r.slug}  ${r.error}`); continue; }
    console.log(`${r.src.padEnd(5)} ${String(r.srcDims || '-').padEnd(10)} ${String(r.srcBytes == null ? '-' : Math.round(r.srcBytes / 1024) + 'KB').padStart(7)}  ->  ${r.dims} ${Math.round(r.bytes / 1024)}KB q${r.q}  ${r.slug}`);
  }
  const ok = report.filter((r) => !r.error);
  const largest = ok.reduce((m, r) => (!m || r.bytes > m.bytes ? r : m), null);
  console.log(`\n[og] ${ok.length}/${songs.length} rendered (${ok.filter((r) => r.src === 'plate').length} from the theme plate).`
    + (largest ? ` Largest: ${largest.slug} ${(largest.bytes / 1024).toFixed(1)} KB.` : ''));

  if (UPLOAD) {
    let up = 0;
    for (const r of ok) {
      execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `${BUCKET}/og/${r.id}.jpg`,
        '--file', r.file, '--content-type', 'image/jpeg',
        '--cache-control', 'public, max-age=86400'],
      { cwd: join(root, 'worker'), stdio: ['ignore', 'ignore', 'inherit'] });
      up++;
      process.stdout.write(`\r[og] uploaded ${up}/${ok.length}`);
    }
    console.log('');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
