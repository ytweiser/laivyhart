/* ============================================================
   SHOW-1 -- "Also show this on Laivy Hart": a dedication is public only
   when its sender opted in; its /d/<code> link works either way.

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
const HELP = 'Everyone listening to this song can see it. If you leave this off, only the person you send it to will see it.';
const row = (o) => ({
  code: 'PUBL0001', song_id: SUPER.id, song_title: SUPER.title, song_slug: SUPER.slug, cover_url: null,
  recipient_name: 'Mom', occasion: 'birthday', occasion_other: null, message: 'Love you', sender_name: 'Nova Ash',
  sender_handle: 'nova-ash', created_at: new Date().toISOString(), show_publicly: true, ...o,
});
const ROWS = [
  row({}),
  row({ code: 'PRIV0002', recipient_name: 'Dad', show_publicly: false }),
  row({ code: 'ANON0003', recipient_name: 'Gran', sender_name: null, sender_handle: null }),
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
  r.section(`SHOW-1: the new box in the form ${tag}`);
  const { page, errors } = await openSheet(browser, port, { width, theme });
  const d = await page.evaluate(() => {
    const box = document.getElementById('dedicate-public');
    const label = box.closest('label');
    const anonLabel = document.getElementById('dedicate-anonymous').closest('label');
    const help = label.querySelector('.ded-checkbox-help');
    const textSpan = label.querySelector('span');
    const lh = parseFloat(getComputedStyle(textSpan).lineHeight) || 20;
    const labelTextH = textSpan.getBoundingClientRect().height - help.getBoundingClientRect().height;
    return {
      checked: box.checked, after: !!(anonLabel.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING),
      next: anonLabel.nextElementSibling === label,
      labelText: textSpan.firstChild.textContent.trim(), help: help.textContent,
      labelOneLine: labelTextH < lh * 1.6, labelTextH, lh,
      formH: document.querySelector('[data-ded-pane="form"]').getBoundingClientRect().height,
      text: document.getElementById('dedicate-modal').textContent,
      pageW: document.scrollingElement.scrollWidth, vw: innerWidth,
    };
  });
  r.check(`${tag} right under "Keep my name private", unchecked`, d.next && d.after && d.checked === false, JSON.stringify(d));
  r.check(`${tag} "Also show this on Laivy Hart", on one line`, d.labelText === 'Also show this on Laivy Hart' && d.labelOneLine, JSON.stringify(d));
  r.check(`${tag} the one helper line, word for word`, d.help === HELP, d.help);
  r.check(`${tag} the form grew by the box alone (468px before; <= 528px with it)`, d.formH <= 528, d.formH);
  r.check(`${tag} nowhere says "someone you love"`, !/someone you love/i.test(d.text));
  r.check(`${tag} no sideways scrolling`, d.pageW <= d.vw, JSON.stringify(d));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioSavesChoice(browser, port, r) {
  r.section('SHOW-1: the choice reaches create_dedication(); sign-in and every other field unchanged');
  for (const [tick, anon] of [[false, false], [true, false], [true, true]]) {
    const calls = [];
    const { page, errors } = await openSheet(browser, port, { onCall: (name, req) => { if (name === 'rpc:create_dedication') calls.push(JSON.parse(req.postData() || '{}')); } });
    await page.fill('#dedicate-recipient', 'Mom');
    if (tick) await page.check('#dedicate-public');
    if (anon) await page.check('#dedicate-anonymous');
    await page.click('#dedicate-submit');
    await page.waitForSelector('[data-ded-pane="success"]:not([hidden])', { timeout: 10000 });
    const c = calls[0] || {};
    r.check(`${tick ? 'ticked' : 'unticked'}${anon ? ' + private name' : ''}: p_show_publicly ${tick}, p_is_anonymous ${anon}, the rest as before`,
      c.p_show_publicly === tick && c.p_is_anonymous === anon && c.p_recipient_name === 'Mom' && c.p_occasion === 'birthday' && c.p_song_id === SUPER.id, JSON.stringify(c));
    if (anon) {
      const text = await page.evaluate(() => decodeURIComponent(document.getElementById('dedicate-whatsapp').getAttribute('href').slice('https://wa.me/?text='.length)));
      r.check('public + private name: the message still says "Someone"', text.startsWith('Someone dedicated a song to you.') && !/Nova Ash/.test(text), text);
    }
    // The final encoded text: decoded, it carries no U+FFFD and no lone surrogate.
    const enc = await page.evaluate(() => {
      const href = document.getElementById('dedicate-whatsapp').getAttribute('href');
      const text = decodeURIComponent(href.slice('https://wa.me/?text='.length));
      return { href, text, lone: /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text), ok: encodeURIComponent(text) === href.slice('https://wa.me/?text='.length) };
    });
    r.check('the WhatsApp link decodes cleanly: no "\\uFFFD", no lone surrogate, round-trips exactly',
      !enc.text.includes('�') && !enc.lone && enc.ok && !/\p{Extended_Pictographic}/u.test(enc.text), enc.text);
    r.check('new wording: "<sender> dedicated a song to you." / the occasion line / the title / "Listen here: <link>"',
      /^(Nova Ash|Someone) dedicated a song to you\.\nA birthday song for Mom\.\nSupernova\nListen here: https:\/\/laivyhart\.com\/d\/ABCD2345$/.test(enc.text), enc.text);
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
  r.check('a public dedication with a private name still reads "from someone"', strip.some((t) => /Gran.*from someone/.test(t)), JSON.stringify(strip));
  await page.goto(`http://localhost:${port}/d/PRIV0002`, { waitUntil: 'load' });
  await page.waitForFunction(() => /Dad/.test((document.querySelector('.ded-page-headline') || {}).textContent || ''), null, { timeout: 10000 });
  r.check('the private one\'s /d/ link still opens for whoever has it', true);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioMyPage(browser, port, r) {
  for (const fail of [false, true]) {
    r.section(`SHOW-1: "Shown on site" on My page${fail ? ' (the server says no)' : ''}`);
    const page = await newPage(browser);
    const errors = collectErrors(page);
    const calls = [];
    await signInAs(page, F.SESSION_USERS.NOVA);
    await wireSupabaseStubs(page, {
      selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH],
      myDedications: [
        { code: 'LIVE0001', created_at: new Date().toISOString(), status: 'live', song_id: SUPER.id, song_title: SUPER.title, song_slug: SUPER.slug, recipient_name: 'Mom', occasion: 'birthday', occasion_other: null, message: null, is_anonymous: false, show_publicly: false },
        { code: 'LIVE0002', created_at: new Date().toISOString(), status: 'live', song_id: SUPER.id, song_title: SUPER.title, song_slug: SUPER.slug, recipient_name: 'Dad', occasion: 'birthday', occasion_other: null, message: null, is_anonymous: false, show_publicly: true },
        { code: 'GONE0003', created_at: new Date().toISOString(), status: 'removed', song_id: SUPER.id, song_title: SUPER.title, song_slug: SUPER.slug, recipient_name: 'Gran', occasion: 'birthday', occasion_other: null, message: null, is_anonymous: false, show_publicly: false },
      ],
      ...(fail ? { setMyDedicationPublicResult: { status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'That dedication is not yours, or it was removed.', code: 'P0001' }) } } : {}),
    }, (name, req) => { if (name === 'rpc:set_my_dedication_public') calls.push(JSON.parse(req.postData() || '{}')); });
    page.on('dialog', (dlg) => dlg.dismiss());
    await page.goto(`http://localhost:${port}/settings`, { waitUntil: 'load' });
    await page.waitForFunction(() => { const el = document.getElementById('lv-dedications-list'); return el && el.querySelector('.lv-ded-row'); }, null, { timeout: 10000 });
    const d = await page.evaluate(() => [...document.querySelectorAll('.lv-ded-row')].map((row) => {
      const box = row.querySelector('[data-ded-public]');
      return { code: row.dataset.code, has: !!box, on: box ? box.checked : null, role: box && box.getAttribute('role'), label: box ? box.closest('label').textContent.trim() : null };
    }));
    r.check('each live dedication has a "Shown on site" switch showing its current setting; a removed one has none',
      JSON.stringify(d.map((x) => [x.code, x.has, x.on])) === JSON.stringify([['LIVE0001', true, false], ['LIVE0002', true, true], ['GONE0003', false, null]])
        && d[0].role === 'switch' && d[0].label === 'Shown on site', JSON.stringify(d));
    await page.click('[data-ded-public="LIVE0001"]');
    await page.waitForFunction((n) => !document.querySelector('[data-ded-public="LIVE0001"]').disabled, null, { timeout: 5000 });
    await page.waitForTimeout(200);
    const on = await page.evaluate(() => document.querySelector('[data-ded-public="LIVE0001"]').checked);
    r.check('turning it on calls set_my_dedication_public(code, true)', JSON.stringify(calls) === JSON.stringify([{ p_code: 'LIVE0001', p_show: true }]), JSON.stringify(calls));
    r.check(fail ? 'refused: the switch goes back to off' : 'and it stays on', on === !fail, on);
    r.check('no console/page errors', errors.filter((e) => !fail || !/400/.test(e)).length === 0, errors.join(' | '));
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
  r.check('the anon allowlist names dedication_by_code with a reason', /^dedication_by_code\s+#\s*\S/m.test(readFileSync(join(ROOT, 'tests', 'sql', 'anon-allowlist.txt'), 'utf8')));
}
