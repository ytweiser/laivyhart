/* ============================================================
   HOME-2 / HOME-2b -- the homepage "Show some Hart" box beside the #1 song
   (HOME-1's "Get involved"): three numbered cards -- "Dedicate a song",
   "Send us your song idea", "Upload your song" -- under "Three ways to put
   your heart into the music.", each with a big faded number (aria-hidden)
   instead of an icon; the two-card "Two ways" form when upload is left out.
   Gated by the same site_settings.contribute_cta_enabled switch as before
   (upload has no switch of its own). Covers the
   "Dedicate a song" picker flow signed in and signed out, including the
   signed-out -> sign in -> straight back into the picker round trip via
   /auth/callback. HOME-3: the heart after the heading (scenarioHeart, plus
   its place, size and contrast in every skin and width).
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SONG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);
const SETTINGS_CTA_ON = [...F.SITE_SETTINGS_ROWS, { key: 'contribute_cta_enabled', value: true }];
const SETTINGS_CTA_OFF = F.SITE_SETTINGS_ROWS; // contribute_cta_enabled: false is already the fixture default

async function gotoHome(page, url, port) {
  await page.goto(`http://localhost:${port}${url}`, { waitUntil: 'load' });
  await page.waitForSelector('#homepage .hero-tile', { timeout: 10000 });
}

export async function run(browser, port) {
  const r = makeReporter('homepage-show-some-hart.spec.mjs');
  await scenarioBoxRenders(browser, port, r);
  await scenarioSkinsAndWidths(browser, port, r);
  await scenarioHeart(browser, port, r);
  await scenarioGatedOff(browser, port, r);
  await scenarioDedicateSignedOut(browser, port, r);
  await scenarioDedicateSignedInPicksAndSearches(browser, port, r);
  await scenarioAuthCallbackReopensPicker(browser, port, r);
  return r;
}

async function scenarioBoxRenders(browser, port, r) {
  r.section('switch on: "Show some Hart", three numbered cards, no icons');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_CTA_ON, songs: F.SONGS_ROWS });
  await gotoHome(page, '/', port);
  await page.waitForSelector('.gi-action', { timeout: 10000 });
  const d = await page.evaluate(() => {
    const box = document.querySelector('.hero-callout.show-some-hart');
    const cards = Array.from(box.querySelectorAll('.gi-action'));
    return {
      heading: box.querySelector('#hero-callout-h')?.textContent,
      labelledBy: box.getAttribute('aria-labelledby'),
      sub: box.querySelector('.hero-callout-sub')?.textContent,
      cards: cards.map((c) => ({
        id: c.id, tag: c.tagName, href: c.getAttribute('href'),
        num: c.querySelector('.gi-num')?.textContent, numHidden: c.querySelector('.gi-num')?.getAttribute('aria-hidden'),
        strong: c.querySelector('strong')?.textContent, small: c.querySelector('small')?.textContent,
        // What a screen reader gets: the card's text minus the aria-hidden number.
        a11yText: (() => { const k = c.cloneNode(true); k.querySelectorAll('[aria-hidden="true"]').forEach((x) => x.remove()); return k.textContent.replace(/\s+/g, ' ').trim(); })(),
      })),
      icons: box.querySelectorAll('.gi-icon, .gi-action svg').length,
      oldWording: /get involved/i.test(document.body.innerText),
    };
  });
  r.check('heading reads "Show some Hart" (Hart with an a)', d.heading === 'Show some Hart', d.heading);
  r.check('the box is labelled by that heading', d.labelledBy === 'hero-callout-h');
  r.check('subline reads "Three ways to put your heart into the music." (heart with an e)', d.sub === 'Three ways to put your heart into the music.', d.sub);
  r.check('three cards', d.cards.length === 3, d.cards.length);
  const want = [
    { id: 'gi-dedicate', strong: 'Dedicate a song', small: 'to someone who deserves it' },
    { id: 'gi-idea', strong: 'Send us your song idea', small: 'your idea, our music' },
    { id: 'gi-upload', strong: 'Upload your song', small: "You could be next week's #1." },
  ];
  want.forEach((w, i) => {
    const c = d.cards[i] || {};
    r.check(`card ${i + 1}: "${w.strong}" / "${w.small}"`, c.id === w.id && c.strong === w.strong && c.small === w.small, JSON.stringify(c));
    r.check(`card ${i + 1}: big number ${i + 1}, aria-hidden`, c.num === String(i + 1) && c.numHidden === 'true', JSON.stringify(c));
    r.check(`card ${i + 1}: a screen reader hears only the action text`, c.a11yText === `${w.strong} ${w.small}`, c.a11yText);
  });
  r.check('the idea card is a link to /your-song; the other two are buttons (the whole card is the control)',
    d.cards[1]?.tag === 'A' && d.cards[1]?.href === '/your-song' && d.cards[0]?.tag === 'BUTTON' && d.cards[2]?.tag === 'BUTTON');
  r.check('no icons left in the box', d.icons === 0, d.icons);
  r.check('"Get involved" appears nowhere on the page', d.oldWording === false);

  // Upload opens what it did before HOME-2: signed out, sign in with next=/upload.
  await page.evaluate(() => {
    window.__openModalCalls = [];
    const orig = window.laivy.accountUI.openModal;
    window.laivy.accountUI.openModal = (opts) => { window.__openModalCalls.push(opts); return orig(opts); };
  });
  await page.click('#gi-upload');
  await page.waitForFunction(() => window.__openModalCalls.length > 0, null, { timeout: 10000 });
  const call = await page.evaluate(() => window.__openModalCalls[0]);
  r.check('Upload your song, signed out: sign-in opens and lands on /upload after', call && call.next === '/upload', JSON.stringify(call));

  // Hover brightens the number from 15% to 25%; reduced motion drops the transition.
  const before = await page.evaluate(() => getComputedStyle(document.querySelector('#gi-dedicate .gi-num')).opacity);
  await page.keyboard.press('Escape').catch(() => {});
  await page.hover('#gi-dedicate');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#gi-dedicate .gi-num')).opacity === '0.25', null, { timeout: 3000 }).catch(() => {});
  const after = await page.evaluate(() => getComputedStyle(document.querySelector('#gi-dedicate .gi-num')).opacity);
  r.check('number at 15% at rest, 25% on hover', before === '0.15' && after === '0.25', `${before} -> ${after}`);
  const focusRule = await page.evaluate(() => [...document.styleSheets].some((sh) => { try { return [...sh.cssRules].some((ru) => ru.cssText && ru.cssText.includes('.gi-action:focus-visible .gi-num') && ru.cssText.includes('0.25')); } catch (e) { return false; } }));
  r.check('keyboard focus brightens it the same way', focusRule);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const rm = await page.evaluate(() => getComputedStyle(document.querySelector('#gi-dedicate .gi-num')).transitionDuration);
  // theme.css's site-wide reduced-motion rule forces 0.001ms on everything
  // (with !important), so "no transition" reads as 0s or 1e-06s here.
  r.check('reduced motion: no transition, just the change', parseFloat(rm) <= 0.000001, rm);

  // The two-card form (upload left out): "Two ways", numbered 1 and 2.
  const two = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML = heroCalloutHTML({ upload: false });
    return {
      sub: host.querySelector('.hero-callout-sub')?.textContent,
      nums: [...host.querySelectorAll('.gi-num')].map((n) => n.textContent),
      ids: [...host.querySelectorAll('.gi-action')].map((c) => c.id),
    };
  });
  r.check('upload left out: "Two ways to put your heart into the music."', two.sub === 'Two ways to put your heart into the music.', two.sub);
  r.check('...two cards numbered 1 and 2, no upload', JSON.stringify(two.nums) === '["1","2"]' && JSON.stringify(two.ids) === '["gi-dedicate","gi-idea"]', JSON.stringify(two));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioGatedOff(browser, port, r) {
  r.section('switch off: the whole box is absent, exactly as before (HOME-1 kept the existing gate)');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_CTA_OFF, songs: F.SONGS_ROWS });
  await gotoHome(page, '/', port);
  await page.waitForLoadState('networkidle');
  const present = await page.evaluate(() => !!document.querySelector('.show-some-hart'));
  r.check('Show some Hart box is absent', present === false, present);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioDedicateSignedOut(browser, port, r) {
  r.section('Dedicate a song, signed out: sign-in modal opens with the right reason and next, no picker');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_CTA_ON, songs: F.SONGS_ROWS });
  await gotoHome(page, '/', port);
  await page.waitForSelector('#gi-dedicate', { timeout: 10000 });
  await page.evaluate(() => {
    window.__openModalCalls = [];
    const orig = window.laivy.accountUI.openModal;
    window.laivy.accountUI.openModal = (opts) => { window.__openModalCalls.push(opts); return orig(opts); };
  });
  await page.click('#gi-dedicate');
  await page.waitForFunction(() => window.__openModalCalls.length > 0, { timeout: 10000 });
  const d = await page.evaluate(() => ({
    calls: window.__openModalCalls,
    pickerHidden: document.getElementById('dedicate-picker-overlay')?.classList.contains('hidden'),
  }));
  r.check('sign-in modal opens, picker stays closed', d.pickerHidden === true && d.calls.length === 1, d);
  r.check('reason is "Sign in to dedicate a song"', d.calls[0] && d.calls[0].reason === 'Sign in to dedicate a song', d.calls[0]);
  r.check('next carries the dedicate marker, back to the homepage', d.calls[0] && d.calls[0].next === '/?dedicate=1', d.calls[0]);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioDedicateSignedInPicksAndSearches(browser, port, r) {
  r.section('Dedicate a song, signed in: picker opens, search and Popular work, picking hands off to the dedicate sheet');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_CTA_ON, songs: F.SONGS_ROWS, selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await gotoHome(page, '/', port);
  await page.waitForSelector('#gi-dedicate', { timeout: 10000 });
  await page.click('#gi-dedicate');
  await page.waitForSelector('#dedicate-picker-overlay:not(.hidden)', { timeout: 10000 });

  const initial = await page.evaluate(() => Array.from(document.querySelectorAll('#dedicate-picker-list .pick')).length);
  r.check('the picker lists songs (Recent tab, default)', initial > 0, initial);

  await page.click('#dedicate-picker-tabs [data-tab="popular"]');
  const afterPopular = await page.evaluate(() => Array.from(document.querySelectorAll('#dedicate-picker-list .pick')).length);
  r.check('Popular tab still lists songs', afterPopular > 0, afterPopular);

  await page.fill('#dedicate-picker-search', SONG.title);
  await page.waitForFunction((title) => {
    const picks = Array.from(document.querySelectorAll('#dedicate-picker-list .pick-title'));
    return picks.length > 0 && picks.every((p) => p.textContent.includes(title));
  }, SONG.title, { timeout: 10000 });

  await page.click('#dedicate-picker-list .pick');
  await page.waitForSelector('#dedicate-modal:not([hidden])', { timeout: 10000 });
  const d = await page.evaluate(() => ({
    pickerHidden: document.getElementById('dedicate-picker-overlay')?.classList.contains('hidden'),
    songTitle: document.getElementById('dedicate-song-title')?.textContent,
  }));
  r.check('picker closes once a song is chosen', d.pickerHidden === true, d);
  r.check('the dedicate sheet opens for the chosen song', d.songTitle === (SONG.title || SONG.title_translit), d.songTitle);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioAuthCallbackReopensPicker(browser, port, r) {
  r.section('signed out -> sign in -> straight back into the picker (the /auth/callback round trip)');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { siteSettings: SETTINGS_CTA_ON, songs: F.SONGS_ROWS, selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  // Simulates the magic-link/OAuth tab landing on /auth/callback already
  // signed in (supabase-js restores the session synchronously on load, the
  // same way the real redirect does once the exchange has completed).
  await signInAs(page, F.SESSION_USERS.NOVA);
  await page.goto(`http://localhost:${port}/auth/callback?next=${encodeURIComponent('/?dedicate=1')}`, { waitUntil: 'load' });
  await page.waitForSelector('#dedicate-picker-overlay:not(.hidden)', { timeout: 10000 });
  const d = await page.evaluate(() => ({
    path: location.pathname,
    search: location.search,
    onHome: !document.getElementById('page-home').classList.contains('hidden'),
  }));
  r.check('lands on the homepage', d.path === '/' && d.onHome === true, d);
  r.check('the dedicate=1 marker is cleaned out of the address', d.search === '', d.search);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* Every skin, both lightings, at a 375 px phone and at 1280: the heading
   stays on one line (or wraps without stranding a word); the cards fit; each
   number's circle is cut by its card on purpose (wider than the card is tall,
   past its left edge) while the digit itself stays whole inside the card;
   and every piece of text reads at 4.5:1 or better -- the card text measured
   against the card with the number at its brightest (25%) behind it. */
async function scenarioSkinsAndWidths(browser, port, r) {
  r.section('four skins x light/dark, at 375 px and 1280 px: heading, cards, cropped numbers, readable text');
  for (const width of [375, 1280]) {
    const page = await newPage(browser, { width, height: 900 });
    const errors = collectErrors(page);
    await wireSupabaseStubs(page, { siteSettings: SETTINGS_CTA_ON, songs: F.SONGS_ROWS });
    await gotoHome(page, '/', port);
    await page.waitForSelector('.show-some-hart .gi-action', { timeout: 10000 });
    for (const color of ['bordeaux', 'emerald', 'royal', 'gold']) {
      for (const theme of ['dark', 'light']) {
        const d = await page.evaluate(({ color, theme }) => {
          document.documentElement.setAttribute('data-color', color);
          document.documentElement.setAttribute('data-theme', theme);
          const box = document.querySelector('.show-some-hart');
          const h = box.querySelector('#hero-callout-h');
          const words = [];
          const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const re = /\S+/g; let m;
            while ((m = re.exec(node.data))) {
              const range = document.createRange(); range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
              words.push({ w: m[0], top: Math.round(range.getClientRects()[0].top) });
            }
          }
          const lines = [...new Set(words.map((x) => x.top))].map((t) => words.filter((x) => x.top === t).map((x) => x.w).join(' '));
          const parse = (str) => str.match(/[\d.]+/g).map(Number);
          const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
          const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
          const mix = (a, b, t) => [0, 1, 2].map((i) => a[i] * (1 - t) + b[i] * t);
          const boxBg = parse(getComputedStyle(box).backgroundColor);
          const contrast = {
            heading: ratio(parse(getComputedStyle(h).color), boxBg),
            sub: ratio(parse(getComputedStyle(box.querySelector('.hero-callout-sub')).color), boxBg),
          };
          const cards = [...box.querySelectorAll('.gi-action')].map((c, i) => {
            const n = c.querySelector('.gi-num'), dg = c.querySelector('.gi-num-digit');
            const cr = c.getBoundingClientRect(), nr = n.getBoundingClientRect(), dr = dg.getBoundingClientRect();
            const cardBg = parse(getComputedStyle(c).backgroundColor);
            const accent = parse(getComputedStyle(n).color);
            const worstBg = mix(cardBg, accent, 0.25);   // the digit at its hover brightness
            for (const el of c.querySelectorAll('.gi-text strong, .gi-text small')) {
              const k = `card${i + 1}-${el.tagName.toLowerCase()}`;
              contrast[k] = Math.min(ratio(parse(getComputedStyle(el).color), cardBg), ratio(parse(getComputedStyle(el).color), worstBg));
            }
            const textLeft = c.querySelector('.gi-text').getBoundingClientRect().left;
            return {
              circleBigger: nr.height / cr.height,
              croppedTop: nr.top < cr.top, croppedBottom: nr.bottom > cr.bottom, croppedLeft: nr.left < cr.left,
              digitWhole: dr.left >= cr.left - 0.5 && dr.top >= cr.top - 2 && dr.bottom <= cr.bottom + 2,
              digitClearOfText: dr.right <= textLeft + 2,
              fits: cr.left >= 0 && cr.right <= window.innerWidth + 0.5,
            };
          });
          for (const k of Object.keys(contrast)) contrast[k] = Math.round(contrast[k] * 100) / 100;
          // HOME-3: the heart, on the heading's (one) line, about cap height,
          // 3:1+ against the box.
          const hh = h.querySelector('.hart-heart');
          const hr = hh.getBoundingClientRect();
          const hart = (() => { const t = [...h.querySelectorAll('.hart-nowrap')][0].firstChild; const rg = document.createRange(); rg.setStart(t, 0); rg.setEnd(t, t.length); return rg.getBoundingClientRect(); })();
          const fs = parseFloat(getComputedStyle(h).fontSize);
          const heart = {
            afterHart: hr.left >= hart.right - 1 && hr.left - hart.right < fs * 0.4,
            onLine: hr.top >= hart.top - 2 && hr.bottom <= hart.bottom + 2,
            capHeight: Math.round((hh.getBoundingClientRect().height / fs) * 100) / 100,
            inBox: hr.right <= box.getBoundingClientRect().right,
            contrast: Math.round(ratio(parse(getComputedStyle(hh).fill), boxBg) * 100) / 100,
          };
          return { lines, contrast, cards, heart };
        }, { color, theme });
        const tag = `[${width}px ${color}/${theme}]`;
        r.check(`${tag} heading on one line: ${d.lines.map((l) => '"' + l + '"').join(' / ')}`, d.lines.length === 1, JSON.stringify(d.lines));
        r.check(`${tag} three cards fit the screen`, d.cards.length === 3 && d.cards.every((c) => c.fits));
        r.check(`${tag} each circle about 1.6x its card, cut by the card's top, bottom and left`,
          d.cards.every((c) => c.circleBigger > 1.45 && c.circleBigger < 1.75 && c.croppedTop && c.croppedBottom && c.croppedLeft), JSON.stringify(d.cards));
        r.check(`${tag} each digit whole and clear of the text (intentionally cropped, not broken)`,
          d.cards.every((c) => c.digitWhole && c.digitClearOfText), JSON.stringify(d.cards));
        r.check(`${tag} the heart sits right after "Hart" on the heading line, inside the box`, d.heart.afterHart && d.heart.onLine && d.heart.inBox, JSON.stringify(d.heart));
        // Height of the 8deg-tilted heart's box, as a share of the font size.
        r.check(`${tag} the heart is about cap height (${d.heart.capHeight}em)`, d.heart.capHeight >= 0.6 && d.heart.capHeight <= 0.85, JSON.stringify(d.heart));
        r.check(`${tag} the heart is clearly visible: ${d.heart.contrast}:1 against the box (3:1+)`, d.heart.contrast >= 3, JSON.stringify(d.heart));
        const low = Object.entries(d.contrast).filter(([, v]) => v < 4.5);
        r.check(`${tag} all text 4.5:1+, over the numbers too (lowest ${Math.min(...Object.values(d.contrast))})`, low.length === 0, JSON.stringify(low));
      }
    }
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}

/* HOME-3: the heart after "Show some Hart". Decoration (aria-hidden), the
   heading still reads "Show some Hart". Still at rest; one double beat
   (scale ~1.12, tilt kept, 0.8s, once) on hover or a card's keyboard focus;
   none at all under reduced motion; nothing around it moves mid-beat. */
async function scenarioHeart(browser, port, r) {
  r.section('HOME-3: the heart -- decoration, still at rest, one gentle beat, none with reduced motion');
  for (const reduced of [false, true]) {
    const page = await newPage(browser, { width: 1280, height: 900 });
    const errors = collectErrors(page);
    if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
    await wireSupabaseStubs(page, { siteSettings: SETTINGS_CTA_ON, songs: F.SONGS_ROWS });
    await gotoHome(page, '/', port);
    await page.waitForSelector('.show-some-hart .hart-heart', { timeout: 10000 });
    const tag = reduced ? '[reduced motion]' : '[motion]';
    await page.mouse.move(5, 890);
    const rest = await page.evaluate(() => {
      const h = document.getElementById('hero-callout-h'), hh = h.querySelector('.hart-heart');
      const k = h.cloneNode(true); k.querySelectorAll('[aria-hidden="true"]').forEach((x) => x.remove());
      return {
        svg: hh.tagName.toLowerCase() === 'svg' && !!hh.querySelector('path'), hidden: hh.getAttribute('aria-hidden'),
        inHeading: hh.closest('h3') === h, a11y: k.textContent.replace(/\s+/g, ' ').trim(), text: h.textContent,
        noEmoji: !/[\u2665\u2764\u{1F90D}-\u{1F9E1}\u{1F493}-\u{1F49F}]/u.test(h.textContent),
        anims: hh.getAnimations().length, transform: getComputedStyle(hh).transform,
      };
    });
    if (!reduced) {
      r.check('an inline SVG heart inside the heading (no emoji, no icon font)', rest.svg && rest.inHeading && rest.noEmoji, JSON.stringify(rest));
      r.check('aria-hidden; the heading still reads "Show some Hart"', rest.hidden === 'true' && rest.a11y === 'Show some Hart' && rest.text === 'Show some Hart', JSON.stringify(rest));
      // matrix(cos8, sin8, -sin8, cos8, 0, 0): cos 8deg = 0.990, sin 8deg = 0.139.
      const m = (rest.transform.match(/-?[\d.]+/g) || []).map(Number);
      r.check('tilted about 8 degrees', Math.abs(Math.atan2(m[1], m[0]) * 180 / Math.PI - 8) < 0.5, rest.transform);
    }
    r.check(`${tag} no motion at rest`, rest.anims === 0, rest.anims);

    const layout = () => page.evaluate(() => {
      const box = document.querySelector('.show-some-hart');
      const rr = (el) => { const b = el.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map((v) => Math.round(v * 10) / 10).join(','); };
      return [box, box.querySelector('h3'), box.querySelector('.hero-callout-sub'), ...box.querySelectorAll('.gi-action')].map(rr).join(' | ')
        + ' | heart-layout:' + [box.querySelector('.hart-heart')].map((x) => x.getBoundingClientRect()).map(() => {
          const t = box.querySelector('.hart-nowrap'); const b = t.getBoundingClientRect(); return [b.left, b.top, b.height].map((v) => Math.round(v * 10) / 10).join(',');
        })[0];
    });
    // Web fonts first: a font arriving between the two measurements moves
    // the text (that is font loading, not the beat).
    await page.evaluate(() => document.fonts.ready);
    const before = await layout();
    await page.hover('.show-some-hart h3');
    const beat = await page.evaluate(() => {
      const hh = document.querySelector('.hart-heart');
      const a = hh.getAnimations();
      // animation-name, not just running animations: theme.css's global
      // reduced-motion rule shrinks any animation to 0.001ms, which would
      // also leave nothing running a moment later.
      if (!a.length) return { n: 0, animName: getComputedStyle(hh).animationName };
      const t = a[0].effect.getComputedTiming();
      a[0].pause(); a[0].currentTime = 200;   // a quarter in: the first beat's peak
      const m = getComputedStyle(hh).transform.match(/-?[\d.]+/g).map(Number);
      return { n: a.length, name: a[0].animationName, dur: t.duration, iters: t.iterations, scale: Math.round(Math.hypot(m[0], m[1]) * 1000) / 1000,
        tilt: Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI * 10) / 10 };
    });
    if (reduced) {
      r.check(`${tag} hovering the box: no animation at all (animation-name none)`, beat.n === 0 && beat.animName === 'none', JSON.stringify(beat));
    } else {
      r.check('hovering the box: one heartbeat animation, 0.8s, played once', beat.n === 1 && beat.name === 'hart-beat' && beat.dur === 800 && beat.iters === 1, JSON.stringify(beat));
      r.check('...scaling up about 12% at the beat, still tilted', Math.abs(beat.scale - 1.12) < 0.01 && Math.abs(beat.tilt - 8) < 0.5, JSON.stringify(beat));
      r.check('...and nothing around it shifts mid-beat', await layout() === before, JSON.stringify({ before, during: await layout() }));
      const kf = await page.evaluate(() => {
        for (const sh of document.styleSheets) { let rules; try { rules = sh.cssRules; } catch (e) { continue; }
          for (const ru of rules) if (ru.type === CSSRule.KEYFRAMES_RULE && ru.name === 'hart-beat') return [...ru.cssRules].map((k) => k.keyText + ' ' + k.style.transform); }
        return null;
      });
      r.check('two beats: up at 25% and 75%, back at 50% and 100%', !!kf && kf.join('|').includes('25%, 75% rotate(8deg) scale(1.12)'), JSON.stringify(kf));
    }
    // A card's keyboard focus (Tab, so :focus-visible really applies).
    await page.mouse.move(5, 890);
    await page.waitForFunction(() => !document.querySelector('.hart-heart').getAnimations().length, null, { timeout: 3000 }).catch(() => {});
    let focused = false;
    for (let i = 0; i < 80 && !focused; i++) {
      await page.keyboard.press('Tab');
      focused = await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('.show-some-hart .gi-action'));
    }
    const kb = await page.evaluate(() => { const hh = document.querySelector('.hart-heart');
      return { visible: document.activeElement.matches(':focus-visible'), n: hh.getAnimations().length, animName: getComputedStyle(hh).animationName }; });
    r.check(`${tag} a card reached by keyboard ${reduced ? 'gives no animation' : 'gives the heartbeat'}`,
      focused && kb.visible && (reduced ? kb.n === 0 && kb.animName === 'none' : kb.n === 1 && kb.animName === 'hart-beat'), JSON.stringify({ focused, ...kb }));
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}
