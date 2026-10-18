/* ============================================================
   DED-3 -- the grouped occasion list and the one canonical phrase table
   (dedHeadline/dedLine/dedSenderLine in index.html, and SHARE-1's dedSharePayload). These are
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
  await scenarioSomethingElseLine(browser, port, r);
  await scenarioSenderLines(browser, port, r);
  await scenarioShareText(browser, port, r);
  return r;
}

async function loadAnyPage(browser, port) {
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  // dedHeadline/dedLine/etc. are defined by the same inline script that
  // builds the occasion dropdown, so its presence means the functions these
  // tests call directly are ready too. state: 'attached', not the default
  // 'visible' -- the dropdown lives inside the (hidden until opened)
  // dedicate sheet, and a native <option> has no box Playwright considers
  // "visible" regardless, so the default would just time out.
  await page.waitForSelector('#dedicate-occasion option', { state: 'attached', timeout: 10000 });
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

async function scenarioSomethingElseLine(browser, port, r) {
  r.section('LISTEN-1: "Something else" line never produces ": ." (empty) or ".." (trailing punctuation)');
  const { page, errors } = await loadAnyPage(browser, port);

  const d = await page.evaluate(() => ({
    empty: dedLine('other', 'Yankel', ''),
    nullOther: dedLine('other', 'Yankel', null),
    whitespaceOnly: dedLine('other', 'Yankel', '   '),
    filled: dedLine('other', 'Yankel', 'a surprise'),
    trailingPeriod: dedLine('other', 'Yankel', 'a surprise.'),
    trailingBang: dedLine('other', 'Yankel', 'a surprise!'),
  }));
  r.check('empty string: no colon at all', d.empty === 'A song for Yankel', d.empty);
  r.check('null: same as empty', d.nullOther === 'A song for Yankel', d.nullOther);
  r.check('whitespace-only: same as empty', d.whitespaceOnly === 'A song for Yankel', d.whitespaceOnly);
  r.check('filled: colon plus the text, no trailing punctuation added', d.filled === 'A song for Yankel: a surprise', d.filled);
  r.check('a trailing period in the typed text is stripped, not doubled', d.trailingPeriod === 'A song for Yankel: a surprise', d.trailingPeriod);
  r.check('a trailing "!" in the typed text is stripped the same way', d.trailingBang === 'A song for Yankel: a surprise', d.trailingBang);

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
  r.section('SHARE-1 share text per occasion: note + headline, message, sender line, link (the table\'s own wording)');
  const { page, errors } = await loadAnyPage(browser, port);

  const d = await page.evaluate(() => {
    const go = (o) => shareFullText(dedSharePayload({ recipient: 'Yankel', message: '', sender: 'Laivy Hart', anonymous: false, code: 'CODE0001', ...o }));
    return { birthday: go({ occasion: 'birthday' }), somethingElse: go({ occasion: 'other' }), inMemory: go({ occasion: 'in_memory' }) };
  });
  r.check('default occasion: the headline, the sender line, the link',
    d.birthday === '\u{1F3B5} Happy birthday, Yankel\nWith love, Laivy Hart\nhttps://laivyhart.com/d/CODE0001', d.birthday);
  r.check('"Something else" uses its own headline',
    d.somethingElse === "\u{1F3B5} This one's for you, Yankel\nWith love, Laivy Hart\nhttps://laivyhart.com/d/CODE0001", d.somethingElse);
  r.check('in_memory: "In loving memory of", "Dedicated by"',
    d.inMemory === '\u{1F3B5} In loving memory of Yankel\nDedicated by Laivy Hart\nhttps://laivyhart.com/d/CODE0001', d.inMemory);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
