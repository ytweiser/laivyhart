# Laivy Hart

A static jukebox site (vanilla HTML/JS, no build step for the app) backed by a
Supabase Postgres database, with audio and cover art served from Cloudflare R2.
Deployed on Vercel; `songs.json` is a committed static snapshot used as the
Supabase-outage fallback (regenerated on every deploy by
`scripts/snapshot-songs.mjs`).

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
   job); the live schema wins if they ever disagree.
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
  search box, Listen link) → **site banner** → **primary buttons** (Radio, Browse
  all songs) → **hero** → ranked **rails** → **Editor's picks band** → listener
  feed (8 with "More") → About footer.
  - **Site banner** + **primary buttons** are unchanged: banner is full-width
    (≈3:1 desktop capped 320px, ≈2:1 mobile capped 200px) with the wordmark +
    tagline over `SITE_BANNER_URL` (empty → generative theme gradient via
    `genArtStyle`; set → image behind a scrim through the cover CDN); Radio
    (filled) + Browse all songs (outlined) both `navigate('listen')`.
  - **Ranking window** (`rankedByListens()`): `plays_7d` desc, then `play_count`
    desc. `plays_7d` is a rolling 7-day listen count maintained by
    `refresh_plays_7d()` (hourly pg_cron) off the `plays` history table (see
    `sql/002`). **Fallback:** if fewer than 3 songs have any 7-day plays, ranking
    falls back to `play_count` desc and sets `weeklyFallback`, which switches the
    hero label ("This week's most played" → "Most played"), the weekly rail title
    ("Most listened this week" → "Most listened to"), and **omits the All-time
    rail** (so the same ranking is not shown twice). Numbers are never displayed.
  - **Hero**: the #1 ranked song as a centered landscape (3:2) card (~2/3 width
    desktop, full width mobile), with the label, title, displayed category, and
    first sentence of the note. Tapping plays it.
  - **Rails**, in order — *Most listened this week* (weekly ranking minus hero),
    *Most loved*, *Newest*, *Most talked about* (`comment_count > 0`), *All-time
    favorites* (`play_count`). Each is **deduped against everything shown above it**
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

  Built entirely from the in-memory `SONGS` array, so it works from the
  `songs.json` snapshot during an outage. Tapping any song, or a homepage search,
  navigates to `/listen`.
- **`/listen` — song page** (`#page-listen`): the two-column jukebox (player +
  lyrics + list). Its idle state is the simple "pick a song" line plus the
  listener feed. The wordmark navigates to `/`.
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
