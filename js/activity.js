/* ============================================================
   ACT-1: first-party activity log.

   Records meaningful actions (page views, plays, hearts, ratings, comments,
   follows, shares, searches, sign-in/up, submissions) to the Worker's
   POST /event route, which inserts them into activity_events (sql/020) tied
   to the signed-in member (verified server-side from the access token, never
   from anything sent here) or to this browser's own random device id.

   This is separate from, and additional to, GA4 (laivyTrack in index.html)
   and the existing increment_play_count RPC: neither of those changes.
   window.laivy.activity.log(type, opts) is the one entry point every caller
   uses; it is as self-guarding as laivyTrack already is, so a caller never
   has to check laivy-no-track itself.

   Respects the SAME opt-out the rest of the site already honours
   (laivy-no-track), plus the browser's own Global Privacy Control signal,
   which gets the same treatment as a matter of policy, not because any page
   here reads it elsewhere.
   ============================================================ */
import { supabase } from './auth.js';

const ENDPOINT = 'https://laivyhart-audio-upload.ytweiser-399.workers.dev/event';
const DEVICE_KEY = 'laivy-device-id';
const IDLE_MS = 30 * 60 * 1000;     // a session_id this old is replaced
const FLUSH_MS = 10 * 1000;
const MAX_QUEUE = 25;                // mirrors the Worker's own per-request cap

function noTrack() {
  try {
    if (localStorage.getItem('laivy-no-track') === '1') return true;
  } catch (e) { /* storage blocked: fall through to the GPC check below */ }
  try { if (navigator.globalPrivacyControl === true) return true; } catch (e) {}
  return false;
}

// localStorage can throw (private mode, blocked storage); an in-memory id
// still lets the rest of a single page view work, it just does not persist.
let memoryDeviceId = null;
function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch (e) {
    if (!memoryDeviceId) memoryDeviceId = crypto.randomUUID();
    return memoryDeviceId;
  }
}

let sessionId = crypto.randomUUID();
let lastActivityAt = Date.now();
function currentSessionId() {
  const now = Date.now();
  if (now - lastActivityAt > IDLE_MS) sessionId = crypto.randomUUID();
  lastActivityAt = now;
  return sessionId;
}

let queue = [];

/* The one entry point. `opts` is any of { song_id, artist_id, meta, page } --
   all optional. Trimming/validation happens server-side (the Worker drops an
   unknown type rather than erroring, and caps meta); this just shapes the
   event and queues it. */
export function log(type, opts) {
  if (!type || noTrack()) return;
  const ev = { type, ts: Date.now() };
  if (opts) {
    if (opts.song_id) ev.song_id = opts.song_id;
    if (opts.artist_id) ev.artist_id = opts.artist_id;
    if (opts.meta) ev.meta = opts.meta;
    if (opts.page) ev.page = opts.page;
  }
  currentSessionId(); // an action resets the idle clock even if the queue is full
  queue.push(ev);
  if (queue.length >= MAX_QUEUE) flush(false);
}

async function accessToken() {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return (data && data.session && data.session.access_token) || null;
  } catch (e) { return null; }
}

/* `urgent`: the page is actually being torn down (pagehide only -- see the
   wiring below). sendBeacon is the right tool there, but it cannot carry a
   custom header, so a signed-in visitor's last beacon of a visit goes out
   anonymous rather than being skipped; every other flush goes through fetch
   and carries the token when there is one.

   FIX-4: the beacon's Blob MUST be sent as text/plain, not application/json.
   application/json is not a CORS-safelisted content type, and this request
   is cross-origin (the site to the Worker's own workers.dev domain);
   sendBeacon cannot run a preflight, so a JSON-typed beacon is silently
   dropped or blocked by the browser rather than ever reaching the Worker.
   The body is still the same JSON string; only the declared type changes,
   and the Worker parses the body as JSON regardless of what it is told the
   content type is.

   A fetch failure (including a non-2xx response) is retried once, and
   logged to the console if the retry fails too -- never silently dropped.
   Never throws beyond that: analytics is never allowed to break the page. */
async function sendOnce(headers, body) {
  const res = await fetch(ENDPOINT, { method: 'POST', headers, body, keepalive: true });
  if (!res.ok) throw new Error('activity flush HTTP ' + res.status);
}

export async function flush(urgent) {
  if (noTrack()) { queue = []; return; }
  if (!queue.length) return;
  const events = queue;
  queue = [];
  const body = JSON.stringify({ device_id: deviceId(), session_id: currentSessionId(), events });

  if (urgent && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    try {
      const blob = new Blob([body], { type: 'text/plain' });
      if (navigator.sendBeacon(ENDPOINT, blob)) return;
    } catch (e) { /* fall through to fetch keepalive */ }
  }

  const headers = { 'Content-Type': 'application/json' };
  try {
    const token = await accessToken();
    if (token) headers.Authorization = 'Bearer ' + token;
  } catch (e) { /* send anonymous rather than drop the batch */ }

  try {
    await sendOnce(headers, body);
  } catch (e) {
    try {
      await sendOnce(headers, body);
    } catch (e2) {
      console.error('[laivy] activity flush failed twice, dropping this batch:', e2 && e2.message);
    }
  }
}

setInterval(() => flush(false), FLUSH_MS);
if (typeof document !== 'undefined') {
  // Not urgent: the tab is only hidden, not necessarily gone, so this still
  // goes through fetch+keepalive like the periodic timer, not sendBeacon.
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(false); });
}
if (typeof window !== 'undefined') {
  // The one truly urgent case: the page is being torn down right now.
  window.addEventListener('pagehide', () => flush(true));
}

window.laivy = window.laivy || {};
window.laivy.activity = { log, flush };
