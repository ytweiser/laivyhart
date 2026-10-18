/* ============================================================
   IMG-1 -- every picture is compressed in the browser before upload.

   The test pictures are made here with sharp (from worker/node_modules, the
   same copy the backfill scripts use): a >3 MB phone-style JPEG stored
   sideways with EXIF orientation 6 and a GPS block; a small PNG; a
   wide picture for the avatar crop; and unsupported files.

   Checks js/image-compress.js directly (size cap, upright, no enlarging,
   no metadata, the avatar square, the unsupported message), then that each
   upload form -- the contributor form, the admin song editor, the avatar on
   My page -- shows the prepared preview and "Ready, N KB" and sends that
   compressed file, never the original.
   ============================================================ */
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sharp = createRequire(join(ROOT, 'worker', 'package.json'))('sharp');
const WORKER = 'laivyhart-audio-upload.ytweiser-399.workers.dev';
const UNSUPPORTED = "This photo format isn't supported, please choose a JPG or PNG";

/* Upright it is 3000x4000 (portrait) with a solid red band across the top;
   stored rotated 90 degrees counter-clockwise (4000x3000) with EXIF
   orientation 6, so only a viewer that applies the orientation sees it
   upright. Noise everywhere else keeps it over 3 MB. */
async function makeBigRotatedPhoto() {
  const W = 3000, H = 4000;
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < px.length; i++) px[i] = (Math.random() * 256) | 0;
  for (let y = 0; y < 300; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 3; px[o] = 230; px[o + 1] = 10; px[o + 2] = 10; }
  const stored = await sharp(px, { raw: { width: W, height: H, channels: 3 } }).rotate(270).toBuffer();
  return sharp(stored, { raw: { width: H, height: W, channels: 3 } })
    .withExif({ IFD0: { Make: 'TestPhone', Model: 'IMG-1' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '31/1 46/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '35/1 13/1 0/1' } })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 97 })
    .toBuffer();
}

const hasGpsIfd = (exif) => !!exif && (exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88])));

/* In the page: run a File through the helper and describe the result. */
async function runHelper(page, b64, name, type, opts) {
  return page.evaluate(async ({ b64, name, type, opts }) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bin], name, { type });
    const m = await import('/js/image-compress.js');
    try {
      const out = await m.compressPicture(file, opts);
      const bytes = new Uint8Array(await out.blob.arrayBuffer());
      // Any APP1 (EXIF/XMP) or APP13 (IPTC) segment, or the text "GPS", in the output?
      let app1 = false, app13 = false;
      for (let i = 2; i + 3 < bytes.length && bytes[i] === 0xFF;) {
        const marker = bytes[i + 1];
        if (marker === 0xDA) break;              // start of scan: headers are over
        if (marker === 0xE1) app1 = true;
        if (marker === 0xED) app13 = true;
        i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
      }
      const text = new TextDecoder('latin1').decode(bytes.slice(0, 4096));
      const bmp = await createImageBitmap(out.blob);
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0);
      const at = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
      return {
        ok: true, type: out.blob.type, bytes: out.bytes, width: out.width, height: out.height,
        decodedW: bmp.width, decodedH: bmp.height, quality: out.quality,
        app1, app13, gpsText: text.includes('GPS') || text.includes('Exif'),
        top: at(Math.floor(bmp.width / 2), 5), bottom: at(Math.floor(bmp.width / 2), bmp.height - 5),
        label: m.readyLabel(out.bytes),
      };
    } catch (e) {
      return { ok: false, message: e.message, isPictureError: e instanceof m.PictureError };
    }
  }, { b64, name, type, opts });
}

const isRed = (rgb) => rgb[0] > 180 && rgb[1] < 70 && rgb[2] < 70;

async function decodeSent(buf) {
  const m = await sharp(buf).metadata();
  return { format: m.format, width: m.width, height: m.height, exif: !!m.exif, bytes: buf.length };
}

export async function run(browser, port) {
  const r = makeReporter('image-compress.spec.mjs');
  const big = await makeBigRotatedPhoto();
  const bigMeta = await sharp(big).metadata();
  const small = await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 20, g: 120, b: 200, alpha: 0.5 } } }).png().toBuffer();
  const wide = await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#3a4fc4' } }).jpeg().toBuffer();
  const ctx = { big, small, wide };

  r.section('the test photo really is big, sideways and carrying GPS');
  r.check('over 3 MB', big.length > 3 * 1024 * 1024, big.length);
  r.check('stored 4000x3000 with EXIF orientation 6', bigMeta.width === 4000 && bigMeta.height === 3000 && bigMeta.orientation === 6, JSON.stringify({ w: bigMeta.width, h: bigMeta.height, o: bigMeta.orientation }));
  r.check('has an EXIF block with a GPS section', hasGpsIfd(bigMeta.exif));

  await scenarioHelper(browser, port, r, ctx);
  await scenarioContributorForm(browser, port, r, ctx);
  await scenarioAdminForm(browser, port, r, ctx);
  await scenarioAvatar(browser, port, r, ctx);
  return r;
}

async function scenarioHelper(browser, port, r, { big, small, wide }) {
  r.section('js/image-compress.js');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, {});
  await page.goto(`http://localhost:${port}/listen`, { waitUntil: 'load' });

  const a = await runHelper(page, big.toString('base64'), 'IMG_0001.jpg', 'image/jpeg', { maxSide: 1200 });
  r.check('big phone photo: JPEG under 300 KB', a.ok && a.type === 'image/jpeg' && a.bytes <= 300 * 1024, JSON.stringify(a));
  r.check('upright: portrait 900x1200, longest side 1200', a.width === 900 && a.height === 1200 && a.decodedW === 900 && a.decodedH === 1200, `${a.width}x${a.height}`);
  r.check('upright: the red band is at the top, not the side', isRed(a.top) && !isRed(a.bottom), JSON.stringify({ top: a.top, bottom: a.bottom }));
  r.check('cover keeps its own proportions (not cropped square)', a.width !== a.height);
  r.check('no metadata: no EXIF/XMP or IPTC segment, no GPS', !a.app1 && !a.app13 && !a.gpsText, JSON.stringify({ app1: a.app1, app13: a.app13, gps: a.gpsText }));
  r.check('"Ready, N KB" label', /^Ready, \d+ KB$/.test(a.label), a.label);

  const s = await runHelper(page, small.toString('base64'), 'small.png', 'image/png', { maxSide: 1200 });
  r.check('a small picture is not enlarged (300x200 stays 300x200)', s.ok && s.width === 300 && s.height === 200, `${s.width}x${s.height}`);
  r.check('PNG transparency becomes a JPEG', s.type === 'image/jpeg');

  const av = await runHelper(page, wide.toString('base64'), 'me.jpg', 'image/jpeg', { maxSide: 400, square: true });
  r.check('avatar: center-cropped square, 400x400', av.ok && av.width === 400 && av.height === 400, `${av.width}x${av.height}`);

  const heic = await runHelper(page, Buffer.from('not really a heic file').toString('base64'), 'IMG_0002.HEIC', 'image/heic', { maxSide: 1200 });
  r.check('a HEIC this browser cannot decode -> the clear message', !heic.ok && heic.isPictureError && heic.message === UNSUPPORTED, JSON.stringify(heic));
  const pdf = await runHelper(page, Buffer.from('%PDF-1.4').toString('base64'), 'doc.pdf', 'application/pdf', { maxSide: 1200 });
  r.check('a PDF -> the same message', !pdf.ok && pdf.message === UNSUPPORTED, JSON.stringify(pdf));
  const broken = await runHelper(page, Buffer.from('garbage').toString('base64'), 'x.jpg', 'image/jpeg', { maxSide: 1200 });
  r.check('a corrupt JPEG -> the same message', !broken.ok && broken.message === UNSUPPORTED, JSON.stringify(broken));
  const tooBig = await page.evaluate(async () => {
    const m = await import('/js/image-compress.js');
    try { await m.compressPicture(new File([new Uint8Array(21 * 1024 * 1024)], 'huge.jpg', { type: 'image/jpeg' }), {}); return 'no error'; }
    catch (e) { return e.message; }
  });
  r.check('over 20 MB -> refused before decoding', /over 20 MB/.test(tooBig), tooBig);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* Captures what reaches the Worker. */
async function captureWorker(page) {
  const sent = [];
  await page.route(`https://${WORKER}/**`, async (route) => {
    const req = route.request();
    const url = req.url();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (url.includes('/event')) return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    sent.push({ url, method: req.method(), type: req.headers()['content-type'], body: req.postDataBuffer() });
    const key = url.includes('og_for') || url.includes('folder=og') ? 'og/x.jpg'
      : url.includes('/upload/avatar') ? 'avatars/x/1.jpg' : 'covers/x/1.jpg';
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ url: 'https://pub-75904c6ec4a240bbaa60162b9258ba52.r2.dev/' + key, key }) });
  });
  return sent;
}

async function stubSongWrites(page) {
  await page.route('https://tshkrghrgokplakktvik.supabase.co/rest/v1/songs*', async (route) => {
    const m = route.request().method();
    if (m === 'POST') return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'f0000000-0000-4000-8000-0000000000aa' }) });
    if (m === 'PATCH') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'f0000000-0000-4000-8000-0000000000aa' }]) });
    return route.fallback();
  });
}

async function scenarioContributorForm(browser, port, r, { big }) {
  r.section('contributor upload form: preview, size, and the compressed file is what is sent');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  await stubSongWrites(page);
  const sent = await captureWorker(page);
  await signInAs(page, F.SESSION_USERS.NOVA);
  await page.goto(`http://localhost:${port}/upload`, { waitUntil: 'load' });
  await page.waitForSelector('#u-cover', { state: 'attached', timeout: 10000 });
  await page.fill('#u-title', 'Image Test Song');
  await page.setInputFiles('#u-cover', { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: big });
  await page.waitForFunction(() => /Ready, \d+ KB/.test(document.querySelector('#u-cover-card .u-file-state')?.textContent || ''), null, { timeout: 15000 });
  const shown = await page.evaluate(() => ({
    state: document.querySelector('#u-cover-card .u-file-state').textContent,
    src: document.querySelector('#u-cover-card img.u-cover-thumb')?.getAttribute('src') || '',
  }));
  r.check('the form shows "Ready, N KB"', /^Ready, \d+ KB$/.test(shown.state), shown.state);
  r.check('the preview is the prepared picture (a blob)', shown.src.startsWith('blob:'), shown.src);

  await page.click('#u-draft');
  await page.waitForFunction(() => true, null, { timeout: 100 });
  const deadline = Date.now() + 15000;
  while (!sent.some((s) => /\/upload\/cover(\?|$)/.test(s.url) && !s.url.includes('og_for')) && Date.now() < deadline) {
    await page.waitForTimeout(100);
  }
  const cover = sent.find((s) => /\/upload\/cover(\?|$)/.test(s.url) && !s.url.includes('og_for'));
  const d = cover ? await decodeSent(cover.body) : null;
  r.check('the cover is sent as image/jpeg', cover && cover.type === 'image/jpeg', cover && cover.type);
  r.check('what is sent is the compressed file: 900x1200, under 300 KB, no EXIF',
    d && d.format === 'jpeg' && d.width === 900 && d.height === 1200 && d.bytes <= 300 * 1024 && !d.exif, JSON.stringify(d));
  r.check('...and exactly the size the form showed', d && shown.state === 'Ready, ' + Math.max(1, Math.round(d.bytes / 1024)) + ' KB', shown.state + ' vs ' + (d && d.bytes));
  r.check('never the original', d && d.bytes < big.length / 10);
  const deadline2 = Date.now() + 10000;
  while (!sent.some((s) => s.url.includes('og_for')) && Date.now() < deadline2) await page.waitForTimeout(100);
  const og = sent.find((s) => s.url.includes('og_for'));
  const od = og ? await decodeSent(og.body) : null;
  r.check('the og/ share copy is made in the same step: 600x600 JPEG under 200 KB', od && od.width === 600 && od.height === 600 && od.bytes <= 200 * 1024, JSON.stringify(od));

  // An unsupported pick shows the message on the field and sends nothing.
  const before = sent.length;
  await page.click('#u-cover-card .u-replace').catch(() => {});
  await page.setInputFiles('#u-cover', { name: 'IMG_0002.HEIC', mimeType: 'image/heic', buffer: Buffer.from('not a real heic') });
  await page.waitForFunction(() => !document.getElementById('u-err-cover').hidden, null, { timeout: 10000 });
  const msg = await page.evaluate(() => document.getElementById('u-err-cover').textContent);
  r.check('unsupported photo -> the clear message on the field', msg === UNSUPPORTED, msg);
  r.check('...and nothing more was sent', sent.length === before);
  r.check('no console/page errors', errors.filter((e) => !/HTTP|net::/.test(e)).length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioAdminForm(browser, port, r, { big }) {
  r.section('admin song editor: preview, size, and the compressed file is what is sent');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { isAdmin: true });
  await stubSongWrites(page);
  const sent = await captureWorker(page);
  await signInAs(page, F.SESSION_USERS.LISTENER);
  await page.goto(`http://localhost:${port}/admin.html`, { waitUntil: 'load' });
  await page.waitForSelector('#new-song-btn', { state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => window.laivy && window.laivy.images, null, { timeout: 10000 });
  await page.click('#new-song-btn');
  await page.waitForSelector('#f-cover-file', { state: 'attached', timeout: 10000 });
  await page.fill('#f-title', 'Admin Image Test');
  await page.fill('#f-upload-token', 'test-token');
  await page.setInputFiles('#f-cover-file', { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: big });
  await page.waitForFunction(() => /^Ready, \d+ KB/.test(document.getElementById('cover-status').textContent), null, { timeout: 15000 });
  const shown = await page.evaluate(() => ({
    status: document.getElementById('cover-status').textContent,
    preview: document.getElementById('cover-preview').style.backgroundImage,
  }));
  r.check('shows "Ready, N KB" and the pixel size', /^Ready, \d+ KB, 900×1200\./.test(shown.status), shown.status);
  r.check('preview is the prepared picture', /blob:/.test(shown.preview), shown.preview);
  await page.click('#save-btn');
  const deadline = Date.now() + 15000;
  while (!sent.some((s) => s.url.includes('folder=covers')) && Date.now() < deadline) await page.waitForTimeout(100);
  const cover = sent.find((s) => s.url.includes('folder=covers'));
  const d = cover ? await decodeSent(cover.body) : null;
  r.check('admin sends the compressed JPEG (900x1200, under 300 KB, no EXIF), not the original',
    d && d.format === 'jpeg' && d.width === 900 && d.height === 1200 && d.bytes <= 300 * 1024 && !d.exif && cover.type === 'image/jpeg', JSON.stringify(d));
  r.check('...with a .jpg name', cover && /filename=[^&]*\.jpg/.test(cover.url), cover && cover.url);
  const deadline2 = Date.now() + 10000;
  while (!sent.some((s) => s.url.includes('folder=og')) && Date.now() < deadline2) await page.waitForTimeout(100);
  const og = sent.find((s) => s.url.includes('folder=og'));
  const od = og ? await decodeSent(og.body) : null;
  r.check('admin makes the og/ share copy too: 600x600 under 200 KB', od && od.width === 600 && od.height === 600 && od.bytes <= 200 * 1024, JSON.stringify(od));

  await page.setInputFiles('#f-cover-file', { name: 'IMG_0002.HEIC', mimeType: 'image/heic', buffer: Buffer.from('nope') });
  await page.waitForFunction((m) => document.getElementById('cover-status').textContent === m, UNSUPPORTED, { timeout: 10000 }).catch(() => {});
  r.check('unsupported photo -> the clear message', await page.evaluate(() => document.getElementById('cover-status').textContent) === UNSUPPORTED);
  r.check('no console/page errors', errors.filter((e) => !/HTTP|net::/.test(e)).length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioAvatar(browser, port, r, { big }) {
  r.section('avatar on My page: square 400 px, compressed file sent');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  const sent = await captureWorker(page);
  await page.route('https://tshkrghrgokplakktvik.supabase.co/rest/v1/artists*', (route) =>
    route.request().method() === 'PATCH' ? route.fulfill({ status: 204, body: '' }) : route.fallback());
  await signInAs(page, F.SESSION_USERS.NOVA);
  await page.goto(`http://localhost:${port}/settings`, { waitUntil: 'load' });
  await page.waitForSelector('[data-avatar-file]', { state: 'attached', timeout: 10000 });
  await page.setInputFiles('[data-avatar-file]', { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: big });
  const deadline = Date.now() + 15000;
  while (!sent.some((s) => s.url.includes('/upload/avatar')) && Date.now() < deadline) await page.waitForTimeout(100);
  const av = sent.find((s) => s.url.includes('/upload/avatar'));
  const d = av ? await decodeSent(av.body) : null;
  r.check('avatar sent as a 400x400 JPEG under 300 KB with no EXIF', d && d.format === 'jpeg' && d.width === 400 && d.height === 400 && d.bytes <= 300 * 1024 && !d.exif, JSON.stringify(d));
  await page.waitForFunction(() => /Ready, \d+ KB/.test(document.querySelector('[data-avatar-size]')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
  const label = await page.evaluate(() => document.querySelector('[data-avatar-size]')?.textContent || '');
  r.check('My page shows "Ready, N KB" for it', d && label === 'Ready, ' + Math.max(1, Math.round(d.bytes / 1024)) + ' KB', label);
  r.check('no console/page errors', errors.filter((e) => !/HTTP|net::/.test(e)).length === 0, errors.join(' | '));
  await page.close();
}
