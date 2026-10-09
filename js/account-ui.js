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

// ACT-1: the first-party activity log (js/activity.js), separate from GA4
// above. Self-guarding the same way track() is.
function logActivity(type, opts) {
  try { if (window.laivy && window.laivy.activity) window.laivy.activity.log(type, opts); }
  catch (e) { /* activity logging is best effort, same as analytics */ }
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
      <p class="lv-modal-reason" data-reason hidden></p>

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
        By continuing you agree to the <a href="/terms">Terms</a> and <a href="/privacy.html">Privacy Policy</a>.
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
      await signInWithEmail(email, modalNext);
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
    try { await signInWithGoogle(modalNext); }
    catch (err) { showErr((err && err.message) || 'Could not start Google sign-in.'); }
  });

  return modal;
}

/* Where a sign-in started from this modal should land. Null means "back where
   you were" (auth.js's default); the "Share your music" link sets '/upload'.
   `opts` may also be a click event when openModal is a listener -- only a
   string `next` counts. */
let modalNext = null;

export function openModal(opts) {
  modalNext = (opts && typeof opts.next === 'string') ? opts.next : null;
  const m = buildModal();
  const reasonEl = m.querySelector('[data-reason]');
  const reason = (opts && typeof opts.reason === 'string') ? opts.reason : '';
  reasonEl.textContent = reason;
  reasonEl.hidden = !reason;
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

// The close() of whichever chip menu is currently open, so opening one shuts
// the other. index.html renders two account slots (listen topbar + homepage).
let openChipMenu = null;

/* ---------------- "Share your music" nav link ----------------
   The contribute invitation, on every page that has an account slot (the
   /listen and homepage topbars, about, terms). Gated by the same
   site_settings.contribute_cta_enabled switch as the homepage CTA, read
   here because about/terms have no page script of their own: live first,
   then the build-time settings.json, and OFF by default so an outage can
   never show an invitation nobody can accept. It renders only once the
   switch is known to be true, so there is no flash of it when it is off. */
let contributeOn = false;
async function readContributeSwitch() {
  const norm = (v) => {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) {} }
    return v === true;
  };
  try {
    if (supabase) {
      const { data, error } = await supabase.from('site_settings')
        .select('value').eq('key', 'contribute_cta_enabled').maybeSingle();
      if (!error) return norm(data && data.value);
    }
  } catch (e) { /* fall through */ }
  try {
    const res = await fetch('/settings.json', { cache: 'no-cache' });
    if (res.ok) {
      const rows = await res.json();
      const r = Array.isArray(rows) && rows.find((x) => x && x.key === 'contribute_cta_enabled');
      return norm(r && r.value);
    }
  } catch (e) { /* defaults stand */ }
  return false;
}

function shareLink(user) {
  // Signed in it is a plain link; signed out it opens the modal and the
  // sign-in lands on /upload rather than back here.
  const a = el('a', 'nav-share', user ? 'Upload a song' : 'Share your music');
  a.href = '/upload';
  if (location.pathname === '/upload') { a.classList.add('is-current'); a.setAttribute('aria-current', 'page'); }
  a.addEventListener('click', (e) => {
    track('contribute_click', { where: 'nav', signed_in: !!user });
    if (user) return;
    e.preventDefault();
    openModal({ next: '/upload' });
  });
  return a;
}

function renderSlot(slot) {
  const { user, artist } = authState();
  // Re-rendering throws the old chip away; close its menu first so its
  // listeners are removed rather than left pointing at a detached node.
  if (openChipMenu) openChipMenu();
  slot.innerHTML = '';
  if (contributeOn) slot.appendChild(shareLink(user));

  if (!user) {
    const a = el('button', 'lv-signin-link', 'Sign in or join');
    a.type = 'button';
    a.setAttribute('aria-label', 'Sign in or join / התחברות או הצטרפות');
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

  const menu = el('div', 'lv-menu account-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  /* "My page" only points at a public page when there IS one. Since 1A-7 a
     listener (is_artist false) is absent from artists_public, so their handle
     would resolve to "Artist not found" -- linking a signed-in person to a dead
     page from their own menu is the worst version of that. They get /settings
     instead, which is the page that is actually theirs. */
  const myPage = (artist && artist.is_artist && artist.handle)
    ? `/artist/${encodeURIComponent(artist.handle)}`
    : '/settings';
  menu.innerHTML =
    `<a role="menuitem" href="${esc(myPage)}">My page</a>` +
    `<a role="menuitem" href="/upload">Upload a song</a>` +
    `<a role="menuitem" href="/settings">Settings</a>` +
    (isAdmin() ? `<a role="menuitem" href="/admin.html">Admin</a>` : '') +
    `<button role="menuitem" type="button" data-act="signout">Sign out</button>`;

  /* Dismissal. What was here before was a single document click listener added
     inside renderSlot -- which meant one more listener every time the chip
     re-rendered, none of them ever removed, all of them pointing at menus that
     had already been thrown away. There was no Escape handler at all, and
     nothing closed the menu when an item was chosen.

     The outside-click listener is registered in the CAPTURE phase so that no
     handler in between can suppress it with stopPropagation -- index.html has
     several delegated click handlers that do exactly that for their own
     targets, and this must not depend on none of them ever matching. Rather
     than deferring the attach by a tick, the chip and the menu are simply
     excluded from the target test, which is the same guarantee without a
     timer. Both listeners go on at open and come off at close, so nothing
     leaks. */
  let onDocClick = null, onKeydown = null;

  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
    if (onDocClick) { document.removeEventListener('click', onDocClick, true); onDocClick = null; }
    if (onKeydown) { document.removeEventListener('keydown', onKeydown, true); onKeydown = null; }
    if (openChipMenu === closeMenu) openChipMenu = null;
  }

  function openMenu() {
    if (!menu.hidden) return;
    // Only one chip menu at a time: index.html has two account slots.
    if (openChipMenu) openChipMenu();
    menu.hidden = false;
    chip.setAttribute('aria-expanded', 'true');
    openChipMenu = closeMenu;

    onDocClick = (e) => {
      // The opening click itself lands on the chip, so excluding the chip (and
      // the menu, so choosing an item is handled by its own listener) is what
      // stops this from closing the menu the instant it opens.
      if (chip.contains(e.target) || menu.contains(e.target)) return;
      closeMenu();
    };
    onKeydown = (e) => {
      if (e.key === 'Escape') { closeMenu(); try { chip.focus(); } catch (err) {} }
    };
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeydown, true);
  }

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu(); else closeMenu();   // re-click toggles shut
  });

  // Any item closes it: the three links navigate, and on a client-side route
  // (My page / Settings are pushState routes) there is no reload to do it.
  menu.querySelectorAll('[role="menuitem"]').forEach((item) => {
    item.addEventListener('click', () => closeMenu());
  });

  menu.querySelector('[data-act="signout"]').addEventListener('click', async () => {
    closeMenu();
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
      ${artist && artist.is_artist === false ? `<p class="lv-hint lv-notyet">
        Your page goes live when your first song is approved.
        <span dir="rtl" lang="he">העמוד שלך יעלה לאוויר כשהשיר הראשון שלך יאושר.</span>
      </p>` : ''}
      <p class="lv-err" data-err hidden></p>
      <p class="lv-ok" data-ok hidden>Saved.</p>
      <div class="lv-onboard-actions">
        <button class="lv-btn filled" type="button" data-act="save">Save</button>
        <button class="lv-btn ghost" type="button" data-act="signout">Sign out</button>
      </div>

      <hr class="lv-rule">
      <h2 class="lv-section-h">My songs</h2>
      <p class="lv-hint">Editing sends a song back for review and takes it off the site until it is re-approved.</p>
      <div id="lv-mysongs-list"><p class="lv-hint">Loading&hellip;</p></div>

      ${(artist && artist.is_artist) ? `
      <hr class="lv-rule">
      <h2 class="lv-section-h">My picks</h2>
      <div class="lv-pick-search">
        <input class="lv-input" id="lv-pick-search-input" type="text" placeholder="Search a title to add&hellip;" autocomplete="off">
        <div class="lv-pick-results" id="lv-pick-search-results"></div>
      </div>
      <p class="lv-err" data-pick-err hidden></p>
      <div id="lv-mypicks-list"><p class="lv-hint">Loading&hellip;</p></div>
      ` : ''}

      <hr class="lv-rule">
      <h2 class="lv-section-h">Following</h2>
      <div id="lv-following-list"><p class="lv-hint">Loading&hellip;</p></div>

      <hr class="lv-rule">
      <h2 class="lv-section-h">My dedications</h2>
      <div id="lv-dedications-list"><p class="lv-hint">Loading&hellip;</p></div>

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
  renderMySongs(container, artist);
  if (artist && artist.is_artist) renderMyPicks(container, artist);
  renderFollowing(container, user);
  renderMyDedications(container);

  container.querySelector('[data-act="save"]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; errEl.hidden = true; okEl.hidden = true;
    try {
      await saveProfile(container, artist);
      // saveProfile() -> refreshArtist() -> a fresh laivy:auth event ->
      // renderSettings() runs AGAIN (so My songs/My picks/Following reload
      // against the saved profile too) and replaces this whole container's
      // innerHTML -- including okEl/errEl, which detaches the ones closed
      // over above. Re-query the live ones so "Saved." lands on an element
      // actually still in the document, not a stale reference.
      const freshOk = container.querySelector('[data-ok]');
      if (freshOk) freshOk.hidden = false;
      track('settings_saved', {});
    } catch (err) {
      const freshErr = container.querySelector('[data-err]');
      if (freshErr) { freshErr.textContent = (err && err.message) || 'Could not save.'; freshErr.hidden = false; }
    } finally {
      const freshBtn = container.querySelector('[data-act="save"]');
      if (freshBtn) freshBtn.disabled = false;
    }
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

/* ---------------- My songs (ARTIST-3) ----------------
   Moved here from /artist/<handle>, which used to carry two separate
   owner-only lists (the published Edit/Withdraw row, and a "Not yet public"
   draft/pending list). One query, every status, one render -- the artist
   page now keeps only its "Edit page" link to here. */
const STATUS_LABEL = { draft: 'Draft', submitted: 'Awaiting review', rejected: 'Needs changes', removed: 'Removed' };

function wireWithdraw(scope) {
  scope.querySelectorAll('[data-withdraw]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('Take this song off the site? You can submit it again later.')) return;
      btn.disabled = true;
      try {
        const { error } = await supabase.from('songs').update({ status: 'removed' }).eq('id', btn.dataset.withdraw);
        if (error) throw error;
        btn.textContent = 'Withdrawn';
        const pill = btn.closest('.artist-private-row') && btn.closest('.artist-private-row').querySelector('.artist-private-pill');
        if (pill) { pill.hidden = false; pill.dataset.status = 'removed'; pill.textContent = STATUS_LABEL.removed; }
      } catch (err) {
        alert('Could not withdraw: ' + (err && err.message));
        btn.disabled = false;
      }
    });
  });
}

async function renderMySongs(container, artist) {
  const host = container.querySelector('#lv-mysongs-list');
  if (!host || !artist) return;
  let rows = [];
  try {
    const { data, error } = await supabase.from('songs')
      .select('id, title, title_translit, status, created_at')
      .eq('artist_id', artist.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    rows = data || [];
  } catch (e) {
    host.innerHTML = `<p class="lv-hint">Could not load your songs right now.</p>`;
    return;
  }

  // The latest rejection reason per rejected song (same as the old artist-page list).
  const reasons = {};
  const rejected = rows.filter((r) => r.status === 'rejected').map((r) => r.id);
  if (rejected.length) {
    try {
      const { data } = await supabase.from('reviews')
        .select('song_id, decision, reason, created_at')
        .in('song_id', rejected).order('created_at', { ascending: false });
      (data || []).forEach((v) => {
        if (!(v.song_id in reasons)) reasons[v.song_id] = v.decision === 'reject' ? (v.reason || 'No reason was given.') : null;
      });
    } catch (e) { /* the pill still says Needs changes; the edit form shows the reason */ }
  }

  if (!rows.length) {
    host.innerHTML = `<p class="artist-private-empty">Nothing yet. Anything you save as a draft, submit, or publish shows up here.</p>`;
    return;
  }
  host.innerHTML = rows.map((r) => `
    <div class="artist-private-row${reasons[r.id] ? ' has-reason' : ''}">
      <span class="artist-private-title">${esc(r.title || r.title_translit || 'Untitled')}</span>
      <span class="artist-private-pill" data-status="${esc(r.status)}"${r.status === 'approved' ? ' hidden' : ''}>${esc(STATUS_LABEL[r.status] || r.status)}</span>
      <span class="artist-private-act-row">
        <a class="artist-private-act" href="/upload?song=${encodeURIComponent(r.id)}">Edit</a>
        ${r.status !== 'removed' ? `<button type="button" class="artist-private-act is-warn" data-withdraw="${esc(r.id)}">Withdraw</button>` : ''}
      </span>
      ${reasons[r.id] ? `<details class="artist-private-reason"><summary>Why</summary><p>${esc(reasons[r.id])}</p></details>` : ''}
    </div>`).join('');
  wireWithdraw(host);
}

/* ---------------- My picks (ARTIST-3, artists only) ----------------
   "Reuse the existing search": same EXPERIENCE (debounced, live results) as
   the site's search box, not literally the same in-memory index -- that
   index lives in index.html's classic (non-module) script scope, which an
   ES module cannot see, and SONGS there carries no `status` field to filter
   on anyway (it only ever holds approved rows for an anonymous read). A
   direct, explicitly `status=eq.approved` query is simpler and cannot drift
   from that invariant. */
const PICK_MAX = 6;

async function searchApprovedSongsByTitle(q) {
  const term = (q || '').trim();
  if (term.length < 2) return [];
  try {
    const { data, error } = await supabase.from('songs')
      .select('id, title, title_translit, language, artist:artists_public!songs_artist_id_fkey(display_name, handle)')
      .eq('status', 'approved')
      .or(`title.ilike.%${term}%,title_translit.ilike.%${term}%`)
      .order('title')
      .limit(8);
    if (error) throw error;
    return data || [];
  } catch (e) { return []; }
}

async function renderMyPicks(container, artist) {
  const section = container; // the whole settings container; ids are unique on the page
  const searchInput = section.querySelector('#lv-pick-search-input');
  const searchResults = section.querySelector('#lv-pick-search-results');
  const list = section.querySelector('#lv-mypicks-list');
  const errEl = section.querySelector('[data-pick-err]');
  if (!searchInput || !list) return;

  const showErr = (m) => { if (errEl) { errEl.textContent = m || ''; errEl.hidden = !m; } };

  async function loadPicks() {
    try {
      const { data, error } = await supabase.from('artist_picks')
        .select('id, song_id, note, position, songs(title, title_translit, language, artist:artists_public!songs_artist_id_fkey(display_name, handle))')
        .eq('artist_id', artist.id)
        .order('position');
      if (error) throw error;
      return data || [];
    } catch (e) { return null; }
  }

  async function paint() {
    const picks = await loadPicks();
    if (picks === null) { list.innerHTML = `<p class="lv-hint">Could not load your picks right now.</p>`; return; }
    if (!picks.length) {
      list.innerHTML = `<p class="lv-hint">Pick up to six songs, yours or anyone's, and say why.</p>`;
      return;
    }
    list.innerHTML = picks.map((p) => {
      const song = p.songs || {};
      const by = (song.artist && (song.artist.display_name || song.artist.handle)) || '';
      const title = song.title || song.title_translit || 'Untitled';
      return `<div class="lv-pick-row" data-pick-id="${esc(p.id)}" data-position="${p.position}">
          <div class="lv-pick-head">
            <div class="lv-pick-main">
              <span class="lv-pick-title">${esc(title)}</span>
              ${by ? `<span class="lv-pick-by">by ${esc(by)}</span>` : ''}
            </div>
            <div class="lv-pick-reorder">
              <button type="button" class="lv-pick-move" data-dir="up" aria-label="Move up">&uarr;</button>
              <button type="button" class="lv-pick-move" data-dir="down" aria-label="Move down">&darr;</button>
            </div>
          </div>
          <textarea class="lv-input lv-textarea lv-pick-note" maxlength="140" rows="2" placeholder="Why this song? (optional)">${esc(p.note || '')}</textarea>
          <p class="lv-hint"><span data-pick-count>${(p.note || '').length}</span>/140</p>
          <button type="button" class="lv-btn outlined lv-pick-remove">Remove</button>
        </div>`;
    }).join('');

    const rowEls = Array.from(list.querySelectorAll('.lv-pick-row'));
    rowEls.forEach((row, i) => {
      const pickId = row.dataset.pickId;
      const note = row.querySelector('.lv-pick-note');
      const count = row.querySelector('[data-pick-count]');
      note.addEventListener('input', () => { count.textContent = String(note.value.length); });
      note.addEventListener('change', async () => {
        try {
          const { error } = await supabase.from('artist_picks').update({ note: note.value.trim() || null }).eq('id', pickId);
          if (error) throw error;
          showErr('');
        } catch (e) { showErr((e && e.message) || 'Could not save that note.'); }
      });
      row.querySelector('.lv-pick-remove').addEventListener('click', async () => {
        try {
          const { error } = await supabase.from('artist_picks').delete().eq('id', pickId);
          if (error) throw error;
          showErr('');
          await paint();
        } catch (e) { showErr((e && e.message) || 'Could not remove that pick.'); }
      });
      row.querySelectorAll('.lv-pick-move').forEach((btn) => {
        if ((btn.dataset.dir === 'up' && i === 0) || (btn.dataset.dir === 'down' && i === rowEls.length - 1)) {
          btn.disabled = true;
          return;
        }
        btn.addEventListener('click', async () => {
          const otherRow = btn.dataset.dir === 'up' ? rowEls[i - 1] : rowEls[i + 1];
          if (!otherRow) return;
          try {
            const { error } = await supabase.rpc('swap_my_pick_positions', {
              p_pos_a: Number(row.dataset.position), p_pos_b: Number(otherRow.dataset.position),
            });
            if (error) throw error;
            showErr('');
            await paint();
          } catch (e) { showErr((e && e.message) || 'Could not reorder that.'); }
        });
      });
    });
  }

  let searchDebounce;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(async () => {
      const q = searchInput.value;
      const results = await searchApprovedSongsByTitle(q);
      if (!results.length) { searchResults.innerHTML = ''; return; }
      searchResults.innerHTML = results.map((s) => {
        const title = s.title || s.title_translit || 'Untitled';
        const by = (s.artist && (s.artist.display_name || s.artist.handle)) || '';
        return `<button type="button" class="lv-pick-result" data-song-id="${esc(s.id)}">${esc(title)}${by ? ` <span class="lv-pick-by">by ${esc(by)}</span>` : ''}</button>`;
      }).join('');
      searchResults.querySelectorAll('[data-song-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const current = await loadPicks();
            const nextPos = (current ? current.length : 0) + 1;
            const { error } = await supabase.from('artist_picks')
              .insert({ artist_id: artist.id, song_id: btn.dataset.songId, position: nextPos });
            if (error) throw error;
            showErr('');
            searchInput.value = '';
            searchResults.innerHTML = '';
            await paint();
          } catch (e) {
            // The trigger's own words: the picks_max cap, or an unpublished song.
            showErr((e && e.message) || 'Could not add that pick.');
            btn.disabled = false;
          }
        });
      });
    }, 300);
  });

  await paint();
}

/* ---------------- Following (ARTIST-3) ----------------
   Read under the signed-in user's own RLS (artist_follows_select_own) --
   this is the one place that policy exists for. Unfollow reuses
   follow_artist(p_on:false), the same RPC the artist page's button calls. */
async function renderFollowing(container, user) {
  const host = container.querySelector('#lv-following-list');
  if (!host || !user) return;
  try {
    const { data, error } = await supabase.from('artist_follows').select('artist_id').eq('follower_user_id', user.id);
    if (error) throw error;
    const ids = (data || []).map((r) => r.artist_id);
    if (!ids.length) { host.innerHTML = `<p class="lv-hint">You are not following anyone yet.</p>`; return; }
    const { data: arows, error: aerr } = await supabase.from('artists_public')
      .select('id, handle, display_name, avatar_url').in('id', ids);
    if (aerr) throw aerr;
    host.innerHTML = (arows || []).map((a) => `
      <div class="lv-following-row" data-artist-id="${esc(a.id)}">
        ${a.avatar_url
          ? `<img class="lv-following-avatar" src="${esc('https://wsrv.nl/?url=' + encodeURIComponent(a.avatar_url) + '&w=72&output=jpg&q=80')}" alt="">`
          : `<div class="lv-following-avatar is-initial">${esc(initialOf(a))}</div>`}
        <a class="lv-following-name" href="/artist/${encodeURIComponent(a.handle)}">${esc(a.display_name || a.handle)}</a>
        <button type="button" class="lv-btn outlined lv-following-unfollow" data-unfollow="${esc(a.id)}">Unfollow</button>
      </div>`).join('');
    host.querySelectorAll('[data-unfollow]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const { error } = await supabase.rpc('follow_artist', { p_artist_id: btn.dataset.unfollow, p_on: false });
          if (error) throw error;
          const row = btn.closest('.lv-following-row');
          if (row) row.remove();
          if (!host.querySelector('.lv-following-row')) host.innerHTML = `<p class="lv-hint">You are not following anyone yet.</p>`;
        } catch (e) {
          alert('Could not unfollow: ' + (e && e.message));
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    host.innerHTML = `<p class="lv-hint">Could not load your Following list right now.</p>`;
  }
}

/* ---------------- My dedications (DED-2) ----------------
   my_dedications() (sql/022_dedications.sql): the sender's own, any status,
   newest first. Open goes to the real /d/<code> page; Remove calls
   remove_my_dedication(), the sender's own removal path -- the same RPC
   the dedication page itself could call, just reached from here instead.
   DED_OCCASION_LABEL/SITE_ORIGIN are duplicated from index.html: this
   module and that page share no import, the same reasoning TROPHY_LABELS
   already documents in middleware.js. */
const SITE_ORIGIN = 'https://laivyhart.com';
const DED_OCCASION_LABEL = {
  birthday: 'Birthday', wedding: 'Wedding', anniversary: 'Anniversary',
  bar_bat_mitzvah: 'Bar or Bat Mitzvah', new_baby: 'New baby',
  refuah_shleimah: 'Refuah shleimah', in_memory: 'In memory of',
  thank_you: 'Thank you', just_because: 'Just because', other: null,
};
function dedOccasionLabel(occasion, occasionOther) {
  return occasion === 'other' ? (occasionOther || 'Other') : (DED_OCCASION_LABEL[occasion] || occasion);
}
function fmtDedDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch (e) { return ''; }
}

async function renderMyDedications(container) {
  const host = container.querySelector('#lv-dedications-list');
  if (!host) return;
  try {
    const { data, error } = await supabase.rpc('my_dedications');
    if (error) throw error;
    if (!data || !data.length) { host.innerHTML = `<p class="lv-hint">You haven't dedicated a song yet.</p>`; return; }
    host.innerHTML = data.map((d) => `
      <div class="lv-ded-row" data-code="${esc(d.code)}">
        <div class="lv-ded-main">
          <span class="lv-ded-recipient">For ${esc(d.recipient_name)}</span>
          <span class="lv-ded-meta">${esc(dedOccasionLabel(d.occasion, d.occasion_other))} &middot; ${esc(d.song_title || '')} &middot; ${esc(fmtDedDate(d.created_at))}</span>
        </div>
        <span class="lv-ded-status${d.status === 'removed' ? ' is-removed' : ''}">${d.status === 'removed' ? 'Removed' : 'Live'}</span>
        <div class="lv-ded-actions">
          ${d.status === 'live' ? `<a class="lv-btn outlined" href="/d/${encodeURIComponent(d.code)}" target="_blank" rel="noopener">Open</a>` : ''}
          ${d.status === 'live' ? `<button type="button" class="lv-btn outlined" data-ded-copy="${esc(d.code)}">Copy link</button>` : ''}
          ${d.status === 'live' ? `<button type="button" class="lv-btn outlined" data-ded-remove="${esc(d.code)}">Remove</button>` : ''}
        </div>
      </div>`).join('');

    host.querySelectorAll('[data-ded-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const url = SITE_ORIGIN + '/d/' + encodeURIComponent(btn.dataset.dedCopy);
        try { await navigator.clipboard.writeText(url); }
        catch (e) { window.prompt('Copy this link:', url); }
      });
    });
    host.querySelectorAll('[data-ded-remove]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!window.confirm('Remove this dedication? This cannot be undone.')) return;
        btn.disabled = true;
        try {
          const { error } = await supabase.rpc('remove_my_dedication', { p_code: btn.dataset.dedRemove });
          if (error) throw error;
          const row = btn.closest('.lv-ded-row');
          if (row) {
            const statusEl = row.querySelector('.lv-ded-status');
            statusEl.textContent = 'Removed';
            statusEl.classList.add('is-removed');
            row.querySelector('.lv-ded-actions').innerHTML = '';
          }
        } catch (e) {
          alert('Could not remove: ' + (e && e.message));
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    host.innerHTML = `<p class="lv-hint">Could not load your dedications right now.</p>`;
  }
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
      logActivity('sign_in', { meta: { method } });
      const fresh = user.created_at && (Date.now() - Date.parse(user.created_at) < 60000);
      if (fresh) { track('sign_up', { method }); logActivity('sign_up', { meta: { method } }); }
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
readContributeSwitch().then((on) => { contributeOn = on; if (on) renderAccountSlots(); });
if (authState().ready) onAuth();

window.laivy = window.laivy || {};
window.laivy.accountUI = { openModal, closeModal, renderSettings, renderAccountSlots };
