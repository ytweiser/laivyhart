/* ============================================================
   SHOW-1 -- "Also show this on Laivy Hart": a dedication is public only
   when its sender opted in; its /d/<code> link works either way.
   NAME-1 -- only then can it go up "without my name", and that applies to
   the public places alone: the form reveals the second box under the
   first; whatever the person receives always carries the name; a "from
   someone" card in the strip has no link; My page has both switches.

   Browser (index.html with Supabase stubbed): the new box sits under "Keep
   my name private", unchecked, with its one helper line, at 380 and 1280 in
   both skins; its value reaches create_dedication(); the song's Dedications
   strip lists only public ones (a private name still reads "someone"); a
   private dedication's /d/ page still opens; My page's "Shown on site"
   switch calls set_my_dedication_public() and puts itself back on failure;
   the WhatsApp text decodes to the new wording with no U+FFFD and no lone
   surrogate.

   Node: middleware.js renders a private /d/<code> through
   dedication_by_code() with noindex; the sitemap has no /d/ link; sql/032
   filters every public list and names no email column, and its backfill
   runs only once. The live database was checked the same way when 032 was
   applied (see its report).
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUPER = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);
const HELP = 'Anyone listening to this song can see it.';
const row = (o) => ({
  code: 'PUBL0001', song_id: SUPER.id, song_title: SUPER.title, song_slug: SUPER.slug, cover_url: null,
  recipient_name: 'Mom', occasion: 'birthday', occasion_other: null, message: 'Love you', sender_name: 'Nova Ash',
  sender_handle: 'nova-ash', created_at: new Date().toISOString(), show_publicly: true, ...o,
});
const ROWS = [
  row({}),
  row({ code: 'PRIV0002', recipient_name: 'Dad', show_publicly: false }),
  row({ code: 'ANON0003', recipient_name: 'Gran', sender_name: null, sender_handle: null, sender_name_private: 'Nova Ash' }),
];

export async function run(browser, port) {
  const r = makeReporter('show-publicly.spec.mjs');
  for (const width of [380, 1280]) for (const theme of ['dark', 'light']) await scenarioForm(browser, port, r, width, theme);
  await scenarioSavesChoice(browser, port, r);
  await scenarioStripAndLink(browser, port, r);
  await scenarioMyPage(browser, port, r);
  await scenarioMiddleware(r);
  scenarioStatic(r);
  return r;
}

async function openSheet(browser, port, { width = 1280, theme = 'dark', onCall } = {}) {
  const page = await newPage(browser, { width, height: 900 });
  const errors = collectErrors(page);
  await page.addInitScript((t) => { try { localStorage.setItem('laivy-theme', t); localStorage.setItem('laivy-ded-hint-v1', '1'); } catch (e) {} }, theme);
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH], createDedicationResult: 'ABCD2345' }, onCall);
  await signInAs(page, F.SESSION_USERS.NOVA);
  await page.goto(`http://localhost:${port}/song/${SUPER.slug}`, { waitUntil: 'load' });
  await page.waitForSelector('#now-dedicate-btn', { state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => !!(window.laivy && window.laivy.auth && window.laivy.auth.user), null, { timeout: 10000 });
  await page.click('#now-dedicate-btn');
  await page.waitForSelector('#dedicate-modal:not([hidden])', { timeout: 10000 });
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'dedicate-recipient', null, { timeout: 5000 });
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}

async function scenarioForm(browser, port, r, width, theme) {
  const tag = `[${width}px ${theme}]`;
  r.section(`NAME-1: the two boxes in the form ${tag}`);
  const { page, errors } = await openSheet(browser, port, { width, theme });
  const read = () => page.evaluate(() => {
    const pub = document.getElementById('dedicate-public'), anon = document.getElementById('dedicate-anonymous');
    const wrap = document.getElementById('dedicate-anon-wrap');
    const pubLabel = pub.closest('label'), anonLabel = anon.closest('label');
    const help = pubLabel.querySelector('.ded-checkbox-help'), textSpan = pubLabel.querySelector('span');
    const lh = parseFloat(getComputedStyle(textSpan).lineHeight) || 20;
    const B = (el) => el.getBoundingClientRect();
    return {
      pubChecked: pub.checked, anonChecked: anon.checked,
      firstInForm: pubLabel === document.querySelector('[data-ded-pane="form"] label.ded-checkbox-row'),
      noOldBox: !/Keep my name private/.test(document.getElementById('dedicate-modal').textContent),
      labelText: textSpan.firstChild.textContent.trim(), help: help.textContent,
      labelOneLine: (B(textSpan).height - B(help).height) < lh * 1.6,
      anonText: anonLabel.textContent.replace(/\s+/g, ' ').trim(),
      open: wrap.classList.contains('is-open'), inert: wrap.inert, anonH: B(wrap).height,
      anonIndent: B(anonLabel).left - B(pubLabel).left, below: B(anonLabel).top >= B(pubLabel).bottom - 1,
      live: document.getElementById('dedicate-anon-live').getAttribute('aria-live'),
      liveText: document.getElementById('dedicate-anon-live').textContent,
      preview: document.getElementById('dedicate-preview').textContent,
      formH: B(document.querySelector('[data-ded-pane="form"]')).height,
      text: document.getElementById('dedicate-modal').textContent,
      pageW: document.scrollingElement.scrollWidth, vw: innerWidth,
    };
  });
  const tabOrder = async () => {
    await page.focus('#dedicate-public');
    await page.keyboard.press('Tab');
    return page.evaluate(() => document.activeElement.id);
  };
  // 1. First box unticked: the second is hidden and out of the tab order.
  let d = await read();
  r.check(`${tag} the old "Keep my name private" box is gone; "Also show this on Laivy Hart" comes first, unticked`, d.noOldBox && d.firstInForm && !d.pubChecked, JSON.stringify(d));
  r.check(`${tag} its label on one line, its helper word for word`, d.labelText === 'Also show this on Laivy Hart' && d.labelOneLine && d.help === HELP, JSON.stringify(d));
  r.check(`${tag} unticked: the second box is hidden (no height) and out of the tab order`, !d.open && d.inert && d.anonH < 1 && await tabOrder() === 'dedicate-submit', JSON.stringify(d));
  r.check(`${tag} at 380px about what it was before the opt-in (468px then; <= 484px now)`, width !== 380 || d.formH <= 484, d.formH);
  const preview0 = d.preview;
  r.check(`${tag} the preview names the sender`, /With love, Nova Ash\.$/.test(preview0) && !/someone/i.test(preview0), preview0);
  // 2. Ticked: the second appears under it, indented, announced, reachable.
  await page.check('#dedicate-public');
  await page.waitForTimeout(350);
  d = await read();
  r.check(`${tag} ticked: "Post without my name (shows as "Someone")" appears directly under it, indented, unticked`,
    d.open && !d.inert && d.anonH > 20 && d.below && d.anonIndent > 10 && !d.anonChecked && d.anonText === 'Post without my name (shows as “Someone”)', JSON.stringify(d));
  r.check(`${tag} the reveal is announced politely, and the box is in the tab order`, d.live === 'polite' && /Post without my name/.test(d.liveText) && await tabOrder() === 'dedicate-anonymous', JSON.stringify(d));
  // 3. Both ticked: the preview does not change.
  await page.check('#dedicate-anonymous');
  d = await read();
  r.check(`${tag} both ticked: the preview still names the sender, unchanged`, d.preview === preview0, d.preview);
  // 4. Untick the first: the second hides and resets.
  await page.uncheck('#dedicate-public');
  await page.waitForTimeout(350);
  d = await read();
  r.check(`${tag} unticking the first hides the second and resets it`, !d.open && d.inert && !d.anonChecked, JSON.stringify(d));
  r.check(`${tag} nowhere says "someone you love"`, !/someone you love/i.test(d.text));
  r.check(`${tag} no sideways scrolling`, d.pageW <= d.vw, JSON.stringify(d));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioSavesChoice(browser, port, r) {
  r.section('NAME-1: anonymous is saved only when both boxes are ticked; the person always gets the name');
  for (const [tick, anon] of [[false, false], [true, false], [true, true]]) {
    const calls = [];
    const { page, errors } = await openSheet(browser, port, { onCall: (name, req) => { if (name === 'rpc:create_dedication') calls.push(JSON.parse(req.postData() || '{}')); } });
    await page.fill('#dedicate-recipient', 'Mom');
    if (tick) await page.check('#dedicate-public');
    if (anon) await page.check('#dedicate-anonymous');
    await page.click('#dedicate-submit');
    await page.waitForSelector('[data-ded-pane="success"]:not([hidden])', { timeout: 10000 });
    const c = calls[0] || {};
    r.check(`${tick ? 'shown' : 'not shown'}${anon ? ' + without my name' : ''}: p_show_publicly ${tick}, p_is_anonymous ${anon}, the rest as before`,
      c.p_show_publicly === tick && c.p_is_anonymous === anon && c.p_recipient_name === 'Mom' && c.p_occasion === 'birthday' && c.p_song_id === SUPER.id, JSON.stringify(c));
    // The final encoded WhatsApp text and the share-sheet text.
    const enc = await page.evaluate(() => {
      const href = document.getElementById('dedicate-whatsapp').getAttribute('href');
      const text = decodeURIComponent(href.slice('https://wa.me/?text='.length));
      return { href, text, lone: /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text), ok: encodeURIComponent(text) === href.slice('https://wa.me/?text='.length),
        share: dedSendPayload({ occasion: 'birthday', recipient: 'Mom', code: 'ABCD2345', sender: dedMySenderName(), songTitle: 'Supernova' }).text };
    });
    r.check('the WhatsApp link decodes cleanly: no "\\uFFFD", no lone surrogate, round-trips exactly',
      !enc.text.includes('�') && !enc.lone && enc.ok && !/\p{Extended_Pictographic}/u.test(enc.text), enc.text);
    r.check('WhatsApp: always "Nova Ash dedicated a song to you." -- never "Someone", never the sender\'s email',
      /^Nova Ash dedicated a song to you\.\nA birthday song for Mom\.\nSupernova\nListen here: https:\/\/laivyhart\.com\/d\/ABCD2345$/.test(enc.text)
        && !/Someone|@/.test(enc.text), enc.text);
    r.check('the share-sheet text says the same', /^Nova Ash dedicated a song to you\./.test(enc.share) && !/Someone|@/.test(enc.share), enc.share);
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}

async function scenarioStripAndLink(browser, port, r) {
  r.section('SHOW-1: only public dedications in the strip; a private one still opens from its link');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { dedicationsPublic: ROWS });
  await page.goto(`http://localhost:${port}/song/${SUPER.slug}`, { waitUntil: 'load' });
  await page.waitForSelector('#dedications-strip:not(.hidden) .dedications-strip-card', { timeout: 10000 });
  const strip = await page.evaluate(() => [...document.querySelectorAll('#dedications-strip .dedications-strip-card')].map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
  r.check('the strip lists the two public ones, not the private one', strip.length === 2 && strip.some((t) => /Mom/.test(t)) && strip.some((t) => /Gran/.test(t)) && !strip.some((t) => /Dad/.test(t)), JSON.stringify(strip));
  r.check('a public dedication posted without the name still reads "from someone"', strip.some((t) => /Gran.*from someone/.test(t)), JSON.stringify(strip));
  const links = await page.evaluate(() => [...document.querySelectorAll('#dedications-strip .dedications-strip-card')].map((c) => ({ t: c.textContent, d: (c.querySelector('a[href^="/d/"]') || {}).getAttribute ? c.querySelector('a[href^="/d/"]').getAttribute('href') : null })));
  r.check('the named card links to its /d/ page; the "from someone" card has no link',
    links.find((x) => /Mom/.test(x.t)).d === '/d/PUBL0001' && links.find((x) => /Gran/.test(x.t)).d === null, JSON.stringify(links));
  // The person it is for, on the /d/ page of that "from someone" dedication, sees the name.
  await page.goto(`http://localhost:${port}/d/ANON0003`, { waitUntil: 'load' });
  await page.waitForFunction(() => /Gran/.test((document.querySelector('.ded-page-headline') || {}).textContent || ''), null, { timeout: 10000 });
  const sender = await page.evaluate(() => (document.querySelector('.ded-page-sender') || {}).textContent || '');
  r.check('its /d/ page names the sender ("With love, Nova Ash"), never "someone"', /Nova Ash/.test(sender) && !/someone/i.test(sender), sender);
  await page.goto(`http://localhost:${port}/d/PRIV0002`, { waitUntil: 'load' });
  await page.waitForFunction(() => /Dad/.test((document.querySelector('.ded-page-headline') || {}).textContent || ''), null, { timeout: 10000 });
  r.check('the private one\'s /d/ link still opens for whoever has it', true);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

const myRow = (o) => ({ created_at: new Date().toISOString(), status: 'live', song_id: SUPER.id, song_title: SUPER.title, song_slug: SUPER.slug,
  recipient_name: 'Mom', occasion: 'birthday', occasion_other: null, message: null, is_anonymous: false, show_publicly: false, ...o });
async function myPage(browser, port, stubs) {
  const page = await newPage(browser);
  const errors = collectErrors(page);
  const calls = [];
  await signInAs(page, F.SESSION_USERS.NOVA);
  await wireSupabaseStubs(page, {
    selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH],
    myDedications: [
      myRow({ code: 'LIVE0001' }),
      myRow({ code: 'LIVE0002', recipient_name: 'Dad', show_publicly: true }),
      myRow({ code: 'LIVE0003', recipient_name: 'Gran', show_publicly: true, is_anonymous: true }),
      myRow({ code: 'GONE0004', recipient_name: 'Aunt', status: 'removed' }),
    ],
    ...stubs,
  }, (name, req) => { if (/^rpc:set_my_dedication_/.test(name)) calls.push(name.replace('rpc:set_my_dedication_', '') + ' ' + JSON.stringify(JSON.parse(req.postData() || '{}'))); });
  page.on('dialog', (dlg) => dlg.dismiss());
  await page.goto(`http://localhost:${port}/settings`, { waitUntil: 'load' });
  await page.waitForFunction(() => { const el = document.getElementById('lv-dedications-list'); return el && el.querySelector('.lv-ded-row'); }, null, { timeout: 10000 });
  const state = () => page.evaluate(() => [...document.querySelectorAll('.lv-ded-row')].map((row) => {
    const pub = row.querySelector('[data-ded-public]'), anon = row.querySelector('[data-ded-anon]');
    return [row.dataset.code, pub ? pub.checked : null, anon && !anon.closest('label').hidden ? anon.checked : 'hidden'];
  }));
  const settle = (sel) => page.waitForFunction((s) => !document.querySelector(s).disabled, sel, { timeout: 5000 }).then(() => page.waitForTimeout(150));
  return { page, errors, calls, state, settle };
}

async function scenarioMyPage(browser, port, r) {
  r.section('NAME-1: My page -- "Shown on site", and "Without my name" only while it is on');
  {
    const { page, errors, calls, state, settle } = await myPage(browser, port, {});
    const s0 = await state();
    r.check('each live dedication: "Shown on site"; "Without my name" only where shown; a removed one has neither',
      JSON.stringify(s0) === JSON.stringify([['LIVE0001', false, 'hidden'], ['LIVE0002', true, false], ['LIVE0003', true, true], ['GONE0004', null, 'hidden']]), JSON.stringify(s0));
    r.check('both are switches, labelled', await page.evaluate(() => {
      const a = document.querySelector('[data-ded-anon="LIVE0002"]'), p = document.querySelector('[data-ded-public="LIVE0002"]');
      return a.getAttribute('role') === 'switch' && p.getAttribute('role') === 'switch' && a.closest('label').textContent.trim() === 'Without my name' && p.closest('label').textContent.trim() === 'Shown on site';
    }));
    await page.click('[data-ded-public="LIVE0001"]'); await settle('[data-ded-public="LIVE0001"]');
    await page.click('[data-ded-anon="LIVE0002"]'); await settle('[data-ded-anon="LIVE0002"]');
    await page.click('[data-ded-public="LIVE0003"]'); await settle('[data-ded-public="LIVE0003"]');
    const s1 = await state();
    r.check('turning "Shown on site" on reveals "Without my name" (off); "Without my name" turns on; turning "Shown on site" off clears and hides it',
      JSON.stringify(s1) === JSON.stringify([['LIVE0001', true, false], ['LIVE0002', true, true], ['LIVE0003', false, 'hidden'], ['GONE0004', null, 'hidden']]), JSON.stringify(s1));
    r.check('the calls: public(LIVE0001, on); anonymous(LIVE0002, on); anonymous(LIVE0003, off) BEFORE public(LIVE0003, off)',
      JSON.stringify(calls) === JSON.stringify([
        'public {"p_code":"LIVE0001","p_show":true}', 'anonymous {"p_code":"LIVE0002","p_anon":true}',
        'anonymous {"p_code":"LIVE0003","p_anon":false}', 'public {"p_code":"LIVE0003","p_show":false}']), JSON.stringify(calls));
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
  r.section('NAME-1: My page -- each switch puts itself back if the server says no');
  {
    const refuse = { status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Turn on "Shown on site" first.', code: 'P0001' }) };
    const { page, errors, state, settle } = await myPage(browser, port, { setMyDedicationAnonResult: refuse });
    await page.click('[data-ded-anon="LIVE0002"]'); await settle('[data-ded-anon="LIVE0002"]');
    r.check('"Without my name" refused: back to off', JSON.stringify((await state())[1]) === JSON.stringify(['LIVE0002', true, false]), JSON.stringify(await state()));
    r.check('no console/page errors', errors.filter((e) => !/400/.test(e)).length === 0, errors.join(' | '));
    await page.close();
  }
  {
    const refuse = { status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'That dedication is not yours, or it was removed.', code: 'P0001' }) };
    const { page, errors, calls, state, settle } = await myPage(browser, port, { setMyDedicationPublicResult: refuse });
    await page.click('[data-ded-public="LIVE0001"]'); await settle('[data-ded-public="LIVE0001"]');
    await page.click('[data-ded-public="LIVE0003"]'); await settle('[data-ded-public="LIVE0003"]');
    const s = await state();
    r.check('"Shown on site" refused: back to off (and nothing revealed)', JSON.stringify(s[0]) === JSON.stringify(['LIVE0001', false, 'hidden']), JSON.stringify(s));
    r.check('turning off refused: back on, and "Without my name" restored too', JSON.stringify(s[2]) === JSON.stringify(['LIVE0003', true, true])
      && calls.slice(-3).join(' / ') === 'anonymous {"p_code":"LIVE0003","p_anon":false} / public {"p_code":"LIVE0003","p_show":false} / anonymous {"p_code":"LIVE0003","p_anon":true}', JSON.stringify({ s, calls }));
    r.check('no console/page errors', errors.filter((e) => !/400/.test(e)).length === 0, errors.join(' | '));
    await page.close();
  }
}

async function scenarioMiddleware(r) {
  r.section('SHOW-1: a private dedication\'s /d/ page renders through dedication_by_code(), noindex, never in the sitemap');
  const scratch = mkdtempSync(join(tmpdir(), 'laivy-mw-show1-'));
  writeFileSync(join(scratch, 'songs.json'), readFileSync(join(ROOT, 'songs.json')));
  writeFileSync(join(scratch, 'artists.json'), readFileSync(join(ROOT, 'artists.json')));
  const src = readFileSync(join(ROOT, 'middleware.js'), 'utf8')
    .replace("import SONGS from './songs.json';", `import SONGS from '${join(scratch, 'songs.json')}' with { type: 'json' };`)
    .replace("import ARTISTS from './artists.json';", `import ARTISTS from '${join(scratch, 'artists.json')}' with { type: 'json' };`);
  const mwPath = join(scratch, 'middleware.mjs');
  writeFileSync(mwPath, src);
  const { decide } = await import(mwPath);
  const shell = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url: String(url), method: opts && opts.method, body: opts && opts.body });
    return { ok: true, json: async () => ([row({ code: 'PRIV0002', recipient_name: 'Dad', show_publicly: false })]) };
  };
  const plan = await decide('/d/PRIV0002', new URLSearchParams(), fetchImpl);
  const html = plan.fn(shell);
  r.check('it renders (the link works whatever the setting)', plan.kind === 'render' && plan.tag === 'dedication', JSON.stringify(plan));
  r.check('through POST rpc/dedication_by_code with the code', seen.length === 1 && seen[0].url.endsWith('/rest/v1/rpc/dedication_by_code')
    && seen[0].method === 'POST' && JSON.parse(seen[0].body).p_code === 'PRIV0002', JSON.stringify(seen));
  r.check('noindex', /<meta name="robots" content="noindex/.test(html));
  r.check('the sitemap has no /d/ links at all', !/\/d\//.test(readFileSync(join(ROOT, 'sitemap.xml'), 'utf8')));
}

function scenarioStatic(r) {
  r.section('SHOW-1: sql/032 filters every public list, names no email column, backfills once');
  const s = readFileSync(join(ROOT, 'sql', '032_dedication_show_publicly.sql'), 'utf8');
  const code = s.replace(/--[^\n]*/g, '');
  r.check('no DELETE and no TRUNCATE', !/\b(delete|truncate)\b/i.test(code));
  r.check('the backfill runs only in the run that adds the column',
    /if not exists \([\s\S]*?column_name = 'show_publicly'[\s\S]*?\) then\s+alter table public\.dedications add column show_publicly boolean not null default false;\s+update public\.dedications d/.test(code));
  const view = (code.match(/create or replace view public\.dedications_public[\s\S]*?;/) || [''])[0];
  r.check('dedications_public: live AND show_publicly', /where d\.status = 'live' and d\.show_publicly;/.test(view), view.slice(-80));
  r.check('public_ticker: dedications only when show_publicly', /where d\.status = 'live' and d\.show_publicly and d\.created_at >= v_since/.test(code));
  r.check('member_profile: the list and the count only when show_publicly',
    (code.match(/is_anonymous = false and status = 'live' and show_publicly/g) || []).length === 2);
  r.check('no email column anywhere in 032', !/recipient_email|email_sent_at|email_status/.test(code));
  r.check('dedication_by_code: anon may call it, nobody may list with it (one code in, one row out)',
    /grant execute on function public\.dedication_by_code\(text\) to anon, authenticated;/.test(code) && /where d\.code = p_code and d\.status = 'live';/.test(code));
  r.check('set_my_dedication_public: signed-in senders, their own live rows only',
    /where code = p_code and sender_user_id = v_uid and status = 'live';/.test(code)
      && /revoke all on function public\.set_my_dedication_public\(text, boolean\) from public, anon;/.test(code)
      && /grant execute on function public\.set_my_dedication_public\(text, boolean\) to authenticated;/.test(code));
  r.section('NAME-1: sql/033 -- three function definitions, the name always to the person');
  const n = readFileSync(join(ROOT, 'sql', '033_dedication_name_privately.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const top = n.replace(/\$fn\$[\s\S]*?\$fn\$/g, '<BODY>').split(';').map((x) => x.trim()).filter(Boolean);
  r.check('only create-or-replace function, revoke and grant at the top level (no table, column or row change)',
    top.length === 9 && top.every((t) => /^(create or replace function|revoke all on function|grant execute on function)/.test(t)), JSON.stringify(top.map((t) => t.slice(0, 50))));
  r.check('no DELETE or TRUNCATE anywhere', !/\b(delete|truncate)\b/i.test(n));
  const byCode = (n.match(/function public\.dedication_by_code[\s\S]*?\$fn\$;/) || [''])[0];
  const claim = (n.match(/function public\.claim_dedication_email[\s\S]*?\$fn\$;/) || [''])[0];
  r.check('dedication_by_code and the email claim always return the sender\'s name (display name, else handle)',
    /coalesce\(nullif\(a\.display_name, ''\), a\.handle::text\)/.test(byCode) && !/is_anonymous/.test(byCode)
      && /'sender_name', coalesce\(nullif\(a\.display_name, ''\), a\.handle::text\)/.test(claim) && !/is_anonymous/.test(claim));
  r.check('set_my_dedication_anonymous refuses ON unless shown on the site; own live rows only; signed-in only',
    /if coalesce\(p_anon, false\) and not v_show then\s+raise exception 'Turn on "Shown on site" first\.';/.test(n)
      && /where code = p_code and sender_user_id = v_uid and status = 'live';/.test(n)
      && /grant execute on function public\.set_my_dedication_anonymous\(text, boolean\) to authenticated;/.test(n));
  r.check('the email claim stays the service role\'s only', /revoke all on function public\.claim_dedication_email\(text, uuid, text\) from public, anon, authenticated;\s+grant execute on function public\.claim_dedication_email\(text, uuid, text\) to service_role;/.test(n));
  r.check('no email column is returned by dedication_by_code', !/recipient_email|email_sent_at|email_status/.test(byCode));
  r.check('the anon allowlist names dedication_by_code with a reason', /^dedication_by_code\s+#\s*\S/m.test(readFileSync(join(ROOT, 'tests', 'sql', 'anon-allowlist.txt'), 'utf8')));
}
