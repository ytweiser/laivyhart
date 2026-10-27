/* ============================================================
   SEND-1 -- sending a dedication to the person it is for.

   Browser (the real index.html, Supabase and the Worker stubbed): the form
   is unchanged and no taller on a phone; saving shows "Dedication saved"
   with "Send on WhatsApp" as a real wa.me link whose text is right (sender
   or "Someone", the occasion line, the title, the message, the link, never
   an email); "Send by email" reveals the field, validates it, calls the
   Worker once and shows the outcome (sent, masked; suppressed; a limit);
   Copy link and "More options"; the four GA4 events; Done.

   Worker (Node, worker/src/index.js loaded directly, every network call
   stubbed -- no real email is ever sent): JWT required; the claim RPC's
   answers map to what the sender sees; ONE Resend call with the right
   from/reply-to/subject/body and no tracking; finish recorded; the
   unsubscribe page (GET confirms, POST writes, bad signature refused).

   Preview: /d/<code>'s tags carry only the song's cover and the
   dedication line, never the logo.

   Privacy (static, over the committed files): no public read path -- the
   dedications_public view, the middleware's and the page's selects,
   songs.json -- can return recipient_email, email_sent_at or email_status;
   the new functions and table are service-role only. The live database
   was checked the same way when sql/031 was applied (see its report).
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import { loadWorker } from '../lib/load-worker.mjs';
import * as F from '../fixtures.mjs';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODE = 'ABCD2345';
const LINK = 'https://laivyhart.com/d/' + CODE;
const SUPER = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);
const EMAIL_COLS = ['recipient_email', 'email_sent_at', 'email_status'];

export async function run(browser, port) {
  const r = makeReporter('dedication-send.spec.mjs');
  await scenarioFormUnchanged(browser, port, r);
  for (const width of [1280, 380]) for (const theme of ['dark', 'light']) await scenarioSuccess(browser, port, r, width, theme);
  await scenarioPrivateSender(browser, port, r);
  await scenarioEmail(browser, port, r);
  await scenarioGa(browser, port, r);
  await scenarioWorker(r);
  await scenarioPreview(r);
  scenarioPrivacy(r);
  return r;
}

async function open(browser, port, { width = 1280, theme = 'dark', share = false, track = false, worker } = {}) {
  const page = await newPage(browser, { width, height: 900 });
  const errors = collectErrors(page);
  await page.addInitScript(({ theme, share, track }) => {
    try {
      localStorage.setItem('laivy-theme', theme);
      localStorage.setItem('laivy-ded-hint-v1', '1');
      if (track) localStorage.removeItem('laivy-no-track');
    } catch (e) {}
    window.__shared = [];
    Object.defineProperty(navigator, 'share', { configurable: true,
      value: share ? (d) => { window.__shared.push(d); return Promise.resolve(); } : undefined });
  }, { theme, share, track });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${port}` });
  const calls = [];
  await page.route('**/dedication/email', async (route) => {
    const req = route.request();
    calls.push({ body: req.postDataJSON(), auth: req.headers().authorization || '' });
    const res = typeof worker === 'function' ? worker(req.postDataJSON()) : { status: 200, body: { status: 'sent', masked: 'n***@gmail.com' } };
    await route.fulfill({ status: res.status, contentType: 'application/json', body: JSON.stringify(res.body) });
  });
  await page.route('**/event', (route) => route.fulfill({ status: 204, body: '' }));
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH], createDedicationResult: CODE });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await page.goto(`http://localhost:${port}/song/${SUPER.slug}`, { waitUntil: 'load' });
  await page.waitForSelector('#now-dedicate-btn', { state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => !!(window.laivy && window.laivy.auth && window.laivy.auth.user), null, { timeout: 10000 });
  return { page, errors, calls };
}
async function openSheet(page) {
  await page.click('#now-dedicate-btn');
  await page.waitForSelector('#dedicate-modal:not([hidden])', { timeout: 10000 });
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'dedicate-recipient', null, { timeout: 5000 });
}
async function save(page, { recipient = 'Sarah', occasion = 'birthday', message = 'Love you always', anonymous = false } = {}) {
  await openSheet(page);
  await page.fill('#dedicate-recipient', recipient);
  await page.selectOption('#dedicate-occasion', occasion);
  if (message) await page.fill('#dedicate-message', message);
  if (anonymous) await page.check('#dedicate-anonymous');
  await page.click('#dedicate-submit');
  await page.waitForSelector('[data-ded-pane="success"]:not([hidden])', { timeout: 10000 });
}
const waText = (page) => page.evaluate(() => {
  const h = document.getElementById('dedicate-whatsapp').getAttribute('href');
  return decodeURIComponent(h.slice('https://wa.me/?text='.length));
});

async function scenarioFormUnchanged(browser, port, r) {
  r.section('SEND-1: the form is unchanged, and no taller on a 380px phone');
  const { page, errors } = await open(browser, port, { width: 380 });
  await openSheet(page);
  await page.evaluate(() => document.fonts.ready);   // measured with the real fonts in
  const d = await page.evaluate(() => {
    const form = document.querySelector('[data-ded-pane="form"]');
    return {
      fields: [...form.querySelectorAll('input, select, textarea, button')].map((el) => el.id).filter(Boolean),
      labels: [...form.querySelectorAll('label.lv-label')].map((l) => l.textContent.trim()),
      submit: document.getElementById('dedicate-submit').textContent.trim(),
      emailInForm: !!form.querySelector('input[type="email"], #dedicate-email'),
      sheetH: Math.round(document.querySelector('.ded-sheet').getBoundingClientRect().height),
      formH: Math.round(form.getBoundingClientRect().height),
      parts: [...form.children].map((c) => (c.id || c.className || c.tagName) + ':' + Math.round(c.getBoundingClientRect().height)).join(' '),
      text: document.getElementById('dedicate-modal').textContent,
    };
  });
  r.check('the same fields, in order (SHOW-1 adds "Also show this on Laivy Hart" after "Keep my name private")', JSON.stringify(d.fields) === JSON.stringify(['dedicate-recipient', 'dedicate-occasion', 'dedicate-occasion-other', 'dedicate-message', 'dedicate-anonymous', 'dedicate-public', 'dedicate-submit']), JSON.stringify(d.fields));
  r.check('labels: Who is it for?, Occasion, Message', JSON.stringify(d.labels) === JSON.stringify(['Who is it for?', 'Occasion', 'Message (optional)']), JSON.stringify(d.labels));
  r.check('the button still says "Dedicate this song"', d.submit === 'Dedicate this song', d.submit);
  r.check('no email field in the form', !d.emailInForm);
  // Measured at 380px: 468px form pane / 511.6px sheet before SHOW-1; its
  // one checkbox (label + helper) adds 59.3px. Guards against more growth.
  r.check(`the form pane is no taller than with the SHOW-1 box (${d.formH}px <= 528)`, d.formH <= 528, d.formH + ' ' + d.parts);
  r.check(`the sheet is no taller than with the SHOW-1 box (${d.sheetH}px <= 571)`, d.sheetH <= 571, d.sheetH);
  r.check('nowhere says "someone you love"', !/someone you love/i.test(d.text));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioSuccess(browser, port, r, width, theme) {
  const tag = `[${width}px ${theme}]`;
  r.section(`SEND-1: the success state ${tag}`);
  const { page, errors } = await open(browser, port, { width, theme, share: true });
  await save(page);
  const d = await page.evaluate(() => {
    const b = (id) => document.getElementById(id).getBoundingClientRect();
    const wa = document.getElementById('dedicate-whatsapp');
    const cs = getComputedStyle(wa);
    const L = (c) => { const [r, g, bl] = c.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl); };
    const stops = cs.backgroundImage.match(/rgba?\([^)]+\)/g) || [];
    const more = ['dedicate-email-toggle', 'dedicate-copy', 'dedicate-native-share'].map(b);
    return {
      title: document.getElementById('dedicate-success-title').textContent,
      sub: document.getElementById('dedicate-success-sub').textContent,
      waTag: wa.tagName, waTarget: wa.target, waRel: wa.rel, waText: wa.textContent.trim(), waH: b('dedicate-whatsapp').height,
      waIcon: !!wa.querySelector('svg[aria-hidden="true"]'),
      contrast: Math.min(...stops.map((s) => (L(cs.color) + 0.05) / (L(s) + 0.05))),
      labels: ['dedicate-email-toggle', 'dedicate-copy', 'dedicate-native-share'].map((id) => document.getElementById(id).textContent.trim()),
      heights: more.map((x) => x.height), tops: more.map((x) => Math.round(x.top)),
      doneText: document.getElementById('dedicate-done').textContent.trim(),
      sheetBottom: b('dedicate-done').bottom, vh: innerHeight,
      pageW: document.scrollingElement.scrollWidth, vw: innerWidth,
    };
  });
  r.check(`${tag} "Dedication saved", then "Now send it to Sarah."`, d.title === 'Dedication saved' && d.sub === 'Now send it to Sarah.', JSON.stringify(d));
  r.check(`${tag} "Send on WhatsApp" is a real link opening a new tab, with its icon, 48px+`,
    d.waTag === 'A' && d.waTarget === '_blank' && /noopener/.test(d.waRel) && d.waText === 'Send on WhatsApp' && d.waIcon && d.waH >= 48, JSON.stringify(d));
  r.check(`${tag} white on the WhatsApp button clears 4.5:1 (${d.contrast.toFixed(2)})`, d.contrast >= 4.5, d.contrast);
  r.check(`${tag} then "Send by email", "Copy link", "More options", each 44px+`,
    JSON.stringify(d.labels) === JSON.stringify(['Send by email', 'Copy link', 'More options']) && d.heights.every((h) => h >= 44), JSON.stringify(d));
  if (width >= 1280) r.check(`${tag} in one neat row on a wide screen`, new Set(d.tops).size === 1, JSON.stringify(d.tops));
  else r.check(`${tag} stacked on a phone`, d.tops[0] < d.tops[1] && d.tops[1] < d.tops[2], JSON.stringify(d.tops));
  r.check(`${tag} a "Done" link`, d.doneText === 'Done', d.doneText);
  r.check(`${tag} no sideways scrolling`, d.pageW <= d.vw, JSON.stringify(d));

  const text = await waText(page);
  const want = ['Nova Ash dedicated a song to you.', 'A birthday song for Sarah.', 'Supernova', '“Love you always”', 'Listen here: ' + LINK];
  r.check(`${tag} the WhatsApp text: sender, occasion line, title, message, link`, JSON.stringify(text.split('\n')) === JSON.stringify(want), JSON.stringify(text.split('\n')));
  r.check(`${tag} never the sender's email`, !text.includes('nova@example.test') && !text.includes('@'));

  // Copy link: the link, "Copied" for 2 seconds.
  await page.evaluate(() => navigator.clipboard.writeText('__empty__'));
  await page.click('#dedicate-copy');
  await page.waitForFunction(async (u) => { try { return (await navigator.clipboard.readText()) === u; } catch (e) { return false; } }, LINK, { timeout: 5000 });
  r.check(`${tag} Copy link copies the dedication link and says "Copied"`, await page.evaluate(() => document.getElementById('dedicate-copy-text').textContent) === 'Copied');
  await page.waitForFunction(() => document.getElementById('dedicate-copy-text').textContent === 'Copy link', null, { timeout: 3500 });
  r.check(`${tag} ...then back to "Copy link" after ~2s`, true);

  // More options: the system sheet with the same text and the link once.
  await page.click('#dedicate-native-share');
  await page.waitForFunction(() => window.__shared.length > 0, null, { timeout: 5000 });
  const sh = await page.evaluate(() => window.__shared[0]);
  r.check(`${tag} More options opens the share sheet with the same text and the link`,
    sh.url === LINK && sh.text === want.slice(0, 4).join('\n') + '\nListen here:', JSON.stringify(sh));

  await page.click('#dedicate-done');
  r.check(`${tag} Done closes the sheet`, await page.evaluate(() => document.getElementById('dedicate-modal').hidden));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioPrivateSender(browser, port, r) {
  r.section('SEND-1: kept private shows as "Someone"; In memory keeps its wording; no share sheet where there is none');
  const { page, errors } = await open(browser, port, { share: false });
  await save(page, { recipient: 'Grandpa', occasion: 'in_memory', message: '', anonymous: true });
  const text = await waText(page);
  r.check('"Someone dedicated a song to you." then "A song in memory of Grandpa."',
    JSON.stringify(text.split('\n')) === JSON.stringify(['Someone dedicated a song to you.', 'A song in memory of Grandpa.', 'Supernova', 'Listen here: ' + LINK]), JSON.stringify(text.split('\n')));
  r.check('no sender name anywhere', !/Nova Ash/.test(text));
  r.check('"More options" is hidden without navigator.share', await page.evaluate(() => document.getElementById('dedicate-native-share').hidden));
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioEmail(browser, port, r) {
  for (const width of [1280, 380]) {
    r.section(`SEND-1: Send by email (${width}px)`);
    const { page, errors, calls } = await open(browser, port, { width });
    await save(page);
    r.check('the email field starts hidden', await page.evaluate(() => document.getElementById('dedicate-email-form').hidden));
    await page.click('#dedicate-email-toggle');
    const f = await page.evaluate(() => ({
      shown: !document.getElementById('dedicate-email-form').hidden,
      label: document.querySelector('label[for="dedicate-email"]').textContent,
      ph: document.getElementById('dedicate-email').placeholder,
      expanded: document.getElementById('dedicate-email-toggle').getAttribute('aria-expanded'),
      inSheet: document.querySelector('.ded-sheet').contains(document.getElementById('dedicate-email')),
    }));
    r.check('tapping it reveals "Their email" (name@email.com) inside the same sheet', f.shown && f.label === 'Their email' && f.ph === 'name@email.com' && f.expanded === 'true' && f.inSheet, JSON.stringify(f));
    await page.fill('#dedicate-email', 'not-an-email');
    await page.click('#dedicate-email-send');
    const bad = await page.evaluate(() => ({ hidden: document.getElementById('dedicate-email-err').hidden, text: document.getElementById('dedicate-email-err').textContent }));
    r.check('a bad address: an inline error, and no call', !bad.hidden && /doesn.t look like an email/.test(bad.text) && calls.length === 0, JSON.stringify({ bad, calls }));
    await page.fill('#dedicate-email', '  Nina@Gmail.com ');
    await page.click('#dedicate-email-send');
    await page.waitForFunction(() => !document.getElementById('dedicate-email-ok').hidden, null, { timeout: 5000 });
    const ok = await page.evaluate(() => ({ text: document.getElementById('dedicate-email-ok').textContent, sendOff: document.getElementById('dedicate-email-send').disabled }));
    r.check('one call to the Worker, signed in, with the code and the address (trimmed, lowercased)',
      calls.length === 1 && calls[0].body.code === CODE && calls[0].body.email === 'nina@gmail.com' && /^Bearer \S+/.test(calls[0].auth), JSON.stringify(calls));
    r.check('"Sent to n***@gmail.com", and Send turns off (one email per dedication)', ok.text === 'Sent to n***@gmail.com' && ok.sendOff, JSON.stringify(ok));
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }

  for (const [kind, res, want] of [
    ['suppressed', { status: 200, body: { status: 'suppressed', message: 'We couldn\'t email them, but you can send them the link instead.' } }, /^We couldn't email them, but you can send them the link instead\.$/],
    ['a daily limit', { status: 429, body: { status: 'rate_limited', limit: 'sender_daily', message: 'You\'ve sent 5 dedication emails today, the most we send in a day. Your dedication is saved: send it on WhatsApp or copy the link instead.' } }, /saved: send it on WhatsApp or copy the link instead/],
    ['a failed send', { status: 502, body: { status: 'failed', message: 'We couldn\'t send that email just now. Your dedication is saved: send it on WhatsApp or copy the link instead.' } }, /couldn't send that email just now/],
  ]) {
    r.section(`SEND-1: a blocked email (${kind}) keeps the dedication and points to WhatsApp and Copy link`);
    const { page, errors, calls } = await open(browser, port, { worker: () => res });
    await save(page);
    await page.click('#dedicate-email-toggle');
    await page.fill('#dedicate-email', 'nina@gmail.com');
    await page.click('#dedicate-email-send');
    await page.waitForFunction(() => !document.getElementById('dedicate-email-err').hidden, null, { timeout: 5000 });
    const d = await page.evaluate(() => ({ err: document.getElementById('dedicate-email-err').textContent,
      wa: document.getElementById('dedicate-whatsapp').getAttribute('href'), ok: document.getElementById('dedicate-email-ok').hidden }));
    r.check(`${kind}: the sender is told plainly`, want.test(d.err) && d.ok, d.err);
    r.check(`${kind}: WhatsApp and Copy link are still right there`, d.wa.startsWith('https://wa.me/?text=') && calls.length === 1, d.wa);
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}

async function scenarioGa(browser, port, r) {
  r.section('SEND-1: GA4 events for each tap');
  const { page, errors } = await open(browser, port, { share: true, track: true });
  await page.evaluate(() => { window.open = () => null; });
  await save(page);
  await page.evaluate(() => {
    // The real link would leave the page; keep the tap, stop the navigation.
    document.getElementById('dedicate-whatsapp').addEventListener('click', (e) => e.preventDefault());
  });
  await page.click('#dedicate-whatsapp');
  await page.click('#dedicate-copy');
  await page.click('#dedicate-native-share');
  await page.click('#dedicate-email-toggle');
  await page.fill('#dedicate-email', 'nina@gmail.com');
  await page.click('#dedicate-email-send');
  // The page's own gtag() pushes onto dataLayer (the GA script itself is
  // blocked in this harness), so the events are read back from there.
  const gaEvents = () => page.evaluate(() => (window.dataLayer || []).filter((a) => a && a[0] === 'event').map((a) => a[1]));
  await page.waitForFunction(() => (window.dataLayer || []).some((a) => a && a[0] === 'event' && a[1] === 'dedication_email_send'), null, { timeout: 5000 });
  const ga = await gaEvents();
  for (const ev of ['dedication_whatsapp_tap', 'dedication_copy_link', 'dedication_share_sheet', 'dedication_email_send']) {
    r.check(`fires ${ev}`, ga.includes(ev), JSON.stringify(ga));
  }
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------------- the Worker, in Node ---------------- */
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function makeSignedJwt(sub) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'test-kid-send1', alg: 'ES256', use: 'sig' };
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64url(Buffer.from(JSON.stringify({ alg: 'ES256', kid: jwk.kid, typ: 'JWT' })))}.${b64url(Buffer.from(JSON.stringify({ sub, exp: now + 3600, iat: now })))}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(input));
  return { token: `${input}.${b64url(new Uint8Array(sig))}`, jwks: { keys: [jwk] } };
}
const SENDER = 'a0000000-0000-4000-8000-0000000000aa';
const ENV = { SUPABASE_SERVICE_ROLE_KEY: 'svc-test-key', RESEND_API_KEY: 're_test_key' };
const CLAIM_OK = {
  status: 'ok', code: CODE, recipient_name: 'Sarah', occasion: 'birthday', occasion_other: null, message: 'Love you always',
  sender_name: 'Nova Ash', song_id: SUPER.id, song_title: 'Supernova', cover_url: 'https://example.com/cover.png', cover_focus_x: 50, cover_focus_y: 50,
};
function fakeFetch(claim, { resendOk = true } = {}) {
  const calls = { claim: [], finish: [], resend: [], suppress: [] };
  const impl = async (url, opts) => {
    const u = String(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (u.endsWith('/rpc/claim_dedication_email')) { calls.claim.push({ body, headers: opts.headers }); return { ok: true, text: async () => JSON.stringify(claim) }; }
    if (u.endsWith('/rpc/finish_dedication_email')) { calls.finish.push(body); return { ok: true, text: async () => '' }; }
    if (u.endsWith('/rpc/suppress_dedication_email')) { calls.suppress.push(body); return { ok: true, text: async () => '' }; }
    if (u === 'https://api.resend.com/emails') {
      calls.resend.push({ body, headers: opts.headers });
      return resendOk ? { ok: true, text: async () => '{"id":"stub"}' } : { ok: false, status: 500, text: async () => 'boom' };
    }
    throw new Error('unexpected fetch ' + u);
  };
  return { impl, calls };
}
const req = (token, body) => new Request('https://worker.test/dedication/email', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body),
});

async function scenarioWorker(r) {
  r.section('SEND-1: the Worker route (Node, every network call stubbed, no real email)');
  const W = await loadWorker();
  const { token, jwks } = await makeSignedJwt(SENDER);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).includes('/.well-known/jwks.json')
    ? { ok: true, json: async () => jwks } : realFetch(url, opts));
  W.__resetJwksCacheForTests();
  try {
    // No token.
    let f = fakeFetch(CLAIM_OK);
    let res = await W.handleDedicationEmail(req(null, { code: CODE, email: 'nina@gmail.com' }), ENV, {}, f.impl);
    r.check('no sign-in: 401, nothing claimed or sent', res.status === 401 && f.calls.claim.length === 0 && f.calls.resend.length === 0, res.status);

    // Server-side format check.
    f = fakeFetch(CLAIM_OK);
    res = await W.handleDedicationEmail(req(token, { code: CODE, email: 'nina@' }), ENV, {}, f.impl);
    r.check('a bad address is refused on the server too (400), before any claim', res.status === 400 && (await res.json()).status === 'invalid' && f.calls.claim.length === 0);

    // The happy path.
    f = fakeFetch(CLAIM_OK);
    res = await W.handleDedicationEmail(req(token, { code: CODE, email: ' Nina@Gmail.com ' }), ENV, {}, f.impl);
    const out = await res.json();
    r.check('sent: 200 with the masked address', res.status === 200 && out.status === 'sent' && out.masked === 'n***@gmail.com', JSON.stringify(out));
    r.check('the claim carries the verified sender, the code and the lowercased address, with the service role',
      f.calls.claim.length === 1 && f.calls.claim[0].body.p_sender === SENDER && f.calls.claim[0].body.p_code === CODE
        && f.calls.claim[0].body.p_email === 'nina@gmail.com' && f.calls.claim[0].headers.Authorization === 'Bearer svc-test-key', JSON.stringify(f.calls.claim));
    r.check('exactly ONE Resend call', f.calls.resend.length === 1);
    const m = f.calls.resend[0].body;
    r.check('from and reply-to hello@laivyhart.com, to the one address, the subject',
      m.from === 'Laivy Hart <hello@laivyhart.com>' && m.reply_to === 'hello@laivyhart.com' && JSON.stringify(m.to) === '["nina@gmail.com"]'
        && m.subject === 'A song was dedicated to you', JSON.stringify({ from: m.from, reply_to: m.reply_to, to: m.to, subject: m.subject }));
    const footer = 'Laivy Hart sent this one email for the person who dedicated the song. We won\'t email you again unless someone else dedicates a song to you.';
    for (const [what, re] of [
      ['the recipient name', /Hi Sarah,/], ['the sender', /Nova Ash<\/strong> dedicated a song to you/], ['the occasion', /A birthday song for Sarah\./],
      ['the message', /Love you always/], ['the song title', /Supernova/], ['the cover art', /<img src="https:\/\/wsrv\.nl\/\?url=https%3A%2F%2Fexample\.com%2Fcover\.png/],
      ['"Listen to your song" to the dedication page', new RegExp(`<a href="${LINK}"[^>]*>Listen to your song</a>`)],
      ['the footer, word for word', new RegExp(footer.replace(/[.']/g, (c) => (c === "'" ? '(?:\'|&#39;)' : '\\.')))],
      ['an unsubscribe link', /href="https:\/\/laivyhart-audio-upload\.ytweiser-399\.workers\.dev\/unsubscribe\?e=[^"]+&amp;s=[^"]+"[^>]*>Unsubscribe</],
      ['hello@laivyhart.com', /mailto:hello@laivyhart\.com/],
    ]) r.check(`the email has ${what}`, re.test(m.html), what);
    r.check('the plain-text part says the same', /Hi Sarah,/.test(m.text) && /Nova Ash dedicated a song to you\. A birthday song for Sarah\./.test(m.text)
      && m.text.includes('Listen to your song: ' + LINK) && m.text.includes(footer), m.text);
    const imgs = (m.html.match(/<img\b/g) || []).length;
    r.check('no open or click tracking: one image (the cover), plain links only', imgs === 1 && !/utm_|track|pixel|open\.gif/i.test(m.html), imgs);
    r.check('the sender\'s own email is nowhere in it', !/nova@example\.test/.test(m.html + m.text));
    r.check('the outcome is recorded: finish(sent)', JSON.stringify(f.calls.finish) === JSON.stringify([{ p_code: CODE, p_status: 'sent' }]), JSON.stringify(f.calls.finish));

    // Private sender.
    f = fakeFetch({ ...CLAIM_OK, sender_name: null });
    await W.handleDedicationEmail(req(token, { code: CODE, email: 'nina@gmail.com' }), ENV, {}, f.impl);
    r.check('kept private: "Someone dedicated a song to you", no name', /Someone<\/strong> dedicated a song to you/.test(f.calls.resend[0].body.html) && !/Nova Ash/.test(f.calls.resend[0].body.html));

    // Resend fails: the dedication stays, the sender is told, finish(failed).
    f = fakeFetch(CLAIM_OK, { resendOk: false });
    res = await W.handleDedicationEmail(req(token, { code: CODE, email: 'nina@gmail.com' }), ENV, {}, f.impl);
    const fo = await res.json();
    r.check('a failed send: 502, a plain message offering WhatsApp and Copy link, finish(failed)',
      res.status === 502 && fo.status === 'failed' && /WhatsApp or copy the link/.test(fo.message)
        && JSON.stringify(f.calls.finish) === JSON.stringify([{ p_code: CODE, p_status: 'failed' }]), JSON.stringify(fo));

    // Every blocked answer from the database: nothing sent.
    for (const [claim, status, check] of [
      [{ status: 'suppressed' }, 200, (o) => o.message === 'We couldn\'t email them, but you can send them the link instead.'],
      [{ status: 'rate_limited', limit: 'sender_daily' }, 429, (o) => /5 dedication emails today/.test(o.message) && /WhatsApp or copy the link/.test(o.message)],
      [{ status: 'rate_limited', limit: 'same_address_week' }, 429, (o) => /this week/.test(o.message) && /WhatsApp or copy the link/.test(o.message)],
      [{ status: 'rate_limited', limit: 'address_week' }, 429, (o) => /this week/.test(o.message) && /WhatsApp or copy the link/.test(o.message)],
      [{ status: 'already_sent' }, 409, (o) => /already been emailed/.test(o.message)],
      [{ status: 'not_owner' }, 403, () => true],
      [{ status: 'not_found' }, 404, () => true],
    ]) {
      f = fakeFetch(claim);
      res = await W.handleDedicationEmail(req(token, { code: CODE, email: 'nina@gmail.com' }), ENV, {}, f.impl);
      const o = await res.json();
      r.check(`${claim.status}${claim.limit ? ' (' + claim.limit + ')' : ''}: ${status}, told plainly, no email, no finish`,
        res.status === status && check(o) && f.calls.resend.length === 0 && f.calls.finish.length === 0, JSON.stringify(o));
    }

    // The occasion line agrees with index.html's phrase table for every occasion.
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const occasions = [...html.matchAll(/^\s{2}(\w+):\s+\{ group:/gm)].map((x) => x[1]);
    const table = html.slice(html.indexOf('const DED_OCCASION = {'), html.indexOf('function dedHeadline('));
    // eslint-disable-next-line no-new-func
    const DED = new Function(table.replace('const DED_OCCASION =', 'return') )();
    const mismatched = occasions.filter((o) => W.dedicationLine(o, 'Sarah', 'finishing Shas.') !== DED[o].line('Sarah', 'finishing Shas.'));
    r.check(`the email's occasion wording matches the form's for all ${occasions.length} occasions`, occasions.length >= 20 && mismatched.length === 0, mismatched);

    // Unsubscribe: GET confirms (no write), POST writes, a bad signature is refused.
    const url = await W.unsubscribeUrl('nina@gmail.com', ENV);
    f = fakeFetch(CLAIM_OK);
    let page = await W.handleUnsubscribe(new Request(url, { method: 'GET' }), ENV, {}, f.impl);
    let body = await page.text();
    r.check('the unsubscribe link opens a page with one confirming button, and writes nothing yet',
      page.status === 200 && /Yes, stop these emails/.test(body) && /<form method="post">/.test(body) && f.calls.suppress.length === 0 && /n\*\*\*@gmail\.com/.test(body), body.slice(0, 200));
    page = await W.handleUnsubscribe(new Request(url, { method: 'POST' }), ENV, {}, f.impl);
    body = await page.text();
    r.check('the tap adds the address to email_suppressions and says it is done',
      /Done/.test(body) && JSON.stringify(f.calls.suppress) === JSON.stringify([{ p_email: 'nina@gmail.com' }]), JSON.stringify(f.calls.suppress));
    f = fakeFetch(CLAIM_OK);
    page = await W.handleUnsubscribe(new Request(url.replace(/s=[^&]+/, 's=forged'), { method: 'POST' }), ENV, {}, f.impl);
    r.check('a forged link is refused and writes nothing', /does not work/.test(await page.text()) && f.calls.suppress.length === 0);
    r.check('the masked address: first letter and the domain', W.maskEmail('Nina@Gmail.com') === 'n***@gmail.com');
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ---------------- the /d/ link preview ---------------- */
async function scenarioPreview(r) {
  r.section('SEND-1: the /d/<code> link preview: the song cover only, and the dedication line');
  const scratch = mkdtempSync(join(tmpdir(), 'laivy-mw-send1-'));
  writeFileSync(join(scratch, 'songs.json'), readFileSync(join(ROOT, 'songs.json')));
  writeFileSync(join(scratch, 'artists.json'), readFileSync(join(ROOT, 'artists.json')));
  const src = readFileSync(join(ROOT, 'middleware.js'), 'utf8')
    .replace("import SONGS from './songs.json';", `import SONGS from '${join(scratch, 'songs.json')}' with { type: 'json' };`)
    .replace("import ARTISTS from './artists.json';", `import ARTISTS from '${join(scratch, 'artists.json')}' with { type: 'json' };`);
  const mwPath = join(scratch, 'middleware.mjs');
  writeFileSync(mwPath, src);
  const { decide } = await import(mwPath);
  const shell = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const fetchImpl = async () => ({ ok: true, json: async () => ([{
    code: CODE, song_id: 'not-in-the-snapshot', song_title: 'Supernova', song_slug: 'supernova-a000',
    cover_url: 'https://example.com/cover.png', recipient_name: 'Sarah', occasion: 'birthday', occasion_other: null,
    message: 'Love you always', sender_name: 'Nova Ash', created_at: new Date().toISOString(),
  }]) });
  const plan = await decide('/d/' + CODE, new URLSearchParams(), fetchImpl);
  const html = plan.fn(shell);
  const images = [...html.matchAll(/<meta (?:property|name)="(?:og|twitter):image" content="([^"]*)">/g)].map((x) => x[1]);
  r.check('one og:image and one twitter:image, both the song cover (never the logo)',
    images.length === 2 && images.every((u) => u.includes('wsrv.nl') && u.includes(encodeURIComponent('https://example.com/cover.png')))
      && !/<meta [^>]*og-image\.png/.test(html), JSON.stringify(images));
  const title = (html.match(/<meta property="og:title" content="([^"]*)">/) || [])[1];
  const desc = (html.match(/<meta property="og:description" content="([^"]*)">/) || [])[1];
  r.check('og:title is a short dedication line ("Happy birthday, Sarah")', title === 'Happy birthday, Sarah', title);
  r.check('og:description starts with the dedication line', /^A birthday song for Sarah/.test(desc || ''), desc);
}

/* ---------------- privacy, over the committed files ---------------- */
function scenarioPrivacy(r) {
  r.section('SEND-1: no public read can return the email columns');
  const sqlDir = join(ROOT, 'sql');
  const files = readdirSync(sqlDir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  // The latest definition of dedications_public across every migration.
  let view = '';
  for (const f of files) {
    const t = readFileSync(join(sqlDir, f), 'utf8');
    const m = [...t.matchAll(/create or replace view public\.dedications_public[\s\S]*?;/gi)];
    if (m.length) view = m[m.length - 1][0];
  }
  r.check('dedications_public names its columns and none of the email ones', !!view && !/\bd\.\*/.test(view) && EMAIL_COLS.every((c) => !view.includes(c)), view.slice(0, 120));
  const mw = readFileSync(join(ROOT, 'middleware.js'), 'utf8');
  const page = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const selects = [...(mw + page).matchAll(/dedications_public[\s\S]{0,200}?select[=(]['"]?([^'")&]+)/g)].map((x) => x[1]);
  // SHOW-1: only the strip reads the view now; the /d/ page and its preview
  // use dedication_by_code(), whose columns show-publicly.spec.mjs checks.
  r.check('every dedications_public select (the strip) lists only safe columns',
    selects.length >= 1 && selects.every((s) => !s.includes('*') && EMAIL_COLS.every((c) => !s.includes(c))), JSON.stringify(selects));
  r.check('no client code reads the dedications table directly', !/from\(['"]dedications['"]\)/.test(page) && !/rest\/v1\/dedications\?/.test(mw));
  const songsJson = readFileSync(join(ROOT, 'songs.json'), 'utf8');
  r.check('songs.json (the public snapshot) carries none of them', EMAIL_COLS.every((c) => !songsJson.includes(c)));
  const snap = readFileSync(join(ROOT, 'scripts', 'snapshot-songs.mjs'), 'utf8');
  r.check('the snapshot script never reads dedications', !/dedications/.test(snap));
  for (const f of ['sitemap.xml', 'artists.json']) {
    r.check(`${f} carries none of them`, EMAIL_COLS.every((c) => !readFileSync(join(ROOT, f), 'utf8').includes(c)));
  }
  const s031 = readFileSync(join(sqlDir, '031_dedication_email.sql'), 'utf8');
  r.check('sql/031: the client roles lose every grant on dedications', /revoke all on table public\.dedications from anon, authenticated;/.test(s031));
  r.check('sql/031: email_suppressions is RLS-forced, no policies, no client grants',
    /alter table public\.email_suppressions force row level security;/.test(s031) && !/create policy/i.test(s031)
      && /revoke all on table public\.email_suppressions from public, anon, authenticated;/.test(s031));
  for (const fn of ['claim_dedication_email(text, uuid, text)', 'finish_dedication_email(text, text)', 'suppress_dedication_email(text)', 'dedication_email_valid(text)']) {
    const esc = fn.replace(/[()]/g, '\\$&');
    r.check(`sql/031: ${fn.split('(')[0]} is the service role's only`,
      new RegExp(`revoke all on function public\\.${esc} from public, anon, authenticated;`).test(s031)
        && new RegExp(`grant execute on function public\\.${esc} to service_role;`).test(s031)
        && !new RegExp(`grant execute on function public\\.${esc} to (anon|authenticated)`).test(s031), fn);
  }
  r.check('sql/031: the limits are 5 a day per sender, 1 per address per sender per 7 days, 3 per address per 7 days',
    /interval '24 hours'[\s\S]*?v_n >= 5 then v_limit := 'sender_daily'/.test(s031)
      && /recipient_email = v_email\s+and email_sent_at > now\(\) - interval '7 days'[\s\S]*?v_n >= 1 then v_limit := 'same_address_week'/.test(s031)
      && /v_n >= 3 then v_limit := 'address_week'/.test(s031));
  const terms = readFileSync(join(ROOT, 'terms.html'), 'utf8'), md = readFileSync(join(ROOT, 'docs', 'legal', 'terms-v2.md'), 'utf8');
  const sentence = 'If you send a dedication, you confirm that you know the person it is for, and if you give their email address, we use it only to deliver that one dedication and never show it publicly.';
  r.check('the Terms (terms.html and docs/legal) carry the dedication sentence', terms.includes(sentence) && md.includes(sentence));
}
