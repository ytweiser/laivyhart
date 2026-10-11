/* ============================================================
   SONG-2 -- /your-song, the full page: hero, how it works, the idea box,
   signed-out submit (keeps the typed text through sign-in), a successful
   submit, "This week", "Made from your ideas", and the FAQ. The idea board
   (/your-song/ideas) is covered separately in
   your-song-ideas-board.spec.mjs.
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SONG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);

async function gotoYourSong(page, port) {
  await page.goto(`http://localhost:${port}/your-song`, { waitUntil: 'load' });
  await page.waitForSelector('#idea-box', { timeout: 10000 });
}

export async function run(browser, port) {
  const r = makeReporter('your-song-page.spec.mjs');
  await scenarioRendersAllSections(browser, port, r);
  await scenarioNoTopicExamples(browser, port, r);
  await scenarioSignedOutKeepsText(browser, port, r);
  await scenarioSubmitSuccess(browser, port, r);
  await scenarioMadeFromIdeas(browser, port, r);
  await scenarioViewports(browser, port, r);
  return r;
}

async function scenarioRendersAllSections(browser, port, r) {
  r.section('the page renders every section: hero, steps, box, this week, FAQ');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { songIdeasBoard: [], songs: F.SONGS_ROWS });
  await gotoYourSong(page, port);

  const d = await page.evaluate(() => ({
    heroTitle: document.querySelector('.ys-title')?.textContent,
    heroSub: document.querySelector('.ys-sub')?.textContent,
    stepCount: document.querySelectorAll('.ys-step').length,
    boxHeading: document.querySelector('#idea-box h2')?.textContent,
    hasCountdown: !!document.getElementById('ys-countdown')?.textContent,
    faqCount: document.querySelectorAll('.ys-faq-item').length,
  }));
  r.check('hero title is exact', d.heroTitle === 'Your idea. Our music.', d.heroTitle);
  r.check('hero subline is exact', d.heroSub === "Send us your song idea. Every week we choose one and turn it into a real song, with your name on it.", d.heroSub);
  r.check('three "how it works" steps', d.stepCount === 3, d.stepCount);
  r.check('box heading is exact', d.boxHeading === "What's your song idea?", d.boxHeading);
  r.check('the countdown renders something', d.hasCountdown === true, d.hasCountdown);
  r.check('five FAQ items', d.faqCount === 5, d.faqCount);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioNoTopicExamples(browser, port, r) {
  r.section('no topic examples anywhere in the box copy -- exact placeholder and helper text');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await gotoYourSong(page, port);

  const d = await page.evaluate(() => ({
    placeholder: document.getElementById('ys-text')?.getAttribute('placeholder'),
    helper: document.querySelector('.ys-box-line')?.textContent,
  }));
  r.check('placeholder is exactly "Write as much or as little as you like."', d.placeholder === 'Write as much or as little as you like.', d.placeholder);
  r.check('helper line is exact, no topic suggestions', d.helper === 'Tell us in your own words. The more detail you give, the closer we get to your vision.', d.helper);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioSignedOutKeepsText(browser, port, r) {
  r.section('signed out: Submit opens sign-in with the reason, and the typed text survives through it');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page);
  await gotoYourSong(page, port);

  await page.evaluate(() => {
    window.__openModalCalls = [];
    const orig = window.laivy.accountUI.openModal;
    window.laivy.accountUI.openModal = (opts) => { window.__openModalCalls.push(opts); return orig(opts); };
  });

  await page.fill('#ys-text', 'A song about my grandfather crossing the ocean.');
  await page.fill('#ys-credit', 'A Reader');
  await page.check('#ys-agree');
  await page.click('#ys-submit');
  await page.waitForFunction(() => window.__openModalCalls && window.__openModalCalls.length > 0, { timeout: 10000 });

  const d = await page.evaluate(() => ({
    calls: window.__openModalCalls,
    draft: sessionStorage.getItem('laivy-your-song-draft'),
  }));
  r.check('sign-in modal opens', d.calls.length === 1, JSON.stringify(d.calls));
  r.check('reason is "Sign in to send your idea"', d.calls[0] && d.calls[0].reason === 'Sign in to send your idea', d.calls[0]);
  r.check('the typed text is saved to sessionStorage', !!d.draft && JSON.parse(d.draft).text === 'A song about my grandfather crossing the ocean.', d.draft);

  // Reload (as if returning from sign-in): the draft restores into the box.
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#idea-box', { timeout: 10000 });
  await page.waitForFunction(() => document.getElementById('ys-text').value.length > 0, { timeout: 10000 });
  const after = await page.evaluate(() => ({
    text: document.getElementById('ys-text').value,
    credit: document.getElementById('ys-credit').value,
    draftGone: sessionStorage.getItem('laivy-your-song-draft'),
  }));
  r.check('the typed text is restored after the reload', after.text === 'A song about my grandfather crossing the ocean.', after.text);
  r.check('the credit name is restored too', after.credit === 'A Reader', after.credit);
  r.check('the draft is cleared once restored (no stale draft lingers)', after.draftGone === null, after.draftGone);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioSubmitSuccess(browser, port, r) {
  r.section('signed in: a successful submit shows the success pane with both links');
  const page = await newPage(browser);
  const errors = collectErrors(page);
  const rpcCalls = [];
  await wireSupabaseStubs(page,
    { selfArtistRow: F.SELF_ARTIST_ROWS[F.NOVA_ASH], submitSongIdeaResult: 'idea-abc-1' },
    (name, req) => { if (name === 'rpc:submit_song_idea') rpcCalls.push(JSON.parse(req.postData() || '{}')); });
  await signInAs(page, F.SESSION_USERS.NOVA);
  await gotoYourSong(page, port);

  // Signed in: the credit field prefills with the artist's own display name.
  await page.waitForFunction(() => document.getElementById('ys-credit').value === 'Nova Ash', { timeout: 10000 });
  const prefilled = await page.evaluate(() => document.getElementById('ys-credit').value);
  r.check('credit-as prefills with the signed-in artist\'s display name', prefilled === 'Nova Ash', prefilled);

  await page.fill('#ys-text', 'A song about the first rain after a long drought.');
  await page.check('#ys-agree');
  await page.click('#ys-submit');
  await page.waitForFunction(() => {
    const success = document.querySelector('[data-ys-pane="success"]');
    return success && !success.hidden;
  }, { timeout: 10000 });

  const d = await page.evaluate(() => ({
    formHidden: document.querySelector('[data-ys-pane="form"]').hidden,
    successHidden: document.querySelector('[data-ys-pane="success"]').hidden,
    heading: document.querySelector('.ys-success h2')?.textContent,
    links: Array.from(document.querySelectorAll('.ys-success-links a')).map((a) => a.getAttribute('href')),
  }));
  r.check('sent request carries the idea text and the prefilled credit', rpcCalls[0] && rpcCalls[0].p_text === 'A song about the first rain after a long drought.' && rpcCalls[0].p_credit_name === 'Nova Ash', JSON.stringify(rpcCalls[0]));
  r.check('switches to the success pane', d.formHidden === true && d.successHidden === false, JSON.stringify(d));
  r.check('success heading is exact', d.heading === 'Thank you. Your idea is in.', d.heading);
  r.check('links to My ideas and the idea board', d.links.includes('/settings') && d.links.includes('/your-song/ideas'), d.links);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioMadeFromIdeas(browser, port, r) {
  r.section('"Made from your ideas" is hidden with none, shown with one');
  const hiddenPage = await newPage(browser);
  const errors1 = collectErrors(hiddenPage);
  await wireSupabaseStubs(hiddenPage, { songs: F.SONGS_ROWS });
  // "Stays hidden" has no DOM change to poll for (the section's class never
  // moves), so the real condition here is "the songs fetch that would have
  // shown it has actually finished" -- the network response, not a guess at
  // how long that takes.
  const songsFetched = hiddenPage.waitForResponse((resp) => resp.url().includes('/rest/v1/songs?'), { timeout: 10000 });
  await gotoYourSong(hiddenPage, port);
  await songsFetched;
  const hidden = await hiddenPage.evaluate(() => document.getElementById('ys-made-section').classList.contains('hidden'));
  r.check('hidden when no song carries an idea credit', hidden === true);
  r.check('no console/page errors', errors1.length === 0, errors1.join(' | '));
  await hiddenPage.close();

  const shownPage = await newPage(browser);
  const errors2 = collectErrors(shownPage);
  const withCredit = F.SONGS_ROWS.map((s) => (s.id === SONG.id ? { ...s, idea_credit: 'A Reader' } : s));
  await wireSupabaseStubs(shownPage, { songs: withCredit });
  await gotoYourSong(shownPage, port);
  await shownPage.waitForSelector('.ys-made-card', { timeout: 10000 });
  const d = await shownPage.evaluate(() => ({
    hidden: document.getElementById('ys-made-section').classList.contains('hidden'),
    card: document.querySelector('.ys-made-card')?.textContent,
    href: document.querySelector('.ys-made-card')?.getAttribute('href'),
  }));
  r.check('shown once a song has an idea credit', d.hidden === false, d);
  r.check('shows the song title and "Idea by" credit', d.card?.includes(SONG.title) && d.card?.includes('Idea by A Reader'), d.card);
  r.check('links to the real song page', d.href === '/song/' + SONG.slug, d.href);
  r.check('no console/page errors', errors2.length === 0, errors2.join(' | '));
  await shownPage.close();
}

async function scenarioViewports(browser, port, r) {
  r.section('renders cleanly at 1280 and 390, no horizontal overflow');
  for (const width of [1280, 390]) {
    const page = await newPage(browser, { width, height: 900 });
    const errors = collectErrors(page);
    await wireSupabaseStubs(page);
    await gotoYourSong(page, port);
    const d = await page.evaluate(() => ({
      boxVisible: !!document.getElementById('idea-box'),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    }));
    r.check(`the box renders at ${width}px`, d.boxVisible === true, width);
    r.check(`no horizontal overflow at ${width}px`, d.overflow === false, width);
    r.check('no console/page errors', errors.length === 0, errors.join(' | '));
    await page.close();
  }
}
