/* ============================================================
   RADIO-2 -- the mood stations, visible and one tap away.

   Songs get a stubbed silent WAV (as in play-continuation.spec.mjs) so radio
   really plays. Covers: the /listen station row (RADIO first, then every
   channel in order, the old dropdown gone); a mood tap starts a song from
   that mood, highlights it and filters the list; RADIO goes back to all
   songs; nothing is highlighted off radio; the station line for radio, a
   mood and a Play all queue; Change station opens, switches and closes; the
   takeover glow (and its reduced-motion form); the mini-player's station;
   a 375 px screen (one sideways-scrolling line, fade, search box on screen);
   and text contrast of every station button in all 4 colors x 2 lightings.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

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
const WAV = silentWav(3);
const SONGS = F.SONGS_ROWS.map((s) => ({ ...s, audio_url: `https://${AUDIO_HOST}/${s.id}.wav` }));
const CHANNELS = [...F.CHANNELS_ROWS].sort((a, b) => a.sort_order - b.sort_order);

// The eight real station names (channels.json), for the narrow-screen check.
const EIGHT = ['INSPIRE ME', 'MAKE ME FEEL GOOD', 'MOVE ME', 'PERCEPTIONS', 'HELP ME ESCAPE', 'FIRE ME UP', 'WIND ME DOWN', 'CELEBRATE WITH ME']
  .map((title, i) => ({ id: title.toLowerCase().replace(/ /g, '-'), title, tagline: '', sort_order: (i + 1) * 10, active: true }));

async function setup(browser, opts) {
  opts = opts || {};
  const page = await newPage(browser, opts.viewport);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { songs: opts.songs || SONGS, ...(opts.overrides || {}) });
  await page.route(`**://${AUDIO_HOST}/**`, (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }));
  return { page, errors };
}
async function openListen(page, port, path) {
  await page.goto(`http://localhost:${port}${path || '/listen'}`, { waitUntil: 'load' });
  await page.waitForSelector('#rows .row', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('#station-row [data-station]').length > 1, null, { timeout: 10000 });
}
const stations = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(sel + ' [data-station]')].map((b) => ({
  key: b.dataset.station, text: b.textContent.trim(), on: b.classList.contains('is-on'), pressed: b.getAttribute('aria-pressed'),
})), sel);
const lineText = (page) => page.evaluate(() => document.getElementById('station-line-text').textContent);
const visibleSongIds = (page) => page.evaluate(() => [...document.querySelectorAll('#rows .row')].map((r) => SONGS[Number(r.dataset.idx)].id));
async function clickFirstRow(page) {
  for (let i = 0; i < 15; i++) {
    if (await page.evaluate(() => currentIdx !== null)) return;
    await page.click('#rows .row .row-title-primary', { timeout: 5000 }).catch(() => {});
    if (await page.waitForFunction(() => currentIdx !== null, null, { timeout: 1000 }).then(() => true, () => false)) return;
  }
  throw new Error('no song loaded');
}

export async function run(browser, port) {
  const r = makeReporter('stations.spec.mjs');
  await scenarioRow(browser, port, r);
  await scenarioLineAndPanel(browser, port, r);
  await scenarioGlow(browser, port, r);
  await scenarioMini(browser, port, r);
  await scenarioNarrow(browser, port, r);
  await scenarioContrast(browser, port, r);
  return r;
}

async function scenarioRow(browser, port, r) {
  r.section('the station row on /listen');
  const { page, errors } = await setup(browser);
  await openListen(page, port);
  const st = await stations(page, '#station-row');
  r.check('RADIO first, then every channel in the strip\'s order and wording',
    JSON.stringify(st.map((s) => s.key)) === JSON.stringify(['all', ...CHANNELS.map((c) => c.id)])
      && st.slice(1).every((s, i) => s.text === CHANNELS[i].title), JSON.stringify(st));
  r.check('nothing highlighted before anything plays', st.every((s) => !s.on && s.pressed === 'false'));
  r.check('the old Mood radio dropdown is gone', await page.evaluate(() =>
    !document.getElementById('mood-radio-btn') && !document.getElementById('mood-menu') && !document.querySelector('.mood-radio, .mood-menu')));

  await clickFirstRow(page);
  r.check('a single song (not radio): still nothing highlighted', (await stations(page, '#station-row')).every((s) => !s.on));

  // One tap on a mood.
  const mood = CHANNELS[0];
  await page.click(`#station-row [data-station="${mood.id}"]`);
  await page.waitForFunction((id) => activeChannel === id && currentIdx !== null && SONGS[currentIdx].channels.includes(id), mood.id, { timeout: 10000 });
  const members = new Set(SONGS.filter((s) => (s.channels || []).includes(mood.id)).map((s) => s.id));
  const playing = await page.evaluate(() => SONGS[currentIdx].id);
  r.check(`tapping ${mood.title} starts a song from that mood now`, members.has(playing) && await page.evaluate(() => mode === 'channelRadio'), playing);
  const st2 = await stations(page, '#station-row');
  r.check('that mood is highlighted, and only it', st2.filter((s) => s.on).map((s) => s.key).join() === mood.id && st2.find((s) => s.key === mood.id).pressed === 'true', JSON.stringify(st2));
  const vis = await visibleSongIds(page);
  r.check('the list is filtered to that mood', vis.length === members.size && vis.every((id) => members.has(id)), JSON.stringify(vis));
  r.check('the station is named (banner + address)', await page.evaluate((t) => document.querySelector('.channel-banner-title')?.textContent === t
    && new URLSearchParams(location.search).get('channel') !== null, mood.title));
  r.check('station line: "On Radio: <mood>"', await lineText(page) === 'On Radio: ' + mood.title, await lineText(page));

  // RADIO back to all songs.
  await page.click('#station-row [data-station="all"]');
  await page.waitForFunction(() => mode === 'radio' && activeChannel === null, null, { timeout: 10000 });
  const st3 = await stations(page, '#station-row');
  r.check('RADIO is highlighted, the mood is not', st3.filter((s) => s.on).map((s) => s.key).join() === 'all', JSON.stringify(st3));
  r.check('the list is back to all songs', (await visibleSongIds(page)).length === SONGS.length);
  r.check('the mood banner and ?channel= are gone', await page.evaluate(() => !document.querySelector('.channel-banner') && !location.search.includes('channel')));
  r.check('station line: "On Radio: All songs"', await lineText(page) === 'On Radio: All songs', await lineText(page));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioLineAndPanel(browser, port, r) {
  r.section('the station line and the Change station panel');
  const { page, errors } = await setup(browser);
  await page.goto(`http://localhost:${port}/artist/nova-ash`, { waitUntil: 'load' });
  await page.waitForSelector('#artist-playall', { timeout: 10000 });
  await page.click('#artist-playall');
  await page.waitForFunction(() => currentIdx !== null && manualQueue && manualQueue.length, null, { timeout: 10000 });
  r.check('Play all: "Playing: Nova Ash: Play all"', await lineText(page) === 'Playing: Nova Ash: Play all', await lineText(page));
  r.check('the line sits directly under the play controls', await page.evaluate(() =>
    document.querySelector('.transport').nextElementSibling === document.getElementById('station-line')));
  r.check('nothing highlighted during a queue', (await page.evaluate(() => [...document.querySelectorAll('.station-row .is-on')].length)) === 0);

  await page.click('#station-change');
  await page.waitForFunction(() => !document.getElementById('station-panel').hidden, null, { timeout: 5000 });
  const panel = await stations(page, '#station-panel-row');
  r.check('Change station opens the panel with the same stations', JSON.stringify(panel.map((s) => s.key)) === JSON.stringify(['all', ...CHANNELS.map((c) => c.id)]), JSON.stringify(panel));
  r.check('...marked expanded', await page.evaluate(() => document.getElementById('station-change').getAttribute('aria-expanded')) === 'true');
  const mood = CHANNELS[1];
  await page.click(`#station-panel-row [data-station="${mood.id}"]`);
  await page.waitForFunction((id) => activeChannel === id && mode === 'channelRadio', mood.id, { timeout: 10000 });
  r.check('a pick switches the station and closes the panel', await page.evaluate(() => document.getElementById('station-panel').hidden)
    && await lineText(page) === 'On Radio: ' + mood.title, await lineText(page));
  r.check('the panel\'s own copy shows the new station highlighted', (await stations(page, '#station-panel-row')).find((s) => s.on)?.key === mood.id);

  await page.click('#station-change');
  await page.waitForFunction(() => !document.getElementById('station-panel').hidden, null, { timeout: 5000 });
  await page.keyboard.press('Escape');
  r.check('Escape closes it', await page.evaluate(() => document.getElementById('station-panel').hidden));
  await page.click('#station-change');
  await page.click('#station-panel-close');
  r.check('the close button closes it', await page.evaluate(() => document.getElementById('station-panel').hidden));
  await page.click('#station-change');
  await page.mouse.click(5, 5);
  r.check('a tap outside closes it', await page.evaluate(() => document.getElementById('station-panel').hidden));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioGlow(browser, port, r) {
  r.section('the station line glows for ~3s when radio takes over (still, with reduced motion)');
  for (const reduced of [false, true]) {
    const { page, errors } = await setup(browser);
    if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
    await openListen(page, port);
    await clickFirstRow(page);
    await page.waitForFunction(() => !audioEl.paused, null, { timeout: 10000 });
    const from = await page.evaluate(() => SONGS[currentIdx].id);
    await page.evaluate(() => audioEl.dispatchEvent(new Event('ended')));
    await page.waitForFunction((f) => SONGS[currentIdx].id !== f, from, { timeout: 10000 });
    const g = await page.evaluate(() => {
      const el = document.getElementById('station-line');
      const cs = getComputedStyle(el);
      return { glow: el.classList.contains('is-glow'), anim: cs.animationName, shadow: cs.boxShadow, text: document.getElementById('station-line-text').textContent };
    });
    const label = reduced ? '[reduced motion]' : '[motion]';
    r.check(`${label} takeover: "On Radio: All songs" and the line glows`, g.glow && g.text === 'On Radio: All songs', JSON.stringify(g));
    r.check(reduced ? `${label} no animation, a still highlight instead` : `${label} animated`,
      reduced ? (g.anim === 'none' && g.shadow !== 'none') : g.anim === 'station-glow', JSON.stringify(g));
    await page.waitForFunction(() => !document.getElementById('station-line').classList.contains('is-glow'), null, { timeout: 5000 });
    r.check(`${label} the glow ends by itself (about 3s)`, true);
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}

async function scenarioMini(browser, port, r) {
  r.section('mini-player (phones): the station next to the title, tap to change');
  const { page, errors } = await setup(browser, { viewport: { width: 390, height: 844 } });
  await openListen(page, port);
  const mood = CHANNELS[0];
  await page.click(`#station-row [data-station="${mood.id}"]`);
  await page.waitForFunction((id) => activeChannel === id && currentIdx !== null, mood.id, { timeout: 10000 });
  await page.evaluate(() => navigate('home'));
  await page.waitForFunction(() => !document.getElementById('mini-player').classList.contains('hidden'), null, { timeout: 10000 });
  const mini = await page.evaluate(() => {
    const ms = document.getElementById('mini-station');
    const t = document.getElementById('mini-titles').getBoundingClientRect(), m = ms.getBoundingClientRect();
    return { text: ms.textContent, hidden: ms.classList.contains('hidden'), nextToTitle: m.left >= t.right - 1 && Math.abs((m.top + m.bottom) / 2 - (t.top + t.bottom) / 2) < 20, right: m.right };
  });
  r.check(`shows "Radio · ${mood.title}" next to the title`, !mini.hidden && mini.text === 'Radio · ' + mood.title && mini.nextToTitle, JSON.stringify(mini));
  r.check('fits on a 390 px screen', mini.right <= 390, mini.right);
  await page.click('#mini-station');
  await page.waitForFunction(() => !document.getElementById('station-panel').hidden, null, { timeout: 5000 });
  r.check('tapping it opens the station panel', true);
  await page.click('#station-panel-row [data-station="all"]');
  await page.waitForFunction(() => mode === 'radio' && activeChannel === null, null, { timeout: 10000 });
  r.check('picking RADIO there switches to all songs and closes the panel', await page.evaluate(() => document.getElementById('station-panel').hidden));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioNarrow(browser, port, r) {
  r.section('375 px: one sideways-scrolling line, never wrapping, search box on screen');
  const { page, errors } = await setup(browser, {
    viewport: { width: 375, height: 812 },
    overrides: { channels: EIGHT, songChannels: SONGS.map((s, i) => ({ song_id: s.id, channel_id: EIGHT[i % 8].id })) },
  });
  await openListen(page, port);
  await page.waitForFunction(() => document.querySelectorAll('#station-row [data-station]').length === 9, null, { timeout: 10000 });
  const d = await page.evaluate(() => {
    const row = document.getElementById('station-row');
    const btns = [...row.querySelectorAll('[data-station]')];
    const tops = new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top)));
    const search = document.getElementById('search').getBoundingClientRect();
    const cs = getComputedStyle(row);
    return {
      n: btns.length, lines: tops.size, scrollW: row.scrollWidth, clientW: row.clientWidth,
      overflowX: cs.overflowX, scrollbar: cs.scrollbarWidth, fade: row.classList.contains('has-more'),
      rowRight: row.getBoundingClientRect().right, searchLeft: search.left, searchRight: search.right, searchW: search.width,
      pageScrollW: document.scrollingElement.scrollWidth,
    };
  });
  r.check('all 9 stations on one line', d.n === 9 && d.lines === 1, JSON.stringify(d));
  r.check('the row scrolls sideways (wider than the screen, overflow auto)', d.scrollW > d.clientW && d.overflowX === 'auto', JSON.stringify(d));
  r.check('no visible scrollbar', d.scrollbar === 'none');
  r.check('a soft fade at the right edge while there is more', d.fade);
  r.check('the row does not push the page sideways', d.pageScrollW <= 375 && d.rowRight <= 375, JSON.stringify(d));
  r.check('the search box stays fully on screen', d.searchLeft >= 0 && d.searchRight <= 375 && d.searchW > 150, JSON.stringify(d));
  await page.evaluate(() => { const row = document.getElementById('station-row'); row.scrollLeft = row.scrollWidth; });
  await page.waitForFunction(() => !document.getElementById('station-row').classList.contains('has-more'), null, { timeout: 3000 }).catch(() => {});
  r.check('scrolled to the end: the fade goes away', await page.evaluate(() => !document.getElementById('station-row').classList.contains('has-more')));
  // A pick from the panel brings that station into view in the row.
  await page.evaluate(() => { document.getElementById('station-row').scrollLeft = 0; });
  await clickFirstRow(page);
  await page.click('#station-change');
  await page.click('#station-panel-row [data-station="celebrate-with-me"]');
  await page.waitForFunction(() => activeChannel === 'celebrate-with-me', null, { timeout: 10000 });
  const inView = await page.evaluate(() => {
    const row = document.getElementById('station-row'), lit = row.querySelector('.is-on');
    const rr = row.getBoundingClientRect(), br = lit.getBoundingClientRect();
    return { lit: lit.dataset.station, inside: br.left >= rr.left - 1 && br.right <= rr.right + 1 };
  });
  r.check('a pick from the panel scrolls the row so the playing station is in view', inView.lit === 'celebrate-with-me' && inView.inside, JSON.stringify(inView));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioContrast(browser, port, r) {
  r.section('contrast: every station button, 4 colors x light/dark, playing and not');
  const { page, errors } = await setup(browser);
  await openListen(page, port);
  await page.click(`#station-row [data-station="${CHANNELS[0].id}"]`);
  await page.waitForFunction((id) => activeChannel === id, CHANNELS[0].id, { timeout: 10000 });
  await page.click('#station-change');
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
        for (const b of document.querySelectorAll('.station-row [data-station], #station-change, #mini-station')) {
          const cs = getComputedStyle(b);
          const text = parse(cs.color)[0];
          let worst = Infinity;
          const stops = cs.backgroundImage !== 'none' ? parse(cs.backgroundImage) : [parse(cs.backgroundColor)[0]];
          for (const base of pageBgs) for (const stop of stops) worst = Math.min(worst, ratio(over(text, base), over(stop || [0, 0, 0, 0], base)));
          out.push({ id: (b.closest('#station-panel') ? 'panel:' : '') + (b.dataset.station || b.id), on: b.classList.contains('is-on'), ratio: Math.round(worst * 100) / 100 });
        }
        return out;
      }, { color, theme });
      const bad = res.filter((x) => x.ratio < 4.5);
      const onCount = res.filter((x) => x.on).length;
      r.check(`${color}/${theme}: all ${res.length} buttons (${onCount} playing) at 4.5:1 or better; lowest ${Math.min(...res.map((x) => x.ratio))}`,
        bad.length === 0 && onCount >= 2, JSON.stringify(bad));
    }
  }
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
