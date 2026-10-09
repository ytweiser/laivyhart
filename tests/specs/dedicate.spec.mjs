/* ============================================================
   DED-2 -- the Dedicate button, sheet and success state, and the song
   page's Dedications strip. The dedication page itself (/d/<code>) and the
   middleware SSR are covered in dedication-page.spec.mjs and
   middleware.spec.mjs respectively; "My dedications" is in settings.spec.mjs.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SONG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);
const SLUG = SONG.slug;

async function gotoSong(page, port, slug) {
  await page.goto(`http://localhost:${port}/song/${slug || SLUG}`, { waitUntil: 'load' });
  await page.waitForSelector('#now-artist .now-artist-row', { timeout: 10000 });
  await page.waitForTimeout(300);
}

export async function run(browser, port) {
  const r = makeReporter('dedicate.spec.mjs');
  await scenarioSignedOutReason(browser, port, r);
  await scenarioFormValidation(browser, port, r);
  await scenarioSuccessShareActions(browser, port, r);
  await scenarioServerErrorInline(browser, port, r);
  await scenarioStripShowsAndHides(browser, port, r);
  await scenarioViewport390(browser, port, r);
  return r;
}

async function scenarioSignedOutReason(browser, port, r) {
  r.section('signed out: Dedicate opens sign-in with the reason, and returns to this song');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await gotoSong(page, port);
  await page.evaluate(() => {
    window.__openModalCalls = [];
    const orig = window.laivy.accountUI.openModal;
    window.laivy.accountUI.openModal = (opts) => { window.__openModalCalls.push(opts); return orig(opts); };
  });

  await page.click('#now-dedicate-btn');
  await page.waitForTimeout(150);
  const d = await page.evaluate(() => ({
    calls: window.__openModalCalls,
    modalOpen: !document.getElementById('dedicate-modal').hidden,
  }));
  r.check('sign-in modal opens instead of the Dedicate sheet', d.modalOpen === false && d.calls.length === 1, JSON.stringify(d));
  r.check('reason is "Sign in to dedicate this song"', d.calls[0] && d.calls[0].reason === 'Sign in to dedicate this song', d.calls[0]);
  r.check('returns to this same song page after sign-in', d.calls[0] && d.calls[0].next === '/song/' + SLUG, d.calls[0]);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioFormValidation(browser, port, r) {
  r.section('signed in: the form validates before it ever calls create_dedication');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  const rpcCalls = [];
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] }, (name) => {
    if (name === 'rpc:create_dedication') rpcCalls.push(1);
  });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await gotoSong(page, port);

  await page.click('#now-dedicate-btn');
  await page.waitForTimeout(200);
  r.check('the sheet opens, titled with the song', await page.evaluate(() => document.getElementById('dedicate-song-title').textContent) === SONG.title);

  // Empty recipient: refused client-side, no RPC call.
  await page.click('#dedicate-submit');
  await page.waitForTimeout(150);
  let err = await page.evaluate(() => document.getElementById('dedicate-err').textContent);
  r.check('empty recipient is refused with an inline message', /who this is for/i.test(err), err);
  r.check('no RPC call was made for the empty case', rpcCalls.length === 0, rpcCalls.length);

  // Occasion "Other" with no description: refused client-side.
  await page.fill('#dedicate-recipient', 'Mom');
  await page.selectOption('#dedicate-occasion', 'other');
  await page.click('#dedicate-submit');
  await page.waitForTimeout(150);
  err = await page.evaluate(() => document.getElementById('dedicate-err').textContent);
  r.check('"Other" with no description is refused', /describe the occasion/i.test(err), err);
  r.check('the occasion-other field is revealed for "Other"', await page.evaluate(() => !document.getElementById('dedicate-occasion-other').hidden));
  r.check('still no RPC call', rpcCalls.length === 0, rpcCalls.length);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioSuccessShareActions(browser, port, r) {
  r.section('a successful dedication shows the three share actions with the right WhatsApp text and link');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  const shareCalls = [];
  await wireSupabaseStubs(page,
    { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH], createDedicationResult: 'ABCD2345' },
    (name, req) => { if (name === 'rpc:create_dedication') shareCalls.push(JSON.parse(req.postData() || '{}')); });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await gotoSong(page, port);

  await page.click('#now-dedicate-btn');
  await page.waitForTimeout(150);
  await page.fill('#dedicate-recipient', 'Mom');
  await page.selectOption('#dedicate-occasion', 'birthday');
  await page.fill('#dedicate-message', 'Love you!');

  const preview = await page.evaluate(() => document.getElementById('dedicate-preview').textContent);
  r.check('the live preview shows the recipient, occasion label and the signed-in sender\'s name', preview === 'For Mom · Birthday · from Nova Ash', preview);

  // Block the real wa.me navigation; navigator.clipboard cannot be reassigned
  // (it is a getter on the prototype), so the real API is used instead, with
  // permission granted so it actually works headless.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${port}` });
  await page.evaluate(() => {
    window.__opened = [];
    window.open = (url) => { window.__opened.push(url); return null; };
  });

  await page.click('#dedicate-submit');
  await page.waitForTimeout(250);

  const after = await page.evaluate(() => ({
    formHidden: document.querySelector('[data-ded-pane="form"]').hidden,
    successHidden: document.querySelector('[data-ded-pane="success"]').hidden,
    viewLink: document.getElementById('dedicate-view-link').href,
    waVisible: !document.getElementById('dedicate-whatsapp').hidden,
    copyVisible: !document.getElementById('dedicate-copy').hidden,
  }));
  r.check('sent request carries the right payload', shareCalls[0] && shareCalls[0].p_recipient_name === 'Mom' && shareCalls[0].p_occasion === 'birthday' && shareCalls[0].p_is_anonymous === false, JSON.stringify(shareCalls[0]));
  r.check('switches to the success pane', after.formHidden === true && after.successHidden === false, JSON.stringify(after));
  r.check('the view link points at the real dedication page', after.viewLink === 'https://www.laivyhart.com/d/ABCD2345', after.viewLink);
  r.check('WhatsApp and Copy actions are both present', after.waVisible && after.copyVisible, JSON.stringify(after));

  await page.click('#dedicate-whatsapp');
  await page.waitForTimeout(100);
  const opened = await page.evaluate(() => window.__opened[0]);
  const expectedText = 'I dedicated a song to you on Laivy Hart: Supernova. Listen here: https://www.laivyhart.com/d/ABCD2345';
  r.check('WhatsApp opens wa.me with the exact expected text, URL-encoded', opened === 'https://wa.me/?text=' + encodeURIComponent(expectedText), opened);

  await page.click('#dedicate-copy');
  await page.waitForTimeout(100);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  r.check('Copy link copies the dedication URL', copied === 'https://www.laivyhart.com/d/ABCD2345', copied);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioServerErrorInline(browser, port, r) {
  r.section('a server rejection (banned word, cap, ...) shows inline, not a crash');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, {
    selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH],
    createDedicationResult: { status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'That wording is not allowed here. Please rephrase it.', code: 'P0001' }) },
  });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await gotoSong(page, port);

  await page.click('#now-dedicate-btn');
  await page.waitForTimeout(150);
  await page.fill('#dedicate-recipient', 'Mom');
  await page.click('#dedicate-submit');
  await page.waitForTimeout(250);

  const d = await page.evaluate(() => ({
    err: document.getElementById('dedicate-err').textContent,
    stillOnForm: !document.querySelector('[data-ded-pane="form"]').hidden,
  }));
  r.check('the server\'s own message is shown inline', d.err === 'That wording is not allowed here. Please rephrase it.', d.err);
  r.check('stays on the form (does not fake a success)', d.stillOnForm === true);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioStripShowsAndHides(browser, port, r) {
  r.section('the song page\'s Dedications strip shows the latest 5 and hides when there are none');
  const withDedications = await newPage(browser);
  const errors1 = collectErrors(withDedications);
  await wireSupabaseStubs(withDedications, {
    dedicationsPublic: [
      { code: 'AAAA1111', song_id: SONG.id, recipient_name: 'Mom', occasion: 'birthday', occasion_other: null, sender_name: 'Tzvi', created_at: new Date().toISOString() },
      { code: 'BBBB2222', song_id: SONG.id, recipient_name: 'Yossi', occasion: 'other', occasion_other: 'Getting better', sender_name: null, created_at: new Date().toISOString() },
    ],
  });
  await gotoSong(withDedications, port);
  await withDedications.waitForTimeout(300);
  const shown = await withDedications.evaluate(() => ({
    hidden: document.getElementById('dedications-strip').classList.contains('hidden'),
    cards: Array.from(document.querySelectorAll('.dedications-strip-card')).map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })),
  }));
  r.check('strip is visible when the song has dedications', shown.hidden === false);
  r.check('a named sender renders "from Tzvi"', /For Mom.*Birthday.*from Tzvi/s.test(shown.cards[0]?.text), shown.cards[0]);
  r.check('an anonymous sender renders "from someone"', /For Yossi.*Getting better.*from someone/s.test(shown.cards[1]?.text), shown.cards[1]);
  r.check('each card links to its own /d/<code> page', shown.cards[0]?.href === '/d/AAAA1111' && shown.cards[1]?.href === '/d/BBBB2222', shown.cards);
  r.check('no console/page errors', errors1.length === 0, errors1.join(' | '));
  await withDedications.close();

  const withoutDedications = await newPage(browser);
  const errors2 = collectErrors(withoutDedications);
  await wireSupabaseStubs(withoutDedications, { dedicationsPublic: [] });
  await gotoSong(withoutDedications, port);
  await withoutDedications.waitForTimeout(300);
  const hiddenState = await withoutDedications.evaluate(() => document.getElementById('dedications-strip').classList.contains('hidden'));
  r.check('strip is hidden entirely when the song has none', hiddenState === true);
  r.check('no console/page errors', errors2.length === 0, errors2.join(' | '));
  await withoutDedications.close();
}

async function scenarioViewport390(browser, port, r) {
  r.section('390px: the Dedicate button and sheet both fit, no horizontal overflow');
  const page = await newPage(browser, { width: 390, height: 800 });
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await gotoSong(page, port);

  const btnVisible = await page.evaluate(() => {
    const b = document.getElementById('now-dedicate-btn');
    const rect = b.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  r.check('Dedicate button renders at 390px', btnVisible === true);

  await page.click('#now-dedicate-btn');
  await page.waitForTimeout(200);
  const sheet = await page.evaluate(() => {
    const el = document.querySelector('.ded-sheet');
    const rect = el.getBoundingClientRect();
    return { withinViewport: rect.left >= -1 && rect.right <= window.innerWidth + 1, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
  });
  r.check('the sheet stays within the 390px viewport (bottom-sheet layout)', sheet.withinViewport === true, sheet);
  r.check('no horizontal page overflow with the sheet open', sheet.overflow === false, sheet);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
