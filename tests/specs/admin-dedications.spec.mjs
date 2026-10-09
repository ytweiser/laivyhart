/* ============================================================
   DED-1, Part B -- the admin Dedications tab, exercised against the real
   admin.html with admin_list_dedications/admin_remove_dedication stubbed
   (lib/stub-supabase.mjs). Covers the list, the anonymous tag, the filters,
   and the remove-with-reason flow -- not the real database (that is
   verified separately, directly against the live project, in an aborting
   DO block).
   ============================================================ */
import { newPage, collectErrors } from '../lib/browser.mjs';
import { wireSupabaseStubs } from '../lib/stub-supabase.mjs';
import { signInAs } from '../lib/auth.mjs';
import { makeReporter } from '../lib/report.mjs';
import * as F from '../fixtures.mjs';

const SONG = F.SONGS_ROWS.find((s) => s.id === F.SONGS.SUPERNOVA);

function dedicationsFixture() {
  return [
    {
      code: 'ABCD2345', created_at: new Date(Date.now() - 5 * 60000).toISOString(), status: 'live',
      song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug,
      recipient_name: 'Dana', occasion: 'birthday', occasion_other: null,
      message: 'Happy birthday, hope you love this one!',
      is_anonymous: false, sender_user_id: F.NOVA_ASH, sender_name: 'Nova Ash', sender_email: 'nova@example.test',
      removed_by: null, removed_reason: null,
    },
    {
      code: 'EFGH6789', created_at: new Date(Date.now() - 20 * 60000).toISOString(), status: 'live',
      song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug,
      recipient_name: 'Yossi', occasion: 'other', occasion_other: 'Getting better',
      message: null,
      is_anonymous: true, sender_user_id: F.NOVA_ASH, sender_name: 'Nova Ash', sender_email: 'nova@example.test',
      removed_by: null, removed_reason: null,
    },
    {
      code: 'WXYZ4567', created_at: new Date(Date.now() - 2 * 86400000).toISOString(), status: 'removed',
      song_id: SONG.id, song_title: SONG.title, song_slug: SONG.slug,
      recipient_name: 'Old One', occasion: 'wedding', occasion_other: null, message: null,
      is_anonymous: false, sender_user_id: F.NOVA_ASH, sender_name: 'Nova Ash', sender_email: 'nova@example.test',
      removed_by: 'admin', removed_reason: 'reported by recipient',
    },
  ];
}

async function openAdminDedications(browser, port, overrides) {
  const page = await newPage(browser);
  const errors = collectErrors(page);
  await wireSupabaseStubs(page, { isAdmin: true, adminDedications: dedicationsFixture(), ...overrides });
  await signInAs(page, F.SESSION_USERS.LISTENER);
  await page.goto(`http://localhost:${port}/admin.html`, { waitUntil: 'load' });
  await page.waitForSelector('#dedications-btn', { timeout: 10000, state: 'visible' });
  await page.click('#dedications-btn');
  await page.waitForTimeout(400);
  return { page, errors };
}

export async function run(browser, port) {
  const r = makeReporter('admin-dedications.spec.mjs');
  await scenarioListAndAnonymousTag(browser, port, r);
  await scenarioFilters(browser, port, r);
  await scenarioRemoveFlow(browser, port, r);
  await scenarioRemoveError(browser, port, r);
  return r;
}

async function scenarioListAndAnonymousTag(browser, port, r) {
  r.section('Dedications tab: list renders song, recipient, occasion, message, sender, time');
  const { page, errors } = await openAdminDedications(browser, port);

  const d = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#ded-list .ded-item'));
    return items.map((el) => ({
      song: el.querySelector('.ded-song')?.textContent,
      recipient: el.querySelector('.ded-recipient')?.textContent,
      message: el.querySelector('.ded-message')?.textContent || null,
      anonTag: !!el.querySelector('.ded-anon-tag'),
      removedTag: el.querySelector('.ded-removed-tag')?.textContent || null,
      hasRemoveBtn: !!el.querySelector('[data-ded-remove]'),
    }));
  });

  r.check('default filter is "live" -- only 2 of the 3 fixture rows show', d.length === 2, d.length);
  r.check('first row shows the song title', d[0].song === SONG.title, d[0].song);
  r.check('first row shows the recipient name', d[0].recipient.includes('Dana'), d[0].recipient);
  r.check('first row shows the occasion', d[0].recipient.includes('Birthday'), d[0].recipient);
  r.check('first row shows the message', d[0].message === 'Happy birthday, hope you love this one!', d[0].message);
  r.check('non-anonymous row has no anonymous tag', d[0].anonTag === false);
  r.check('a live row has a Remove button', d[0].hasRemoveBtn === true);

  r.check('second row (occasion "other") shows the custom occasion text', d[1].recipient.includes('Getting better'), d[1].recipient);
  r.check('the anonymous dedication is tagged, even though the real sender is known to the admin', d[1].anonTag === true);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioFilters(browser, port, r) {
  r.section('Dedications tab: status filters (Live / Removed / All)');
  const { page, errors } = await openAdminDedications(browser, port);

  await page.click('#ded-filters [data-status="removed"]');
  await page.waitForTimeout(300);
  const removedView = await page.evaluate(() => Array.from(document.querySelectorAll('#ded-list .ded-item')).map((el) => el.querySelector('.ded-recipient')?.textContent));
  r.check('"Removed" filter shows only the removed row', removedView.length === 1 && removedView[0].includes('Old One'), removedView);

  await page.click('#ded-filters [data-status=""]');
  await page.waitForTimeout(300);
  const allView = await page.evaluate(() => document.querySelectorAll('#ded-list .ded-item').length);
  r.check('"All" filter shows all 3 fixture rows', allView === 3, allView);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioRemoveFlow(browser, port, r) {
  r.section('Dedications tab: Remove asks for a reason and the row leaves the Live list');
  const { page, errors } = await openAdminDedications(browser, port);

  await page.evaluate(() => { window.prompt = () => 'Inappropriate recipient name'; });
  await page.click('#ded-list .ded-item [data-ded-remove]');
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => document.querySelectorAll('#ded-list .ded-item').length);
  r.check('the removed dedication drops out of the Live list', after === 1, after);

  await page.click('#ded-filters [data-status="removed"]');
  await page.waitForTimeout(300);
  const removedText = await page.evaluate(() => document.querySelector('#ded-list .ded-item .ded-removed-tag')?.textContent);
  r.check('it now shows up under Removed, with the reason', removedText && removedText.includes('Inappropriate recipient name'), removedText);

  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function scenarioRemoveError(browser, port, r) {
  r.section('Dedications tab: a failed removal shows an error and leaves the row in place');
  const { page, errors } = await openAdminDedications(browser, port, {
    adminRemoveDedicationResult: { status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'That dedication could not be found or is already removed.', code: 'P0001' }) },
  });

  await page.evaluate(() => {
    window.prompt = () => 'test reason';
    window.__alerts = [];
    window.alert = (m) => window.__alerts.push(m);
  });
  await page.click('#ded-list .ded-item [data-ded-remove]');
  await page.waitForTimeout(300);

  const d = await page.evaluate(() => ({
    alerts: window.__alerts,
    stillThere: document.querySelectorAll('#ded-list .ded-item').length,
  }));
  r.check('an alert with the server message is shown', d.alerts.length === 1 && d.alerts[0].includes('already removed'), d.alerts);
  r.check('the row is still in the Live list (not optimistically removed)', d.stillThere === 2, d.stillThere);
  r.check('no console/page errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
