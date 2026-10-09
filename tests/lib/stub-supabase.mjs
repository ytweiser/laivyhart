/* ============================================================
   Wires every Supabase REST/RPC endpoint the site calls to fixture data,
   so a page renders against real, known data without ever reaching the
   live project. One rule per endpoint; `overrides` lets a scenario replace
   any one fixture (e.g. a rich case with picks/comments/recommendations, or
   an outage that returns HTTP 402 for everything).

   SUPA_HOST is the one constant every spec needs and nothing else does, so
   it lives here rather than being repeated per spec.
   ============================================================ */
import * as F from '../fixtures.mjs';

export const SUPA_HOST = 'tshkrghrgokplakktvik.supabase.co';

function j(body) { return JSON.stringify(body); }

// Builds the {status, body} map this page's Supabase calls should get,
// starting from the committed fixtures and layering scenario overrides on
// top. Call sites can pass partial overrides, e.g. { artistPicks: [...] }.
export function buildFixtureResponses(overrides) {
  const base = {
    songs: F.SONGS_ROWS,
    artistsPublic: F.ARTISTS_PUBLIC,
    channels: F.CHANNELS_ROWS,
    songChannels: F.SONG_CHANNELS_ROWS,
    songBadges: F.SONG_BADGES_ROWS,
    songMilestones: F.SONG_MILESTONES_ROWS,
    artistBadges: F.ARTIST_BADGES_ROWS,
    artistStats: F.ARTIST_STATS,         // keyed by artist_id; artist_stats RPC reads the one for its p_artist_id
    followerCounts: F.FOLLOWER_COUNTS,   // keyed by artist_id; follower_count RPC
    artistPicks: F.ARTIST_PICKS_ROWS,
    comments: F.COMMENTS_ROWS,
    recommend: F.RECOMMEND_ROWS,
    chartSnapshots: F.CHART_SNAPSHOTS_ROWS,
    siteSettings: F.SITE_SETTINGS_ROWS,
    artistFollows: [],          // artist_follows rows visible under the CALLER's own RLS
    selfArtistRow: null,        // js/auth.js's loadSelfFlags() self-scoped `artists` row; null = signed out/non-artist fallback
    reviews: [],                // My songs' rejection-reason lookup
    artistPicksInsertError: null, // {status, message} -- the trigger's own words (cap, unpublished song)
    // ACT-2 (Pulse). isAdmin defaults false so every EXISTING scenario keeps
    // the prior catch-all behavior (admin.html's checkSession() sees it as
    // not-admin) unless a Pulse scenario opts in explicitly.
    isAdmin: false,
    // Zeroed, not null: the real RPCs always return a shaped jsonb object
    // (never null), so these match that contract rather than defensive-
    // coding admin.html against a response shape that cannot occur.
    pulseSummary: {
      listeners: 0, members_active: 0, new_members: 0, plays: 0, completes: 0, completion_rate: 0,
      hearts: 0, ratings: 0, comments: 0, follows: 0, shares: 0, searches: 0,
      top_songs: [], top_cities: [],
    },
    pulseFeed: [], pulseTopListeners: [], pulseRetention: [],
    pulseSong: { funnel: { start: 0, p25: 0, p50: 0, p75: 0, complete: 0 }, hearts: 0, ratings: 0,
      cities: [], listeners: { members: [], visitor_count: 0 } },
    pulseMember: { display_name: null, email: null, totals: {}, events: [] },
    publicPulse: [],             // public_pulse() RPC, read by the homepage box
  };
  return { ...base, ...(overrides || {}) };
}

function rpcParam(request, name) {
  try { return JSON.parse(request.postData() || '{}')[name]; } catch (e) { return undefined; }
}

// supabase-js's .maybeSingle()/.single() send `Accept:
// application/vnd.pgrst.object+json` and expect a BARE OBJECT (or null) back,
// not an array -- real PostgREST honors that header; this stub has to too,
// or `.maybeSingle()` callers (resolveArtist, loadArtist, checkHandle, ...)
// silently get the wrong shape and read undefined properties off an array.
// Filters on `id=eq.<x>` or `handle=eq./ilike.<x>` (ilike with no `%`
// wildcard, which is how this codebase always calls it, is an exact
// case-insensitive match); no matching param returns every row untouched
// (the bulk "whole directory" callers want that).
async function filterRows(req, rows, idKey) {
  const key = idKey || 'id';
  const params = new URL(req.url()).searchParams;
  let out = rows;
  const idParam = params.get(key);
  const handleParam = params.get('handle');
  if (idParam && idParam.startsWith('eq.')) {
    const id = idParam.slice(3);
    out = out.filter((r) => r[key] === id);
  } else if (idParam && idParam.startsWith('in.')) {
    const ids = idParam.slice(3).replace(/^\(|\)$/g, '').split(',');
    out = out.filter((r) => ids.includes(r[key]));
  } else if (handleParam) {
    const val = handleParam.replace(/^(eq|ilike)\./, '').toLowerCase();
    out = out.filter((r) => String(r.handle).toLowerCase() === val);
  }
  const accept = (await req.headerValue('accept').catch(() => null)) || '';
  if (accept.includes('vnd.pgrst.object')) return out[0] || null;
  return out;
}

let pickAutoId = 1;

/**
 * Wires `page` to respond to every Supabase call with fixture data.
 * `overrides` — see buildFixtureResponses. `onCall(name, request)` is an
 * optional hook a scenario can use to record/assert which endpoints fired
 * (e.g. "was follow_artist actually called, and with what args").
 */
export async function wireSupabaseStubs(page, overrides, onCall) {
  const F2 = buildFixtureResponses(overrides);
  // artist_picks is the one table this harness's UI actually mutates
  // (add/remove/reorder/edit-note) and then immediately re-reads to paint
  // itself -- a static fixture can't reflect that, so this one table gets a
  // real, in-memory, per-page-load mutable copy instead.
  let picksState = F2.artistPicks.map((p) => ({ id: p.id || `pick-auto-${pickAutoId++}`, ...p }));

  await page.route(`https://${SUPA_HOST}/**`, async (route) => {
    const req = route.request();
    const url = req.url();
    const fulfill = (body, status) => route.fulfill({ status: status || 200, contentType: 'application/json', body: j(body) });
    const notify = (name) => { if (onCall) onCall(name, req); };

    if (url.includes('/rest/v1/songs?')) {
      notify('songs');
      // Minimal, deliberate query awareness -- just enough for "My songs"
      // (artist_id=eq.<id>), the picks search (status=eq.approved plus an
      // `or=(title.ilike.*,title_translit.ilike.*)` term), and status
      // filtering -- not a real filter engine. Every other caller (the bulk
      // songs?select=*,artist:... read, etc.) gets the full fixture, same
      // as before.
      const params = new URL(url).searchParams;
      let rows = F2.songs;
      const artistFilter = params.get('artist_id');
      if (artistFilter && artistFilter.startsWith('eq.')) {
        const id = artistFilter.slice(3);
        rows = rows.filter((s) => s.artist_id === id);
      }
      const statusFilter = params.get('status');
      if (statusFilter && statusFilter.startsWith('eq.')) {
        const want = statusFilter.slice(3);
        rows = rows.filter((s) => (s.status || 'approved') === want);
      }
      const orFilter = params.get('or');
      if (orFilter) {
        // e.g. "(title.ilike.%low%,title_translit.ilike.%low%)" -- pull the
        // bare search term out of the first ilike clause found.
        const m = orFilter.match(/ilike\.%([^%,)]*)%/i);
        if (m) {
          const term = m[1].toLowerCase();
          rows = rows.filter((s) => (s.title || '').toLowerCase().includes(term) || (s.title_translit || '').toLowerCase().includes(term));
        }
      }
      return fulfill(rows);
    }
    if (url.includes('/rest/v1/artists_public')) { notify('artistsPublic'); return fulfill(await filterRows(req, F2.artistsPublic)); }
    if (url.includes('/rest/v1/channels?')) { notify('channels'); return fulfill(F2.channels); }
    if (url.includes('/rest/v1/song_channels')) { notify('songChannels'); return fulfill(F2.songChannels); }
    if (url.includes('/rest/v1/song_badges')) { notify('songBadges'); return fulfill(F2.songBadges); }
    if (url.includes('/rest/v1/song_milestones')) { notify('songMilestones'); return fulfill(F2.songMilestones); }
    if (url.includes('/rest/v1/artist_badges')) { notify('artistBadges'); return fulfill(await filterRows(req, F2.artistBadges, 'artist_id')); }
    if (url.includes('/rest/v1/chart_snapshots')) { notify('chartSnapshots'); return fulfill(F2.chartSnapshots); }
    if (url.includes('/rest/v1/site_settings')) { notify('siteSettings'); return fulfill(F2.siteSettings); }
    if (url.includes('/rest/v1/comments')) { notify('comments'); return fulfill(F2.comments); }
    if (url.includes('/rest/v1/artist_picks')) {
      notify('artistPicks');
      const params = new URL(url).searchParams;
      if (req.method() === 'POST') {
        if (F2.artistPicksInsertError) {
          return fulfill({ message: F2.artistPicksInsertError.message, code: 'P0001' }, F2.artistPicksInsertError.status || 400);
        }
        const body = JSON.parse(req.postData() || '{}');
        // The REAL rules artist_picks_guard() (sql/016) enforces, so a
        // scenario can exercise an actual 6-then-7th sequence rather than
        // only a pre-canned error: the cap (picks_max, default 6) and
        // "the song must be approved".
        const sameArtistCount = picksState.filter((p) => p.artist_id === body.artist_id).length;
        if (sameArtistCount >= 6) {
          return fulfill({ message: 'You can only pick up to 6 songs.', code: 'P0001' }, 400);
        }
        const song = F.SONGS_ROWS.find((s) => s.id === body.song_id);
        if (!song || song.status !== 'approved') {
          return fulfill({ message: 'You can only pick published songs.', code: 'P0001' }, 400);
        }
        if (picksState.some((p) => p.artist_id === body.artist_id && p.song_id === body.song_id)) {
          return fulfill({ message: 'duplicate key value violates unique constraint "artist_picks_artist_id_song_id_key"', code: '23505' }, 409);
        }
        picksState.push({ id: `pick-auto-${pickAutoId++}`, ...body });
        return fulfill(null, 201);
      }
      if (req.method() === 'PATCH') {
        const idParam = params.get('id');
        const id = idParam && idParam.startsWith('eq.') ? idParam.slice(3) : null;
        const patch = JSON.parse(req.postData() || '{}');
        picksState = picksState.map((p) => (p.id === id ? { ...p, ...patch } : p));
        return fulfill(null);
      }
      if (req.method() === 'DELETE') {
        const idParam = params.get('id');
        const id = idParam && idParam.startsWith('eq.') ? idParam.slice(3) : null;
        picksState = picksState.filter((p) => p.id !== id);
        return fulfill(null);
      }
      // GET, with or without an artist_id=eq.<id> filter, embedded songs(...)
      // resolved from the song fixtures so the picks editor's title/by-line
      // render correctly after an add.
      let rows = picksState;
      const artistFilter = params.get('artist_id');
      if (artistFilter && artistFilter.startsWith('eq.')) {
        const aid = artistFilter.slice(3);
        rows = rows.filter((p) => p.artist_id === aid);
      }
      rows = rows.slice().sort((a, b) => a.position - b.position).map((p) => {
        if (p.songs) return p; // the reorder scenario pre-supplies the embed shape directly
        const song = F.SONGS_ROWS.find((s) => s.id === p.song_id);
        const artist = song ? F.ARTISTS_PUBLIC.find((a) => a.id === song.artist_id) : null;
        return {
          ...p,
          songs: song ? {
            title: song.title, title_translit: song.title_translit, language: song.language,
            artist: artist ? { display_name: artist.display_name, handle: artist.handle } : null,
          } : null,
        };
      });
      return fulfill(rows);
    }
    if (url.includes('/rest/v1/artist_follows')) { notify('artistFollows'); return fulfill(F2.artistFollows); }
    if (url.includes('/rest/v1/reviews')) { notify('reviews'); return fulfill(F2.reviews); }
    // auth.js's loadSelfFlags(): the self-scoped `artists` ROW (not the
    // artists_public VIEW, checked separately above). .maybeSingle() accepts
    // either a bare object or null here.
    if (url.includes('/rest/v1/artists?')) { notify('selfArtistRow'); return fulfill(F2.selfArtistRow); }

    if (url.includes('/rest/v1/rpc/artist_stats')) {
      const id = rpcParam(req, 'p_artist_id');
      notify('rpc:artist_stats');
      return fulfill(F2.artistStats[id] ? [F2.artistStats[id]] : []);
    }
    if (url.includes('/rest/v1/rpc/follower_count')) {
      const id = rpcParam(req, 'p_artist_id');
      notify('rpc:follower_count');
      return fulfill(F2.followerCounts[id] ?? 0);
    }
    if (url.includes('/rest/v1/rpc/recommend_for_artist')) { notify('rpc:recommend_for_artist'); return fulfill(F2.recommend); }
    if (url.includes('/rest/v1/rpc/follow_artist')) {
      notify('rpc:follow_artist');
      // A scenario testing the self-follow/daily-limit error path sets this
      // to a full Playwright fulfill() object (status 400ish + a PostgREST
      // error body carrying the RAISE EXCEPTION's own message).
      if (F2.followArtistResult) return route.fulfill(F2.followArtistResult);
      const id = rpcParam(req, 'p_artist_id');
      const on = rpcParam(req, 'p_on');
      const current = F2.followerCounts[id] ?? 0;
      return fulfill(Math.max(0, current + (on ? 1 : -1)));
    }
    if (url.includes('/rest/v1/rpc/swap_my_pick_positions')) { notify('rpc:swap_my_pick_positions'); return fulfill(null); }

    // ACT-2 (Pulse). pulse_member has two overloads (p_user_id uuid /
    // p_device_id text), both reached through the same RPC name -- the
    // fixture does not need to tell them apart, a scenario sets one
    // pulseMember shape per test.
    if (url.includes('/rest/v1/rpc/is_admin')) { notify('rpc:is_admin'); return fulfill(F2.isAdmin === true); }
    if (url.includes('/rest/v1/rpc/pulse_summary')) { notify('rpc:pulse_summary'); return fulfill(F2.pulseSummary); }
    if (url.includes('/rest/v1/rpc/pulse_feed')) { notify('rpc:pulse_feed'); return fulfill(F2.pulseFeed); }
    if (url.includes('/rest/v1/rpc/pulse_top_listeners')) { notify('rpc:pulse_top_listeners'); return fulfill(F2.pulseTopListeners); }
    if (url.includes('/rest/v1/rpc/pulse_retention')) { notify('rpc:pulse_retention'); return fulfill(F2.pulseRetention); }
    if (url.includes('/rest/v1/rpc/pulse_song')) { notify('rpc:pulse_song'); return fulfill(F2.pulseSong); }
    if (url.includes('/rest/v1/rpc/pulse_member')) { notify('rpc:pulse_member'); return fulfill(F2.pulseMember); }
    if (url.includes('/rest/v1/rpc/public_pulse')) { notify('rpc:public_pulse'); return fulfill(F2.publicPulse); }

    // Anything else (ratings, submission_events, auth token refresh, ...):
    // a harmless empty success, so an unexpected call never hangs the page.
    notify('unhandled:' + url);
    return fulfill([]);
  });
}
