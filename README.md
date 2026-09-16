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
   record of schema changes applied in numerical order; the live schema wins if
   they ever disagree.
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

## Homepage

The left panel's idle state (and the view you get by tapping the LAIVYHART
wordmark while a song plays) is a sectioned homepage, built entirely from the
in-memory `SONGS` array — no extra Supabase queries — so it works from the
`songs.json` snapshot during an outage. All ranking lives in one place,
`homepageSections()`, which returns `{ hero, rails }`; `renderHomepage()` is a
dumb render loop over that.

- **Hero**: the first Editor's pick (lowest `featured_order`, ties by
  `created_at` desc). Full-bleed cover banner; tapping it plays the song. No
  "featured" label. Omitted when no song is marked `featured`.
- **Rails** (horizontal, snap-scrolling, max 8 songs each). A rail renders only
  when it has **at least 3** qualifying songs; otherwise it is omitted with no
  empty state:
  - *Editor's picks* — `featured` by `featured_order` then `created_at` desc,
    excluding the hero.
  - *Most listened to* — `play_count` desc.
  - *Most loved* — `like_count` desc.
  - *Most talked about* — `comment_count` desc, only songs with
    `comment_count > 0`.
  - *Newest* — `created_at` desc.
- **Comments from listeners**: the existing `loadFeed` feed, at the bottom,
  capped at 8 with a "More" expander.

A rail's "Play all" starts the rail in order in manual mode via a small ordered
`manualQueue` (manual mode otherwise has no queue); `manualStep` and end-of-track
auto-advance follow it, and any non-rail selection clears it. No counts, badges,
or "trending" language appear anywhere on the homepage — only the section names.
