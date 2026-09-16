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
