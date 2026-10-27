/* ============================================================
   RATE-2 -- "Your thoughts matter": the brand V in place of the heart and
   the stars, the Dedicate pill with its one-time hint, the comment box
   beside the ratings on wide layouts, and "reflection" renamed "comment".

   Behaviour of the heart, the ratings and posting a comment is covered in
   rating.spec.mjs and activity.spec.mjs and is unchanged; this file checks
   the new layout and the controls' new shape: one grid for all three rows,
   the field matching the ratings column, readable V's in both skins, arrow
   keys on the rating rows (one rate_song call once they settle), the pill,
   and the hint (once, exact text, never again, never without storage).
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLUG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA).slug;
const HINT = 'Dedicate this song to someone who deserves this';

async function open(browser, port, { width = 1280, height = 900, theme = 'dark', hintSeen = true, signIn = null, reducedMotion, noTrack = true, onCall, clock } = {}) {
  const page = await newPage(browser, { width, height });
  const errors = collectErrors(page);
  if (clock) await page.clock.install();
  if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(({ theme, hintSeen, noTrack }) => {
    try {
      localStorage.setItem('laivy-theme', theme);
      if (hintSeen) localStorage.setItem('laivy-ded-hint-v1', '1');
      if (!noTrack) localStorage.removeItem('laivy-no-track');
    } catch (e) {}
  }, { theme, hintSeen, noTrack });
  await wireSupabaseStubs(page, {}, onCall);
  if (signIn) await signInAs(page, signIn);
  await page.goto(`http://localhost:${port}/song/${SLUG}`, { waitUntil: 'load' });
  await page.waitForSelector('#rating-rows .vrow', { timeout: 10000 });
  return { page, errors };
}
// Bring the block on screen with room above it (where the hint goes).
const scrollToBlock = (page) => page.evaluate(() => {
  const r = document.getElementById('loves').getBoundingClientRect();
  window.scrollBy(0, r.top - 300);
});

export async function run(browser, port) {
  const r = makeReporter('thoughts-block.spec.mjs');
  await scenarioLayout(browser, port, r);
  await scenarioKeyboardAndHover(browser, port, r);
  await scenarioComment(browser, port, r);
  await scenarioDedicatePill(browser, port, r);
  await scenarioHint(browser, port, r);
  await scenarioWording(browser, port, r);
  return r;
}

async function scenarioLayout(browser, port, r) {
  for (const width of [1280, 380]) {
    for (const theme of ['dark', 'light']) {
      const tag = `[${width}px ${theme}]`;
      r.section(`RATE-2: layout ${tag}`);
      const { page, errors } = await open(browser, port, { width, theme });
      await page.evaluate(() => { myRatings[SONGS[currentIdx].id + ':words'] = 3; paintRatings(); });
      const d = await page.evaluate(() => {
        const box = (el) => el.getBoundingClientRect();
        const block = box(document.getElementById('loves'));
        const q = document.querySelector('.thoughts-q');
        const pill = box(document.getElementById('now-dedicate-btn')), share = box(document.getElementById('now-share-btn'));
        const rows = [...document.querySelectorAll('.thoughts-rates .vrow')];
        const firstV = rows.map((row) => [...row.querySelectorAll('.v-ic')].map(box).find((b) => b.width > 0).left);
        const labels = rows.map((row) => row.querySelector('.vrow-label'));
        const vbtns = [...document.querySelectorAll('.vbtn')].map(box);
        const rates = box(document.querySelector('.thoughts-rates')), form = box(document.getElementById('comment-form'));
        const ta = box(document.getElementById('comment-body')), btn = box(document.getElementById('comment-submit'));
        const help = document.querySelector('.comment-help');
        return {
          heading: q.textContent, italic: getComputedStyle(q).fontStyle, qMid: (box(q).top + box(q).bottom) / 2,
          pillMid: (pill.top + pill.bottom) / 2, pillRightOfQ: pill.left > box(q).right, pillBeforeShare: pill.right <= share.left,
          shareAtEnd: Math.abs(share.right - block.right) < 2, pillH: pill.height,
          labels: labels.map((l) => l.textContent), labelW: labels.map((l) => box(l.parentElement.children[1]).left - box(l.parentElement).left),
          firstV, vSize: [...document.querySelectorAll('.vbtn .v-ic')].map(box).find((b) => b.width > 0).width,
          minVbtnW: Math.min(...vbtns.map((b) => b.width)), minVbtnH: Math.min(...vbtns.map((b) => b.height)),
          loveH: box(document.querySelector('.love-btn')).height,
          notes: document.querySelectorAll('.thoughts-note').length, note: document.getElementById('thoughts-note').textContent,
          rates: [rates.top, rates.bottom, rates.left, rates.right], form: [form.top, form.bottom, form.left, form.right],
          ta: [ta.top, ta.bottom, ta.height], btn: [btn.top, btn.bottom, btn.left], btnText: document.getElementById('comment-submit').innerText.trim(),
          helpShown: getComputedStyle(help).display !== 'none', helpText: help.textContent,
          pageW: document.scrollingElement.scrollWidth, vw: innerWidth,
        };
      });
      r.check(`${tag} heading "Your thoughts matter" in the italic serif`, d.heading === 'Your thoughts matter' && d.italic === 'italic', JSON.stringify(d));
      r.check(`${tag} Dedicate then Share at the right end`, d.pillBeforeShare && d.shareAtEnd && d.pillH >= 44, JSON.stringify(d));
      if (width >= 1280) r.check(`${tag} ...on the heading's own row`, d.pillRightOfQ && Math.abs(d.pillMid - d.qMid) < 12, JSON.stringify(d));
      r.check(`${tag} three rows: Love the song, The words, The music`, JSON.stringify(d.labels) === JSON.stringify(['Love the song', 'The words', 'The music']), JSON.stringify(d.labels));
      r.check(`${tag} the V's of all three rows start on one line`, Math.max(...d.firstV) - Math.min(...d.firstV) < 1, JSON.stringify(d.firstV));
      const want = width >= 1280 ? [112, 30] : [92, 28];
      r.check(`${tag} label column ${want[0]}px, V ${want[1]}px`, d.labelW.every((w) => Math.abs(w - want[0]) < 1) && Math.abs(d.vSize - want[1]) < 0.5, JSON.stringify({ labelW: d.labelW, v: d.vSize }));
      r.check(`${tag} tap targets at least 36 x 44`, d.minVbtnW >= 36 && d.minVbtnH >= 44 && d.loveH >= 44, JSON.stringify(d));
      r.check(`${tag} one muted line under the rows`, d.notes === 1 && /^Rated by a few listeners so far/.test(d.note), d.note);
      if (width >= 1280) {
        r.check(`${tag} two columns, the comment box beside the ratings, same top and bottom`,
          d.form[2] >= d.rates[3] && Math.abs(d.form[0] - d.rates[0]) < 1 && Math.abs(d.form[1] - d.rates[1]) < 1, JSON.stringify(d));
        r.check(`${tag} the field fills the column; helper on the left, "Post comment" on the right under it`,
          d.ta[2] > 80 && d.btn[0] >= d.ta[1] && d.helpShown && d.helpText === 'A single line is plenty.' && d.btnText === 'Post comment', JSON.stringify(d));
      } else {
        r.check(`${tag} stacked: the comment box under the ratings`, d.form[0] >= d.rates[1], JSON.stringify(d));
        r.check(`${tag} a short field (~2 rows) with "Post" on the same row, no helper line`,
          d.ta[2] < 80 && d.btn[0] < d.ta[1] && d.btn[2] > d.form[2] + 100 && !d.helpShown && d.btnText === 'Post', JSON.stringify(d));
      }
      r.check(`${tag} no sideways scrolling`, d.pageW <= d.vw, JSON.stringify(d));

      // The V's: --badge-gold, filled and outline, clear 3:1 on the page in this skin.
      const c = await page.evaluate(() => {
        const rgb = (str) => str.match(/[\d.]+/g).slice(0, 3).map(Number);
        const hex = (h) => { h = h.trim().replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
        const L = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
        const root = getComputedStyle(document.documentElement);
        const gold = hex(root.getPropertyValue('--badge-gold'));
        const on = document.querySelector('.vrow[data-facet="words"] .vbtn.is-on .v-on');
        const off = document.querySelector('.vrow[data-facet="words"] .vbtn:not(.is-on) .v-off');
        const bgs = [hex(root.getPropertyValue('--bg')), hex(root.getPropertyValue('--bg-2'))];
        return {
          onFill: rgb(getComputedStyle(on).fill), offFill: rgb(getComputedStyle(off).fill), gold,
          onShown: getComputedStyle(on).display !== 'none', offShown: getComputedStyle(off).display !== 'none',
          outlineHref: off.querySelector('use').getAttribute('href'), fillHref: on.querySelector('use').getAttribute('href'),
          worst: Math.min(...bgs.map((b) => ratio(gold, b))),
        };
      });
      r.check(`${tag} filled V (#v-fill) and outline V (#v-outline), both in --badge-gold`,
        c.onShown && c.offShown && c.fillHref === '#v-fill' && c.outlineHref === '#v-outline'
          && c.onFill.join() === c.gold.join() && c.offFill.join() === c.gold.join(), JSON.stringify(c));
      r.check(`${tag} the gold clears 3:1 against the page (lowest ${c.worst.toFixed(2)})`, c.worst >= 3, c.worst);
      r.check('no console/page errors', errors.length === 0, errors.join(' | '));
      await page.close();
    }
  }
}

async function scenarioKeyboardAndHover(browser, port, r) {
  r.section('RATE-2: arrow keys rate (one rate_song call once they settle); focus ring; hover preview');
  const calls = [];
  const { page, errors } = await open(browser, port, {
    noTrack: false, onCall: (name) => { if (name === 'rpc:rate_song') calls.push(name); },
    signIn: { ...F.SESSION_USERS.LISTENER, createdAt: new Date(Date.now() - 60000) },
  });
  await page.waitForFunction(() => !document.querySelector('.vrow[data-facet="words"]').classList.contains('is-locked'), null, { timeout: 10000 });
  const group = await page.evaluate(() => {
    const g = document.querySelector('.vrow[data-facet="words"] .vgroup');
    return { role: g.getAttribute('role'), label: g.getAttribute('aria-label'), radios: [...g.children].every((b) => b.getAttribute('role') === 'radio'),
      tabbable: [...g.children].filter((b) => b.tabIndex === 0).map((b) => b.dataset.score) };
  });
  r.check('each row is a radiogroup "Rate the words, 1 to 5" of five radios, one in the tab order',
    group.role === 'radiogroup' && group.label === 'Rate the words, 1 to 5' && group.radios && group.tabbable.join() === '1', JSON.stringify(group));
  await page.focus('.vrow[data-facet="words"] .vbtn[data-score="1"]');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const k = await page.evaluate(() => {
    const a = document.activeElement, cs = getComputedStyle(a);
    return { filled: document.querySelectorAll('.vrow[data-facet="words"] .vbtn.is-on').length, focus: a.dataset.score, checked: a.getAttribute('aria-checked'),
      ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 };
  });
  r.check('three Arrow Rights from 1: four V\'s filled, focus and aria-checked on the 4th', k.filled === 4 && k.focus === '4' && k.checked === 'true', JSON.stringify(k));
  r.check('a visible focus ring on the focused V', k.ring, JSON.stringify(k));
  r.check('no call yet while the keys are still moving', calls.length === 0, calls.length);
  await page.waitForTimeout(1000);
  r.check('one rate_song call once they settle', calls.length === 1, calls.length);
  await page.keyboard.press('ArrowLeft');
  r.check('Arrow Left steps back to 3', await page.evaluate(() => document.querySelectorAll('.vrow[data-facet="words"] .vbtn.is-on').length) === 3);

  // Hover preview on the music row.
  await page.hover('.vrow[data-facet="music"] .vbtn[data-score="3"]');
  const shown = await page.evaluate(() => [...document.querySelectorAll('.vrow[data-facet="music"] .vbtn')].map((b) => getComputedStyle(b.querySelector('.v-on')).display !== 'none'));
  r.check('hovering the 3rd music V previews three filled', JSON.stringify(shown) === JSON.stringify([true, true, true, false, false]), JSON.stringify(shown));
  await page.mouse.move(0, 0);
  const after = await page.evaluate(() => [...document.querySelectorAll('.vrow[data-facet="music"] .vbtn')].map((b) => getComputedStyle(b.querySelector('.v-on')).display !== 'none'));
  r.check('moving away drops the preview', after.every((x) => !x), JSON.stringify(after));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();

  r.section('RATE-2: signed out, the arrow keys only move the focus');
  const o = await open(browser, port);
  await o.page.evaluate(() => {
    window.__modal = 0;
    const orig = window.laivy.accountUI.openModal;
    window.laivy.accountUI.openModal = (x) => { window.__modal++; return orig(x); };
  });
  await o.page.focus('.vrow[data-facet="music"] .vbtn[data-score="1"]');
  await o.page.keyboard.press('ArrowRight');
  const so = await o.page.evaluate(() => ({ focus: document.activeElement.dataset.score, filled: document.querySelectorAll('.vbtn.is-on').length, modal: window.__modal }));
  r.check('focus moves to the 2nd V, nothing fills, no sign-in modal', so.focus === '2' && so.filled === 0 && so.modal === 0, JSON.stringify(so));
  await o.page.keyboard.press('Enter');
  await o.page.waitForFunction(() => window.__modal === 1, null, { timeout: 5000 });
  r.check('Enter there asks for sign-in, as a tap does', true);
  r.check('no console/page errors', o.errors.length === 0, o.errors.join(' | '));
  await o.page.close();
}

async function scenarioComment(browser, port, r) {
  for (const width of [1280, 380]) {
    r.section(`RATE-2: one comment box, posting as before (signed out, ${width}px)`);
    const { page, errors } = await open(browser, port, { width });
    const posts = [];
    page.on('request', (req) => { if (req.method() === 'POST' && req.url().includes('/rest/v1/comments')) posts.push(req.postDataJSON()); });
    r.check('exactly one comment box on the page, in "Your thoughts matter"', await page.evaluate(() =>
      document.querySelectorAll('#comment-form, textarea[aria-label="Your comment"], textarea[placeholder="Write a comment..."]').length === 2
        && document.getElementById('loves').contains(document.getElementById('comment-form'))
        && !document.querySelector('#comments-wrap textarea, #comments-wrap form')));
    const h0 = await page.evaluate(() => document.getElementById('comment-body').getBoundingClientRect().height);
    await page.click('#comment-body');
    await page.keyboard.type('First line');
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Shift+Enter'); await page.keyboard.type('another line ' + i); }
    const h1 = await page.evaluate(() => document.getElementById('comment-body').getBoundingClientRect().height);
    if (width < 1280) r.check('on a phone the field grows as the visitor types', h1 > h0 + 20, JSON.stringify({ h0, h1 }));
    else r.check('wide, the field keeps the column\'s height', Math.abs(h1 - h0) < 1, JSON.stringify({ h0, h1 }));
    r.check('name and city open up once the visitor clicks in', await page.evaluate(() =>
      getComputedStyle(document.querySelector('.comment-idrow')).display !== 'none'));
    await page.click('#comment-submit');
    await page.waitForFunction(() => /awaiting approval/.test(document.getElementById('comment-status').textContent), null, { timeout: 10000 });
    r.check('posted to comments as before (pending, no sign-in needed)', posts.length === 1 && posts[0].body.startsWith('First line') && posts[0].song_id === F.SONGS.SUPERNOVA, JSON.stringify(posts));
    r.check('"Thanks! Your comment is awaiting approval."', await page.evaluate(() => document.getElementById('comment-status').textContent) === 'Thanks! Your comment is awaiting approval.');
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}

async function scenarioDedicatePill(browser, port, r) {
  for (const theme of ['dark', 'light']) {
    r.section(`RATE-2: the Dedicate pill (${theme})`);
    const { page, errors } = await open(browser, port, { width: 380, theme, signIn: { ...F.SESSION_USERS.LISTENER, createdAt: new Date(Date.now() - 60000) } });
    await page.waitForFunction(() => !!(window.laivy && window.laivy.auth && window.laivy.auth.user), null, { timeout: 10000 });
    const d = await page.evaluate(() => {
      const b = document.getElementById('now-dedicate-btn'), svg = b.querySelector('svg');
      const cs = getComputedStyle(b);
      const L = (c) => { const [r, g, bl] = c.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl); };
      const stops = (cs.backgroundImage.match(/rgba?\([^)]+\)/g) || []);
      const worst = Math.min(...stops.map((s) => (L(cs.color) + 0.05) / (L(s) + 0.05)));
      return { text: b.textContent.trim(), tag: b.tagName, svgHidden: svg && svg.getAttribute('aria-hidden') === 'true', svgInside: !!svg && b.contains(svg),
        nested: b.querySelectorAll('button, a, [role="button"]').length, h: b.getBoundingClientRect().height, worst: Math.round(worst * 100) / 100,
        label: b.getAttribute('aria-label') };
    });
    r.check('one button reading "Dedicate", the gift icon inside it, decorative', d.tag === 'BUTTON' && d.text === 'Dedicate' && d.svgInside && d.svgHidden && d.nested === 0 && !d.label, JSON.stringify(d));
    r.check('at least 44px tall', d.h >= 44, d.h);
    r.check(`white on the pill clears 4.5:1 (lowest ${d.worst})`, d.worst >= 4.5, d.worst);
    // Tap the icon itself: the whole pill is the one button.
    const ic = await page.evaluate(() => { const b = document.querySelector('#now-dedicate-btn svg').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await page.mouse.click(ic.x, ic.y);
    await page.waitForSelector('#dedicate-modal:not([hidden])', { timeout: 10000 });
    r.check('tapping the gift icon opens the dedication flow (signed in; signed out it asks to sign in first, as before)', true);
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}

async function scenarioHint(browser, port, r) {
  for (const width of [1280, 380]) {
    r.section(`RATE-2: the one-time Dedicate hint (${width}px)`);
    // 500px tall: the block starts below the fold.
    const { page, errors } = await open(browser, port, { width, height: 500, hintSeen: false });
    r.check('not shown before the pill is on screen', await page.evaluate(() => document.getElementById('ded-hint').hidden));
    await scrollToBlock(page);
    await page.waitForFunction(() => !document.getElementById('ded-hint').hidden, null, { timeout: 5000 });
    const d = await page.evaluate(() => {
      const b = (el) => el.getBoundingClientRect();
      const h = document.getElementById('ded-hint'), hb = b(h), p = b(document.getElementById('now-dedicate-btn')), s = b(document.getElementById('now-share-btn'));
      const rates = b(document.querySelector('.thoughts-rates'));
      const arrowX = hb.right - parseFloat(getComputedStyle(h).getPropertyValue('--hint-arrow'));
      const overlap = (a, c) => !(a.bottom <= c.top || a.top >= c.bottom || a.right <= c.left || a.left >= c.right);
      return { text: h.textContent, inView: hb.left >= 0 && hb.right <= innerWidth && hb.top >= 0,
        aim: Math.abs(arrowX - (p.left + p.width / 2)), above: hb.bottom <= p.top,
        coversShare: overlap(hb, s), coversRows: overlap(hb, rates), glow: getComputedStyle(document.getElementById('now-dedicate-btn')).animationName,
        stored: localStorage.getItem('laivy-ded-hint-v1') };
    });
    r.check('the bubble says exactly "' + HINT + '"', d.text === HINT, d.text);
    r.check('above the pill, its pointer at the pill, on screen', d.above && d.aim < 2 && d.inView, JSON.stringify(d));
    r.check('it covers neither Share nor the V rows', !d.coversShare && !d.coversRows, JSON.stringify(d));
    r.check('the pill glows while it shows', d.glow === 'ded-glow', d.glow);
    r.check('remembered in this browser', d.stored === '1', d.stored);
    await page.mouse.click(5, 450);
    r.check('any tap dismisses it', await page.evaluate(() => document.getElementById('ded-hint').hidden
      && getComputedStyle(document.getElementById('now-dedicate-btn')).animationName === 'none'));
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#rating-rows .vrow', { timeout: 10000 });
    await scrollToBlock(page);
    await page.waitForTimeout(600);
    r.check('never again after a reload', await page.evaluate(() => document.getElementById('ded-hint').hidden));
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }

  r.section('RATE-2: the hint goes by itself after 6s; reduced motion: no glow, still the bubble');
  {
    const { page, errors } = await open(browser, port, { height: 500, hintSeen: false, reducedMotion: true, clock: true });
    await scrollToBlock(page);
    await page.waitForFunction(() => !document.getElementById('ded-hint').hidden, null, { timeout: 5000 });
    r.check('reduced motion: the bubble shows, the pill does not pulse', await page.evaluate(() =>
      getComputedStyle(document.getElementById('now-dedicate-btn')).animationName === 'none'));
    await page.clock.runFor(5500);
    r.check('still there at 5.5s', await page.evaluate(() => !document.getElementById('ded-hint').hidden));
    await page.clock.runFor(800);
    r.check('gone by itself after 6s', await page.evaluate(() => document.getElementById('ded-hint').hidden));
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }

  r.section('RATE-2: no storage, no hint; never over an open dialog');
  {
    const { page, errors } = await (async () => {
      const page = await newPage(browser, { width: 1280, height: 500 });
      const errors = collectErrors(page);
      // Storage that throws on write: the hint could never be remembered, so it never shows.
      await page.addInitScript(() => { Storage.prototype.setItem = function () { throw new Error('blocked'); }; });
      await wireSupabaseStubs(page);
      await page.goto(`http://localhost:${port}/song/${SLUG}`, { waitUntil: 'load' });
      await page.waitForSelector('#rating-rows .vrow', { timeout: 10000 });
      return { page, errors };
    })();
    await scrollToBlock(page);
    await page.waitForTimeout(700);
    r.check('storage unavailable: no hint', await page.evaluate(() => document.getElementById('ded-hint').hidden));
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
  {
    const { page, errors } = await open(browser, port, { height: 500, hintSeen: false });
    await page.evaluate(() => { document.getElementById('sleep-panel').hidden = false; });
    await scrollToBlock(page);
    await page.waitForTimeout(700);
    r.check('a dialog open: no hint', await page.evaluate(() => document.getElementById('ded-hint').hidden && localStorage.getItem('laivy-ded-hint-v1') === null));
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}

async function scenarioWording(browser, port, r) {
  r.section('RATE-2: no visible "reflection", nothing says "someone you love"');
  const { page, errors } = await open(browser, port);
  const song = await page.evaluate(() => document.body.innerText);
  await page.evaluate(() => navigate('home'));
  await page.waitForTimeout(500);
  const home = await page.evaluate(() => document.body.innerText);
  r.check('the song page never says "reflection"', !/reflection/i.test(song));
  r.check('the homepage never says "reflection"', !/reflection/i.test(home));
  const files = ['index.html', 'about.html', 'admin.html', 'your-song.html', 'your-song-ideas.html', 'terms.html', 'privacy.html', 'worker/src/index.js'];
  const hits = files.filter((f) => { try { return /someone you love/i.test(readFileSync(join(ROOT, f), 'utf8')); } catch (e) { return false; } });
  r.check('"someone you love" appears nowhere in the product', hits.length === 0, hits.join(', '));
  const reflect = files.filter((f) => { try { return /reflections?\b/i.test(readFileSync(join(ROOT, f), 'utf8').replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')); } catch (e) { return false; } });
  r.check('no "reflection" text left in the product\'s pages (comments aside)', reflect.length === 0, reflect.join(', '));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
