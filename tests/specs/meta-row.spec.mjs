/* ============================================================
   META-1 -- the row under the byline: badges on the left, the station on
   the right ("Now playing: <station>" + Change station), and the default
   station named "Mix radio" wherever the station is named.

   Checked at 1280 and 380 px in both skins, for a song with badges that
   wrap, a song with none, Mix radio, a mood, a song tapped from the list,
   and /listen before anything has played: the station group is always
   there and named; it keeps the right end of the first line on a wide
   screen and gets its own line on a phone; Change station is a 44px tap
   target there and opens the same chooser, whose default option now reads
   "Mix radio"; the old row under the divider is gone; the divider has
   ~12px either side; the glow stays clear of its neighbours; nothing
   overlaps, nothing scrolls sideways; no radio label says "All songs".
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

function silentWav(secs) {
  const rate = 8000, n = Math.round(rate * secs);
  const b = Buffer.alloc(44 + n, 0x80);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}
const WAV = silentWav(60);
// Supernova's three badges wrap beside the station at 1280; Afterglow has none.
const SONGS = F.SONGS_ROWS.map((s) => ({ ...s, audio_url: `https://audio.test/${s.id}.wav` }));

async function open(browser, port, { width = 1280, theme = 'dark', path = '/listen', reducedMotion } = {}) {
  const page = await newPage(browser, { width, height: 900 });
  const errors = collectErrors(page);
  if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript((t) => { try { localStorage.setItem('laivy-theme', t); localStorage.setItem('laivy-ded-hint-v1', '1'); } catch (e) {} }, theme);
  await wireSupabaseStubs(page, { songs: SONGS });
  await page.route('**://audio.test/**', (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: WAV }));
  await page.goto(`http://localhost:${port}${path}`, { waitUntil: 'load' });
  return { page, errors };
}
async function ready(page) {
  await page.waitForSelector('#rating-rows .vrow', { timeout: 10000 });
  await page.evaluate(() => document.fonts.ready);
}
const station = (page) => page.evaluate(() => document.querySelector('#station-line .station-line-text').textContent.replace(/\s+/g, ' ').trim());

export async function run(browser, port) {
  const r = makeReporter('meta-row.spec.mjs');
  for (const width of [1280, 380]) for (const theme of ['dark', 'light']) {
    await scenarioLayout(browser, port, r, width, theme, '/song/supernova-a000', 'badges');
    await scenarioLayout(browser, port, r, width, theme, '/song/afterglow-a000', 'no badges');
  }
  await scenarioStations(browser, port, r);
  await scenarioGlow(browser, port, r);
  return r;
}

async function scenarioLayout(browser, port, r, width, theme, path, kind) {
  const tag = `[${width}px ${theme}, ${kind}]`;
  r.section(`META-1: the row under the byline ${tag}`);
  const { page, errors } = await open(browser, port, { width, theme, path });
  await ready(page);
  const d = await page.evaluate(() => {
    const B = (el) => el.getBoundingClientRect();
    const line = document.getElementById('station-line'), badges = document.getElementById('now-badges');
    const row = line.parentElement, change = document.getElementById('station-change');
    const pills = [...badges.querySelectorAll('.badge-pill, .badge-chip')].filter((p) => p.getClientRects().length).map(B);
    const L = B(line), R = B(row), C = B(change), A = B(document.getElementById('now-artist'));
    const ic = line.querySelector('svg');
    const root = getComputedStyle(document.documentElement);
    const name = document.getElementById('station-line-name');
    const dock = B(document.querySelector('.dock')), head = B(document.querySelector('.thoughts-head'));
    // What a tap 20px above/below the pill's centre would hit.
    const cx = C.left + C.width / 2, cy = C.top + C.height / 2;
    const hits = [-20, 20].map((dy) => { const el = document.elementFromPoint(cx, cy + dy); return !!el && (el === change || change.contains(el)); });
    const overlap = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    return {
      text: line.querySelector('.station-line-text').textContent.replace(/\s+/g, ' ').trim(),
      lbl: getComputedStyle(line.querySelector('.station-line-lbl')).color, nameW: getComputedStyle(name).fontWeight,
      live: name.getAttribute('aria-live'), icHidden: ic && ic.getAttribute('aria-hidden') === 'true',
      icColor: ic && getComputedStyle(ic).color, gold: root.getPropertyValue('--badge-gold').trim(),
      sameRow: row.contains(badges) && row === badges.parentElement, rowAfterByline: R.top >= A.bottom,
      oldRowGone: !document.querySelector('.dock .station-line, .dock #station-change'),
      rightEnd: Math.abs(L.right - R.right) < 1.5, pillsTop: pills.length ? Math.min(...pills.map((p) => p.top)) : null,
      pillsBottom: pills.length ? Math.max(...pills.map((p) => p.bottom)) : null, lineTop: L.top, lineBottom: L.bottom,
      lineLeft: L.left, rowLeft: R.left, nameRight: B(line.querySelector('.station-line-text')).right, changeLeft: C.left,
      pillOverlap: pills.some((p) => overlap(p, L)), changeH: C.height, hits,
      aboveDivider: dock.top - R.bottom, belowDivider: head.top - dock.top - 1,
      pageW: document.scrollingElement.scrollWidth, vw: innerWidth,
    };
  });
  r.check(`${tag} "Now playing: Mix radio" (a song page opened directly carries on as Mix radio)`, d.text === 'Now playing: Mix radio', d.text);
  r.check(`${tag} one row, directly under the byline, badges and station together`, d.sameRow && d.rowAfterByline, JSON.stringify(d));
  r.check(`${tag} the old row under the divider is gone`, d.oldRowGone);
  r.check(`${tag} a gold broadcast icon (decorative); the name in medium weight, read out when it changes`,
    d.icHidden && d.gold && d.icColor && d.nameW === '500' && d.live === 'polite', JSON.stringify(d));
  r.check(`${tag} the station group never overlaps a badge`, !d.pillOverlap, JSON.stringify(d));
  if (width >= 1280) {
    r.check(`${tag} the station keeps the right end of the row`, d.rightEnd, JSON.stringify(d));
    if (d.pillsTop != null) r.check(`${tag} ...on the badges' first line, while the badges wrap among themselves`,
      Math.abs(d.lineTop - d.pillsTop) < 3, JSON.stringify(d));
  } else {
    r.check(`${tag} on a phone: its own line under the badges, name on the left, Change station on the right`,
      (d.pillsBottom == null || d.lineTop >= d.pillsBottom) && Math.abs(d.lineLeft - d.rowLeft) < 1.5 && d.rightEnd && d.changeLeft > d.nameRight, JSON.stringify(d));
    r.check(`${tag} Change station: a modest pill (${Math.round(d.changeH)}px) with a 44px tap area`, d.changeH < 36 && d.hits.every(Boolean), JSON.stringify(d));
  }
  const want = width >= 1280 ? 12 : 11;
  r.check(`${tag} ~${want}px either side of the divider`, Math.abs(d.aboveDivider - want) < 1.5 && Math.abs(d.belowDivider - want) < 1.5, JSON.stringify({ above: d.aboveDivider, below: d.belowDivider }));
  r.check(`${tag} no sideways scrolling`, d.pageW <= d.vw, JSON.stringify(d));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioStations(browser, port, r) {
  r.section('META-1: the station name in each state, and "Mix radio" wherever the default station is named');
  const { page, errors } = await open(browser, port);
  await page.waitForSelector('#rows .row', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('#station-row [data-station]').length > 1, null, { timeout: 10000 });
  r.check('before anything has played, the row is already there: "Now playing: Mix radio"',
    await page.evaluate(() => currentIdx === null) && await station(page) === 'Now playing: Mix radio'
      && await page.evaluate(() => document.getElementById('station-line').getClientRects().length > 0), await station(page));
  const rowBtn = await page.evaluate(() => { const b = document.getElementById('radio-btn'); return { text: b.textContent.trim(), label: b.getAttribute('aria-label') }; });
  r.check('the /listen station row\'s first button: "Mix radio"', rowBtn.text === 'Mix radio' && rowBtn.label === 'Mix radio', JSON.stringify(rowBtn));

  // A song tapped by hand from the list.
  await page.evaluate(() => document.querySelector('#rows .row').click());
  await page.waitForFunction(() => currentIdx !== null, null, { timeout: 10000 });
  r.check('a song tapped from the list: no radio running yet, and the line says "Now playing: Mix radio"',
    await page.evaluate(() => mode === 'manual' && !manualQueue) && await station(page) === 'Now playing: Mix radio', await station(page));

  // Change station: the same chooser, its default option now "Mix radio".
  await page.click('#station-change');
  await page.waitForFunction(() => !document.getElementById('station-panel').hidden, null, { timeout: 5000 });
  const panel = await page.evaluate(() => {
    const first = document.querySelector('#station-panel-row [data-station]');
    return { key: first.dataset.station, text: first.textContent.trim(), label: first.getAttribute('aria-label'),
      inBody: document.getElementById('station-panel').parentElement === document.body, expanded: document.getElementById('station-change').getAttribute('aria-expanded') };
  });
  r.check('Change station opens the same chooser (in body), default option "Mix radio" (key still "all")',
    panel.key === 'all' && panel.text === 'Mix radio' && panel.label === 'Mix radio' && panel.inBody && panel.expanded === 'true', JSON.stringify(panel));

  // A mood.
  const mood = await page.evaluate(() => { const b = document.querySelector('#station-panel-row [data-station]:not([data-station="all"])'); return { id: b.dataset.station, title: b.textContent.trim() }; });
  await page.click(`#station-panel-row [data-station="${mood.id}"]`);
  await page.waitForFunction((id) => activeChannel === id && currentIdx !== null, mood.id, { timeout: 10000 });
  r.check(`a mood: "Now playing: ${mood.title}"`, await station(page) === 'Now playing: ' + mood.title, await station(page));

  // Mix radio itself, and the other places it is named.
  await page.click('#station-change');
  await page.waitForFunction(() => !document.getElementById('station-panel').hidden, null, { timeout: 5000 });
  await page.click('#station-panel-row [data-station="all"]');
  await page.waitForFunction(() => mode === 'radio', null, { timeout: 10000 });
  r.check('Mix radio: "Now playing: Mix radio"', await station(page) === 'Now playing: Mix radio', await station(page));
  r.check('the lock screen / media session names it "Mix radio"', await page.evaluate(() => radioLabel()) === 'Mix radio');
  await page.evaluate(() => navigate('home'));
  await page.waitForFunction(() => !document.getElementById('mini-player').classList.contains('hidden'), null, { timeout: 10000 });
  r.check('the mini-player names it "Mix radio"', await page.evaluate(() => document.getElementById('mini-station').textContent) === 'Mix radio');
  const homeText = await page.evaluate(() => document.body.innerText);
  await page.evaluate(() => navigate('listen'));
  await page.waitForTimeout(300);
  const listenText = await page.evaluate(() => document.body.innerText + ' ' + [...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')).join(' '));
  r.check('nowhere visible (or read out) calls the radio station "All songs" ("Browse all songs" is the list, not the station)',
    !/all songs/i.test((homeText + ' ' + listenText).replace(/Browse all songs/g, '')), '');
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioGlow(browser, port, r) {
  for (const [width, rm] of [[1280, false], [380, false], [1280, true]]) {
    const tag = `[${width}px${rm ? ', reduced motion' : ''}]`;
    r.section(`META-1: the station glow stays clear of its neighbours ${tag}`);
    const { page, errors } = await open(browser, port, { width, path: '/song/supernova-a000', reducedMotion: rm });
    await ready(page);
    await page.evaluate(() => glowStationLine());
    const d = await page.evaluate(() => {
      const B = (el) => el.getBoundingClientRect();
      const line = document.getElementById('station-line'), cs = getComputedStyle(line);
      // The widest the glow reaches: 6px blur + 1px spread at its peak.
      const L = B(line), g = { left: L.left - 7, right: L.right + 7, top: L.top - 7, bottom: L.bottom + 7 };
      const overlap = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      const neighbours = [...document.querySelectorAll('#now-badges .badge-pill, #now-badges .badge-chip, #now-artist .now-artist-row, #now-dedicate-btn, #now-share-btn, .thoughts-q')]
        .filter((e) => e.getClientRects().length);
      return { glow: line.classList.contains('is-glow'), anim: cs.animationName, hit: neighbours.filter((e) => overlap(g, B(e))).map((e) => e.id || e.className),
        clipped: [...document.querySelectorAll('#now-content, .now-meta')].some((e) => getComputedStyle(e).overflow !== 'visible') };
    });
    r.check(`${tag} the station group glows when the station changes`, d.glow && (rm ? d.anim === 'none' : d.anim === 'station-glow'), JSON.stringify(d));
    r.check(`${tag} the glow touches no badge, the byline, the heading, Dedicate or Share`, d.hit.length === 0, JSON.stringify(d.hit));
    r.check(`${tag} nothing around it clips it`, !d.clipped);
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}
