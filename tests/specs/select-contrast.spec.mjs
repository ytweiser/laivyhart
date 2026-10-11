/* ============================================================
   LISTEN-1 -- native <select> dropdowns ("white on white" when opened):
   color-scheme set on the control itself, and option/optgroup given the
   theme's own solid, opaque background + text tokens (--bg-2/--text),
   checked for at least 4.5:1 contrast across all 8 color x lighting
   combinations. Exercised through #dedicate-occasion (the one select with
   both plain options AND optgroups, so one page covers both cases); other
   selects on the site (admin, upload, sort) share the same global theme.css
   rule, not a per-select override, so this is the one place that needs to
   prove the rule itself is correct.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SLUG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA).slug;
const COMBOS = [
  ['bordeaux', 'dark'], ['bordeaux', 'light'],
  ['emerald', 'dark'], ['emerald', 'light'],
  ['royal', 'dark'], ['royal', 'light'],
  ['gold', 'dark'], ['gold', 'light'],
];

export async function run(browser, port) {
  const r = makeReporter('select-contrast.spec.mjs');
  await scenarioContrastAndScheme(browser, port, r);
  return r;
}

async function scenarioContrastAndScheme(browser, port, r) {
  r.section('option/optgroup contrast across all 8 theme x lighting combinations, >= 4.5:1');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await page.goto(`http://localhost:${port}/song/${SLUG}`, { waitUntil: 'load' });
  await page.waitForSelector('#now-dedicate-btn', { state: 'visible', timeout: 10000 });
  await page.click('#now-dedicate-btn');
  await page.waitForSelector('#dedicate-modal:not([hidden])', { timeout: 10000 });

  const results = await page.evaluate((combos) => {
    function lin(c) { c = c / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    function parseRgb(s) {
      const m = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
      return m ? [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])] : [0, 0, 0];
    }
    function lum([r, g, b]) { return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
    function contrast(rgb1, rgb2) {
      const l1 = lum(rgb1), l2 = lum(rgb2);
      const lighter = Math.max(l1, l2), darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }
    const sel = document.getElementById('dedicate-occasion');
    const option = sel.querySelector('option[value="birthday"]');
    const optgroup = sel.querySelector('optgroup');
    const out = [];
    for (const [color, theme] of combos) {
      document.documentElement.setAttribute('data-color', color);
      document.documentElement.setAttribute('data-theme', theme);
      const optStyle = getComputedStyle(option);
      const groupStyle = getComputedStyle(optgroup);
      const selStyle = getComputedStyle(sel);
      out.push({
        color, theme,
        colorScheme: selStyle.colorScheme,
        optionContrast: contrast(parseRgb(optStyle.backgroundColor), parseRgb(optStyle.color)),
        groupContrast: contrast(parseRgb(groupStyle.backgroundColor), parseRgb(groupStyle.color)),
      });
    }
    return out;
  }, COMBOS);

  let worst = null;
  for (const row of results) {
    const label = `${row.color}-${row.theme}`;
    r.check(`[${label}] select's color-scheme matches the lighting (${row.theme})`, row.colorScheme === row.theme, row.colorScheme);
    r.check(`[${label}] option contrast >= 4.5:1 (${row.optionContrast.toFixed(2)}:1)`, row.optionContrast >= 4.5, row.optionContrast);
    r.check(`[${label}] optgroup label contrast >= 4.5:1 (${row.groupContrast.toFixed(2)}:1)`, row.groupContrast >= 4.5, row.groupContrast);
    const rowWorst = Math.min(row.optionContrast, row.groupContrast);
    if (!worst || rowWorst < worst.ratio) worst = { label, ratio: rowWorst };
  }
  console.log(`[select-contrast] worst case across all 8 combinations: ${worst.label} at ${worst.ratio.toFixed(2)}:1`);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
