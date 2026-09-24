/* ============================================================
   /upload — the contributor song form (1B-2).

   The admin form minus every admin power: no featured flags, no artist
   picker, no status controls, no reach into anyone else's song. Everything
   that makes a submission safe already lives in the database (1B-1): the
   guard trigger runs the caps, stamps submitted_at, flips is_artist and logs
   the event. This form's job is to be honest about the rules and to surface
   the database's own messages when it refuses.

   Two actions:
     Save for later  status='draft'   — no transliteration, no checkbox needed
     Submit for review status='submitted' — full validation, then the triggers

   Submit runs in a fixed order: validate -> upload -> write -> transition.
   Cheap checks first, so a missing transliteration never costs a 20 MB
   upload; the upload before any row is touched; the content (with the new
   media URLs) written as a draft; and only then the status flip, so a refusal
   from the guard (caps, account age) leaves a saved draft, not lost uploads.

   The form is English-only, like the rating row; the rest of the site chrome
   stays bilingual.

   Media goes to the Worker's JWT routes with the session's access token:
   /upload/audio -> songs/<sub>/, /upload/cover -> covers/<sub>/. The admin's
   UPLOAD_TOKEN is never involved and a contributor never holds it.
   ============================================================ */
import { supabase, refreshArtist } from './auth.js';
import { compressImage, readAudioDuration } from './media-utils.js';

const R2_UPLOAD_URL = 'https://laivyhart-audio-upload.ytweiser-399.workers.dev';
const AUDIO_MAX_BYTES = 20 * 1024 * 1024;         // mirrors the Worker
const COVER_MAX_BYTES = 512 * 1024;
const AUDIO_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav'];

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let CHANNELS = [];
let current = null;          // the song being edited, or a blank
let pendingAudio = null;
let pendingCover = null;
let lastReason = null;
let audioName = null;        // the original name of a file uploaded this session
let pendingAudioDur = null;  // read from the pending File as soon as it is picked
let objUrls = [];            // object URLs for pending-file previews; revoked on repaint

function authUser() {
  return (window.laivy && window.laivy.auth && window.laivy.auth.user) || null;
}

async function accessToken() {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return (data && data.session && data.session.access_token) || null;
  } catch (e) { return null; }
}

async function loadChannels() {
  try {
    const { data, error } = await supabase
      .from('channels').select('id,title,sort_order,active').order('sort_order');
    if (!error && Array.isArray(data)) { CHANNELS = data.filter((c) => c.active !== false); return; }
  } catch (e) { /* fall through */ }
  try {
    const res = await fetch('/channels.json', { cache: 'no-cache' });
    if (res.ok) {
      const rows = await res.json();
      if (Array.isArray(rows)) CHANNELS = rows.filter((c) => c.active !== false);
    }
  } catch (e) { CHANNELS = []; }
}

function blankSong(uid) {
  return {
    id: null, artist_id: uid, title: '', title_translit: '', language: 'Hebrew',
    lyrics_original: '', lyrics_translation: '', about: '',
    audio_url: '', cover_url: null, status: 'draft',
    proposed_channels: [], proposed_tags: [],
  };
}

/* The latest rejection reason, if this song was rejected. `reviews` is
   readable by the song's own artist, so this needs no special path. */
async function loadRejectionReason(songId) {
  if (!songId || !supabase) return null;
  try {
    const { data, error } = await supabase
      .from('reviews').select('decision, reason, created_at')
      .eq('song_id', songId).order('created_at', { ascending: false }).limit(1);
    if (error || !Array.isArray(data) || !data.length) return null;
    return data[0].decision === 'reject' ? (data[0].reason || 'No reason was given.') : null;
  } catch (e) { return null; }
}

/* ---------------- validation ---------------- */

const isHebrewTitle = (s) => /[֐-׿]/.test(s.title || '');

/* Every validation message has a home next to the field it is about. The map
   is keyed by the message itself so the validators can stay plain string
   lists (and stay easy to test). */
const E = {
  title: 'A title is needed.',
  draftTitle: 'A title is needed, even for a draft.',
  audio: 'An audio file is needed.',
  translit: 'A transliteration is needed for a Hebrew title, so your song gets a readable web address.',
  agree: 'Please confirm the statement and the Terms.',
};
export const ERROR_FIELD = {
  [E.title]: 'title', [E.draftTitle]: 'title', [E.audio]: 'audio',
  [E.translit]: 'translit', [E.agree]: 'agree',
};

/* Draft rules are deliberately looser than submit rules: a draft is a
   scratchpad, and demanding a transliteration before someone has even chosen
   a file would be the wrong moment to ask. */
/* `hasPendingAudio`: a file chosen in this form counts, because Submit
   uploads it before it transitions. Audio is required as "already uploaded
   OR about to be uploaded by this same click". */
export function validateForSubmit(song, agreed, hasPendingAudio = false) {
  const errs = [];
  if (!(song.title || '').trim()) errs.push(E.title);
  if (!(song.audio_url || '').trim() && !hasPendingAudio) errs.push(E.audio);
  if (isHebrewTitle(song) && !(song.title_translit || '').trim()) errs.push(E.translit);
  if (!agreed) errs.push(E.agree);
  return errs;
}
export function validateForDraft(song) {
  return (song.title || '').trim() ? [] : [E.draftTitle];
}

/* ---------------- media ---------------- */

/* XHR rather than fetch: fetch still cannot report upload progress, and a
   6 MB file on a phone connection is long enough that a bar matters. */
async function uploadMedia(kind, blob, contentType, onProgress) {
  const token = await accessToken();
  if (!token) throw new Error('Your session has expired. Sign in again.');
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${R2_UPLOAD_URL}/upload/${kind}`);
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.setRequestHeader('Content-Type', contentType);
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    }
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch (e) { /* non-JSON error */ }
      if (xhr.status >= 200 && xhr.status < 300 && body && body.url) resolve(body.url);
      else reject(new Error((body && body.error) || `Upload failed (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('The upload was interrupted. Check your connection and try again.'));
    xhr.send(blob);
  });
}

/* ---------------- save ---------------- */

async function stampTermsIfNeeded(uid) {
  try {
    const { data } = await supabase.from('site_settings')
      .select('value').eq('key', 'terms_current_version').maybeSingle();
    const want = data && data.value;
    if (!want) return;
    const a = (window.laivy.auth && window.laivy.auth.artist) || {};
    if (a.terms_version === want) return;
    await supabase.from('artists')
      .update({ terms_version: want, terms_accepted_at: new Date().toISOString() })
      .eq('id', uid);
  } catch (e) { /* consent stamping must never block a submission */ }
}

/* Statuses a contributor's row can be written back to 'draft' from. The guard
   refuses approved -> draft, and pulling a 'submitted' song back to draft would
   drop it out of the queue, so those two are written straight to 'submitted'. */
const DRAFTABLE = new Set(['draft', 'rejected', 'removed']);

/* `hooks` is either a status callback (text) or
   { status(text), progress(kind, { name, size, loaded, total, done }) }. */
export async function saveSong(mode, form, hooks) {
  const h = typeof hooks === 'function' ? { status: hooks } : (hooks || {});
  const status = (t) => { if (h.status) h.status(t); };
  const progress = (kind, p) => { if (h.progress) h.progress(kind, p); };

  const uid = authUser() && authUser().id;
  if (!uid) throw new Error('Please sign in.');

  // 1. Validate — cheap checks only, before any byte is uploaded.
  const song = { ...current, ...form };
  const errs = mode === 'submit' ? validateForSubmit(song, form.agreed, !!pendingAudio) : validateForDraft(song);
  if (errs.length) return { errors: errs };

  // 2. Upload. Media first: a failed upload must not leave a half-saved row
  //    behind, and on Submit it must not transition anything.
  let kind = null;
  try {
    if (pendingAudio) {
      kind = 'audio';
      const f = pendingAudio, meta = { name: f.name, size: f.size };
      progress('audio', { ...meta, loaded: 0, total: f.size });
      song.audio_url = await uploadMedia('audio', f, f.type || 'audio/mpeg',
        (loaded, total) => progress('audio', { ...meta, loaded, total }));
      progress('audio', { ...meta, loaded: f.size, total: f.size, done: true });
      audioName = f.name;
      const d = pendingAudioDur || await readAudioDuration(f);
      if (d) song.duration_seconds = d;
    }
    if (pendingCover) {
      kind = 'cover';
      let blob = pendingCover, ctype = 'image/jpeg';
      try { const c = await compressImage(pendingCover, 1600, 0.82); if (c) blob = c; }
      catch (e) { /* send the original if compression fails */ }
      const meta = { name: pendingCover.name, size: blob.size };
      progress('cover', { ...meta, loaded: 0, total: blob.size });
      song.cover_url = await uploadMedia('cover', blob, ctype,
        (loaded, total) => progress('cover', { ...meta, loaded, total }));
      progress('cover', { ...meta, loaded: blob.size, total: blob.size, done: true });
    }
  } catch (e) {
    const why = (e && e.message) || 'The upload failed.';
    // Whatever uploaded before the failure is still on the song object; keep
    // it so the retry does not send it twice.
    if (kind === 'cover' && song.audio_url !== current.audio_url) {
      current.audio_url = song.audio_url; current.duration_seconds = song.duration_seconds;
      pendingAudio = null;
    }
    const note = mode !== 'submit' ? 'Nothing was saved. Please try again.'
      : current.id ? 'Nothing was submitted; your song is unchanged. Please try again.'
      : 'Nothing was submitted or saved. Please try again.';
    return { errors: [why, note], uploadFailed: kind };
  }

  const payload = {
    title: (song.title || '').trim(),
    title_translit: (song.title_translit || '').trim() || null,
    language: song.language,
    lyrics_original: song.lyrics_original || '',
    lyrics_translation: song.lyrics_translation || null,
    about: song.about || null,
    audio_url: song.audio_url || null,
    proposed_channels: song.proposed_channels || [],
    proposed_tags: song.proposed_tags || [],
    status: mode === 'submit' ? 'submitted' : 'draft',
  };
  if (song.cover_url) payload.cover_url = song.cover_url;
  if (song.duration_seconds) payload.duration_seconds = song.duration_seconds;

  // Editing an APPROVED song always goes back to review (the 1B-1 relaxation);
  // the guard refuses a content edit that tries to stay approved.
  if (current.id && current.status === 'approved') payload.status = 'submitted';

  // A submit on a new or draft-like row writes the content as a draft first
  // and transitions in a second call (step 4).
  const twoStep = mode === 'submit' && (!current.id || DRAFTABLE.has(current.status));
  const finalStatus = payload.status;
  if (twoStep) payload.status = 'draft';

  // 3. Write.
  status('Saving…');
  let error, saved = current.id;
  if (current.id) {
    ({ error } = await supabase.from('songs').update(payload).eq('id', current.id));
  } else {
    payload.artist_id = uid;
    payload.source = 'uploaded';
    const res = await supabase.from('songs').insert(payload).select('id').single();
    error = res.error;
    if (!error && res.data) saved = res.data.id;
  }
  // The database's own message is the message: the caps, the translit rule and
  // the locked columns all speak for themselves, and rewording them here would
  // only ever make them less accurate.
  if (error) return { errors: [error.message], db: true };

  // The row now holds the uploaded media, so a retry must neither insert a
  // second row nor upload the same files again.
  Object.assign(current, payload, { id: saved });
  pendingAudio = null; pendingCover = null; pendingAudioDur = null;

  // 4. Transition.
  if (twoStep) {
    status('Submitting for review…');
    ({ error } = await supabase.from('songs').update({ status: finalStatus }).eq('id', saved));
    if (error) return { id: saved, db: true, errors: [error.message, 'Your song was saved for later; it was not submitted.'] };
    current.status = finalStatus;
  }

  if (finalStatus === 'submitted') await stampTermsIfNeeded(uid);
  return { id: saved, status: finalStatus };
}

export async function withdrawSong(songId) {
  const { error } = await supabase.from('songs').update({ status: 'removed' }).eq('id', songId);
  if (error) throw new Error(error.message);
}

/* ---------------- file cards ---------------- */

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const kb = (n) => (n >= 1048576 ? mb(n) : `${Math.max(1, Math.round(n / 1024))} KB`);
export function fmtDuration(sec) {
  const n = Math.round(Number(sec) || 0);
  if (!n) return '';
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
let urlFor = new WeakMap();   // one object URL per pending File, however often it repaints
function objUrl(file) {
  if (urlFor.has(file)) return urlFor.get(file);
  try { const u = URL.createObjectURL(file); objUrls.push(u); urlFor.set(file, u); return u; } catch (e) { return ''; }
}
function revokeFor(file) {
  const u = file && urlFor.get(file);
  if (!u) return;
  try { URL.revokeObjectURL(u); } catch (e) {}
  urlFor.delete(file); objUrls = objUrls.filter((x) => x !== u);
}
function revokeObjUrls() {
  objUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) {} });
  objUrls = []; urlFor = new WeakMap();
}
const extOf = (url) => ((/\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(url || '') || [])[1] || '').toLowerCase();

/* Uploaded files are stored under random names, so a reopened song has no
   original file name to show. The song's own title stands in for it. */
function uploadedAudioName() {
  if (audioName) return audioName;
  const ext = extOf(current.audio_url);
  return `${(current.title || '').trim() || 'Your song'}${ext ? '.' + ext : ''}`;
}

const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>';

function audioCardHTML() {
  const pending = !!pendingAudio;
  const src = pending ? objUrl(pendingAudio) : current.audio_url;
  const name = pending ? pendingAudio.name : uploadedAudioName();
  const dur = fmtDuration(pending ? pendingAudioDur : current.duration_seconds);
  const meta = [dur, pending ? mb(pendingAudio.size) : ''].filter(Boolean).join(' · ');
  return `<div class="u-file-card" data-state="${pending ? 'pending' : 'uploaded'}">
      <button type="button" class="u-play" aria-label="Play">${PLAY_SVG}</button>
      <div class="u-file-main">
        <div class="u-file-name">${esc(name)}</div>
        <div class="u-file-meta">${esc(meta)}</div>
        <div class="u-file-state">${pending ? 'Ready to upload' : 'Uploaded ✓'}</div>
        <div class="u-progress" hidden><div class="u-progress-fill"></div></div>
      </div>
      <button type="button" class="u-replace">Replace</button>
      <audio preload="none" src="${esc(src)}"></audio>
    </div>`;
}

function platePreviewHTML(title) {
  const s = { title: title || 'Your song', title_translit: '', id: 'upload-preview' };
  // defaultCoverHTML lives in index.html's page script (the shared no-cover
  // plate); a plain tile stands in if this module is loaded without it.
  if (typeof window.defaultCoverHTML === 'function') return window.defaultCoverHTML(s, 'u-cover-thumb');
  return `<div class="u-cover-thumb cover-plate"></div>`;
}

function coverCardHTML(title) {
  const pending = !!pendingCover;
  if (!pending && !current.cover_url) return '';
  const src = pending ? objUrl(pendingCover) : current.cover_url;
  return `<div class="u-file-card is-cover" data-state="${pending ? 'pending' : 'uploaded'}">
      <img class="u-cover-thumb" src="${esc(src)}" alt="">
      <div class="u-file-main">
        <div class="u-file-name">${esc(pending ? pendingCover.name : 'Cover image')}</div>
        <div class="u-file-state">${pending ? 'Ready to upload' : 'Uploaded ✓'}</div>
        <div class="u-progress" hidden><div class="u-progress-fill"></div></div>
      </div>
      <button type="button" class="u-replace">Replace</button>
    </div>`;
}

/* ---------------- render ---------------- */

function fieldsFromDom(root) {
  const g = (id) => root.querySelector('#' + id);
  return {
    title: g('u-title').value,
    title_translit: g('u-translit').value,
    language: g('u-language').value,
    lyrics_original: g('u-lyrics').value,
    lyrics_translation: g('u-translation').value,
    about: g('u-about').value,
    proposed_channels: [...root.querySelectorAll('.u-chan.on')].map((e) => e.dataset.channel),
    proposed_tags: (g('u-tags').value || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
    agreed: !!(g('u-agree') && g('u-agree').checked),
  };
}

function myPageHref() {
  const a = (window.laivy && window.laivy.auth && window.laivy.auth.artist) || {};
  // Submitting flips is_artist in the database, so a handle is enough here.
  return a.handle ? `/artist/${encodeURIComponent(a.handle)}` : '/settings';
}

function renderSubmitted(container) {
  revokeObjUrls();
  container.innerHTML = `
    <div class="upload-wrap upload-done" id="u-done">
      <h1>Submitted.</h1>
      <p class="upload-sub">Laivy Hart listens to every song personally; you'll see the result on your page.</p>
      <div class="u-actions">
        <a class="home-primary-btn filled" id="u-mypage" href="${esc(myPageHref())}">Go to my page</a>
        <a class="home-primary-btn outlined" id="u-another" href="/upload">Upload another</a>
      </div>
    </div>`;
  container.querySelector('#u-another').addEventListener('click', (e) => {
    e.preventDefault();
    try { history.pushState({ route: 'upload' }, '', '/upload'); } catch (err) {}
    renderUploadPage(container);
  });
  // The chip menu's "My page" and this button both want the fresh is_artist.
  (async () => {
    try {
      await refreshArtist();
      const a = container.querySelector('#u-mypage');
      if (a) a.href = myPageHref();
      if (window.laivy.accountUI) window.laivy.accountUI.renderAccountSlots();
    } catch (err) { /* the link already works via /settings */ }
  })();
  try { window.scrollTo(0, 0); } catch (err) {}
}

export async function renderUploadPage(container, songId) {
  if (!container) return;
  const user = authUser();
  if (!user) {
    container.innerHTML = `<div class="upload-wrap"><h1>Share your music</h1>
      <p class="upload-note">Please sign in to upload a song.</p></div>`;
    if (window.laivy && window.laivy.accountUI) window.laivy.accountUI.openModal();
    return;
  }

  container.innerHTML = `<div class="upload-wrap"><p class="artist-loading">Loading&hellip;</p></div>`;
  if (!CHANNELS.length) await loadChannels();

  current = blankSong(user.id);
  lastReason = null;
  // Fresh file inputs, so nothing chosen on a previous render may ride along.
  pendingAudio = null; pendingCover = null; pendingAudioDur = null; audioName = null;
  revokeObjUrls();
  if (songId) {
    const { data, error } = await supabase.from('songs').select('*').eq('id', songId).maybeSingle();
    // RLS already scopes this to the caller's own songs, so a miss is a miss.
    if (error || !data) {
      container.innerHTML = `<div class="upload-wrap"><h1>Song not found</h1>
        <p class="upload-note">It may have been removed, or it is not yours.
        <a class="quiet-link" href="/upload">Start a new song</a>.</p></div>`;
      return;
    }
    current = data;
    lastReason = await loadRejectionReason(songId);
  }

  const s = current;
  const isApproved = s.id && s.status === 'approved';
  const chans = new Set(s.proposed_channels || []);
  const chips = CHANNELS.map((c) =>
    `<button type="button" class="u-chan${chans.has(c.id) ? ' on' : ''}" data-channel="${esc(c.id)}">${esc(c.title)}</button>`
  ).join('');
  const err = (f) => `<div class="u-field-err" id="u-err-${f}" role="alert" hidden></div>`;

  container.innerHTML = `
    <div class="upload-wrap">
      <h1>${s.id ? 'Edit your song' : 'Share your music'}</h1>
      <p class="upload-sub">Nothing is public until Laivy Hart reviews it.</p>

      ${lastReason ? `<div class="upload-banner is-reject">
          <strong>Not approved last time.</strong> ${esc(lastReason)}
          <span class="upload-banner-tip">Make your changes and submit again.</span>
        </div>` : ''}

      ${isApproved ? `<div class="upload-banner is-warn">
          <strong>This song is live.</strong> Saving changes sends it back for review;
          it comes off the site until it is re-approved.
        </div>` : ''}

      <div class="field"><label for="u-title">Title</label>
        <input type="text" id="u-title" value="${esc(s.title)}">${err('title')}</div>

      <div class="field"><label for="u-translit">Transliteration</label>
        <input type="text" id="u-translit" style="direction:ltr;" value="${esc(s.title_translit)}">
        <div class="cm-note" id="u-translit-note">Needed for a Hebrew title, so your song gets a readable web address.</div>${err('translit')}</div>

      <div class="field"><label for="u-language">Language</label>
        <select id="u-language">
          <option value="Hebrew"${s.language === 'Hebrew' ? ' selected' : ''}>Hebrew</option>
          <option value="English"${s.language === 'English' ? ' selected' : ''}>English</option>
        </select></div>

      <div class="field" id="u-audio-field"><label for="u-audio">Audio</label>
        <div id="u-audio-card"></div>
        <input type="file" id="u-audio" accept="audio/*">
        <div class="cm-note" id="u-audio-status"></div>${err('audio')}</div>

      <div class="field" id="u-cover-field"><label for="u-cover">Cover image <span class="u-optional">optional</span></label>
        <div id="u-cover-card"></div>
        <input type="file" id="u-cover" accept="image/*">
        <div class="cm-note" id="u-cover-status"></div>${err('cover')}</div>

      <div class="field"><label for="u-lyrics">Lyrics <span class="u-optional">optional</span></label>
        <textarea id="u-lyrics">${esc(s.lyrics_original)}</textarea></div>

      <div class="field"><label for="u-translation">Translation <span class="u-optional">optional</span></label>
        <textarea id="u-translation" style="direction:ltr;">${esc(s.lyrics_translation)}</textarea></div>

      <div class="field"><label for="u-about">What inspired it <span class="u-optional">optional</span></label>
        <textarea id="u-about" style="direction:ltr; min-height:80px;">${esc(s.about)}</textarea></div>

      <div class="field"><label>Suggested moods <span class="u-optional">optional</span></label>
        <div class="u-chans">${chips}</div>
        <div class="cm-note">A suggestion only &mdash; Laivy Hart decides where it lands.</div></div>

      <div class="field"><label for="u-tags">Suggested tags <span class="u-optional">optional</span></label>
        <input type="text" id="u-tags" style="direction:ltr;" placeholder="e.g. hopeful, tefilla"
               value="${esc((s.proposed_tags || []).join(', '))}">
        <div class="cm-note">Comma separated. The owner reviews tags.</div></div>

      <div class="u-agree-block">
        <label class="u-agree-row">
          <input type="checkbox" id="u-agree">
          <span>I am 18 or older, this is my own work, and I agree to the
            <a class="quiet-link" href="/terms" target="_blank" rel="noopener">Terms</a>.</span>
        </label>${err('agree')}
      </div>

      <div class="u-actions">
        <button type="button" class="home-primary-btn outlined" id="u-draft">Save for later</button>
        <button type="button" class="home-primary-btn filled" id="u-submit">Submit for review</button>
        ${s.id ? `<a class="quiet-link" id="u-preview" href="${s.slug ? '/song/' + encodeURIComponent(s.slug) : '/listen?song=' + encodeURIComponent(s.id)}">Preview</a>` : ''}
        ${isApproved ? `<button type="button" class="u-withdraw" id="u-withdraw">Withdraw from the site</button>` : ''}
      </div>
      <p class="u-actions-note">Save for later keeps it private on your page. Submit sends it to Laivy Hart to review.</p>
      <div class="u-msg" id="u-msg" role="status"></div>
    </div>`;

  const $ = (sel) => container.querySelector(sel);
  const msg = $('#u-msg');
  const setStatus = (t) => { msg.textContent = t; msg.className = 'u-msg'; };
  let replacing = { audio: false, cover: false };

  /* ---- errors: next to their field, first one scrolled into view ---- */
  const clearErrors = () => {
    container.querySelectorAll('.u-field-err').forEach((e) => { e.textContent = ''; e.hidden = true; });
    msg.textContent = ''; msg.className = 'u-msg';
  };
  const scrollTo = (el) => {
    if (el && typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { el.scrollIntoView(); }
    }
  };
  const putFieldError = (field, text) => {
    const box = $('#u-err-' + field);
    if (!box) return null;
    box.innerHTML += `<div>${esc(text)}</div>`;
    box.hidden = false;
    return box;
  };
  const showErrors = (out) => {
    clearErrors();
    const general = [];
    let firstField = null;
    out.errors.forEach((e, i) => {
      const field = out.uploadFailed && i === 0 ? out.uploadFailed : (!out.db && ERROR_FIELD[e]);
      const box = field ? putFieldError(field, e) : null;
      if (box) { if (!firstField) firstField = box; } else general.push(e);
    });
    if (firstField && !general.length) general.push('Please check the note above.');
    msg.innerHTML = general.map((e) => `<div>${esc(e)}</div>`).join('');
    msg.className = 'u-msg is-err';
    // Validation errors win the scroll (they are above the buttons, in form
    // order); a database message is only near the buttons.
    const target = firstField
      ? [...container.querySelectorAll('.u-field-err')].find((b) => !b.hidden)
      : msg;
    scrollTo(target);
  };

  /* ---- the audio field: a card when attached, the picker otherwise ---- */
  const paintAudio = () => {
    const attached = !!(pendingAudio || current.audio_url);
    const card = $('#u-audio-card');
    card.innerHTML = attached ? audioCardHTML() : '';
    $('#u-audio').hidden = attached && !replacing.audio;
    $('#u-audio-status').textContent = pendingAudio ? 'Uploads when you save or submit.'
      : attached ? '' : 'MP3, M4A or WAV, up to 20 MB.';
    if (!attached) return;
    const player = card.querySelector('audio'), btn = card.querySelector('.u-play');
    btn.addEventListener('click', () => {
      if (player.paused) {
        // One sound at a time: pause the site's player while previewing.
        document.querySelectorAll('audio').forEach((a) => { if (a !== player) try { a.pause(); } catch (e) {} });
        const p = player.play(); if (p && p.catch) p.catch(() => {});
      } else player.pause();
    });
    const sync = (playing) => { btn.innerHTML = playing ? PAUSE_SVG : PLAY_SVG; btn.setAttribute('aria-label', playing ? 'Pause' : 'Play'); };
    player.addEventListener('play', () => sync(true));
    player.addEventListener('pause', () => sync(false));
    player.addEventListener('ended', () => sync(false));
    card.querySelector('.u-replace').addEventListener('click', () => reveal('audio'));
  };

  const paintCover = () => {
    const card = $('#u-cover-card');
    const html = coverCardHTML($('#u-title').value);
    const attached = !!html;
    card.innerHTML = attached ? html
      : `<div class="u-plate-row">${platePreviewHTML($('#u-title').value)}</div>`;
    $('#u-cover').hidden = attached && !replacing.cover;
    $('#u-cover-status').textContent = pendingCover ? 'Resized and uploaded when you save or submit.'
      : attached ? '' : 'Without one, your song gets a coloured plate with its name on it.';
    if (attached) card.querySelector('.u-replace').addEventListener('click', () => reveal('cover'));
  };

  const reveal = (kind) => {
    replacing[kind] = true;
    const inp = $('#u-' + kind);
    inp.hidden = false;
    try { inp.click(); } catch (e) {}
  };

  /* Progress, drawn onto the card for that file. */
  const onProgress = (kind, p) => {
    const card = $(`#u-${kind}-card .u-file-card`);
    if (!card) return;
    const bar = card.querySelector('.u-progress'), fill = card.querySelector('.u-progress-fill');
    const state = card.querySelector('.u-file-state');
    const pct = p.total ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : 0;
    card.dataset.state = p.done ? 'uploaded' : 'uploading';
    bar.hidden = !!p.done;
    fill.style.width = pct + '%';
    state.textContent = p.done ? 'Uploaded ✓' : `Uploading ${p.name}, ${kind === 'audio' ? mb(p.size) : kb(p.size)} — ${pct}%`;
  };

  paintAudio();
  paintCover();
  $('#u-title').addEventListener('input', () => { if (!pendingCover && !current.cover_url) paintCover(); });

  container.querySelectorAll('.u-chan').forEach((b) =>
    b.addEventListener('click', () => b.classList.toggle('on')));

  $('#u-audio').addEventListener('change', (e) => {
    const f = e.target.files[0] || null;
    if (!f) return;               // a cancelled picker keeps what was there
    const box = $('#u-err-audio');
    box.hidden = true; box.textContent = '';
    // Checked here too, so an over-limit file is refused before it is uploaded
    // rather than after a 20 MB round trip. The Worker checks again regardless.
    let bad = null;
    if (f.size > AUDIO_MAX_BYTES) bad = `That file is ${mb(f.size)}. The limit is 20 MB.`;
    else if (f.type && !AUDIO_TYPES.includes(f.type)) bad = 'Please choose an MP3, M4A or WAV file.';
    if (bad) { putFieldError('audio', bad); e.target.value = ''; return; }
    revokeFor(pendingAudio);
    pendingAudio = f; pendingAudioDur = null; replacing.audio = false;
    paintAudio();
    readAudioDuration(f).then((d) => {
      if (pendingAudio !== f || !d) return;
      pendingAudioDur = d;
      const meta = $('#u-audio-card .u-file-meta');
      if (meta) meta.textContent = `${fmtDuration(d)} · ${mb(f.size)}`;
    });
  });

  $('#u-cover').addEventListener('change', (e) => {
    const f = e.target.files[0] || null;
    if (!f) return;
    revokeFor(pendingCover);
    pendingCover = f; replacing.cover = false;
    paintCover();
  });

  const busyEls = () => [...container.querySelectorAll('.u-actions button, input[type=file], .u-replace')];
  let busy = false;
  const run = async (mode) => {
    if (busy) return;
    busy = true;
    busyEls().forEach((b) => { b.disabled = true; });
    clearErrors();
    let done = false;
    try {
      const out = await saveSong(mode, fieldsFromDom(container), { status: setStatus, progress: onProgress });
      if (out.errors) {
        // Anything that did upload before a later failure now shows as attached.
        if (out.uploadFailed) {
          const st = $(`#u-${out.uploadFailed}-card .u-file-state`);
          if (st) st.textContent = 'Upload failed';
          const bar = $(`#u-${out.uploadFailed}-card .u-progress`);
          if (bar) bar.hidden = true;
          if (out.uploadFailed === 'cover') paintAudio();   // the audio did make it
        } else { replacing = { audio: false, cover: false }; paintAudio(); paintCover(); }
        showErrors(out);
        return;
      }
      if (out.status === 'submitted') { done = true; renderSubmitted(container); return; }
      replacing = { audio: false, cover: false };
      paintAudio(); paintCover();
      msg.className = 'u-msg is-ok';
      msg.textContent = 'Saved for later. It stays private on your page until you submit it.';
    } catch (e) { showErrors({ errors: [(e && e.message) || 'Something went wrong.'], db: true }); }
    finally {
      busy = false;
      if (!done) busyEls().forEach((b) => { b.disabled = false; });
    }
  };
  $('#u-draft').addEventListener('click', () => run('draft'));
  $('#u-submit').addEventListener('click', () => run('submit'));

  const wd = $('#u-withdraw');
  if (wd) wd.addEventListener('click', async () => {
    if (!confirm('Take this song off the site? You can submit it again later.')) return;
    try { await withdrawSong(current.id); setStatus('Withdrawn. It is no longer public.'); }
    catch (e) { showErrors({ errors: [e.message], db: true }); }
  });
}

window.laivy = window.laivy || {};
window.laivy.upload = { renderUploadPage, validateForSubmit, validateForDraft };
