/* ============================================================
   PLAY-1 -- the music never stops.

   Every fixture song gets a stubbed audio_url served by page.route() as a
   tiny silent WAV (no R2, no network), so a song really loads and really
   plays. Most checks fire 'ended' by hand for determinism; one lets the clip
   run out on its own, to prove the real event path.

   Covers: /listen row -> ended -> radio takes over (labelled "Radio",
   logged as source 'autoplay'); a /song/<slug> page; a /d/<code> page; no
   repeat inside the last 15 (and the half-the-pool rule for a small pool);
   Mood radio stays in its channel; Autoplay off stops (and is remembered);
   an artist "Play all" finishes in order before radio takes over; Media
   Session metadata; and the share button's canonical /song/<slug> URL.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const AUDIO_HOST = 'audio.test';

// A silent 8 kHz mono 8-bit WAV of `secs` seconds.
function silentWav(secs) {
  const rate = 8000, n = Math.round(rate * secs);
  const b = Buffer.alloc(44 + n, 0x80);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}
const WAV = silentWav(3);

const withAudio = (rows) => rows.map((s) => ({ ...s, audio_url: `https://${AUDIO_HOST}/${s.id}.wav` }));
const BASE_SONGS = withAudio(F.SONGS_ROWS);
// A pool big enough for the full 15-song no-repeat window to apply.
const EXTRA_SONGS = withAudio(Array.from({ length: 32 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return { ...F.SONGS_ROWS[4], id: `e0000000-0000-4000-8000-0000000000${n}`, title: `Extra ${n}`,
    slug: `extra-${n}-e000`, channels: [], badges: [], milestones: [] };
}));

async function setup(browser, songs, extra) {
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { songs, ...(extra || {}) });
  await page.route(`**://${AUDIO_HOST}/**`, (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }));
  return { page, errors };
}

const state = (page) => page.evaluate(() => {
  // RADIO-2: the station line replaced PLAY-1's "Radio" tag.
  const line = document.getElementById('station-line-text');
  return {
    id: currentIdx === null ? null : SONGS[currentIdx].id,
    src: audioEl.currentSrc || audioEl.src,
    paused: audioEl.paused,
    mode,
    tag: line ? line.textContent : '',
    source: currentSource,
  };
});
const fireEnded = (page) => page.evaluate(() => audioEl.dispatchEvent(new Event('ended')));
const waitPlaying = (page, id) => page.waitForFunction((want) => currentIdx !== null && !audioEl.paused
  && (!want || SONGS[currentIdx].id === want) && audioEl.readyState >= 2, id, { timeout: 10000 });
const waitSongChange = (page, from) => page.waitForFunction((f) => currentIdx !== null && SONGS[currentIdx].id !== f
  && !audioEl.paused, from, { timeout: 10000 });

// Captures every activity log call (laivy-no-track keeps the real module
// from sending anything; this sees what the page asked it to log).
async function captureActivity(page) {
  await page.waitForFunction(() => window.laivy && window.laivy.activity && window.laivy.activity.log, null, { timeout: 10000 });
  await page.evaluate(() => {
    window.__acts = [];
    window.laivy.activity.log = (type, opts) => { window.__acts.push({ type, opts: opts || {} }); };
  });
}

async function openListen(page, port, path) {
  await page.goto(`http://localhost:${port}${path || '/listen'}`, { waitUntil: 'load' });
  await page.waitForSelector('#rows .row', { timeout: 10000 });
}
// The song list re-renders once more right after it first appears (late
// channel/badge data), so a click in that window can land on a row that is
// about to be replaced. Click until a song is actually loaded (bounded).
async function clickFirstRow(page) {
  for (let i = 0; i < 15; i++) {
    if (await page.evaluate(() => currentIdx !== null)) return;
    await page.click('#rows .row .row-title-primary', { timeout: 5000 }).catch(() => {});
    const ok = await page.waitForFunction(() => currentIdx !== null, null, { timeout: 1000 }).then(() => true, () => false);
    if (ok) return;
  }
  throw new Error('no song loaded after clicking the first row');
}

export async function run(browser, port) {
  const r = makeReporter('play-continuation.spec.mjs');
  await scenarioListenRow(browser, port, r);
  await scenarioNaturalEnd(browser, port, r);
  await scenarioSongPage(browser, port, r);
  await scenarioDedicationPage(browser, port, r);
  await scenarioNoRepeat(browser, port, r);
  await scenarioSmallPool(browser, port, r);
  await scenarioMood(browser, port, r);
  await scenarioAutoplayOff(browser, port, r);
  await scenarioPlayAll(browser, port, r);
  await scenarioShareUrl(browser, port, r);
  await scenarioShareImage(browser, port, r);
  return r;
}

async function scenarioListenRow(browser, port, r) {
  r.section('/listen: a song row ends with nothing queued -> radio takes over');
  const { page, errors } = await setup(browser, BASE_SONGS);
  await openListen(page, port);
  await captureActivity(page);
  await clickFirstRow(page);
  await waitPlaying(page);
  const a = await state(page);
  r.check('the picked song plays, not labelled Radio', a.id && !a.paused && !/Radio/.test(a.tag) && a.mode === 'manual', JSON.stringify(a));
  const queued = await page.evaluate(() => nextUp && { kind: nextUp.kind, id: SONGS[nextUp.idx].id });
  r.check('the next song is already picked when this one starts', queued && queued.kind === 'takeover' && queued.id !== a.id, JSON.stringify(queued));
  const meta = await page.evaluate(() => navigator.mediaSession && navigator.mediaSession.metadata
    && { title: navigator.mediaSession.metadata.title, artist: navigator.mediaSession.metadata.artist, art: (navigator.mediaSession.metadata.artwork || []).length });
  const want = await page.evaluate(() => SONGS[currentIdx].title);
  r.check('Media Session metadata set (title, artist, artwork)', meta && meta.title === want && meta.artist && meta.art >= 1, JSON.stringify(meta));

  await fireEnded(page);
  await waitSongChange(page, a.id);
  const b = await state(page);
  r.check('ended -> the pre-picked next song starts', b.id === queued.id && !b.paused, JSON.stringify(b));
  r.check('the src switched to the new song', b.src.includes(b.id), b.src);
  r.check('now-playing says "On Radio: All songs"', b.tag === 'On Radio: All songs', b.tag);
  r.check('mode is radio, marked as a takeover', b.mode === 'radio' && await page.evaluate(() => radioTakeover), b.mode);
  const meta2 = await page.evaluate(() => navigator.mediaSession.metadata.title);
  r.check('Media Session metadata follows the radio song', meta2 === await page.evaluate(() => SONGS[currentIdx].title), meta2);
  const acts = await page.evaluate(() => window.__acts.filter((x) => x.type === 'play_start'));
  r.check('the radio song is logged as one play_start with source "autoplay"',
    acts.length === 2 && !acts[0].opts.meta && acts[1].opts.meta && acts[1].opts.meta.source === 'autoplay'
      && acts[1].opts.song_id === b.id, JSON.stringify(acts));

  await fireEnded(page);
  await waitSongChange(page, b.id);
  const c = await state(page);
  r.check('radio keeps going after that', c.id !== b.id && c.tag === 'On Radio: All songs' && c.source === 'autoplay', JSON.stringify(c));

  // previoustrack inside radio steps back through what was played.
  await page.evaluate(() => playPrev());
  await waitSongChange(page, c.id);
  r.check('previous inside radio goes back to the song before', (await state(page)).id === b.id);

  // The listener picking a song themselves ends the takeover.
  await page.evaluate(() => document.querySelectorAll('#rows .row')[2].click());
  await page.waitForFunction(() => !radioTakeover, null, { timeout: 5000 });
  const d = await state(page);
  r.check('a listener pick ends the takeover: label gone, back to manual', !/Radio/.test(d.tag) && d.mode === 'manual', JSON.stringify(d));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioNaturalEnd(browser, port, r) {
  r.section('the real audio "ended" event (clip runs out) continues into radio');
  const { page, errors } = await setup(browser, BASE_SONGS);
  await openListen(page, port);
  await clickFirstRow(page);
  await waitPlaying(page);
  const a = await state(page);
  await page.evaluate(() => { audioEl.currentTime = Math.max(0, audioEl.duration - 0.15); });
  await waitSongChange(page, a.id);
  const b = await state(page);
  r.check('a different song is playing on its own', b.id !== a.id && !b.paused && b.tag === 'On Radio: All songs', JSON.stringify(b));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioSongPage(browser, port, r) {
  r.section('/song/<slug>: play, end -> the next song starts');
  const { page, errors } = await setup(browser, BASE_SONGS);
  const song = BASE_SONGS.find((s) => s.id === F.SONGS.PAPER_MOONS);
  await page.goto(`http://localhost:${port}/song/${song.slug}`, { waitUntil: 'load' });
  await page.waitForFunction((id) => currentIdx !== null && SONGS[currentIdx].id === id, song.id, { timeout: 10000 });
  if (await page.evaluate(() => audioEl.paused)) await page.click('#play-btn');
  await waitPlaying(page, song.id);
  await fireEnded(page);
  await waitSongChange(page, song.id);
  const b = await state(page);
  r.check('the next song starts from a song page', b.id && b.id !== song.id && !b.paused, JSON.stringify(b));
  r.check('labelled On Radio', b.tag === 'On Radio: All songs', b.tag);
  r.check('the address follows the new song', await page.evaluate(() => location.pathname) === '/song/' + BASE_SONGS.find((s) => s.id === b.id).slug);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioDedicationPage(browser, port, r) {
  r.section('/d/<code>: Play, end -> the next song starts');
  const song = BASE_SONGS.find((s) => s.id === F.SONGS.SUPERNOVA);
  const { page, errors } = await setup(browser, BASE_SONGS, {
    dedicationsPublic: [{
      code: 'PLAY0001', song_id: song.id, song_title: song.title, song_slug: song.slug, cover_url: null,
      recipient_name: 'Mom', occasion: 'birthday', occasion_other: null, message: null,
      sender_name: 'Tzvi', created_at: new Date().toISOString(),
    }],
  });
  await page.goto(`http://localhost:${port}/d/PLAY0001`, { waitUntil: 'load' });
  await page.waitForSelector('#ded-page-play-btn', { timeout: 10000 });
  await page.click('#ded-page-play-btn');
  await waitPlaying(page, song.id);
  await fireEnded(page);
  await waitSongChange(page, song.id);
  const b = await state(page);
  r.check('the next song starts after a dedication', b.id !== song.id && !b.paused && b.tag === 'On Radio: All songs', JSON.stringify(b));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function runChain(page, n) {
  const seq = [await page.evaluate(() => SONGS[currentIdx].id)];
  for (let i = 0; i < n; i++) {
    const from = seq[seq.length - 1];
    await fireEnded(page);
    await page.waitForFunction((f) => currentIdx !== null && SONGS[currentIdx].id !== f, from, { timeout: 10000 });
    seq.push(await page.evaluate(() => SONGS[currentIdx].id));
  }
  return seq;
}
function repeatsWithin(seq, win) {
  const bad = [];
  for (let i = 1; i < seq.length; i++) {
    if (seq.slice(Math.max(0, i - win), i).includes(seq[i])) bad.push(i);
  }
  return bad;
}

async function scenarioNoRepeat(browser, port, r) {
  r.section('radio never repeats any of the last 15 songs (41-song pool)');
  const songs = [...BASE_SONGS, ...EXTRA_SONGS];
  const { page, errors } = await setup(browser, songs);
  await openListen(page, port);
  await clickFirstRow(page);
  await waitPlaying(page);
  const seq = await runChain(page, 60);
  const bad = repeatsWithin(seq, 15);
  r.check('60 radio songs in a row, none repeats inside the previous 15', bad.length === 0, 'repeats at ' + bad.join(','));
  r.check('and it is not a fixed loop (more than 16 distinct songs heard)', new Set(seq).size > 16, new Set(seq).size);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioSmallPool(browser, port, r) {
  r.section('a pool smaller than 30: the window is half the pool');
  const { page, errors } = await setup(browser, BASE_SONGS);   // 9 songs -> window 4
  await openListen(page, port);
  await clickFirstRow(page);
  await waitPlaying(page);
  const seq = await runChain(page, 30);
  const bad = repeatsWithin(seq, 4);
  r.check('30 songs from a 9-song pool, none repeats inside the previous 4', bad.length === 0, 'repeats at ' + bad.join(','));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioMood(browser, port, r) {
  r.section('Mood radio: continuation stays inside the mood');
  const { page, errors } = await setup(browser, BASE_SONGS);
  await openListen(page, port, '/listen?channel=inspire-me');
  await page.waitForFunction(() => currentIdx !== null, null, { timeout: 10000 });
  if (await page.evaluate(() => audioEl.paused)) await page.click('#play-btn');
  await waitPlaying(page);
  const members = new Set(BASE_SONGS.filter((s) => (s.channels || []).includes('inspire-me')).map((s) => s.id));
  const seq = await runChain(page, 12);
  r.check('every song is from the inspire-me channel', seq.every((id) => members.has(id)), JSON.stringify(seq));
  const tag = (await state(page)).tag;
  r.check('now-playing says "On Radio: <mood>"', /^On Radio: /.test(tag) && tag !== 'On Radio: All songs', tag);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioAutoplayOff(browser, port, r) {
  r.section('Autoplay off: stop at the end (and it is remembered)');
  const { page, errors } = await setup(browser, BASE_SONGS);
  await openListen(page, port);
  await clickFirstRow(page);
  await waitPlaying(page);
  const on = await page.evaluate(() => document.getElementById('autoplay-switch').checked);
  r.check('Autoplay is on by default', on === true);
  r.check('the switch sits in the now-playing panel', await page.evaluate(() => !!document.querySelector('#now-content ~ .dock #autoplay-switch, .dock #autoplay-switch')));
  await page.click('label.autoplay-toggle');
  const stored = await page.evaluate(() => localStorage.getItem('laivy-autoplay-v1'));
  r.check('turning it off is saved on the device', stored === '0', stored);
  const a = await state(page);
  await fireEnded(page);
  await page.waitForFunction(() => audioEl.paused || audioEl.ended, null, { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => new Promise((res) => setTimeout(res, 300)));
  const b = await state(page);
  r.check('the song does not change', b.id === a.id, JSON.stringify(b));
  r.check('nothing is queued', await page.evaluate(() => nextUp === null));
  r.check('play icon shows stopped', await page.evaluate(() => document.getElementById('play-btn').innerHTML.includes('▶')));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#rows .row', { timeout: 10000 });
  r.check('after a reload Autoplay is still off', await page.evaluate(() => document.getElementById('autoplay-switch').checked === false && autoplayOn === false));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioPlayAll(browser, port, r) {
  r.section('artist Play all: the queue plays to its end, then radio takes over');
  const { page, errors } = await setup(browser, BASE_SONGS);
  await page.goto(`http://localhost:${port}/artist/nova-ash`, { waitUntil: 'load' });
  await page.waitForSelector('#artist-playall', { timeout: 10000 });
  await page.click('#artist-playall');
  await waitPlaying(page);
  const queue = await page.evaluate(() => manualQueue.map((i) => SONGS[i].id));
  r.check('Play all built a queue of the artist\'s songs', queue.length === 6, queue.length);
  const heard = [await page.evaluate(() => SONGS[currentIdx].id)];
  for (let i = 1; i < queue.length; i++) {
    const t = (await state(page)).tag;
    if (/Radio/.test(t)) { r.check('no Radio label inside the queue', false, t); break; }
    await fireEnded(page);
    await page.waitForFunction((f) => SONGS[currentIdx].id !== f, heard[heard.length - 1], { timeout: 10000 });
    heard.push(await page.evaluate(() => SONGS[currentIdx].id));
  }
  r.check('every queued song played, in order', JSON.stringify(heard) === JSON.stringify(queue), JSON.stringify(heard));
  const before = await state(page);
  r.check('still not Radio on the last queued song', !/Radio/.test(before.tag) && before.mode === 'manual', JSON.stringify(before));
  await fireEnded(page);
  await waitSongChange(page, before.id);
  const after = await state(page);
  r.check('after the last one, radio takes over', after.tag === 'On Radio: All songs' && after.mode === 'radio' && after.source === 'autoplay', JSON.stringify(after));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioShareUrl(browser, port, r) {
  r.section('the song share button produces the canonical /song/<slug> URL');
  const { page, errors } = await setup(browser, BASE_SONGS);
  await page.addInitScript(() => {
    window.__shared = [];
    Object.defineProperty(navigator, 'share', { configurable: true, value: (d) => { window.__shared.push(d); return Promise.resolve(); } });
  });
  for (const slug of ['supernova-a000', 'quiet-night-a000']) {
    await page.goto(`http://localhost:${port}/song/${slug}`, { waitUntil: 'load' });
    await page.waitForFunction(() => currentIdx !== null, null, { timeout: 10000 });
    await page.click('#now-share-btn');
    const url = await page.evaluate(() => window.__shared[window.__shared.length - 1]?.url);
    r.check(`share for ${slug} -> https://laivyhart.com/song/${slug}`, url === `https://laivyhart.com/song/${slug}`, url);
  }
  const noSlug = await page.evaluate(() => songShareUrl({ id: 'a0000000-0000-4000-8000-000000000099' }));
  r.check('a song with no slug still shares a /song/ URL, never /?song=', noSlug === 'https://laivyhart.com/song/a0000000-0000-4000-8000-000000000099', noSlug);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioShareImage(browser, port, r) {
  r.section('the upload form\'s share image: square 600x600 JPEG under 200 KB');
  const { page, errors } = await setup(browser, BASE_SONGS);
  await openListen(page, port);
  const out = await page.evaluate(async () => {
    const m = await import('/js/media-utils.js');
    const measure = async (blob) => {
      const bmp = await createImageBitmap(blob);
      return { type: blob.type, size: blob.size, w: bmp.width, h: bmp.height };
    };
    // A wide 1600x900 noisy "cover", the hard case for JPEG size.
    const c = document.createElement('canvas'); c.width = 1600; c.height = 900;
    const ctx = c.getContext('2d'); const img = ctx.createImageData(1600, 900);
    for (let i = 0; i < img.data.length; i++) img.data[i] = (i % 4 === 3) ? 255 : Math.random() * 255;
    ctx.putImageData(img, 0, 0);
    const cover = await new Promise((res) => c.toBlob(res, 'image/png'));
    return {
      cover: await measure(await m.makeShareImage(cover, { title: 'X' }, 30, 50)),
      plate: await measure(await m.makeShareImage(null, { id: 'z', title: 'לילה שקט', title_translit: 'Laila Shaket' })),
    };
  });
  for (const k of ['cover', 'plate']) {
    const o = out[k];
    r.check(`${k}: image/jpeg, 600x600, under 200 KB`, o.type === 'image/jpeg' && o.w === 600 && o.h === 600 && o.size <= 200 * 1024, JSON.stringify(o));
  }
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
