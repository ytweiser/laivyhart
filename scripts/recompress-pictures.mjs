#!/usr/bin/env node
/* ============================================================
   IMG-1: recompress every existing picture to the upload standard.

   Exactly js/image-compress.js's settings, applied with sharp:
     upright (EXIF orientation applied to the pixels), longest side at most
     1200 px for covers / 400 px for avatars, never enlarged, covers keep
     their own proportions (no crop), avatars center-cropped square, PNG
     transparency flattened onto white, JPEG at quality 82 stepping to 75,
     68, 60 until under 300 KB, and no metadata (sharp drops EXIF/GPS/ICC
     unless asked to keep it, and this never asks).

   node scripts/recompress-pictures.mjs --in <inventory.json> [--out <dir>] [--upload]

   inventory.json: [{ kind: 'song'|'member', id, label, url }] -- the rows
   as the database holds them (read through the Supabase MCP, so drafts and
   members are included, not just what the anon key can see).

   Each new file goes to a NEW key, <prefix>/c/<id>-<sha8>.jpg, and is never
   written over the original: the originals stay in R2 as the backup. With
   --upload, every file is put with wrangler and then fetched back from its
   public URL; only a 200 image/jpeg of the exact byte length counts as
   verified. The manifest (<out>/manifest.json) lists old and new for every
   picture; the database rows are switched from it afterwards, and only for
   verified ones.
   ============================================================ */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'worker', 'package.json'));
const sharp = require('sharp');

export const TARGET_BYTES = 300 * 1024;
export const QUALITY_STEPS = [82, 75, 68, 60];
export const COVER_MAX_SIDE = 1200;
export const AVATAR_MAX_SIDE = 400;
const PUBLIC_BASE = 'https://pub-75904c6ec4a240bbaa60162b9258ba52.r2.dev';
const BUCKET = 'laivyhart-audio';

/* The helper's pipeline. Returns { buf, width, height, quality }. */
export async function recompress(input, { maxSide, square }) {
  const upright = await sharp(input, { failOn: 'none' }).rotate().toBuffer();
  const meta = await sharp(upright).metadata();
  let W = meta.width, H = meta.height;
  let base = sharp(upright);
  if (square) {
    const side = Math.min(W, H);
    base = base.extract({ left: Math.round((W - side) / 2), top: Math.round((H - side) / 2), width: side, height: side });
    W = H = side;
  }
  const squared = await base.toBuffer();
  let scale = 1;
  for (let attempt = 0; attempt < 4; attempt++) {
    const long = Math.max(W, H);
    const cap = Math.round(Math.min(maxSide, long) * scale);
    for (const q of QUALITY_STEPS) {
      const buf = await sharp(squared)
        .resize({ width: cap, height: cap, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: q, mozjpeg: false })
        .toBuffer();
      if (buf.length <= TARGET_BYTES) {
        const m = await sharp(buf).metadata();
        return { buf, width: m.width, height: m.height, quality: q };
      }
    }
    scale *= 0.85;   // only if 0.6 still missed, same fallback as the browser
  }
  throw new Error('could not get under 300 KB');
}

const keyFor = (kind, id, buf) => {
  const sha8 = createHash('sha256').update(buf).digest('hex').slice(0, 8);
  return `${kind === 'song' ? 'covers' : 'avatars'}/c/${id}-${sha8}.jpg`;
};

async function main() {
  const argv = process.argv.slice(2);
  const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const inPath = arg('--in');
  if (!inPath) throw new Error('--in <inventory.json> is required');
  const OUT = resolve(arg('--out') || join(root, 'recompress-out'));
  const UPLOAD = argv.includes('--upload');
  mkdirSync(OUT, { recursive: true });
  const items = JSON.parse(readFileSync(inPath, 'utf8'));

  const manifest = [];
  for (const it of items) {
    const row = { kind: it.kind, id: it.id, label: it.label, old_url: it.url };
    try {
      const r = await fetch(it.url);
      if (!r.ok) throw new Error('download HTTP ' + r.status);
      const src = Buffer.from(await r.arrayBuffer());
      const sm = await sharp(src).metadata();
      const out = await recompress(src, it.kind === 'song'
        ? { maxSide: COVER_MAX_SIDE, square: false }
        : { maxSide: AVATAR_MAX_SIDE, square: true });
      const after = await sharp(out.buf).metadata();
      const key = keyFor(it.kind, it.id, out.buf);
      const file = join(OUT, key.replace(/\//g, '__'));
      writeFileSync(file, out.buf);
      Object.assign(row, {
        old_bytes: src.length, old_type: sm.format, old_dims: `${sm.width}x${sm.height}`, old_orientation: sm.orientation || 1,
        new_bytes: out.buf.length, new_dims: `${out.width}x${out.height}`, quality: out.quality / 100,
        has_exif: !!after.exif, has_icc: !!after.icc, key, new_url: PUBLIC_BASE + '/' + key, file,
      });
    } catch (e) {
      row.error = e.message;
    }
    manifest.push(row);
    console.log(row.error ? `FAIL  ${row.label}: ${row.error}`
      : `${row.kind.padEnd(6)} ${row.old_dims.padEnd(10)} ${String(Math.round(row.old_bytes / 1024)).padStart(5)} KB ${row.old_type.padEnd(4)} -> ${row.new_dims.padEnd(10)} ${String(Math.round(row.new_bytes / 1024)).padStart(4)} KB q${row.quality}  ${row.label}`);
  }

  if (UPLOAD) {
    for (const row of manifest) {
      if (row.error) continue;
      execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${row.key}`,
        '--file', row.file, '--content-type', 'image/jpeg',
        '--cache-control', 'public, max-age=31536000, immutable', '--remote'],
      { cwd: join(root, 'worker'), stdio: ['ignore', 'ignore', 'inherit'] });
      const res = await fetch(row.new_url);
      const body = Buffer.from(await res.arrayBuffer());
      row.verified = res.status === 200 && /image\/jpeg/.test(res.headers.get('content-type') || '')
        && body.length === row.new_bytes;
      row.verify_detail = `${res.status} ${res.headers.get('content-type')} ${body.length}`;
      console.log(`${row.verified ? 'OK  ' : 'BAD '} ${row.verify_detail}  ${row.new_url}`);
    }
  }

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const ok = manifest.filter((m) => !m.error);
  const sum = (k) => ok.reduce((a, m) => a + m[k], 0);
  console.log(`\n${ok.length}/${manifest.length} recompressed. Total ${(sum('old_bytes') / 1048576).toFixed(2)} MB -> ${(sum('new_bytes') / 1048576).toFixed(2)} MB.`
    + (UPLOAD ? ` Verified: ${ok.filter((m) => m.verified).length}.` : ''));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
