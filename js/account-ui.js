/* ============================================================
   Account chip, sign-in modal, onboarding panel, settings form.

   Shared by index.html, admin.html and about.html. Each page provides an empty
   <div id="account-slot"></div> in its nav; this module fills every one it
   finds, renders signed-out immediately, and corrects itself on the first
   `laivy:auth` event.

   ON LANGUAGE: discovery found there is no site-wide UI language switch. The
   only toggle in the app (`langView`) is the per-song lyrics original/
   translation control, which has nothing to do with chrome copy. So rather than
   follow a toggle that does not exist, every string here is rendered bilingually
   -- English line, Hebrew line under it -- which is how the rest of the site
   already presents both languages at once.
   ============================================================ */
import { supabase, signInWithEmail, signInWithGoogle, signOut, refreshArtist, isAdmin, authState } from './auth.js';

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;

/* GA. index.html owns laivyTrack (and the laivy-no-track escape hatch); on
   pages that do not define it, fall back to the same guard so the flag is
   honoured everywhere. */
function track(name, params) {
  try {
    if (typeof window.laivyTrack === 'function') { window.laivyTrack(name, params); return; }
    if (localStorage.getItem('laivy-no-track') === '1') return;
    if (typeof window.gtag === 'function') window.gtag('event', name, params || {});
  } catch (e) { /* analytics is best effort */ }
}

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------------- sign-in modal ---------------- */

let modal = null;

function buildModal() {
  if (modal) return modal;
  modal = el('div', 'lv-modal-backdrop');
  modal.hidden = true;
  modal.innerHTML = `
    <div class="lv-modal" role="dialog" aria-modal="true" aria-labelledby="lv-signin-title">
      <button class="lv-modal-x" type="button" aria-label="Close">&times;</button>
      <h2 class="lv-modal-title" id="lv-signin-title">Sign in to Laivy Hart</h2>
      <p class="lv-modal-sub" dir="rtl" lang="he">התחברות ללייvi הארט</p>

      <div class="lv-pane" data-pane="form">
        <label class="lv-label" for="lv-email">Email <span dir="rtl" lang="he">אימייל</span></label>
        <input class="lv-input" id="lv-email" type="email" inputmode="email" autocomplete="email"
               placeholder="you@example.com" dir="ltr">
        <button class="lv-btn filled" type="button" data-act="magic">Send me a link</button>
        <p class="lv-err" data-err hidden></p>

        <div class="lv-or"><span>or <span dir="rtl" lang="he">או</span></span></div>

        <button class="lv-btn outlined" type="button" data-act="google">
          <svg viewBox="0 0 18 18" width="17" height="17" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>
          Continue with Google
        </button>
      </div>

      <div class="lv-pane" data-pane="sent" hidden>
        <p class="lv-sent">Check your email for a link to sign in.</p>
        <p class="lv-sent" dir="rtl" lang="he">בדקו את האימייל שלכם לקישור להתחברות.</p>
        <p class="lv-modal-foot" data-sent-to></p>
      </div>

      <p class="lv-modal-foot">
        By continuing you agree to our <a href="/terms">Terms and Privacy</a>.
      </p>
    </div>`;
  document.body.appendChild(modal);

  const close = () => closeModal();
  modal.querySelector('.lv-modal-x').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });

  const errEl = modal.querySelector('[data-err]');
  const showErr = (m) => { errEl.textContent = m; errEl.hidden = !m; };

  modal.querySelector('[data-act="magic"]').addEventListener('click', async (e) => {
    const input = modal.querySelector('#lv-email');
    const email = (input.value || '').trim();
    showErr('');
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { showErr('Please enter a valid email address.'); return; }
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'Sending...';
    try {
      await signInWithEmail(email);
      modal.querySelector('[data-pane="form"]').hidden = true;
      const sent = modal.querySelector('[data-pane="sent"]');
      sent.hidden = false;
      sent.querySelector('[data-sent-to]').textContent = email;
      track('magic_link_sent', { method: 'email' });
    } catch (err) {
      showErr((err && err.message) || 'Could not send that link. Please try again.');
    } finally {
      btn.disabled = false; btn.textContent = 'Send me a link';
    }
  });

  modal.querySelector('[data-act="google"]').addEventListener('click', async () => {
    showErr('');
    try { await signInWithGoogle(); }
    catch (err) { showErr((err && err.message) || 'Could not start Google sign-in.'); }
  });

  return modal;
}

export function openModal() {
  const m = buildModal();
  m.querySelector('[data-pane="form"]').hidden = false;
  m.querySelector('[data-pane="sent"]').hidden = true;
  m.querySelector('[data-err]').hidden = true;
  m.hidden = false;
  track('sign_in_opened', {});
  setTimeout(() => { try { m.querySelector('#lv-email').focus(); } catch (e) {} }, 30);
}
export function closeModal() { if (modal) modal.hidden = true; }

/* ---------------- account chip ---------------- */

function initialOf(a) {
  const n = (a && (a.display_name || a.handle)) || '';
  return (n.trim()[0] || '?').toUpperCase();
}

function renderSlot(slot) {
  const { user, artist } = authState();
  slot.innerHTML = '';

  if (!user) {
    const a = el('button', 'lv-signin-link', 'Sign in');
    a.type = 'button';
    a.setAttribute('aria-label', 'Sign in / התחברות');
    a.addEventListener('click', openModal);
    slot.appendChild(a);
    return;
  }

  const wrap = el('div', 'lv-chip-wrap');
  const chip = el('button', 'lv-chip');
  chip.type = 'button';
  chip.setAttribute('aria-haspopup', 'menu');
  chip.setAttribute('aria-expanded', 'false');
  chip.setAttribute('aria-label', 'Account menu');
  if (artist && artist.avatar_url) {
    chip.innerHTML = `<img src="${esc(artist.avatar_url)}" alt="" width="30" height="30">`;
  } else {
    chip.textContent = initialOf(artist);
  }

  const menu = el('div', 'lv-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  // The provisional handle from handle_new_user() resolves too, so this works
  // before onboarding is finished. Only a missing handle falls back.
  const myPage = (artist && artist.handle) ? `/artist/${encodeURIComponent(artist.handle)}` : '/settings';
  menu.innerHTML =
    `<a role="menuitem" href="${esc(myPage)}">My page</a>` +
    `<a role="menuitem" href="/settings">Settings</a>` +
    (isAdmin() ? `<a role="menuitem" href="/admin.html">Admin</a>` : '') +
    `<button role="menuitem" type="button" data-act="signout">Sign out</button>`;

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    chip.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('click', () => { menu.hidden = true; chip.setAttribute('aria-expanded', 'false'); });
  menu.querySelector('[data-act="signout"]').addEventListener('click', async () => {
    track('sign_out', {});
    await signOut();
    if (location.pathname === '/settings') location.href = '/';
  });

  wrap.appendChild(chip); wrap.appendChild(menu);
  slot.appendChild(wrap);
}

export function renderAccountSlots() {
  document.querySelectorAll('#account-slot').forEach(renderSlot);
}

/* ---------------- handle availability ---------------- */

/* Both checks go through the anon client: artists_public for taken handles,
   reserved_handles for reserved ones. The database is the real gate (the
   artists guard raises on a reserved handle, and the unique index on handle
   raises on a taken one) -- this is only so the field can say so before save. */
export async function checkHandle(handle, selfId) {
  if (!HANDLE_RE.test(handle)) {
    return { ok: false, reason: '3-30 characters: lowercase letters, numbers and dashes, starting with a letter or number.' };
  }
  if (!supabase) return { ok: true };
  try {
    const [taken, reserved] = await Promise.all([
      supabase.from('artists_public').select('id').eq('handle', handle).maybeSingle(),
      supabase.from('reserved_handles').select('handle').eq('handle', handle).maybeSingle(),
    ]);
    if (reserved.data) return { ok: false, reason: 'That handle is reserved.' };
    if (taken.data && taken.data.id !== selfId) return { ok: false, reason: 'That handle is taken.' };
    return { ok: true, reason: 'Available.' };
  } catch (e) {
    return { ok: true, reason: '' };   // never block on a lookup failure
  }
}

function debounce(fn, ms) {
  let t; return function () { clearTimeout(t); const a = arguments; t = setTimeout(() => fn.apply(null, a), ms); };
}

/* Shared profile form, used by both the onboarding panel and /settings. */
function profileFields(artist) {
  return `
    <label class="lv-label" for="lv-handle">Handle <span dir="rtl" lang="he">כתובת</span></label>
    <div class="lv-handle-row"><span class="lv-handle-pre">laivyhart.com/artist/</span>
      <input class="lv-input" id="lv-handle" type="text" dir="ltr" spellcheck="false"
             value="${esc(artist && artist.handle || '')}" maxlength="30"></div>
    <p class="lv-hint" data-handle-msg></p>

    <label class="lv-label" for="lv-name">Display name <span dir="rtl" lang="he">שם</span></label>
    <input class="lv-input" id="lv-name" type="text" maxlength="60" value="${esc(artist && artist.display_name || '')}">

    <label class="lv-label" for="lv-name-he">Hebrew name (optional) <span dir="rtl" lang="he">שם בעברית</span></label>
    <input class="lv-input" id="lv-name-he" type="text" maxlength="60" dir="rtl" lang="he"
           value="${esc(artist && artist.display_name_he || '')}">

    <label class="lv-label" for="lv-bio">About you (optional) <span dir="rtl" lang="he">על עצמך</span></label>
    <textarea class="lv-input lv-textarea" id="lv-bio" maxlength="600" rows="4">${esc(artist && artist.bio || '')}</textarea>
    <p class="lv-hint"><span data-bio-count>0</span>/600</p>
  `;
}

function wireProfileFields(root, artist, onValid) {
  const handle = root.querySelector('#lv-handle');
  const msg = root.querySelector('[data-handle-msg]');
  const bio = root.querySelector('#lv-bio');
  const count = root.querySelector('[data-bio-count]');
  const setCount = () => { if (count) count.textContent = String((bio.value || '').length); };
  if (bio) { bio.addEventListener('input', setCount); setCount(); }

  let valid = true;
  const run = debounce(async () => {
    const v = (handle.value || '').trim().toLowerCase();
    handle.value = v;
    const res = await checkHandle(v, artist && artist.id);
    valid = res.ok;
    msg.textContent = res.reason || '';
    msg.className = 'lv-hint ' + (res.ok ? 'is-ok' : 'is-bad');
    if (onValid) onValid(valid);
  }, 400);
  handle.addEventListener('input', run);
  return { isValid: () => valid };
}

async function saveProfile(root, artist) {
  const patch = {
    handle: (root.querySelector('#lv-handle').value || '').trim().toLowerCase(),
    display_name: (root.querySelector('#lv-name').value || '').trim(),
    display_name_he: (root.querySelector('#lv-name-he').value || '').trim() || null,
    bio: (root.querySelector('#lv-bio').value || '').trim() || null,
  };
  if (!HANDLE_RE.test(patch.handle)) throw new Error('That handle is not valid.');
  if (!patch.display_name) throw new Error('Please enter a display name.');
  const { error } = await supabase.from('artists').update(patch).eq('id', artist.id);
  // The guard and the unique index are the real gate; surface their words.
  if (error) throw new Error(error.message || 'Could not save.');
  await refreshArtist();
}

/* ---------------- onboarding panel ---------------- */

let onboardShown = false;

function showOnboarding() {
  const { artist } = authState();
  if (!artist || onboardShown) return;
  onboardShown = true;
  track('onboarding_started', {});

  const panel = el('div', 'lv-onboard');
  panel.innerHTML = `
    <div class="lv-onboard-head">
      <h2>Set up your artist page</h2>
      <button class="lv-modal-x" type="button" aria-label="Dismiss">&times;</button>
    </div>
    <p class="lv-modal-sub" dir="rtl" lang="he">הגדירו את עמוד האמן שלכם</p>
    <div class="lv-form">${profileFields(artist)}</div>
    <p class="lv-err" data-err hidden></p>
    <div class="lv-onboard-actions">
      <button class="lv-btn filled" type="button" data-act="save">Save</button>
      <button class="lv-btn ghost" type="button" data-act="later">Not now</button>
    </div>`;
  document.body.appendChild(panel);

  const errEl = panel.querySelector('[data-err]');
  wireProfileFields(panel, artist);
  const dismiss = () => panel.remove();
  panel.querySelector('.lv-modal-x').addEventListener('click', dismiss);
  panel.querySelector('[data-act="later"]').addEventListener('click', dismiss);

  panel.querySelector('[data-act="save"]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; errEl.hidden = true;
    try {
      await saveProfile(panel, artist);
      // onboarded is a column on artists, not on the public view.
      await supabase.from('artists').update({ onboarded: true }).eq('id', artist.id);
      await refreshArtist();
      track('onboarding_complete', {});
      panel.remove();
      renderAccountSlots();
    } catch (err) {
      errEl.textContent = (err && err.message) || 'Could not save.';
      errEl.hidden = false;
    } finally { btn.disabled = false; }
  });
}

/* ---------------- avatar ---------------- */

const WORKER_BASE = 'https://laivyhart-audio-upload.ytweiser-399.workers.dev';
const AVATAR_PX = 512;

/* Same shape as admin.html's compressImage, with one difference that matters:
   an avatar is round, so this CENTER-CROPS to a square first and then scales,
   rather than fitting the long side and leaving a non-square image that CSS
   would crop unpredictably. Canvas-based, so it only runs in a browser. */
export function compressAvatar(file, px = AVATAR_PX, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type || '')) { reject(new Error('That is not an image.')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) { reject(new Error('Could not read that image.')); return; }
      const side = Math.min(w, h);                 // the square we take from the source
      const sx = Math.round((w - side) / 2);
      const sy = Math.round((h - side) / 2);
      const canvas = document.createElement('canvas');
      canvas.width = px; canvas.height = px;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, px, px);   // JPEG has no alpha
      ctx.drawImage(img, sx, sy, side, side, 0, 0, px, px);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not encode that image.')), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not open that image.')); };
    img.src = url;
  });
}

/* The access token is read at click time, never from a render path, so it is
   never a stale one captured when the page drew. A 401 means it expired
   between read and send: refresh once and retry, then give up plainly. */
async function postAvatar(blob) {
  async function send(token) {
    return fetch(`${WORKER_BASE}/upload/avatar`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'image/jpeg' },
      body: blob,
    });
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Please sign in again.');
  let res = await send(session.access_token);
  if (res.status === 401) {
    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data || !data.session) throw new Error('Your session expired. Please sign in again.');
    res = await send(data.session.access_token);
  }
  if (!res.ok) {
    let detail = 'HTTP ' + res.status;
    try { const j = await res.json(); if (j && j.error) detail = j.error; } catch (e) {}
    throw new Error('Upload failed: ' + detail);
  }
  const body = await res.json();
  if (!body || !body.url) throw new Error('Upload returned no URL.');
  return body.url;
}

function avatarPreviewHTML(artist) {
  if (artist && artist.avatar_url) {
    const src = 'https://wsrv.nl/?url=' + encodeURIComponent(artist.avatar_url) + '&w=144&output=jpg&q=80';
    return `<img class="lv-avatar-prev" data-prev src="${esc(src)}" alt="">`;
  }
  return `<div class="lv-avatar-prev" data-prev>${esc(initialOf(artist))}</div>`;
}

function wireAvatar(root, artist) {
  const btn = root.querySelector('[data-act="avatar"]');
  const input = root.querySelector('[data-avatar-file]');
  const err = root.querySelector('[data-avatar-err]');
  if (!btn || !input) return;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    err.hidden = true; btn.disabled = true; btn.textContent = 'Uploading...';
    try {
      const blob = await compressAvatar(file);
      const url = await postAvatar(blob);
      const { error } = await supabase.from('artists').update({ avatar_url: url }).eq('id', artist.id);
      if (error) throw new Error(error.message);
      await refreshArtist();
      track('avatar_uploaded', {});
      const prev = root.querySelector('[data-prev]');
      if (prev) prev.outerHTML = avatarPreviewHTML(authState().artist);
      renderAccountSlots();
    } catch (e) {
      err.textContent = (e && e.message) || 'Could not set that photo.';
      err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = 'Change photo';
      input.value = '';
    }
  });
}

/* ---------------- /settings ---------------- */

export function renderSettings(container) {
  const { user, artist } = authState();
  if (!user) {
    container.innerHTML = `<div class="lv-settings"><h1>Settings</h1><p class="lv-hint">Please sign in to manage your account.</p></div>`;
    openModal();
    return;
  }
  container.innerHTML = `
    <div class="lv-settings">
      <h1>Settings <span dir="rtl" lang="he">הגדרות</span></h1>
      <div class="lv-form">${profileFields(artist)}</div>
      <label class="lv-label">Profile photo <span dir="rtl" lang="he">תמונת פרופיל</span></label>
      <div class="lv-avatar-row">
        ${avatarPreviewHTML(artist)}
        <div>
          <button class="lv-btn outlined" type="button" data-act="avatar" style="width:auto;margin-top:0;">Change photo</button>
          <p class="lv-hint">A square photo works best. It is resized to ${AVATAR_PX}px.</p>
        </div>
      </div>
      <input type="file" accept="image/*" data-avatar-file hidden>
      <p class="lv-err" data-avatar-err hidden></p>
      <p class="lv-err" data-err hidden></p>
      <p class="lv-ok" data-ok hidden>Saved.</p>
      <div class="lv-onboard-actions">
        <button class="lv-btn filled" type="button" data-act="save">Save</button>
        <button class="lv-btn ghost" type="button" data-act="signout">Sign out</button>
      </div>
      <hr class="lv-rule">
      <h2 class="lv-danger-h">Delete my account</h2>
      <p class="lv-hint">This removes your profile and takes your songs off the site. It cannot be undone.</p>
      <input class="lv-input" data-confirm type="text" placeholder="Type DELETE to confirm" dir="ltr">
      <button class="lv-btn danger" type="button" data-act="delete" disabled>Delete my account</button>
      <p class="lv-err" data-del-err hidden></p>
    </div>`;

  const errEl = container.querySelector('[data-err]');
  const okEl = container.querySelector('[data-ok]');
  wireProfileFields(container, artist);
  wireAvatar(container, artist);

  container.querySelector('[data-act="save"]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; errEl.hidden = true; okEl.hidden = true;
    try {
      await saveProfile(container, artist);
      okEl.hidden = false;
      track('settings_saved', {});
      renderAccountSlots();
    } catch (err) {
      errEl.textContent = (err && err.message) || 'Could not save.';
      errEl.hidden = false;
    } finally { btn.disabled = false; }
  });

  container.querySelector('[data-act="signout"]').addEventListener('click', async () => {
    track('sign_out', {});
    await signOut();
    location.href = '/';
  });

  const confirmInput = container.querySelector('[data-confirm]');
  const delBtn = container.querySelector('[data-act="delete"]');
  confirmInput.addEventListener('input', () => { delBtn.disabled = confirmInput.value.trim() !== 'DELETE'; });
  delBtn.addEventListener('click', async () => {
    const delErr = container.querySelector('[data-del-err]');
    delBtn.disabled = true; delErr.hidden = true;
    try {
      const { error } = await supabase.rpc('delete_my_account');
      if (error) throw error;
      track('account_deleted', {});
      // The ban does not invalidate an already-issued token, so sign out now.
      await signOut();
      location.href = '/';
    } catch (err) {
      delErr.textContent = (err && err.message) || 'Could not delete the account.';
      delErr.hidden = false;
      delBtn.disabled = false;
    }
  });
}

/* ---------------- wiring ---------------- */

let lastUserId = undefined;

function onAuth() {
  renderAccountSlots();
  const { user, artist } = authState();

  // sign_in fires once per transition into a signed-in state, not on every
  // INITIAL_SESSION replay of the same user.
  if (user && lastUserId !== user.id) {
    if (lastUserId !== undefined) {
      const method = (user.app_metadata && user.app_metadata.provider) === 'google' ? 'google' : 'email';
      track('sign_in', { method });
      const fresh = user.created_at && (Date.now() - Date.parse(user.created_at) < 60000);
      if (fresh) track('sign_up', { method });
    }
    if (artist && artist.onboarded === false) showOnboarding();
  }
  lastUserId = user ? user.id : null;

  if (location.pathname === '/settings') {
    const host = document.getElementById('settings-root');
    if (host) renderSettings(host);
  }
}

window.addEventListener('laivy:auth', onAuth);
renderAccountSlots();          // signed-out first, corrected on the first event
if (authState().ready) onAuth();

window.laivy = window.laivy || {};
window.laivy.accountUI = { openModal, closeModal, renderSettings, renderAccountSlots };
