/* ============================================================
   LYRICS-1 -- the one "English translation" toggle replaces the old
   עברית / EN pills. It appears ONLY on a Hebrew song that carries an English
   translation; English songs and untranslated Hebrew songs show no language
   control at all. Checked at desktop and 380px, in both skins.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const HE_LYRICS = 'שורה ראשונה\nשורה שנייה\n\nבית שני\nשורה אחרונה';
const EN_LYRICS = 'First line\nSecond line\n\nSecond verse\nLast line';

// Copies, so no other spec's fixture changes.
const ROWS = F.SONGS_ROWS.map((s) => {
  if (s.id === F.SONGS.QUIET_NIGHT_HE) return { ...s, lyrics_original: HE_LYRICS, lyrics_translation: EN_LYRICS };
  if (s.id === F.SONGS.AFTERGLOW) return { ...s, language: 'Hebrew', title: 'זוהר', lyrics_original: HE_LYRICS, lyrics_translation: '  ' };
  if (s.id === F.SONGS.SUPERNOVA) return { ...s, lyrics_original: EN_LYRICS, lyrics_translation: '' };
  return s;
});
const slugOf = (id) => ROWS.find((s) => s.id === id).slug;
const TRANSLATED = slugOf(F.SONGS.QUIET_NIGHT_HE);
const UNTRANSLATED = slugOf(F.SONGS.AFTERGLOW);
const ENGLISH = slugOf(F.SONGS.SUPERNOVA);

const VIEWPORTS = [
  { name: 'desktop', size: { width: 1280, height: 1000 } },
  { name: '380px', size: { width: 380, height: 800 } },
];
const SKINS = ['dark', 'light'];

async function open(browser, port, slug, viewport, skin) {
  const page = await newPage(browser, viewport);
  await page.addInitScript((t) => { try { localStorage.setItem('laivy-theme', t); } catch (e) {} }, skin);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { songs: ROWS });
  await page.goto(`http://localhost:${port}/song/${slug}`, { waitUntil: 'load' });
  await page.waitForSelector('#lyrics-orig:not(.hidden)', { timeout: 10000 });
  return { page, errors };
}

const state = (page) => page.evaluate(() => {
  const btn = document.getElementById('lyrics-lang-btn');
  const vis = (el) => !!el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none';
  const orig = document.getElementById('lyrics-orig');
  const trans = document.getElementById('lyrics-trans');
  const box = btn.getBoundingClientRect();
  const cs = getComputedStyle(btn);
  return {
    btnVisible: vis(btn),
    label: btn.textContent.trim(),
    w: box.width, h: box.height, right: box.right, vw: document.documentElement.clientWidth,
    inHead: !!btn.closest('.lyrics-head'),
    origVisible: vis(orig), transVisible: vis(trans),
    origDir: getComputedStyle(orig).direction, transDir: getComputedStyle(trans).direction,
    origAlign: getComputedStyle(orig).textAlign, transAlign: getComputedStyle(trans).textAlign,
    transText: trans.innerText,
    color: cs.color, bg: cs.backgroundImage,
    oldPills: document.querySelectorAll('#lang-toggle, .lang-toggle').length,
    theme: document.documentElement.getAttribute('data-theme'),
  };
});

export async function run(browser, port) {
  const r = makeReporter('lyrics-lang.spec.mjs');
  for (const vp of VIEWPORTS) {
    for (const skin of SKINS) {
      await scenarioTranslated(browser, port, r, vp, skin);
      await scenarioNoControl(browser, port, r, vp, skin, UNTRANSLATED, 'Hebrew song without a translation');
      await scenarioNoControl(browser, port, r, vp, skin, ENGLISH, 'English song');
    }
  }
  await scenarioResetsOnSongChange(browser, port, r);
  return r;
}

async function scenarioTranslated(browser, port, r, vp, skin) {
  r.section(`Hebrew song with a translation (${vp.name}, ${skin})`);
  const { page, errors } = await open(browser, port, TRANSLATED, vp.size, skin);
  let s = await state(page);
  r.check('skin applied', s.theme === skin, s.theme);
  r.check('no old pills anywhere', s.oldPills === 0);
  r.check('toggle visible in the lyrics head', s.btnVisible && s.inHead);
  r.check('defaults to Hebrew, labelled "English translation"', s.origVisible && !s.transVisible && s.label === 'English translation', s.label);
  r.check('tap target at least 44px tall', s.h >= 44, s.h);
  r.check('stays inside the viewport', s.right <= s.vw, `${s.right} > ${s.vw}`);
  r.check('original is RTL, right-aligned', s.origDir === 'rtl' && (s.origAlign === 'right' || s.origAlign === 'start'), `${s.origDir}/${s.origAlign}`);

  await page.click('#lyrics-lang-btn');
  s = await state(page);
  r.check('click shows English instantly', s.transVisible && !s.origVisible);
  r.check('label now reads עברית / Hebrew', s.label.includes('עברית') && s.label.includes('Hebrew'), s.label);
  r.check('English is LTR', s.transDir === 'ltr', s.transDir);
  r.check('line breaks and stanza gap kept', /Second line\n\nSecond verse/.test(s.transText), JSON.stringify(s.transText));
  r.check('still 44px tall after the swap', s.h >= 44, s.h);

  await page.click('#lyrics-lang-btn');
  s = await state(page);
  r.check('click again returns to Hebrew', s.origVisible && !s.transVisible && s.label === 'English translation');
  // Optional eyeball check: LYRICS_SHOTS=<dir> saves the lyrics area per variant.
  if (process.env.LYRICS_SHOTS) {
    await page.locator('#lyrics-wrap').screenshot({ path: `${process.env.LYRICS_SHOTS}/translated-${vp.name}-${skin}.png` });
  }
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioNoControl(browser, port, r, vp, skin, slug, what) {
  r.section(`${what}: no language control (${vp.name}, ${skin})`);
  const { page, errors } = await open(browser, port, slug, vp.size, skin);
  const s = await state(page);
  r.check('no toggle', !s.btnVisible);
  r.check('no old pills', s.oldPills === 0);
  r.check('original lyrics shown, translation hidden', s.origVisible && !s.transVisible);
  const headText = await page.evaluate(() => document.querySelector('.lyrics-head').innerText.trim());
  r.check('lyrics head carries only the "Lyrics" label', /^lyrics$/i.test(headText), headText);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioResetsOnSongChange(browser, port, r) {
  r.section('the English choice resets to Hebrew when the song changes');
  const { page, errors } = await open(browser, port, TRANSLATED, VIEWPORTS[0].size, 'dark');
  await page.click('#lyrics-lang-btn');
  let s = await state(page);
  r.check('English showing before the change', s.transVisible);
  await page.evaluate((id) => {
    loadSong(SONGS.findIndex((x) => x.id === id)); // eslint-disable-line no-undef
  }, F.SONGS.SUPERNOVA);
  await page.evaluate((id) => {
    loadSong(SONGS.findIndex((x) => x.id === id)); // eslint-disable-line no-undef
  }, F.SONGS.QUIET_NIGHT_HE);
  s = await state(page);
  r.check('back on the translated song, Hebrew is the default again', s.origVisible && !s.transVisible && s.label === 'English translation', s.label);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
