/* ============================================================
   SLEEP-1 -- the sleep timer.

   Songs get a stubbed 3s silent WAV (as in stations.spec.mjs) so radio and
   queues really play and really end. Time is Playwright's fake clock: once
   paused, Date.now() only moves when the test says so and no setTimeout or
   setInterval fires at all -- the "phone throttled every timer" case -- so
   anything that still fires on time did so from the audio's own timeupdate
   events. Covers: every option's deadline and label, Off shown only while
   running, Off cancels, a new pick replaces the old, the mini-player's moon,
   time up fading (Chromium can set volume) then pausing with the volume put
   back, the iPhone case (volume writes ignored: pause at the time, no fade),
   time up while paused (only the timer clears), End of this song stopping
   both radio and a Play all queue, Keep playing never touched, the analytics
   events, and contrast of every sleep control in 4 colors x 2 lightings.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorker } from '../lib/load-worker.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACTIVITY_URL = 'https://laivyhart-audio-upload.ytweiser-399.workers.dev/event';

const AUDIO_HOST = 'audio.test';
function silentWav(secs) {
  const rate = 8000, n = Math.round(rate * secs);
  const b = Buffer.alloc(44 + n, 0x80);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}
// 60s songs wherever the music must simply keep going; 3s ones (opts.short)
// where a song has to end during the test. A 3s song everywhere let a song
// end, under load, in the middle of checks that assumed it would not.
const WAV = silentWav(60);
const SHORT_WAV = silentWav(3);
const SONGS = F.SONGS_ROWS.map((s) => ({ ...s, audio_url: `https://${AUDIO_HOST}/${s.id}.wav` }));
const MIN = 60000;

async function setup(browser, opts) {
  opts = opts || {};
  const page = await newPage(browser, opts.viewport);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { songs: SONGS });
  await page.route(`**://${AUDIO_HOST}/**`, (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: opts.short ? SHORT_WAV : WAV }));
  if (opts.clock) await page.clock.install();
  return { page, errors };
}
// /listen with radio playing (RADIO station), activity calls captured.
async function openPlaying(page, port) {
  await page.goto(`http://localhost:${port}/listen`, { waitUntil: 'load' });
  await page.waitForSelector('#rows .row', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('#station-row [data-station]').length > 1, null, { timeout: 10000 });
  await page.waitForFunction(() => window.laivy && window.laivy.activity && window.laivy.activity.log, null, { timeout: 10000 });
  await page.evaluate(() => {
    window.__acts = [];
    window.laivy.activity.log = (type, opts) => { window.__acts.push({ type, opts: opts || {} }); };
  });
  await page.click('#station-row [data-station="all"]');
  await page.waitForFunction(() => mode === 'radio' && currentIdx !== null && !audioEl.paused, null, { timeout: 10000 });
}
// Fake clock: stop time (no timers fire from here on) and return "now".
async function freeze(page) {
  // pauseAt must lie in the future; a busy machine can spend over a second
  // between these two calls, so leave plenty. Every check is relative to
  // the value returned.
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 20000);
  return now + 20000;
}
async function pick(page, key, opener) {
  await page.click(opener || '#sleep-btn');
  await page.waitForFunction(() => !document.getElementById('sleep-panel').hidden, null, { timeout: 5000 });
  await page.click(`#sleep-panel-row [data-sleep="${key}"]`);
}
const btnText = (page) => page.evaluate(() => document.getElementById('sleep-btn-text').textContent);
const state = (page) => page.evaluate(() => ({
  timer: sleepTimer && { ...sleepTimer }, fading: !!sleepFade, paused: audioEl.paused, vol: audioEl.volume,
  autoplay: autoplayOn, sw: document.getElementById('keep-playing-switch').checked, idx: currentIdx, mode,
}));
const acts = (page, type) => page.evaluate((t) => window.__acts.filter((x) => x.type === t).map((x) => x.opts.meta), type);
// One audio timeupdate, the real one from the playing element.
// Bounded from Node's side (the page's own timers, performance.now and
// requestAnimationFrame are all frozen by the fake clock): a missing
// timeupdate fails loudly, with the audio's state, instead of hanging the
// whole worker.
async function nextTimeupdate(page) {
  // Also done once the audio is (or goes) paused: a real timeupdate can land
  // between moving the clock and getting here, and if that one fired the
  // timer, the music is already paused and no further timeupdate will come.
  const wait = page.evaluate(() => new Promise((res) => {
    if (audioEl.paused) return res();
    audioEl.addEventListener('timeupdate', () => res(), { once: true });
    audioEl.addEventListener('pause', () => res(), { once: true });
  }));
  let timer;
  const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('no timeupdate in 8s')), 8000); });
  try { await Promise.race([wait, limit]); }
  catch (e) {
    const st = await page.evaluate(() => ({ paused: audioEl.paused, ended: audioEl.ended, readyState: audioEl.readyState, idx: currentIdx, src: audioEl.currentSrc, err: audioEl.error && audioEl.error.code }));
    throw new Error(e.message + ' ' + JSON.stringify(st));
  } finally { clearTimeout(timer); }
}

export async function run(browser, port) {
  const r = makeReporter('sleep-timer.spec.mjs');
  await scenarioLayout(browser, port, r);
  await scenarioOptions(browser, port, r);
  await scenarioMini(browser, port, r);
  await scenarioFade(browser, port, r);
  await scenarioFadeAcrossSongEnd(browser, port, r);
  await scenarioNoVolume(browser, port, r);
  await scenarioPausedAtTime(browser, port, r);
  await scenarioEndOfSong(browser, port, r);
  await scenarioContrast(browser, port, r);
  await scenarioEventsEndToEnd(browser, port, r);
  return r;
}

/* PLAYER-4: Sleep at the right end of the play controls row, centered with
   play, above "What did you think?"; the station line right under the row;
   no Autoplay switch (or its old row) left in the panel. At 300 px, too
   narrow for one row, Sleep wraps to its own line under the buttons, still
   above the station line. The buttons never shrink, the page never scrolls
   sideways. */
async function scenarioLayout(browser, port, r) {
  r.section('PLAYER-4: Sleep in the play controls row (1280, 375, and a squeezed 300 px)');
  for (const width of [1280, 375, 300]) {
    const { page, errors } = await setup(browser, { viewport: { width, height: 900 } });
    await openPlaying(page, port);
    for (const label of ['Sleep', 'Sleep: end of song']) {
      if (label !== 'Sleep') await pick(page, 'end_of_song');
      const d = await page.evaluate(() => {
        const box = (id) => document.getElementById(id).getBoundingClientRect();
        const t = document.querySelector('.transport'), sl = box('sleep-btn'), pl = box('play-btn'), pv = box('prev-btn'), nx = box('next-btn');
        const tr = t.getBoundingClientRect();
        return {
          inRow: document.getElementById('sleep-btn').parentElement === t && t.lastElementChild.id === 'sleep-btn',
          text: document.getElementById('sleep-btn-text').textContent,
          sameLine: Math.abs((sl.top + sl.bottom) / 2 - (pl.top + pl.bottom) / 2) <= 1.5,
          rightEnd: Math.abs(sl.right - tr.right) <= 1.5, afterNext: sl.left >= nx.right,
          belowButtons: sl.top >= pl.bottom - 0.5,
          aboveLoves: sl.bottom <= box('loves').top, lineUnder: t.nextElementSibling.id === 'station-line' && box('station-line').top >= sl.bottom - 0.5,
          sizes: [pv.width, pl.width, nx.width, pl.height].map((x) => Math.round(x * 10) / 10),
          cssSizes: ['prev-btn', 'play-btn', 'next-btn'].map((id) => parseFloat(getComputedStyle(document.getElementById(id)).width)),
          pageW: document.scrollingElement.scrollWidth, vw: window.innerWidth,
          noOldRow: !document.getElementById('play-mode-row') && !document.getElementById('autoplay-switch')
            && !document.querySelector('.dock input[role="switch"], .dock .keep-playing-toggle, .autoplay-toggle'),
        };
      });
      const tag = `[${width}px, "${label}"]`;
      r.check(`${tag} Sleep is the last item of the controls row`, d.inRow && d.text === label, JSON.stringify(d));
      if (width >= 375) {
        r.check(`${tag} on the same line as play, vertically centered, at the row's right end`, d.sameLine && d.rightEnd && d.afterNext, JSON.stringify(d));
      } else {
        // "Sleep" alone still fits beside the buttons at 300 px; the long
        // label does not, so it must take its own line under them.
        r.check(label === 'Sleep' ? `${tag} short label still fits on the play line` : `${tag} too narrow: Sleep wraps to its own line right under the play buttons`,
          d.rightEnd && (label === 'Sleep' ? d.sameLine : d.belowButtons), JSON.stringify(d));
      }
      r.check(`${tag} above "What did you think?", station line directly under the row`, d.aboveLoves && d.lineUnder, JSON.stringify(d));
      r.check(`${tag} the play buttons keep their full size`, d.sizes.slice(0, 3).every((w, i) => Math.abs(w - d.cssSizes[i]) < 0.6), JSON.stringify(d));
      r.check(`${tag} no sideways scrolling`, d.pageW <= d.vw, JSON.stringify(d));
      r.check(`${tag} no Autoplay switch or its old row left in the panel`, d.noOldRow);
    }
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}

async function scenarioOptions(browser, port, r) {
  r.section('the menu: every option sets its deadline and label; Off; replacing');
  const { page, errors } = await setup(browser, { clock: true });
  await openPlaying(page, port);
  r.check('the Sleep button has its moon', await page.evaluate(() => !!document.querySelector('#sleep-btn svg')));
  r.check('it says "Sleep" before a timer is set', await btnText(page) === 'Sleep');
  await page.click('#sleep-btn');
  await page.waitForFunction(() => !document.getElementById('sleep-panel').hidden, null, { timeout: 5000 });
  const menu = await page.evaluate(() => [...document.querySelectorAll('#sleep-panel-row [data-sleep]')].filter((b) => !b.hidden).map((b) => b.textContent));
  r.check('below a divider: the "Keep playing after each song" switch, shown with no timer running', await page.evaluate(() => {
    const d = document.querySelector('#sleep-panel .sleep-divider'), l = document.querySelector('#sleep-panel label.keep-playing-toggle');
    return !!d && !!l && l.offsetParent !== null && l.textContent.trim() === 'Keep playing after each song'
      && !!(document.getElementById('sleep-panel-row').compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING)
      && !!(d.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING)
      && l.getBoundingClientRect().top > document.getElementById('sleep-panel-row').getBoundingClientRect().bottom;
  }));
  r.check('menu: 15 minutes, 30 minutes, 45 minutes, 1 hour, End of this song (no Off yet)',
    JSON.stringify(menu) === JSON.stringify(['15 minutes', '30 minutes', '45 minutes', '1 hour', 'End of this song']), JSON.stringify(menu));
  r.check('...in the station panel\'s sheet with station buttons', await page.evaluate(() =>
    document.getElementById('sleep-panel').classList.contains('station-panel')
      && [...document.querySelectorAll('#sleep-panel-row [data-sleep]')].every((b) => b.classList.contains('station-btn'))));
  await page.keyboard.press('Escape');
  r.check('Escape closes it', await page.evaluate(() => document.getElementById('sleep-panel').hidden));

  const t0 = await freeze(page);
  for (const [key, min, label] of [['15', 15, 'Sleep 15:00'], ['30', 30, 'Sleep 30:00'], ['45', 45, 'Sleep 45:00'], ['60', 60, 'Sleep 60:00']]) {
    await pick(page, key);
    const s = await state(page);
    r.check(`${key}: deadline is now + ${min} min, button reads "${label}"`,
      s.timer && s.timer.key === key && s.timer.deadline === t0 + min * MIN && await btnText(page) === label,
      JSON.stringify({ s, text: await btnText(page) }));
    r.check(`${key}: picking closes the menu`, await page.evaluate(() => document.getElementById('sleep-panel').hidden));
  }
  r.check('a new choice replaces the old (one timer, the newest)', (await state(page)).timer.key === '60');
  await page.clock.setSystemTime(t0 + 37 * MIN + 46000);
  await nextTimeupdate(page);
  r.check('the label counts down from the clock ("Sleep 22:14" at 37:46 in)', await btnText(page) === 'Sleep 22:14', await btnText(page));
  r.check('radio keeps playing while the timer runs', !(await state(page)).paused && (await state(page)).mode === 'radio');

  await pick(page, 'end_of_song');
  let s = await state(page);
  r.check('End of this song: no deadline, button reads "Sleep: end of song"', s.timer.key === 'end_of_song' && s.timer.deadline === null
    && await btnText(page) === 'Sleep: end of song', JSON.stringify(s));
  await page.click('#sleep-btn');
  const lit = await page.evaluate(() => [...document.querySelectorAll('#sleep-panel-row [data-sleep]')].map((b) => ({ k: b.dataset.sleep, on: b.classList.contains('is-on'), hidden: b.hidden })));
  r.check('while running, the Keep playing switch is still shown', await page.evaluate(() => document.querySelector('#sleep-panel label.keep-playing-toggle').offsetParent !== null));
  r.check('while running, Off is shown and the running choice is filled', lit.find((x) => x.k === 'off' && !x.hidden)
    && lit.filter((x) => x.on).map((x) => x.k).join() === 'end_of_song', JSON.stringify(lit));
  await page.click('#sleep-panel-row [data-sleep="off"]');
  s = await state(page);
  r.check('Off cancels it, the button is back to "Sleep"', s.timer === null && await btnText(page) === 'Sleep', JSON.stringify(s));
  await page.click('#sleep-btn');
  r.check('...and Off is hidden again', await page.evaluate(() => document.querySelector('#sleep-panel-row [data-sleep="off"]').hidden));
  await page.keyboard.press('Escape');
  await page.clock.setSystemTime(t0 + 120 * MIN);
  await nextTimeupdate(page);
  r.check('a cancelled timer never fires (still playing)', !(await state(page)).paused);
  r.check('sleep_timer_set logged with each chosen option',
    JSON.stringify((await acts(page, 'sleep_timer_set')).map((m) => m.option)) === JSON.stringify(['15', '30', '45', '60', 'end_of_song', 'off']),
    JSON.stringify(await acts(page, 'sleep_timer_set')));
  r.check('Keep playing untouched', (await state(page)).autoplay === true && (await state(page)).sw === true);

  await pick(page, '30');
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#rows .row', { timeout: 10000 });
  r.check('a reload clears the timer (not remembered)', await page.evaluate(() => sleepTimer === null && document.getElementById('sleep-btn-text').textContent === 'Sleep'));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioMini(browser, port, r) {
  r.section('mini-player: a small moon with the time left');
  const { page, errors } = await setup(browser, { clock: true, viewport: { width: 390, height: 844 } });
  await openPlaying(page, port);
  const t0 = await freeze(page);
  await pick(page, '45');
  await page.evaluate(() => navigate('home'));
  await page.waitForFunction(() => !document.getElementById('mini-player').classList.contains('hidden'), null, { timeout: 10000 });
  await page.clock.setSystemTime(t0 + 21 * MIN + 46000);
  await nextTimeupdate(page);
  const m = await page.evaluate(() => {
    const el = document.getElementById('mini-sleep'), rc = el.getBoundingClientRect();
    const all = [...document.querySelectorAll('#mini-player > *')].filter((x) => x.offsetParent);
    return { hidden: el.classList.contains('hidden'), moon: !!el.querySelector('svg'), text: el.textContent, right: rc.right,
      maxRight: Math.max(...all.map((x) => x.getBoundingClientRect().right)), label: el.getAttribute('aria-label') };
  });
  r.check('shows the moon with "23:14" left', !m.hidden && m.moon && m.text === '23:14', JSON.stringify(m));
  r.check('says it to screen readers', m.label === 'Sleep timer: 23:14 left. Change', m.label);
  r.check('the whole bar (station + moon + buttons) fits 390 px', m.maxRight <= 390, JSON.stringify(m));
  await page.click('#mini-sleep');
  await page.waitForFunction(() => !document.getElementById('sleep-panel').hidden, null, { timeout: 5000 });
  r.check('tapping it opens the sleep menu', true);
  await page.click('#sleep-panel-row [data-sleep="end_of_song"]');
  r.check('End of this song: the moon says "End of song"', await page.evaluate(() => document.getElementById('mini-sleep').textContent) === 'End of song');
  await page.click('#mini-sleep');
  await page.click('#sleep-panel-row [data-sleep="off"]');
  r.check('Off: the moon goes away', await page.evaluate(() => document.getElementById('mini-sleep').classList.contains('hidden')));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioFade(browser, port, r) {
  r.section('time up (timers frozen): fade over ~10s from timeupdate alone, pause, volume back');
  const { page, errors } = await setup(browser, { clock: true });
  await openPlaying(page, port);
  await page.evaluate(() => { audioEl.volume = 0.8; });
  const t0 = await freeze(page);
  await pick(page, '15');
  await page.clock.setSystemTime(t0 + 15 * MIN - 1000);
  await nextTimeupdate(page);
  r.check('one second early: nothing yet', !(await state(page)).fading && !(await state(page)).paused);
  await page.clock.setSystemTime(t0 + 15 * MIN);
  await nextTimeupdate(page);
  let s = await state(page);
  r.check('at the deadline, with every timer frozen, timeupdate starts the fade', s.fading && !s.paused, JSON.stringify(s));
  await page.clock.setSystemTime(t0 + 15 * MIN + 5000);
  await nextTimeupdate(page);
  s = await state(page);
  r.check('halfway (5s): about half volume, still playing', !s.paused && Math.abs(s.vol - 0.4) < 0.05, JSON.stringify(s));
  r.check('radio keeps going during the fade', s.mode === 'radio');
  await page.clock.setSystemTime(t0 + 15 * MIN + 10000);
  await nextTimeupdate(page);
  await page.waitForFunction(() => audioEl.paused, null, { timeout: 3000 });
  s = await state(page);
  r.check('after ~10s: paused', s.paused, JSON.stringify(s));
  r.check('the volume is put back (0.8) so the next play is not silent', Math.abs(s.vol - 0.8) < 0.001, JSON.stringify(s));
  r.check('the timer cleared itself; the button reads "Sleep"', s.timer === null && !s.fading && await btnText(page) === 'Sleep');
  r.check('Keep playing untouched', s.autoplay === true && s.sw === true);
  r.check('sleep_timer_fired logged (option 15, faded)', JSON.stringify(await acts(page, 'sleep_timer_fired')) === JSON.stringify([{ option: '15', action: 'fade' }]),
    JSON.stringify(await acts(page, 'sleep_timer_fired')));

  // Paused by hand mid-fade: done there, volume back at once.
  await page.evaluate(() => audioEl.play());
  await page.waitForFunction(() => !audioEl.paused, null, { timeout: 5000 });
  const t1 = await page.evaluate(() => Date.now());
  await pick(page, '30');
  await page.clock.setSystemTime(t1 + 30 * MIN + 3000);
  await nextTimeupdate(page);
  await page.clock.setSystemTime(t1 + 30 * MIN + 6000);
  await nextTimeupdate(page);
  await page.click('#play-btn');   // the real pause control
  await page.waitForFunction(() => sleepTimer === null, null, { timeout: 3000 });
  s = await state(page);
  r.check('paused by hand mid-fade: timer clears, volume back to 0.8', s.paused && Math.abs(s.vol - 0.8) < 0.001, JSON.stringify(s));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* A song that ends during the fade. The element fires 'pause' just before
   'ended' at every natural end; that must not count as a hand pause (which
   used to cancel the fade, put the volume back to full and let radio play
   on). The fade carries on into the next radio song and still ends paused. */
async function scenarioFadeAcrossSongEnd(browser, port, r) {
  r.section('a song ends during the fade: the fade carries on into the next radio song');
  const { page, errors } = await setup(browser, { clock: true, short: true });
  await openPlaying(page, port);
  await page.evaluate(() => { audioEl.volume = 0.8; });
  const t0 = await freeze(page);
  await pick(page, '15');
  await page.clock.setSystemTime(t0 + 15 * MIN);
  await nextTimeupdate(page);
  const from = await page.evaluate(() => currentIdx);
  r.check('the fade has started', (await state(page)).fading);
  await page.waitForFunction((f) => currentIdx !== f && !audioEl.paused, from, { timeout: 10000 });
  await page.clock.setSystemTime(t0 + 15 * MIN + 5000);
  await nextTimeupdate(page);
  let s = await state(page);
  r.check('the song ended and radio moved on, mid-fade', s.idx !== from && s.mode === 'radio' && !s.paused, JSON.stringify(s));
  r.check('...the fade is still running, timer still set, about half volume', s.fading && s.timer && s.timer.key === '15' && Math.abs(s.vol - 0.4) < 0.05, JSON.stringify(s));
  await page.clock.setSystemTime(t0 + 15 * MIN + 10000);
  await nextTimeupdate(page);
  await page.waitForFunction(() => audioEl.paused && sleepTimer === null, null, { timeout: 5000 });
  s = await state(page);
  r.check('...and it still ends: paused, volume back to 0.8, timer cleared', s.paused && Math.abs(s.vol - 0.8) < 0.001 && s.timer === null, JSON.stringify(s));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioNoVolume(browser, port, r) {
  r.section('iPhone Safari (volume writes ignored, always reads 1): pause at the time, no fade');
  const { page, errors } = await setup(browser, { clock: true });
  await openPlaying(page, port);
  await page.evaluate(() => {
    Object.defineProperty(audioEl, 'volume', { configurable: true, get: () => 1, set: () => {} });
  });
  const t0 = await freeze(page);
  await pick(page, '30');
  await page.clock.setSystemTime(t0 + 30 * MIN);
  await nextTimeupdate(page);
  await page.waitForFunction(() => audioEl.paused, null, { timeout: 3000 });
  const s = await state(page);
  r.check('paused right at the deadline, no fade, timer cleared', s.paused && !s.fading && s.timer === null, JSON.stringify(s));
  r.check('sleep_timer_fired logged (option 30, paused)', JSON.stringify(await acts(page, 'sleep_timer_fired')) === JSON.stringify([{ option: '30', action: 'pause' }]));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioPausedAtTime(browser, port, r) {
  r.section('paused by hand: the timer keeps running; at the time only the timer clears');
  const { page, errors } = await setup(browser, { clock: true });
  await openPlaying(page, port);
  const t0 = await freeze(page);
  await pick(page, '15');
  await page.evaluate(() => audioEl.pause());
  await page.waitForFunction(() => audioEl.paused, null, { timeout: 3000 });
  await page.clock.setSystemTime(t0 + 5 * MIN - 1000);
  await page.clock.runFor(1000);   // one interval tick, landing on 5:00 in
  r.check('a hand pause keeps the timer running ("Sleep 10:00")', (await state(page)).timer?.key === '15' && await btnText(page) === 'Sleep 10:00', await btnText(page));
  const before = await state(page);
  await page.clock.setSystemTime(t0 + 15 * MIN - 1000);
  await page.clock.runFor(1000);
  const s = await state(page);
  r.check('time up while paused: timer cleared, nothing else (same song, still paused, volume as was)',
    s.timer === null && s.paused && s.idx === before.idx && s.vol === before.vol && s.mode === 'radio', JSON.stringify(s));
  r.check('sleep_timer_fired logged (action none)', JSON.stringify(await acts(page, 'sleep_timer_fired')) === JSON.stringify([{ option: '15', action: 'none' }]));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioEndOfSong(browser, port, r) {
  r.section('End of this song: stops at the end even with radio, or a queue, to continue');
  for (const kind of ['radio', 'queue']) {
    const { page, errors } = await setup(browser, { short: true });
    if (kind === 'radio') {
      await openPlaying(page, port);
    } else {
      await page.goto(`http://localhost:${port}/artist/nova-ash`, { waitUntil: 'load' });
      await page.waitForSelector('#artist-playall', { timeout: 10000 });
      await page.click('#artist-playall');
      await page.waitForFunction(() => currentIdx !== null && manualQueue && manualQueue.length > 1 && !audioEl.paused, null, { timeout: 10000 });
      await page.evaluate(() => navigate('listen'));
      await page.waitForFunction(() => !document.getElementById('sleep-btn').classList.contains('hidden'), null, { timeout: 5000 });
    }
    const before = await state(page);
    const hadNext = await page.evaluate(() => !!nextUp);
    await pick(page, 'end_of_song');
    await page.waitForFunction(() => audioEl.ended || (audioEl.paused && sleepTimer === null), null, { timeout: 10000 });
    await page.waitForFunction(() => sleepTimer === null, null, { timeout: 3000 });
    // A continuation would have started synchronously inside 'ended'.
    const s = await state(page);
    r.check(`[${kind}] something was lined up to continue`, hadNext);
    r.check(`[${kind}] stopped when the song ended: same song, paused, nothing new started`,
      s.paused && s.idx === before.idx, JSON.stringify({ before, s }));
    r.check(`[${kind}] the timer cleared; Keep playing untouched`, s.timer === null && s.autoplay === true && s.sw === true);
    r.check(`[${kind}] the play button shows play`, await page.evaluate(() => document.getElementById('play-btn').innerHTML.includes('▶')));
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}

async function scenarioContrast(browser, port, r) {
  r.section('contrast: the Sleep button, every menu option, the Keep playing label and the moon, 4 colors x light/dark, set and not');
  const { page, errors } = await setup(browser);
  await openPlaying(page, port);
  await pick(page, '30');
  await page.click('#sleep-btn');
  for (const color of ['bordeaux', 'emerald', 'royal', 'gold']) {
    for (const theme of ['dark', 'light']) {
      const res = await page.evaluate(({ color, theme }) => {
        document.documentElement.setAttribute('data-color', color);
        document.documentElement.setAttribute('data-theme', theme);
        const parse = (str) => (str.match(/rgba?\([^)]+\)/g) || []).map((c) => c.match(/[\d.]+/g).map(Number));
        const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
        const over = (fg, bg) => { const a = fg[3] == null ? 1 : fg[3]; return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)); };
        const rootCs = getComputedStyle(document.documentElement);
        const hex = (h) => { h = h.trim().replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
        const pageBgs = [hex(rootCs.getPropertyValue('--bg')), hex(rootCs.getPropertyValue('--bg-2'))];
        const out = [];
        for (const b of document.querySelectorAll('#sleep-panel-row [data-sleep], #sleep-btn, #mini-sleep, #sleep-panel .keep-playing-text')) {
          const cs = getComputedStyle(b);
          const text = parse(cs.color)[0];
          let worst = Infinity;
          const stops = cs.backgroundImage !== 'none' ? parse(cs.backgroundImage) : [parse(cs.backgroundColor)[0]];
          for (const base of pageBgs) for (const stop of stops) worst = Math.min(worst, ratio(over(text, base), over(stop || [0, 0, 0, 0], base)));
          out.push({ id: b.dataset.sleep || b.id || b.className, on: b.classList.contains('is-on'), ratio: Math.round(worst * 100) / 100 });
        }
        return out;
      }, { color, theme });
      const bad = res.filter((x) => x.ratio < 4.5);
      const onCount = res.filter((x) => x.on).length;
      r.check(`${color}/${theme}: all ${res.length} sleep controls (${onCount} set) at 4.5:1 or better; lowest ${Math.min(...res.map((x) => x.ratio))}`,
        bad.length === 0 && res.length === 9 && onCount >= 2, JSON.stringify(bad));
    }
  }
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* DEPLOY-1: the real js/activity.js -> the real Worker POST /event handler
   (worker/src/index.js, loaded into Node) -> the rows it would insert,
   checked against the newest activity_events_event_type_check in sql/. The
   one network hop that would leave the sandbox (the insert) is a stub. This
   page alone clears laivy-no-track, as activity.spec.mjs does, so the
   client really sends. */
function newestConstraintTypes() {
  const files = readFileSync(join(ROOT, 'sql', '030_sleep_timer_events.sql'), 'utf8');
  const m = files.match(/check \(event_type = any \(array\[([\s\S]*?)\]\)\)/);
  return m ? [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]) : [];
}
async function scenarioEventsEndToEnd(browser, port, r) {
  r.section('sleep events end to end: client -> Worker /event -> insert rows (unknown type still dropped)');
  const W = await loadWorker();
  const inserted = [];
  const fetchImpl = async (url, opts) => { inserted.push(...JSON.parse(opts.body)); return { ok: true, text: async () => '[]' }; };
  const { page, errors } = await setup(browser, { short: true });
  await page.addInitScript(() => { try { localStorage.removeItem('laivy-no-track'); } catch (e) {} });
  await page.route(ACTIVITY_URL, async (route) => {
    const req = route.request();
    const wreq = new Request(ACTIVITY_URL, { method: 'POST', headers: req.headers(), body: req.postData() || '' });
    // Jerusalem, as Cloudflare would describe the visitor (no IP anywhere).
    Object.defineProperty(wreq, 'cf', { value: { city: 'Jerusalem', region: 'Jerusalem', country: 'IL', latitude: '31.78', longitude: '35.22' } });
    const waits = [];
    const res = await W.handleActivityEvent(wreq, { SUPABASE_SERVICE_ROLE_KEY: 'svc' }, { waitUntil: (p) => waits.push(p) }, fetchImpl);
    await Promise.all(waits);
    await route.fulfill({ status: res.status });
  });
  await page.goto(`http://localhost:${port}/listen`, { waitUntil: 'load' });
  await page.waitForSelector('#rows .row', { timeout: 10000 });
  await page.waitForFunction(() => window.laivy && window.laivy.activity && window.laivy.activity.log, null, { timeout: 10000 });
  await page.click('#station-row [data-station="all"]');
  await page.waitForFunction(() => mode === 'radio' && currentIdx !== null && !audioEl.paused, null, { timeout: 10000 });
  await pick(page, 'end_of_song');
  await page.waitForFunction(() => sleepTimer === null && audioEl.paused, null, { timeout: 10000 });
  await page.evaluate(() => window.laivy.activity.log('not_a_real_type', { meta: { x: 1 } }));
  await page.evaluate(() => window.laivy.activity.flush(false));
  const set = inserted.filter((x) => x.event_type === 'sleep_timer_set');
  const fired = inserted.filter((x) => x.event_type === 'sleep_timer_fired');
  r.check('sleep_timer_set reaches the insert with its option', set.length === 1 && set[0].meta.option === 'end_of_song', JSON.stringify(set));
  r.check('sleep_timer_fired reaches the insert with option and action', fired.length === 1
    && fired[0].meta.option === 'end_of_song' && fired[0].meta.action === 'pause', JSON.stringify(fired));
  r.check('an unknown event type is still dropped by the Worker', !inserted.some((x) => x.event_type === 'not_a_real_type')
    && inserted.length > 2, inserted.map((x) => x.event_type).join());
  const row = fired[0] || {};
  r.check('same rules as other events: a device id, anonymous (no account), session id', typeof row.device_id === 'string' && row.device_id.length > 0
    && row.user_id === null && !!row.session_id, JSON.stringify(row));
  r.check('city-level location only: no IP, no coordinates in the row', !('ip' in row) && !('latitude' in row) && !('longitude' in row)
    && /Jerusalem/.test(row.display_city || ''), JSON.stringify(row));
  const allowed = newestConstraintTypes();
  r.check('sql/030 allows both sleep events and not the unknown one', allowed.includes('sleep_timer_set') && allowed.includes('sleep_timer_fired')
    && !allowed.includes('not_a_real_type'), allowed.join());
  r.check('every row the Worker would insert passes the database constraint', inserted.every((x) => allowed.includes(x.event_type)),
    inserted.map((x) => x.event_type).filter((t) => !allowed.includes(t)).join());
  r.check('every Worker-allowed type is allowed by the database', W.ACTIVITY_EVENT_TYPES.every((t) => allowed.includes(t)),
    W.ACTIVITY_EVENT_TYPES.filter((t) => !allowed.includes(t)).join());
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
