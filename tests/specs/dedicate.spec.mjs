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
  // dock-react (the Dedicate/Share buttons) starts hidden in the static
  // markup and is unhidden once loadSong() finishes -- the actual thing
  // every scenario below needs ready before it clicks Dedicate.
  await page.waitForSelector('#now-dedicate-btn', { state: 'visible', timeout: 10000 });
}

// Every scenario below opens the sheet the same way: click, then wait for
// the modal itself (not a fixed delay) before touching it further.
async function openDedicateSheet(page) {
  await page.click('#now-dedicate-btn');
  await page.waitForSelector('#dedicate-modal:not([hidden])', { timeout: 10000 });
  // The sheet focuses "Who is it for?" 30ms after it opens; typing into
  // another field before that lands would be moved there mid-fill.
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'dedicate-recipient', null, { timeout: 5000 });
}

export async function run(browser, port) {
  const r = makeReporter('dedicate.spec.mjs');
  await scenarioSignedOutReason(browser, port, r);
  await scenarioFormValidation(browser, port, r);
  await scenarioSomethingElsePreview(browser, port, r);
  await scenarioCounter(browser, port, r);
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
  await page.waitForFunction(() => window.__openModalCalls.length > 0, { timeout: 10000 });
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

  await openDedicateSheet(page);
  r.check('the sheet opens, titled with the song', await page.evaluate(() => document.getElementById('dedicate-song-title').textContent) === SONG.title);

  // Empty recipient: refused client-side, no RPC call.
  await page.click('#dedicate-submit');
  await page.waitForFunction(() => document.getElementById('dedicate-err').textContent.length > 0, { timeout: 10000 });
  let err = await page.evaluate(() => document.getElementById('dedicate-err').textContent);
  r.check('empty recipient is refused with an inline message', /who this is for/i.test(err), err);
  r.check('no RPC call was made for the empty case', rpcCalls.length === 0, rpcCalls.length);

  // Occasion "Other" with no description: refused client-side. The error
  // text must actually CHANGE from the "who this is for" message above, not
  // just stay non-empty, or this would pass on a stale message too.
  await page.fill('#dedicate-recipient', 'Mom');
  await page.selectOption('#dedicate-occasion', 'other');
  await page.click('#dedicate-submit');
  await page.waitForFunction(() => /describe the occasion/i.test(document.getElementById('dedicate-err').textContent), { timeout: 10000 });
  err = await page.evaluate(() => document.getElementById('dedicate-err').textContent);
  r.check('"Other" with no description is refused', /describe the occasion/i.test(err), err);
  r.check('the occasion-other field is revealed for "Other"', await page.evaluate(() => !document.getElementById('dedicate-occasion-other').hidden));
  r.check('still no RPC call', rpcCalls.length === 0, rpcCalls.length);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioSomethingElsePreview(browser, port, r) {
  r.section('LISTEN-1: "Something else" preview -- clean empty, clean filled, clean after a stray trailing period');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await gotoSong(page, port);
  await openDedicateSheet(page);

  await page.fill('#dedicate-recipient', 'Mom');
  await page.selectOption('#dedicate-occasion', 'other');

  const empty = await page.evaluate(() => document.getElementById('dedicate-preview').textContent);
  r.check('empty box: no colon, no stray period', empty === 'A song for Mom. With love, Nova Ash.', empty);

  await page.fill('#dedicate-occasion-other', 'for being wonderful');
  const filled = await page.evaluate(() => document.getElementById('dedicate-preview').textContent);
  r.check('filled: colon, the text, one period', filled === 'A song for Mom: for being wonderful. With love, Nova Ash.', filled);

  // A trailing period typed into the box itself must not double up.
  await page.fill('#dedicate-occasion-other', 'for being wonderful.');
  const trailingPeriod = await page.evaluate(() => document.getElementById('dedicate-preview').textContent);
  r.check('a trailing period in the box does not produce ".."', trailingPeriod === 'A song for Mom: for being wonderful. With love, Nova Ash.', trailingPeriod);
  r.check('never shows ": ."', !trailingPeriod.includes(': .'), trailingPeriod);
  r.check('never shows ".."', !trailingPeriod.includes('..'), trailingPeriod);

  // Back to empty (e.g. the visitor cleared it): clean again, not "stuck"
  // with whatever punctuation guard fired last.
  await page.fill('#dedicate-occasion-other', '');
  const clearedAgain = await page.evaluate(() => document.getElementById('dedicate-preview').textContent);
  r.check('cleared back to empty: clean again', clearedAgain === 'A song for Mom. With love, Nova Ash.', clearedAgain);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioCounter(browser, port, r) {
  r.section('LISTEN-1: the message counter -- 280 on an empty box, the real typed length after typing/deleting/switching occasion');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH] });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await gotoSong(page, port);

  const counterText = () => page.evaluate(() => document.getElementById('dedicate-counter').textContent);
  const waitForCounter = (expected) => page.waitForFunction(
    (exp) => document.getElementById('dedicate-counter').textContent === exp, expected, { timeout: 10000 },
  );

  await openDedicateSheet(page);
  r.check('280 on a freshly opened, empty box', await counterText() === '280 characters left', await counterText());

  await page.fill('#dedicate-message', 'Love you!');
  await waitForCounter('271 characters left');
  r.check('280 minus the actual typed length (9 characters)', await counterText() === '271 characters left', await counterText());

  await page.fill('#dedicate-message', '');
  await waitForCounter('280 characters left');
  r.check('back to 280 after deleting everything', await counterText() === '280 characters left', await counterText());

  await page.fill('#dedicate-message', 'Mazel tov');
  await waitForCounter('271 characters left');
  await page.selectOption('#dedicate-occasion', 'wedding');
  r.check('switching occasion does not touch the message or its count', await counterText() === '271 characters left', await counterText());

  // Reopening (a different song, or the same one again) must not carry a
  // stale count from the last time the sheet was open -- the actual bug:
  // nothing reset the counter text itself when the box was cleared on open.
  await page.click('#dedicate-close');
  await openDedicateSheet(page);
  r.check('reopening resets to 280, not stuck at the last count shown', await counterText() === '280 characters left', await counterText());

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

  await openDedicateSheet(page);
  await page.fill('#dedicate-recipient', 'Mom');
  await page.selectOption('#dedicate-occasion', 'birthday');
  await page.fill('#dedicate-message', 'Love you!');

  const preview = await page.evaluate(() => document.getElementById('dedicate-preview').textContent);
  r.check('the live preview reads like the page: the line, then the sender line', preview === 'A birthday song for Mom. With love, Nova Ash.', preview);

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${port}` });

  await page.click('#dedicate-submit');
  await page.waitForSelector('[data-ded-pane="success"]:not([hidden])', { timeout: 10000 });

  const after = await page.evaluate(() => ({
    formHidden: document.querySelector('[data-ded-pane="form"]').hidden,
    successHidden: document.querySelector('[data-ded-pane="success"]').hidden,
    title: document.getElementById('dedicate-success-title').textContent,
    sub: document.getElementById('dedicate-success-sub').textContent,
    viewLink: document.getElementById('dedicate-view-link').href,
    waTag: document.getElementById('dedicate-whatsapp').tagName,
    wa: document.getElementById('dedicate-whatsapp').getAttribute('href'),
    copyVisible: !document.getElementById('dedicate-copy').hidden,
  }));
  r.check('sent request carries the right payload', shareCalls[0] && shareCalls[0].p_recipient_name === 'Mom' && shareCalls[0].p_occasion === 'birthday' && shareCalls[0].p_is_anonymous === false, JSON.stringify(shareCalls[0]));
  r.check('switches to the success pane', after.formHidden === true && after.successHidden === false, JSON.stringify(after));
  r.check('SEND-1: "Dedication saved", then "Now send it to Mom."', after.title === 'Dedication saved' && after.sub === 'Now send it to Mom.', JSON.stringify(after));
  r.check('the view link points at the real dedication page', after.viewLink === 'https://laivyhart.com/d/ABCD2345', after.viewLink);
  // SEND-1: a real link the sender taps, to the person, not "about" them.
  // SHOW-1: reads like the email; no emoji (it broke on the wa.me hop).
  const expectedText = 'Nova Ash dedicated a song to you.\nA birthday song for Mom.\nSupernova\n“Love you!”\nListen here: https://laivyhart.com/d/ABCD2345';
  r.check('WhatsApp is a link to wa.me with the exact expected text, URL-encoded', after.waTag === 'A' && after.wa === 'https://wa.me/?text=' + encodeURIComponent(expectedText), after.wa);

  await page.click('#dedicate-copy');
  await page.waitForFunction(
    async (expected) => { try { return (await navigator.clipboard.readText()) === expected; } catch (e) { return false; } },
    'https://laivyhart.com/d/ABCD2345',
    { timeout: 10000 },
  );
  r.check('Copy link copies the dedication page link', true);

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

  await openDedicateSheet(page);
  await page.fill('#dedicate-recipient', 'Mom');
  await page.click('#dedicate-submit');
  await page.waitForFunction(() => document.getElementById('dedicate-err').textContent.length > 0, { timeout: 10000 });

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
  await withDedications.waitForFunction(() => document.querySelectorAll('.dedications-strip-card').length === 2, { timeout: 10000 });
  const shown = await withDedications.evaluate(() => ({
    hidden: document.getElementById('dedications-strip').classList.contains('hidden'),
    // PROFILE-1: the card is now a <div> (a link cannot nest inside another
    // link, and the sender's name got its own link to /u/<handle>) with the
    // /d/<code> link as its first <a> child, not the card element itself.
    cards: Array.from(document.querySelectorAll('.dedications-strip-card')).map((card) => ({
      text: card.textContent.trim(), href: card.querySelector('a')?.getAttribute('href'),
    })),
  }));
  r.check('strip is visible when the song has dedications', shown.hidden === false);
  r.check('card shows the line, then "from Tzvi"', /A birthday song for Mom.*from Tzvi/s.test(shown.cards[0]?.text), shown.cards[0]);
  r.check('an anonymous sender renders "from someone", and "Something else" renders its own text', /A song for Yossi: Getting better.*from someone/s.test(shown.cards[1]?.text), shown.cards[1]);
  r.check('each card links to its own /d/<code> page', shown.cards[0]?.href === '/d/AAAA1111' && shown.cards[1]?.href === '/d/BBBB2222', shown.cards);
  r.check('no console/page errors', errors1.length === 0, errors1.join(' | '));
  await withDedications.close();

  const withoutDedications = await newPage(browser);
  const errors2 = collectErrors(withoutDedications);
  await wireSupabaseStubs(withoutDedications, { dedicationsPublic: [] });
  // The strip is hidden in the static markup too, so "hidden" alone cannot
  // tell "not loaded yet" from "loaded and confirmed empty" -- wait for the
  // actual dedications_public response (attached before the navigation that
  // triggers it) before reading that state.
  const stripResponse = withoutDedications.waitForResponse((resp) => resp.url().includes('dedications_public'), { timeout: 10000 });
  await gotoSong(withoutDedications, port);
  await stripResponse;
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
  await page.waitForSelector('#dedicate-modal:not([hidden])', { timeout: 10000 });
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
