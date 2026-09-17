# Laivy Hart

A static jukebox site (vanilla HTML/JS, no build step for the app) backed by a
Supabase Postgres database, with audio and cover art served from Cloudflare R2.
Deployed on Vercel; `songs.json` (the songs list) and `chart.json` (the latest
daily chart) are committed static snapshots used as the Supabase-outage fallback
(both regenerated on every deploy by `scripts/snapshot-songs.mjs`).

Key files: `index.html` (public jukebox), `admin.html` (owner editor),
`config.js` (Supabase URL + publishable key), `middleware.js` (per-song OG
tags), `sw.js` (service worker), `worker/` (R2 upload + publish Worker),
`sql/` (record of schema changes).

## Adding a song field

Adding a new column to the `songs` table touches a fixed set of places. To add
a field end to end:

1. **`sql/`** — write the next numbered migration (e.g.
   `sql/00N_<name>.sql`, idempotent) and apply it to the database. `sql/` is the
   record of schema changes applied in numerical order (`001` = tags/featured/
   comment_count; `002` = the `plays` history table, `plays_7d` column, the
   `increment_play_count` + `refresh_plays_7d` functions, and the hourly pg_cron
   job; `003` = the `like_*_count` columns + the old `set_like_facet`; `004` = the
   `chart_snapshots` table + `take_chart_snapshot` + its daily pg_cron job;
   `005` = `toggle_love`, dropping `set_like_facet` and `like_all_count`); the
   live schema wins if they ever disagree.
2. **`mapSong()` in `index.html`** (~line 964) — add the field to the mapped
   song object, with a sensible default. Fields not listed here are dropped on
   the public side, even though the load uses `select('*')`.
3. **The `saveSong()` payload in `admin.html`** (~line 860) — add the field so
   the admin can write it, plus a form input to edit it. (Trigger-maintained
   columns like `comment_count` are the exception: do NOT put them in the
   payload.)
4. **`sw.js` cache version** — bump `CACHE_VERSION` (e.g. `v36` → `v37`) so
   returning visitors pick up the new `index.html`/`admin.html`.

`scripts/snapshot-songs.mjs` selects `*`, so the new column flows into
`songs.json` automatically — no change needed there. RLS is column-agnostic: new
columns inherit the table's existing policies unless you add column-level rules.

## Search

Client-side search lives entirely in `index.html`. Each song gets a normalized
copy of every field (`buildSearchIndexes`): `nTitle`, `nTranslit`, `nTags`,
`nCategories`, `nAbout`, `nLyricsOriginal`, `nLyricsTranslation`. The query is
normalized with the SAME routine so both sides agree. A song matches when EVERY
whitespace-separated query term is found in at least one field (AND semantics);
an empty query matches everything. There is no typo tolerance — matching is
exact substring after normalization.

Each matching row shows a Google-style "why it matched" line: the field the
**first** term matched in (priority: title, translit, tags, categories, about,
lyrics, translation) with a ~60-char snippet from that field's RAW text and the
term wrapped in `<mark>` (soft accent highlight). The snippet is skipped for
title/translit matches, since those are already visible in the row. Snippet
elements carry `dir="auto"` so Hebrew snippets render right-to-left.

Snippets slice the RAW text (nikkud, final letters, original case intact). To
place the `<mark>` correctly, `normalizeMapped(str)` returns both the normalized
string and a `map` from each normalized-char index back to the raw-char index it
came from. Normalization only deletes characters or replaces them one-for-one,
except the `ch`/`kh`/`ts` digraph folds, whose output characters all map back to
the digraph's first raw character. (A `SEARCH_DEBUG` block self-tests the map on
a nikkud word, a final-letter word, and "chesed".)

`normalizeForSearch` (= `normalizeMapped(str).norm`) applies these steps, in
order — if you change one, change it here too so the index and the query stay in
sync:

1. Lowercase, Unicode NFD, then strip combining marks (removes Latin accents in
   transliterations).
2. Strip Hebrew nikkud + cantillation (U+0591–U+05C7).
3. Fold Hebrew final letters to their base forms (ך→כ, ם→מ, ן→נ, ף→פ, ץ→צ).
4. Remove geresh/gershayim (U+05F3, U+05F4) and ASCII apostrophes/quotes.
5. Fold transliteration variants: `ch`→`kh`→`h` **only when followed by a vowel**
   (a, e, i, o, u, y) — so "chesed"/"Chanukah" fold to an `h` form while "much"
   and "teach" are left alone — and `ts`→`tz` (so "tsion" == "tzion"). Lossy on
   purpose.
6. Replace any remaining punctuation with a space and collapse whitespace.

`searchIndex` = title + transliteration + categories + tags + about + lyrics.
`metaIndex` (non-lyric fields) and `lyricsIndex` (lyrics only) are kept so a
lyric-only hit shows a quiet snippet under the row. The snippet is sliced from
the RAW `lyrics_original` at the index found in the normalized line — an
approximation, since normalization removes/folds characters, but a 60-char
window absorbs the drift.

Sort is chosen in the control beside the search box, stored in `localStorage`
(`laivy-sort-v1`): Shuffle (per-session order), Newest, Most listened to, Most
loved, Most talked about, A to Z. `sortedSongs()` returns the ordered array and
`renderList` renders `visibleOrder()` (sorted then filtered). Play counts and
comment counts are never displayed — only the sort reveals ranking.

## Pages

`index.html` is a single-page app with two History-API routes (no hash routing).
`vercel.json` rewrites `/listen` to `index.html`; the service worker precaches
both `/` (via `index.html`) and `/listen` so each works offline. The audio
element and all player state live at the app level, above both pages, so moving
between routes never stops playback. `navigate(route)` pushes history + fires a
manual `page_view` (GA4's automatic page view only fires on real loads);
`popstate` moves between pages without reloading; `showPage(route)` toggles which
`#page-home` / `#page-listen` is visible.

- **`/` — homepage** (`#page-home`): full-width, single column. Header (wordmark,
  search box, Listen link, and the **theme controls** — the four-color picker +
  light/dark toggle, the same `.swatch`/`.theme-toggle` markup and handlers as the
  `/listen` topbar, so a change on either page applies to both; on mobile the four
  colors collapse behind a single swatch button while light/dark stays visible)
  → **site banner** → **primary buttons** (Radio, Browse
  all songs) → **hero** → ranked **rails** → **Editor's picks band** → **Find a
  song** → About footer. (The listener feed was removed from the homepage; it
  still lives on `/listen`'s idle state.)
  - **Site banner** + **primary buttons** are unchanged: banner is full-width
    (≈3:1 desktop capped 320px, ≈2:1 mobile capped 200px) with the wordmark +
    tagline over `SITE_BANNER_URL` (empty → generative theme gradient via
    `genArtStyle`; set → image behind a scrim through the cover CDN); Radio
    (filled) + Browse all songs (outlined) both `navigate('listen')`.
  - **Find a song** (`findASongHTML`): at the **bottom** of the page (below the
    Editor's picks band, above the footer). A "Find a song" heading, then a row of
    **mood pills** — the `categories` in the `mood` group, ordered by
    `sort_order` (nulls last → alphabetical), same pill look as the `/listen`
    filter pills — and a **tag cloud** ("Themes") of every tag in use, alphabetical,
    in exactly two sizes (tags on ≥6 songs larger, the rest smaller). A mood pill
    goes to `/listen?cat=<name>` (category active); a tag goes to `/listen?tag=<tag>`
    (search applied). Both are applied on arrival **without playback**, and the
    param is cleared with `replaceState` so back/forward behaves — see
    `applyListenParams()` / `goListenWithParam()` and the `initRoute` branch.
  - **Ranking window** (`rankedByListens()`): the weekly ranking **is yesterday's
    chart**, not the live `plays_7d`. It reads the latest daily snapshot in
    `chart_snapshots` (ranks 1-10, by `song_id`) and puts those songs in chart
    order, then appends every remaining song by `play_count` desc so the dedupe
    and the 3-song floor below still have material. The order therefore **changes
    once a night**, when `take_chart_snapshot()` closes the Jerusalem day (see
    **Charts**), and not as plays land during the day. `loadChart()` reads the
    chart **live from Supabase** when it is reachable, so a new night's chart
    appears without a deploy, and falls back to the committed **`chart.json`**
    (written at build time by `scripts/snapshot-songs.mjs`, precached by `sw.js`).
    **Fallback:** if there is no chart at all, ranking is `play_count` desc and
    `weeklyFallback` is set, which also **omits the All-time rail** (so the same
    ranking is not shown twice). The **wording is always weekly** — the hero
    always reads "This week's #1 song" and the top rail always "Most listened this
    week". Numbers other than the weekly rail's rank badges are never displayed.
  - **Hero**: the #1 ranked song as a **two-column labeled block** — left column
    (~45%) holds a large display-serif label ("This week's #1 song"), the title,
    displayed category, and first sentence of the note; right column holds the
    landscape 3:2 cover; the text is vertically centered against the image. On
    mobile it stacks: label, cover, title, category, note. The whole block plays
    the song.
  - **Rails**, in order — *Most listened this week* (weekly ranking minus hero),
    *Most loved*, *New releases*, *Most talked about* (`comment_count > 0`),
    *All-time favorites* (`play_count`). The *New releases* rail keeps the
    analytics key `newest`. The **weekly rail caps at 9** (not 8) so it shows the
    chart's **#2–#10** — the hero is #1 — and each of its cards gets a **rank
    badge** (accent circle, white numeral, top-left of the cover) numbered by
    position after dedupe; **no other rail or the Editor's picks band gets
    badges**. Each is **deduped against everything shown above it**
    (hero + earlier rails, top-to-bottom); the **≥3 floor is applied after dedupe**,
    and an omitted rail does not consume its songs. `homepageSections()` returns
    `{ hero, rails, editors, fallback }`.
  - **Editor's picks band**: a visually distinct full-width band at the bottom
    (theme accent at very low opacity, light + dark) with "Editor's picks" /
    "Chosen by Laivy Hart" and all `featured` songs by `featured_order`, **NOT**
    deduped against the rails above (curation may repeat).
  - **Rail cards**: landscape 3:2, focal-point crop, 14px radius, stacked title —
    ~3.5 across desktop content / ~2.5 tablet / ~1.5 on a 390px phone. The scroll
    track bleeds to the page edge but the first card snaps flush to the content
    edge (`scroll-padding-inline-start` = page padding + `scroll-snap-align:start`).
    The song-page list keeps round `row-thumb`s (`coverThumbHTML`'s row variant
    unchanged; rails use the landscape `rail-thumb`).
  - **Scroll affordance**: each rail and the Editor's picks band has a ~48px edge
    fade (transparent → page background) shown on whichever side can still scroll
    (`can-left`/`can-right`, updated on scroll + resize); on fine-pointer/hover
    devices, quiet glass chevron arrows appear on hover and scroll by one card +
    gap (hidden at the ends, keyboard-focusable). Touch devices get the fade only.

  Built entirely from the in-memory `SONGS` array, so it works from the
  `songs.json` snapshot during an outage. Tapping any song, or a homepage search,
  navigates to `/listen`.
- **`/listen` — song page** (`#page-listen`): the two-column jukebox (player +
  lyrics + list). Its idle state is the simple "pick a song" line plus the
  listener feed. The wordmark navigates to `/`.
  - **Dock layout**, three rows: (1) the **scrubber**; (2) **prev/play/next** on
    the left and **Share** (the accent-filled circle) pushed to the far right,
    nothing else; (3) the **three loves** (see **Likes**) centered and evenly
    spaced, each a circle of **64px desktop / 56px mobile** (deliberately larger
    than the 48px play button) with its label beneath in the body font at
    0.95rem, under one always-visible display-serif italic line, "What did you
    love?". Off is the muted glass outline, on is the accent fill with a white
    glyph and a soft pulse on tap. At ≈390px the three stay on one row: the
    circles hold at 56px and the gaps close instead.
    **Radio** and **Category radio** live in the list-column header beside the
    Songs/Playlists tabs (wrapping two-across below the tabs on mobile).
- **Deep link**: shared links stay `/?song=<id>` so the OG middleware (matcher
  `/`) still rewrites previews. On load with `?song=` present, the app goes
  straight to the song page, plays the song, and `replaceState`s the visible URL
  to `/listen?song=<id>`.
- **Mini-player**: while a song plays, the homepage shows a slim bottom bar
  (cover, title, play/pause, next); tapping the cover/title returns to `/listen`.
  The full dock is never shown on the homepage.

A rail's "Play all" hands the song page an ordered `manualQueue`: the homepage
calls `navigate('listen')` then `playRail(idxs)`, which sets `manualQueue` and
loads the first track; `manualStep` and end-of-track auto-advance follow it, and
any non-rail selection clears it. No counts, badges, or "trending" language
appear on the homepage — only the section names.

## Likes

The dock's third row holds **three independent loves** for the playing song:
**the words** (a quill), **the music** (a three-bar equalizer), and **the song**
(the heart). They are independent toggles, not one exclusive choice: any
combination can be on at once, each with its own counter.

- **the song** is the heart, unchanged: `songs.like_count` via the
  `toggle_like(song_id, liked)` RPC, with this browser's liked ids in
  `localStorage` (`laivy-likes-v1`). It is the only one that shows its count on
  the public site, small beside its label.
- **the words** and **the music** go through `toggle_love(song_id, kind, on)`
  (`sql/005`), where `kind` is `'lyrics'` or `'music'`. It increments or
  decrements `like_lyrics_count` / `like_tune_count`, clamped at 0, **never
  touches `like_count`**, and returns the new count so the client can reconcile.
  This browser's state for these two lives in `localStorage`
  (`laivy-loves-v1`, `{songId: {lyrics, music}}`). Their counts are never shown
  on the public site.

All three are optimistic (the circle fills instantly), and all three are written
through the resilient event queue, so a Supabase outage cannot drop a tap. The
do-not-track flag guards all three: with it set, **none of them toggle at all**,
since the guard sits at the top of each toggle.

`sql/005` also retired the old exclusive facet: `set_like_facet` is dropped, and
`like_all_count` is dropped after folding any nonzero value into `like_count`
("all of it" is just the heart once the loves are independent).

**The words and music counts are admin-only** — the split (`♥ N · words n ·
music n`) is read-only in `admin.html` (song list + form header), never on the
public site, and never in the admin save payload. Analytics: `love` with the
song id, `kind` (`lyrics` / `music` / `song`) and `on` (`"on"` / `"off"`).

## Charts

`chart_snapshots` (`sql/004`) holds a daily top-10, one row per (`chart_date`,
`rank` 1–10) with `song_id` (nullable, `ON DELETE SET NULL`), `title` (kept so
history stays readable if a song is deleted), `plays_7d`, `play_count`,
`like_count`, and `is_week_end`. RLS: anon + authenticated may **SELECT** (it
holds no personal data); no client writes — rows come only from the SECURITY
DEFINER `take_chart_snapshot()`.

`take_chart_snapshot()` closes the Jerusalem day that just ended
(`(now() at time zone 'Asia/Jerusalem')::date - 1`), skips a date already
recorded, and inserts the top 10 ordered by `plays_7d` desc, `play_count` desc,
`like_count` desc, `title` (during the fallback period, with no `plays_7d` yet,
that is effectively all-time order, so history still starts on day one). It sets
`is_week_end = true` when that Jerusalem date is a **Saturday** (`dow = 6`).
Scheduled via pg_cron **`take-chart-snapshot`** at `10 22 * * *` (22:10 UTC =
01:10 Jerusalem summer / 00:10 winter, just after the hourly `plays_7d` refresh
at `:05`).

The homepage weekly ranking reads this table: the hero and the *Most listened
this week* rail are **yesterday's chart, refreshed nightly**, so **"This week's
#1" is exactly `rank` 1 of the latest `chart_date` in `chart_snapshots`** and the
rail is its #2-#10. See **Pages** for the client side (`rankedByListens()`,
`loadChart()`, and the `chart.json` fallback).

The admin **Charts** tab (`admin.html`, read-only) lists snapshots grouped by
date, newest first — rank, title, `plays_7d` — with week-end dates badged, and a
browser-computed summary above it: the songs with the most **days at #1** and the
most **weeks at #1** (week-end snapshots at rank 1).

## Testing

Set `localStorage` key `laivy-no-track` to `1` before any browser verification, so test plays and likes never reach the database or analytics (guards `laivyTrack` and the `increment_play_count` / `toggle_like` / `toggle_love` paths in `index.html`). Note that the guard sits at the top of each toggle, so with the flag set the three loves do not visibly toggle either.
