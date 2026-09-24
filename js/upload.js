/* ============================================================
   /upload — the contributor song form (1B-2).

   The admin form minus every admin power: no featured flags, no artist
   picker, no status controls, no reach into anyone else's song. Everything
   that makes a submission safe already lives in the database (1B-1): the
   guard trigger runs the caps, stamps submitted_at, flips is_artist and logs
   the event. This form's job is to be honest about the rules and to surface
   the database's own messages when it refuses.

   Two actions:
     Save draft      status='draft'   — no transliteration, no checkbox needed
     Submit for review status='submitted' — full validation, then the triggers

   Media goes to the Worker's JWT routes with the session's access token:
   /upload/audio -> songs/<sub>/, /upload/cover -> covers/<sub>/. The admin's
   UPLOAD_TOKEN is never involved and a contributor never holds it.
   ============================================================ */
import { supabase } from './auth.js';
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

/* Draft rules are deliberately looser than submit rules: a draft is a
   scratchpad, and demanding a transliteration before someone has even chosen
   a file would be the wrong moment to ask. */
export function validateForSubmit(song, agreed) {
  const errs = [];
  if (!(song.title || '').trim()) errs.push('A title is needed.');
  if (!(song.audio_url || '').trim()) errs.push('An audio file is needed.');
  if (isHebrewTitle(song) && !(song.title_translit || '').trim()) {
    errs.push('A transliteration is needed for a Hebrew title, so your song gets a readable web address.');
  }
  if (!agreed) errs.push('Please confirm the statement and the Terms.');
  return errs;
}
export function validateForDraft(song) {
  return (song.title || '').trim() ? [] : ['A title is needed, even for a draft.'];
}

/* ---------------- media ---------------- */

async function uploadMedia(kind, blob, contentType, onProgress) {
  const token = await accessToken();
  if (!token) throw new Error('Your session has expired. Sign in again.');
  if (onProgress) onProgress(`Uploading ${kind}…`);
  const res = await fetch(`${R2_UPLOAD_URL}/upload/${kind}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': contentType },
    body: blob,
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON error */ }
  if (!res.ok) throw new Error((body && body.error) || `Upload failed (HTTP ${res.status}).`);
  return body.url;
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

export async function saveSong(mode, form, setStatus) {
  const uid = authUser() && authUser().id;
  if (!uid) throw new Error('Please sign in.');

  const song = { ...current, ...form };
  const errs = mode === 'submit' ? validateForSubmit(song, form.agreed) : validateForDraft(song);
  if (errs.length) return { errors: errs };

  // Media first: a failed upload must not leave a half-saved row behind.
  if (pendingAudio) {
    song.audio_url = await uploadMedia('audio', pendingAudio, pendingAudio.type || 'audio/mpeg', setStatus);
    const d = await readAudioDuration(pendingAudio);
    if (d) song.duration_seconds = d;
  }
  if (pendingCover) {
    let blob = pendingCover, ctype = 'image/jpeg';
    try { const c = await compressImage(pendingCover, 1600, 0.82); if (c) blob = c; }
    catch (e) { /* send the original if compression fails */ }
    song.cover_url = await uploadMedia('cover', blob, ctype, setStatus);
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

  if (setStatus) setStatus('Saving…');
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
  if (error) return { errors: [error.message] };

  if (payload.status === 'submitted') await stampTermsIfNeeded(uid);
  pendingAudio = null; pendingCover = null;
  return { id: saved, status: payload.status };
}

export async function withdrawSong(songId) {
  const { error } = await supabase.from('songs').update({ status: 'removed' }).eq('id', songId);
  if (error) throw new Error(error.message);
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
        <input type="text" id="u-title" value="${esc(s.title)}"></div>

      <div class="field"><label for="u-translit">Transliteration</label>
        <input type="text" id="u-translit" style="direction:ltr;" value="${esc(s.title_translit)}">
        <div class="cm-note" id="u-translit-note">Needed for a Hebrew title, so your song gets a readable web address.</div></div>

      <div class="field"><label for="u-language">Language</label>
        <select id="u-language">
          <option value="Hebrew"${s.language === 'Hebrew' ? ' selected' : ''}>Hebrew</option>
          <option value="English"${s.language === 'English' ? ' selected' : ''}>English</option>
        </select></div>

      <div class="field"><label for="u-audio">Audio</label>
        <input type="file" id="u-audio" accept="audio/*">
        <div class="cm-note" id="u-audio-status">${s.audio_url ? 'A file is already attached.' : 'MP3, M4A or WAV, up to 20 MB.'}</div></div>

      <div class="field"><label for="u-cover">Cover image <span class="u-optional">optional</span></label>
        <input type="file" id="u-cover" accept="image/*">
        <div class="cm-note" id="u-cover-status">${s.cover_url ? 'A cover is already attached.' : 'Without one, your song gets a coloured plate with its name on it.'}</div></div>

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

      <label class="u-agree-row">
        <input type="checkbox" id="u-agree">
        <span>I am 18 or older, this is my own work, and I agree to the
          <a class="quiet-link" href="/terms" target="_blank" rel="noopener">Terms</a>.</span>
      </label>

      <div class="u-actions">
        <button type="button" class="home-primary-btn outlined" id="u-draft">Save draft</button>
        <button type="button" class="home-primary-btn filled" id="u-submit">Submit for review</button>
        ${s.id ? `<a class="quiet-link" id="u-preview" href="${s.slug ? '/song/' + encodeURIComponent(s.slug) : '/listen?song=' + encodeURIComponent(s.id)}">Preview</a>` : ''}
        ${isApproved ? `<button type="button" class="u-withdraw" id="u-withdraw">Withdraw from the site</button>` : ''}
      </div>
      <div class="u-msg" id="u-msg"></div>
    </div>`;

  const msg = container.querySelector('#u-msg');
  const setStatus = (t) => { msg.textContent = t; msg.className = 'u-msg'; };
  const setErrors = (list) => {
    msg.innerHTML = list.map((e) => `<div>${esc(e)}</div>`).join('');
    msg.className = 'u-msg is-err';
  };

  container.querySelectorAll('.u-chan').forEach((b) =>
    b.addEventListener('click', () => b.classList.toggle('on')));

  container.querySelector('#u-audio').addEventListener('change', (e) => {
    const f = e.target.files[0] || null;
    const note = container.querySelector('#u-audio-status');
    pendingAudio = null;
    if (!f) { note.textContent = 'MP3, M4A or WAV, up to 20 MB.'; return; }
    // Checked here too, so an over-limit file is refused before it is uploaded
    // rather than after a 20 MB round trip. The Worker checks again regardless.
    if (f.size > AUDIO_MAX_BYTES) { note.textContent = `That file is ${(f.size / 1048576).toFixed(1)} MB. The limit is 20 MB.`; return; }
    if (f.type && !AUDIO_TYPES.includes(f.type)) { note.textContent = 'Please choose an MP3, M4A or WAV file.'; return; }
    pendingAudio = f;
    note.textContent = `${f.name} — ${(f.size / 1048576).toFixed(1)} MB, uploads when you save.`;
  });

  container.querySelector('#u-cover').addEventListener('change', (e) => {
    const f = e.target.files[0] || null;
    const note = container.querySelector('#u-cover-status');
    pendingCover = f;
    note.textContent = f ? `${f.name} — resized and uploaded when you save.`
                         : 'Without one, your song gets a coloured plate with its name on it.';
  });

  const run = async (mode) => {
    try {
      const out = await saveSong(mode, fieldsFromDom(container), setStatus);
      if (out.errors) { setErrors(out.errors); return; }
      current.id = out.id;
      msg.className = 'u-msg is-ok';
      msg.textContent = out.status === 'submitted'
        ? 'Submitted for review. You will see it here until it is approved.'
        : 'Draft saved.';
      if (out.status === 'submitted') setTimeout(() => renderUploadPage(container, out.id), 1200);
    } catch (e) { setErrors([(e && e.message) || 'Something went wrong.']); }
  };
  container.querySelector('#u-draft').addEventListener('click', () => run('draft'));
  container.querySelector('#u-submit').addEventListener('click', () => run('submit'));

  const wd = container.querySelector('#u-withdraw');
  if (wd) wd.addEventListener('click', async () => {
    if (!confirm('Take this song off the site? You can submit it again later.')) return;
    try { await withdrawSong(current.id); setStatus('Withdrawn. It is no longer public.'); }
    catch (e) { setErrors([e.message]); }
  });
}

window.laivy = window.laivy || {};
window.laivy.upload = { renderUploadPage, validateForSubmit, validateForDraft };
