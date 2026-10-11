/* ============================================================
   DED-3 -- the grouped occasion list and the one canonical phrase table
   (dedHeadline/dedLine/dedSenderLine/dedShareText in index.html). These are
   plain, stateless functions once the page's script has run, so every
   occasion is checked by calling them directly in-page rather than
   round-tripping the real form 21 times. The form's own wiring (the
   dropdown, validation, the live preview, the success share actions) is
   still covered end-to-end in dedicate.spec.mjs; this file is the phrase
   table itself.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { makeReporter } from '../lib/report.mjs';

// Mirrors DED-3's prompt exactly, name "Yankel" throughout (its own example).
const ALL_OCCASIONS = [
  { key: 'birthday', headline: 'Happy birthday, Yankel', line: 'A birthday song for Yankel' },
  { key: 'engagement', headline: 'Mazel tov, Yankel', line: "A song for Yankel's engagement" },
  { key: 'wedding', headline: 'Mazel tov, Yankel', line: 'A wedding song for Yankel' },
  { key: 'anniversary', headline: 'Happy anniversary, Yankel', line: 'An anniversary song for Yankel' },
  { key: 'bar_mitzvah', headline: 'Mazel tov, Yankel', line: 'A Bar Mitzvah song for Yankel' },
  { key: 'bat_mitzvah', headline: 'Mazel tov, Yankel', line: 'A Bat Mitzvah song for Yankel' },
  { key: 'new_baby', headline: 'Welcome to the world, Yankel', line: 'A song to welcome Yankel' },
  { key: 'bris', headline: 'Mazel tov, Yankel', line: "A song for Yankel's bris" },
  { key: 'upsherin', headline: 'Mazel tov, Yankel', line: "A song for Yankel's upsherin" },
  { key: 'graduation', headline: 'Congratulations, Yankel', line: 'A graduation song for Yankel' },
  { key: 'siyum', headline: 'Mazel tov, Yankel', line: "A song for Yankel's siyum" },
  { key: 'new_job', headline: 'Congratulations, Yankel', line: "A song for Yankel's new job" },
  { key: 'new_home', headline: 'Mazel tov, Yankel', line: "A song for Yankel's new home" },
  { key: 'aliyah', headline: 'Welcome home, Yankel', line: "A song for Yankel's aliyah" },
  { key: 'retirement', headline: 'Congratulations, Yankel', line: "A song for Yankel's retirement" },
  { key: 'refuah_shleimah', headline: 'Refuah shleimah, Yankel', line: 'A song wishing Yankel a refuah shleimah' },
  { key: 'encouragement', headline: 'Stay strong, Yankel', line: "A song to lift Yankel's spirits" },
  { key: 'thank_you', headline: 'Thank you, Yankel', line: 'A thank-you song for Yankel' },
  { key: 'in_memory', headline: 'In loving memory of Yankel', line: 'A song in memory of Yankel' },
  { key: 'just_because', headline: "This one's for you, Yankel", line: 'A song for Yankel, just because' },
  { key: 'other', other: 'a surprise', headline: "This one's for you, Yankel", line: 'A song for Yankel: a surprise' },
];

export async function run(browser, port) {
  const r = makeReporter('dedication-occasions.spec.mjs');
  await scenarioGroupedDropdown(browser, port, r);
  await scenarioHeadlinesAndLines(browser, port, r);
  await scenarioSenderLines(browser, port, r);
  await scenarioShareText(browser, port, r);
  return r;
}

async function loadAnyPage(browser, port) {
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  await page.waitForTimeout(200);
  return { page, errors };
}

async function scenarioGroupedDropdown(browser, port, r) {
  r.section('the occasion dropdown is grouped (optgroup), matching DED-3\'s three groups plus two top-level options');
  const { page, errors } = await loadAnyPage(browser, port);

  const d = await page.evaluate(() => {
    const sel = document.getElementById('dedicate-occasion');
    const groups = Array.from(sel.querySelectorAll('optgroup')).map((g) => ({
      label: g.getAttribute('label'),
      options: Array.from(g.querySelectorAll('option')).map((o) => o.value),
    }));
    // Direct children options of the <select> itself, not inside any optgroup.
    const topLevel = Array.from(sel.children).filter((c) => c.tagName === 'OPTION').map((o) => o.value);
    return { groups, topLevel };
  });

  r.check('three optgroups present', d.groups.length === 3, JSON.stringify(d.groups.map((g) => g.label)));
  r.check('"Celebrations" group has 9 options', d.groups[0]?.label === 'Celebrations' && d.groups[0].options.length === 9, d.groups[0]);
  r.check('"Milestones" group has 6 options', d.groups[1]?.label === 'Milestones' && d.groups[1].options.length === 6, d.groups[1]);
  r.check('"Support" group has 4 options, including in_memory', d.groups[2]?.label === 'Support' && d.groups[2].options.length === 4 && d.groups[2].options.includes('in_memory'), d.groups[2]);
  r.check('"Just because" and "Something else" sit outside any group', d.topLevel.includes('just_because') && d.topLevel.includes('other'), d.topLevel);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioHeadlinesAndLines(browser, port, r) {
  r.section('every occasion renders its own headline and line');
  const { page, errors } = await loadAnyPage(browser, port);

  const results = await page.evaluate((list) => list.map((o) => ({
    key: o.key,
    headline: dedHeadline(o.key, 'Yankel'),
    line: dedLine(o.key, 'Yankel', o.other || null),
  })), ALL_OCCASIONS);

  for (let i = 0; i < ALL_OCCASIONS.length; i++) {
    const expect = ALL_OCCASIONS[i];
    const got = results[i];
    r.check(`${expect.key}: headline`, got.headline === expect.headline, got.headline);
    r.check(`${expect.key}: line`, got.line === expect.line, got.line);
  }

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioSenderLines(browser, port, r) {
  r.section('sender line: "With love" by default, "Dedicated by" for in_memory, each with an anonymous form');
  const { page, errors } = await loadAnyPage(browser, port);

  const d = await page.evaluate(() => ({
    namedDefault: dedSenderLine('birthday', 'Laivy Hart', false),
    anonDefault: dedSenderLine('birthday', null, true),
    namedMemory: dedSenderLine('in_memory', 'Laivy Hart', false),
    anonMemory: dedSenderLine('in_memory', null, true),
  }));
  r.check('named, default occasion: "With love, {sender}"', d.namedDefault === 'With love, Laivy Hart', d.namedDefault);
  r.check('anonymous, default occasion: "With love, from someone who cares"', d.anonDefault === 'With love, from someone who cares', d.anonDefault);
  r.check('named, in_memory: "Dedicated by {sender}"', d.namedMemory === 'Dedicated by Laivy Hart', d.namedMemory);
  r.check('anonymous, in_memory: "Dedicated by someone who cares"', d.anonMemory === 'Dedicated by someone who cares', d.anonMemory);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioShareText(browser, port, r) {
  r.section('WhatsApp/share text per occasion, including the in_memory exception');
  const { page, errors } = await loadAnyPage(browser, port);

  const d = await page.evaluate(() => ({
    birthday: dedShareText('birthday', 'Yankel', 'Precious Son', 'https://laivyhart.com/d/CODE0001'),
    somethingElse: dedShareText('other', 'Yankel', 'Precious Son', 'https://laivyhart.com/d/CODE0002'),
    inMemory: dedShareText('in_memory', 'Yankel', 'Precious Son', 'https://laivyhart.com/d/CODE0003'),
  }));
  r.check('default occasion: "{Headline}! I dedicated a song to you..."',
    d.birthday === 'Happy birthday, Yankel! I dedicated a song to you on Laivy Hart: Precious Son. Listen here: https://laivyhart.com/d/CODE0001', d.birthday);
  r.check('"Something else" uses its own headline in the same general form',
    d.somethingElse === "This one's for you, Yankel! I dedicated a song to you on Laivy Hart: Precious Son. Listen here: https://laivyhart.com/d/CODE0002", d.somethingElse);
  r.check('in_memory: never addresses the recipient as "you"',
    d.inMemory === 'I dedicated a song in memory of Yankel on Laivy Hart: Precious Son. https://laivyhart.com/d/CODE0003', d.inMemory);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
