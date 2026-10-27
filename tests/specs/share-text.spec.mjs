/* ============================================================
   SHARE-1 -- what a song or dedication share actually sends, through the
   real buttons: the song Share button (native sheet, and copy where there
   is none), the dedication success pane ("Send on WhatsApp" / Copy link /
   More options, SEND-1's own wording below) and the /d/<code> page's
   Share button.

   Song: note + title as the song page shows it + ", by <artist>", the
   inspiration in quotes (cut at a sentence, or a word, with "…" past ~280
   characters; left out when empty), then the canonical /song/<slug> link
   alone as the last line. Dedication: note + the phrase table's headline,
   the message in quotes, the sender line (none for anonymous), then the
   canonical /d/<code> link (SHARE-1b: for Something else the headline is
   followed by ": <the write-in>"). WhatsApp text survives encoding (Hebrew, quotes,
   line breaks, the note); the native sheet gets the link once, as `url`,
   never inside `text` too. One emoji only: the note. (The single-og:image
   check for /song/ and /d/ is share-og.spec.mjs's, run alongside.)
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const NOTE = '\u{1F3B5}';
const SITE = 'https://laivyhart.com';
const SUPER = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);
const HEB = F.SONGS_ROWS.find((s) => s.id === F.SONGS.QUIET_NIGHT_HE);
const INSPIRATION = 'Written on a night drive. The sky would not stop.';
const HEB_INSPIRATION = 'שיר על לילה שקט, "בלי מילים" אחרי יום ארוך.';
// 7 sentences, well over 280 characters in all, so it has to be cut.
const LONG = Array.from({ length: 7 }, (_, i) => `Sentence number ${i + 1} is here to fill the space.`).join(' ');
const NO_STOP = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
const emojiCount = (t) => (t.match(/\p{Extended_Pictographic}/gu) || []).length;

function songsWith(abouts) {
  return F.SONGS_ROWS.map((s) => (s.id in abouts ? { ...s, about: abouts[s.id] } : s));
}
// mode 'native': navigator.share captured; 'copy': no navigator.share, real clipboard.
async function setup(browser, port, mode, stubs, signIn) {
  const page = await newPage(browser, { width: 390, height: 844 });
  const errors = collectErrors(page);
  await page.addInitScript((mode) => {
    window.__shared = [];
    if (mode === 'native') {
      Object.defineProperty(navigator, 'share', { configurable: true, value: (d) => { window.__shared.push(d); return Promise.resolve(); } });
    } else {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    }
  }, mode);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${port}` });
  await wireSupabaseStubs(page, stubs);
  if (signIn) await signInAs(page, signIn);
  return { page, errors };
}
async function openSong(page, port, slug) {
  await page.goto(`http://localhost:${port}/song/${slug}`, { waitUntil: 'load' });
  await page.waitForFunction((slug) => currentIdx !== null && SONGS[currentIdx].slug === slug, slug, { timeout: 10000 });
  await page.waitForFunction(() => !document.getElementById('dock-react').classList.contains('hidden'), null, { timeout: 10000 });
}
const lastShared = (page) => page.evaluate(() => window.__shared[window.__shared.length - 1] || null);
async function clipboardAfter(page, click) {
  await page.evaluate(() => navigator.clipboard.writeText('__empty__'));
  await page.click(click);
  await page.waitForFunction(async () => { try { return (await navigator.clipboard.readText()) !== '__empty__'; } catch (e) { return false; } }, null, { timeout: 10000 });
  return page.evaluate(() => navigator.clipboard.readText());
}
// The rules every full share text follows.
function checkFull(r, tag, full, url, wantLines) {
  const lines = full.split('\n');
  r.check(`${tag} lines exactly as expected`, JSON.stringify(lines) === JSON.stringify([...wantLines, url]), JSON.stringify(lines));
  r.check(`${tag} the canonical link appears once, alone, as the last line`,
    lines[lines.length - 1] === url && full.split(url).length === 2 && !/[?#]/.test(url), JSON.stringify(lines.slice(-1)));
  r.check(`${tag} one emoji only: the note, first`, emojiCount(full) === 1 && full.startsWith(NOTE + ' '), emojiCount(full));
}
function checkNative(r, tag, d, url, wantLines) {
  r.check(`${tag} native sheet: text is the lines, url is the link, the link not repeated in text`,
    !!d && d.url === url && d.text === wantLines.join('\n') && !d.text.includes(url) && !d.text.includes('laivyhart.com'), JSON.stringify(d));
}

export async function run(browser, port) {
  const r = makeReporter('share-text.spec.mjs');
  await scenarioSongs(browser, port, r);
  await scenarioClip(browser, port, r);
  await scenarioDedicationTexts(browser, port, r);
  await scenarioDedicationSuccess(browser, port, r);
  await scenarioDedicationSuccessOther(browser, port, r);
  await scenarioDedicationPage(browser, port, r);
  return r;
}

async function scenarioSongs(browser, port, r) {
  r.section('song shares: with and without inspiration, long, Hebrew; native sheet and copy');
  const songs = songsWith({ [F.SONGS.SUPERNOVA]: INSPIRATION, [F.SONGS.QUIET_NIGHT_HE]: HEB_INSPIRATION, [F.SONGS.LOW_LIGHT]: LONG });
  const cases = [
    { tag: '[with inspiration]', slug: SUPER.slug, lines: [`${NOTE} Supernova, by Nova Ash`, `“${INSPIRATION}”`] },
    { tag: '[no inspiration]', slug: 'quiet-static-a000', lines: [`${NOTE} Quiet Static, by Nova Ash`] },
    { tag: '[Hebrew title]', slug: HEB.slug, lines: [`${NOTE} לילה שקט, by Nova Ash`, `“${HEB_INSPIRATION}”`] },
  ];
  for (const mode of ['native', 'copy']) {
    const { page, errors } = await setup(browser, port, mode, { songs });
    for (const c of cases) {
      await openSong(page, port, c.slug);
      const url = `${SITE}/song/${c.slug}`;
      const tag = `[${mode}] ${c.tag}`;
      if (mode === 'native') {
        await page.click('#now-share-btn');
        await page.waitForFunction(() => window.__shared.length > 0, null, { timeout: 5000 });
        const d = await lastShared(page);
        checkNative(r, tag, d, url, c.lines);
        checkFull(r, tag, d.text + '\n' + d.url, url, c.lines);
        await page.evaluate(() => { window.__shared = []; });
      } else {
        const full = await clipboardAfter(page, '#now-share-btn');
        checkFull(r, tag + ' copy:', full, url, c.lines);
      }
    }
    // The long one, through the button: cut, ends with "…".
    await openSong(page, port, 'low-light-a000');
    const full = mode === 'native'
      ? await (async () => { await page.click('#now-share-btn'); await page.waitForFunction(() => window.__shared.length > 0); const d = await lastShared(page); return d.text + '\n' + d.url; })()
      : await clipboardAfter(page, '#now-share-btn');
    const insp = full.split('\n')[1] || '';
    r.check(`[${mode}] [long inspiration] cut at a full sentence, ending with "…", within ~280 characters`,
      insp.startsWith('“Sentence number 1') && insp.endsWith('space…”') && [...insp].length - 2 <= 280 && LONG.startsWith(insp.slice(1, -2)),
      JSON.stringify({ insp, len: [...insp].length - 2 }));
    r.check(`[${mode}] no console/page errors`, errors.length === 0, errors.join(' | '));
    await page.close();
  }
  // WhatsApp-style encoding of a song share (Hebrew, quotes, line breaks, the note).
  const { page, errors } = await setup(browser, port, 'copy', { songs });
  await openSong(page, port, HEB.slug);
  const enc = await page.evaluate(() => { const p = songSharePayload(SONGS[currentIdx]); return { wa: 'https://wa.me/?text=' + encodeURIComponent(shareFullText(p)), full: shareFullText(p) }; });
  const back = decodeURIComponent(enc.wa.replace('https://wa.me/?text=', ''));
  r.check('[Hebrew song] wa.me text decodes back exactly (Hebrew, quotes, line breaks, note survive)',
    back === enc.full && enc.wa.includes('%0A') && enc.wa.includes('%F0%9F%8E%B5') && /[֐-׿]/.test(back) && !/\s/.test(enc.wa), enc.wa);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioClip(browser, port, r) {
  r.section('the ~280-character cut: sentence first, else a whole word; short text untouched');
  const { page, errors } = await setup(browser, port, 'copy', { songs: F.SONGS_ROWS });
  await openSong(page, port, SUPER.slug);
  const d = await page.evaluate(({ LONG, NO_STOP }) => ({
    short: clipInspiration('One line.\n\nTwo  lines.'),
    long: clipInspiration(LONG), noStop: clipInspiration(NO_STOP), exactly: clipInspiration('a'.repeat(280)),
    question: clipInspiration('Is this the one? ' + 'x'.repeat(300)),
  }), { LONG, NO_STOP });
  r.check('short: kept whole, one line', d.short === 'One line. Two lines.', d.short);
  r.check('exactly 280: kept whole', d.exactly.length === 280 && !d.exactly.endsWith('…'));
  // The most whole sentences whose text plus the "…" stays within 280.
  const sentences = LONG.match(/[^.]+\./g).map((x) => x.trim());
  let fit = '';
  for (let k = 1; k <= sentences.length; k++) { const t = sentences.slice(0, k).join(' '); if (t.length <= 279) fit = t; }
  r.check('long: the last full sentence that fits, its period turned into "…"',
    d.long === fit.replace(/\.$/, '') + '\u2026' && [...d.long].length <= 280 && fit.length < LONG.length, JSON.stringify({ got: d.long, want: fit }));
  r.check('a sentence ending in "?" keeps it, then "…"', d.question === 'Is this the one?…', d.question);
  const words = d.noStop.slice(0, -1).split(' ');
  r.check('no sentence fits: cut at the last whole word, then "…"',
    d.noStop.endsWith('…') && [...d.noStop].length <= 280 && words.every((w, i) => w === `word${i}`), d.noStop);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioDedicationTexts(browser, port, r) {
  r.section('dedication texts: normal, anonymous, no message, In memory, Something else (phrase table wording)');
  const { page, errors } = await setup(browser, port, 'copy', { songs: F.SONGS_ROWS });
  await openSong(page, port, SUPER.slug);
  const d = await page.evaluate(() => {
    const base = { recipient: 'Mom', occasion: 'birthday', message: 'Love you!', sender: 'Tzvi', anonymous: false, code: 'ABCD2345' };
    const go = (o) => { const p = dedSharePayload({ ...base, ...o }); return { full: shareFullText(p), p }; };
    return {
      normal: go({}), anon: go({ anonymous: true }), noMsg: go({ message: '' }), noName: go({ sender: null }),
      memory: go({ occasion: 'in_memory', recipient: 'Grandpa Avi', message: 'We miss you.' }),
      other: go({ occasion: 'other', recipient: 'Dina' }),
      // SHARE-1b: the write-in after a colon, trimmed, otherwise as typed.
      otherWritten: go({ occasion: 'other', recipient: 'Dad', other: '  finishing Shas  ' }),
      otherHebrew: go({ occasion: 'other', recipient: '\u05D0\u05D1\u05D0', other: 'סיום הש"ס' }),
      otherPunct: go({ occasion: 'other', recipient: 'Dad', other: 'finishing Shas!' }),
      birthdayIgnoresOther: go({ other: 'finishing Shas' }),
      hebrew: go({ recipient: 'אמא', message: 'אוהבת אותך\nתמיד' }),
      table: { b: dedHeadline('birthday', 'Mom'), m: dedHeadline('in_memory', 'Grandpa Avi'), o: dedHeadline('other', 'Dina'), s: dedSenderLine('birthday', 'Tzvi', false), sm: dedSenderLine('in_memory', 'Tzvi', false) },
    };
  });
  const url = `${SITE}/d/ABCD2345`;
  checkFull(r, '[normal]', d.normal.full, url, [`${NOTE} Happy birthday, Mom`, '“Love you!”', 'With love, Tzvi']);
  r.check('[normal] headline and sender line are the phrase table\'s own', d.normal.full.includes(d.table.b) && d.normal.full.includes(d.table.s));
  checkFull(r, '[anonymous]', d.anon.full, url, [`${NOTE} Happy birthday, Mom`, '“Love you!”']);
  r.check('[anonymous] no sender line at all (not even "someone who cares")', !/With love|Dedicated by|someone/.test(d.anon.full), d.anon.full);
  checkFull(r, '[no message]', d.noMsg.full, url, [`${NOTE} Happy birthday, Mom`, 'With love, Tzvi']);
  checkFull(r, '[no sender name]', d.noName.full, url, [`${NOTE} Happy birthday, Mom`, '“Love you!”']);
  checkFull(r, '[In memory]', d.memory.full, url, [`${NOTE} ${d.table.m}`, '“We miss you.”', d.table.sm]);
  r.check('[In memory] "In loving memory of ..." and "Dedicated by ..."', d.table.m === 'In loving memory of Grandpa Avi' && d.table.sm === 'Dedicated by Tzvi');
  checkFull(r, '[Something else, no write-in]', d.other.full, url, [`${NOTE} ${d.table.o}`, '“Love you!”', 'With love, Tzvi']);
  checkFull(r, '[Something else + write-in]', d.otherWritten.full, url, [`${NOTE} This one's for you, Dad: finishing Shas`, '“Love you!”', 'With love, Tzvi']);
  r.check('[Something else + write-in] the native-sheet title carries it too', d.otherWritten.p.title === "This one's for you, Dad: finishing Shas", d.otherWritten.p.title);
  checkFull(r, '[Something else + Hebrew write-in]', d.otherHebrew.full, url, [`${NOTE} This one's for you, \u05D0\u05D1\u05D0: סיום הש"ס`, '“Love you!”', 'With love, Tzvi']);
  r.check('[Something else] the write-in exactly as typed (its own punctuation kept, no quotes added)',
    d.otherPunct.full.split('\n')[0] === `${NOTE} This one's for you, Dad: finishing Shas!`, d.otherPunct.full.split('\n')[0]);
  checkFull(r, '[birthday, a stray write-in] other occasions unchanged', d.birthdayIgnoresOther.full, url, [`${NOTE} Happy birthday, Mom`, '“Love you!”', 'With love, Tzvi']);
  checkFull(r, '[Hebrew]', d.hebrew.full, url, [`${NOTE} Happy birthday, אמא`, '“אוהבת אותך', 'תמיד”', 'With love, Tzvi']);
  r.check('[Hebrew] the message is exactly as written (its own line break kept)', d.hebrew.full.includes('אותך\nתמיד'));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* SEND-1: the success pane sends a message written TO the person:
     "<sender> dedicated a song to you: <the form's own occasion line>",
     the note + the song title, the message in quotes, "Listen here: <link>".
   WhatsApp is a real wa.me link (no window.open after the save); Copy link
   copies the link alone; the share sheet gets the same lines as `text` and
   the link once, as `url`. */
async function sendSuccess(browser, port, fill) {
  const { page, errors } = await setup(browser, port, 'native',
    { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH], createDedicationResult: 'ABCD2345' }, F.SESSION_USERS.NOVA);
  await openSong(page, port, SUPER.slug);
  await page.click('#now-dedicate-btn');
  await page.waitForSelector('#dedicate-modal:not([hidden])', { timeout: 10000 });
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'dedicate-recipient', null, { timeout: 5000 });
  await fill(page);
  await page.click('#dedicate-submit');
  await page.waitForSelector('[data-ded-pane="success"]:not([hidden])', { timeout: 10000 });
  return { page, errors };
}
async function checkSend(r, tag, page, lines) {
  const url = `${SITE}/d/ABCD2345`;
  const wa = await page.evaluate(() => document.getElementById('dedicate-whatsapp').getAttribute('href'));
  r.check(`${tag} WhatsApp is a real wa.me link`, wa.startsWith('https://wa.me/?text=') && !/\s/.test(wa), wa);
  const waText = decodeURIComponent(wa.slice('https://wa.me/?text='.length));
  r.check(`${tag} [WhatsApp] lines exactly as expected`, JSON.stringify(waText.split('\n')) === JSON.stringify([...lines, 'Listen here: ' + url]), JSON.stringify(waText.split('\n')));
  r.check(`${tag} [WhatsApp] one emoji, the note`, emojiCount(waText) === 1, waText);
  r.check(`${tag} [Copy link] copies the link alone`, await clipboardAfter(page, '#dedicate-copy') === url);
  await page.click('#dedicate-native-share');
  await page.waitForFunction(() => window.__shared.length > 0, null, { timeout: 5000 });
  const d = await lastShared(page);
  r.check(`${tag} [More options] the same lines as text, the link once as url`,
    d && d.url === url && d.text === [...lines, 'Listen here:'].join('\n') && !d.text.includes(url), JSON.stringify(d));
  return waText;
}

async function scenarioDedicationSuccess(browser, port, r) {
  r.section('SEND-1: send it to them after creating a dedication: WhatsApp, Copy link, More options');
  const { page, errors } = await sendSuccess(browser, port, async (page) => {
    await page.fill('#dedicate-recipient', 'אמא Mom');
    await page.selectOption('#dedicate-occasion', 'birthday');
    await page.fill('#dedicate-message', 'Love you, "always"!');
  });
  const waText = await checkSend(r, '[birthday]', page,
    ['Nova Ash dedicated a song to you: a birthday song for אמא Mom', `${NOTE} Supernova`, '“Love you, "always"!”']);
  const wa = await page.evaluate(() => document.getElementById('dedicate-whatsapp').getAttribute('href'));
  r.check('[WhatsApp] Hebrew, quotes, line breaks and the note survive encoding', wa.includes('%0A') && wa.includes('%22always%22') && wa.includes('%F0%9F%8E%B5') && /[֐-׿]/.test(waText));
  r.check('[WhatsApp] never the sender\'s email', !/nova@example\.test|@/.test(waText), waText);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioDedicationSuccessOther(browser, port, r) {
  r.section('SEND-1: Something else carries the write-in; private sender shows as Someone');
  const { page, errors } = await sendSuccess(browser, port, async (page) => {
    await page.fill('#dedicate-recipient', 'Dad');
    await page.selectOption('#dedicate-occasion', 'other');
    await page.fill('#dedicate-occasion-other', '  finishing Shas ');
    await page.check('#dedicate-anonymous');
  });
  await checkSend(r, '[Something else, private]', page,
    ['Someone dedicated a song to you: a song for Dad: finishing Shas', `${NOTE} Supernova`]);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioDedicationPage(browser, port, r) {
  r.section('the /d/<code> page Share button: named and anonymous, native sheet and copy');
  const row = (o) => ({ code: 'ABCD2345', song_id: SUPER.id, song_title: SUPER.title, song_slug: SUPER.slug, cover_url: null,
    recipient_name: 'Mom', occasion: 'birthday', occasion_other: null, message: 'Love you so much!', sender_name: 'Tzvi', sender_handle: null,
    created_at: new Date().toISOString(), ...o });
  const url = `${SITE}/d/ABCD2345`;
  for (const [tag, o, lines] of [
    ['[named]', {}, [`${NOTE} Happy birthday, Mom`, '“Love you so much!”', 'With love, Tzvi']],
    ['[anonymous]', { sender_name: null }, [`${NOTE} Happy birthday, Mom`, '“Love you so much!”']],
    ['[In memory, no message]', { occasion: 'in_memory', message: null }, [`${NOTE} In loving memory of Mom`, 'Dedicated by Tzvi']],
    ['[Something else + Hebrew write-in]', { occasion: 'other', occasion_other: 'סיום הש"ס' }, [`${NOTE} This one's for you, Mom: סיום הש"ס`, '“Love you so much!”', 'With love, Tzvi']],
  ]) {
    for (const mode of ['native', 'copy']) {
      const { page, errors } = await setup(browser, port, mode, { dedicationsPublic: [row(o)] });
      await page.goto(`http://localhost:${port}/d/ABCD2345`, { waitUntil: 'load' });
      await page.waitForSelector('#ded-page-share-btn', { timeout: 10000 });
      if (o.occasion === 'other') {
        const pg = await page.evaluate(() => ({ h: document.querySelector('.ded-page-headline').textContent, l: document.querySelector('.ded-page-line').textContent }));
        r.check(`${tag} [${mode}] the /d page itself is unchanged (headline without the write-in; it stays in the line)`,
          pg.h === "This one's for you, Mom" && pg.l === 'A song for Mom: סיום הש"ס', JSON.stringify(pg));
      }
      if (mode === 'native') {
        await page.click('#ded-page-share-btn');
        await page.waitForFunction(() => window.__shared.length > 0, null, { timeout: 5000 });
        const d = await lastShared(page);
        checkNative(r, `${tag} [native]`, d, url, lines);
      } else {
        checkFull(r, `${tag} [copy]`, await clipboardAfter(page, '#ded-page-share-btn'), url, lines);
      }
      r.check('no console/page errors', errors.length === 0, errors.join(' | '));
      await page.close();
    }
  }
}
