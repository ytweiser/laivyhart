# Laivy Hart — project report v3

Supersedes v2. Written at the close of **Stage 1A** (prompts 1A-1 … 1A-7),
against the code and migrations actually deployed, not against a plan.

Project: **laivyhart.com** · Supabase ref `tshkrghrgokplakktvik` · Vercel + Cloudflare R2/Workers

> **Note on this rewrite.** v2 lives in the project knowledge base and is not in
> the repository, so this file could not be diffed against it. **Part One is
> authoritative** — every statement in it was read out of the shipped code, the
> migrations, or the live database. **Parts Two, Four and Five are scaffolds**
> reconstructed from the Stage 1A briefs and from how the work was actually
> done; where v2 carried prose that is not derivable from the code, merge it
> back in rather than taking this file as complete. v2 is not deleted — mark it
> *superseded by v3* wherever it is stored.

---

## Part One — What is built

### The site

A single-page jukebox at `/` (homepage) and `/listen` (the song page), plus
`/about`, `/terms`, `/settings`, `/artist/<handle>` and `/song/<slug>`. All are
one `index.html` served through Vercel rewrites, except `about.html` and
`terms.html`. A service worker (`CACHE_VERSION`, currently **v82**) caches the
shell network-first and assets stale-while-revalidate, and bypasses `/auth/*`,
`/settings` and every `*.supabase.co` host.

**37 approved songs**, all owned by the one artist, `laivyhart`.

### Songs — the data shape (corrected facts)

There is **no separate Hebrew and English title**. A song has:

- `title` — not null, holds Hebrew **or** English
- `title_translit` — the transliteration, nullable
- `language` — distinguishes the two

and `lyrics_original`, `lyrics_translation`, `about`, `audio_url`, `cover_url`,
`cover_focus_x/y`, `featured_category`, `categories[]`, `tags[]`.

**There is no `updated_at` on songs.** Anywhere a "last modified" is needed
(the sitemap), `reviewed_at` is used, falling back to `created_at`.

`length_seconds` and `duration_seconds` both exist; both were empty until
1A-5's backfill read all 37 from the R2 audio headers.

### Accounts

Sign-in is **magic link + Google**, PKCE, through Supabase Auth. There is no
password anywhere in the public UI; the admin keeps a password form purely as
the owner's fallback.

- One Supabase client per document (`js/supabase-client.js`), because two
  clients share the auth storage key and race on refresh.
- `js/auth.js` holds `window.laivy.auth = { user, artist, ready }` and fires a
  `laivy:auth` event. Nothing in a render path calls `getSession()`.
- `/auth/callback` validates its `next` parameter against an open redirect and
  `replaceState`s the one-time code out of the address bar.
- **The project issues ES256 JWTs** with a published JWKS, which is why the
  Worker's avatar route needs no shared secret.

### Artists, and the listener/artist line

Every auth user gets an `artists` row from `handle_new_user()`. Since 1A-7 an
explicit **`is_artist`** flag separates the two kinds of account:

| | listener | public artist |
|---|---|---|
| has an account, can rate | yes | yes |
| in `artists_public` / `artists.json` / sitemap | **no** | yes |
| `/artist/<handle>` resolves | **no** ("Artist not found") | yes |
| chip "My page" goes to | `/settings` | their page |

Rating is **not** gated on `is_artist` — a listener rates freely. `is_artist`
controls whether you have a public *page*. Only an admin can flip it
(`promote_to_artist` / `demote_to_listener`); the artists guard raises
"You cannot make yourself a public artist" on any self-write.

`artists_public` is the single definition everything inherits: the site's handle
resolution, `artists.json`, and the edge middleware all read it, so none of them
had to learn about `is_artist`.

**Account deletion bans rather than deletes.** `artists.id` references
`auth.users` `ON DELETE CASCADE` while `songs.artist_id` references `artists`
with no action — deleting the user cascades the artist away and then violates
the songs FK, so the delete raises and the scrubbing rolls back with it.
`delete_my_account()` instead scrubs the profile, frees the handle, sets the
songs to `removed`, and sets `banned_until = 'infinity'`. **Deleting a user from
the Supabase dashboard will fail with an FK error** for the same reason; use the
admin's Artists tab, which calls `admin_delete_artist()` and does the songs
first.

### The status pipeline

Songs carry `status` in `draft | submitted | approved | rejected | removed`,
plus `submitted_at`, `reviewed_at`, `slug`, `source`, `contest_id`.

**Every status change goes through `review_song(song, decision, reason)`**,
which writes the `reviews` row, stamps `status` and `reviewed_at`, and assigns
the slug on first approval — all in one transaction. The admin never writes
`status` directly. `reviews` records human and (later) AI decisions.

`token_ledger` exists with `token_balance()` and restrictive RLS. **Nothing
writes to it yet**; it is the placeholder for the token economy.

### Ratings (Option B)

The **heart is unchanged**: anonymous, one tap, public `like_count`, feeding the
"Most loved" rail.

The **words** and the **music** are 1-to-5 star ratings that require an account.
`rate_song()` is the only write path and enforces sign-in, facet, range,
approved song, active account, not-your-own-song, and an age gate read from
`site_settings.account_age_hours` (48h). One row per account per song per facet,
changeable, never deletable by the rater.

- The **average is withheld** below `site_settings.min_ratings` (5). The rater
  **count is never rendered anywhere** — house rule.
- `like_lyrics_count` / `like_tune_count` are no longer written. The columns
  stay for history and the admin's read-only split.

Nightly, `take_chart_snapshot()` writes **three** lists to `chart_snapshots`,
distinguished by `kind` (`plays` | `words` | `music`):

- `plays` — the top 10 by `plays_7d`, exactly as before.
- `words` / `music` — a Bayesian average, `(sum + m·C) / (n + m)`, with
  `m = min_ratings` and `C` the night's site-wide facet mean (3.0 when there are
  none). Songs with no mature rating are excluded, not seeded at the prior.

**The ranking and the display read different sources on purpose.** The dock
average uses the cached `rating_<facet>_n/sum`, which count everyone. The
nightly ranking recomputes from `ratings ⋈ auth.users` counting only accounts
**≥ 7 days old**, so a fresh account can move what one visitor sees but cannot
move the chart.

`chart_snapshots` is keyed **`UNIQUE (chart_date, kind, rank)`** — it was
`(chart_date, rank)`, which would have collided the moment a second kind was
written. All three readers (homepage, admin Charts, snapshot script) filter
`kind='plays'` explicitly.

### URLs, sharing and indexing

Every approved song has a permanent **slug** and a canonical **`/song/<slug>`**.
The slug is `slugify(title)` — or the transliteration when the title is Hebrew —
plus four hex characters of the id, so it is unique without a lookup and stable
across a title edit.

- **`/?song=<id>` 301s to `/song/<slug>`**, so links already in WhatsApp keep
  landing.
- The **edge middleware** server-renders `/song/*` and `/artist/*`: real
  `<title>`, description, canonical, OG/Twitter, a hidden `#ssr` body carrying
  the lyrics for crawlers, and JSON-LD (`MusicRecording` / `MusicGroup`).
  Unknown slugs and non-public artists get a `noindex` shell.
- `og:image` is always the **wsrv.nl compressed variant**, never the raw
  multi-megabyte R2 object — the WhatsApp bug, fixed once and guarded since.
- `sitemap.xml` (42 URLs today) and `robots.txt` are generated each build.

### Attribution

Every surface that shows a song names its artist, linked to their page: song
rows (`Laivy Hart · Faith` on the meta line), the hero ("by …"), rail cards
(line 2), the now-playing panel (28px avatar + name), and the mini-player.
Search gained an **Artist** field, normalised like every other field so a Hebrew
name matches regardless of nikkud.

Two link shapes, because HTML forbids an `<a>` inside a `<button>`: a real
anchor in divs, a `span[role=link]` inside buttons. One delegated handler in the
**capture phase**, which is what makes an artist tap navigate instead of playing.

### The admin

`admin.html`, gated on the database's own `is_admin()` rather than "is there a
session". Tabs: songs, Comments, Charts, and **Artists** (new in 1A-7 — list,
filter, promote/demote, suspend/restore, delete, plus a "since last visit"
sign-up count). Songs have a status pill, a status filter, a Status box with the
review history and Approve/Reject/Remove/Restore, and an artist picker.

### Security posture

RLS is on and forced across every table. The full matrix is in the 1A-7 report.
In short: anon reads approved songs, approved comments, categories, charts,
settings and `artists_public`, and writes **only** a pending comment. A
signed-in listener adds their own artist row, their own ratings and their own
(empty) ledger. A public artist additionally writes their own draft/submitted
songs. Everything privileged goes through SECURITY DEFINER functions that
re-check `is_admin()` in the database.

**Comments and categories writes were tightened to admin-only in 1A-7's
predecessor (007)** — they had carried "any authenticated user may write" from
the original single-user model, which was harmless with one account and a hole
the moment anyone could sign in.

---

## Part Two — How we work

*(Reconstructed from practice in Stage 1A; merge v2 prose where it is richer.)*

- **One Supabase project**, ref `tshkrghrgokplakktvik`, confirmed before every
  MCP call.
- **Migrations are numbered files in `sql/`**, idempotent, applied through the
  MCP under a matching name. `001`–`010` at the close of 1A.
- **Verification before claiming.** RLS and behaviour checks run as `DO` blocks
  that do the work and then **raise to abort**, so nothing persists. Frontend
  changes are verified by running the *shipped* functions — extracted from
  `index.html` at test time — over the real snapshot, rather than a retyped
  copy.
- **The service worker's `CACHE_VERSION` is bumped on every deploy.**
- Never the service role key in anything the browser or the committed
  middleware loads.
- The site is static; `vercel.json` sets `outputDirectory: "."` and the build
  command regenerates `songs.json`, `artists.json`, `chart.json`, `sitemap.xml`
  and `robots.txt`.

---

## Part Three — Stage 1 design decisions

- **Option B for ratings**: the heart stays a one-tap anonymous love; the words
  and the music become account-gated 1-to-5 ratings. Two different instruments
  for two different jobs.
- **Never show play counts** publicly. Never show the rater count. Averages only
  once there are enough of them.
- **`is_artist`** rather than "has songs": a person can be a listener with an
  account indefinitely, and that must not produce an empty public page.
- **Slug assigned in `review_song()`**, not a trigger, to avoid depending on
  BEFORE-trigger ordering against the freeze guard.
- **Approved songs are frozen** for their artist; the one remaining move is
  pulling the song down (`removed`).
- **Quiet launch**: no "Join" call to action. The only entry point is a small
  "Sign in" in the nav.

---

## Part Four — Roadmap

**Stage 1A is complete** (1A-1 … 1A-7).

**1B — contributor upload flow and the review queue.** What it inherits:

1. The submit path must **flip `is_artist` true** (inside a SECURITY DEFINER
   function) and rely on `review_song()` to assign the slug on approval.
2. ~~Two generic Hebrew slugs~~ — **CLOSED 23 September 2026.** The owner
   entered English titles in the admin and the two slugs were regenerated from
   them: `song-26b4` → `your-better-half-26b4` (שמם אדם, "Your Better Half")
   and `song-e93c` → `nature-s-beauty-e93c` (ברכי נפשי, "Nature's Beauty").
   Applied as the one-time data migration `data_fix_reslug_two_hebrew_songs`;
   the other 35 slugs were verified byte-identical before and after. Neither
   old URL was ever shared, so no redirect was needed.
3. `admin_delete_artist()` is already FK-aware (songs → `removed` first).
4. The avatar upload route exists and is JWT-authorized; **avatar orphan
   cleanup is manual and monthly** (`scripts/check-orphans.mjs`).
5. Durations are read automatically by the admin on upload from 1A-5 onwards.

Later stages: the token economy (`token_ledger` is ready), Best-words /
Best-music rails reading the nightly lists, contests (`contest_id` exists), and
the daily email report that replaces the "since last visit" counter.

---

## Part Five — AI research

*(Not derivable from the code; carry v2's content forward.)*

What the schema already anticipates: `reviews.reviewer_kind` accepts `'ai'` with
a `model` and a `confidence`, and the decision vocabulary includes
`recommend_approve`, `recommend_reject` and `flag` — so an AI reviewer can file
advisory rows alongside human ones without any schema change. `songs.source`
distinguishes `uploaded`, `ai_lyrics` and `ai_generated`. The terms already
forbid imitating a named artist, including with AI tools.

---

## Open items at the close of 1A

Items 1–3 were closed by the cleanup pass of **23 September 2026**.

1. ~~The two generic Hebrew slugs.~~ **CLOSED** — regenerated from the owner's
   transliterations; see 1B inheritance note 2 above for the new slugs.
2. ~~`[DATE]` placeholder in the terms.~~ **CLOSED** — both
   `docs/legal/terms-v1.md` and `terms.html` now read "23 September 2026". The
   text is mirrored, not generated, so both files must be edited together.
3. ~~`sql/008b_durations_generated.sql` unrun.~~ **CLOSED** — applied as the
   migration `008b_durations`. All 37 songs now carry a `duration_seconds`.
   The file stays in `sql/` as the record of what was run.
   **One value was wrong and has since been corrected** (23 September 2026):
   "Hear it From Them" read **33s**. The audio in R2 was never truncated — the
   file simply carries no Xing/VBRI header, so `music-metadata` could not read
   a declared duration and estimated one from the buffer it was given. The
   backfill hands it a 512 KB `Range` slice, and
   `512*1024*8 / 128000 bps = 32.77s`, which rounded to 33. Parsing the whole
   5,756,589-byte object gives **359.78s → 360s**, agreeing three ways (parser
   duration, `numberOfSamples/sampleRate`, `totalBytes*8/bitrate`) and matching
   the owner's player reading of −5:40 remaining at 0:18. Fixed by the one-row
   migration `data_fix_duration_hear_it_from_them`.

   The other 36 were screened by **implied bitrate** (`bytes*8/duration`, which
   needs only a `HEAD`): all land in a normal **128–225 kbps** band, so they
   are credible. The bad row implied 1396 kbps, which no MP3 is. That screen is
   the cheap way to catch this class of error in future.

   **Latent bug, not yet fixed:** `scripts/backfill-durations.mjs` will make the
   same mistake on any future file lacking a Xing header, and it fails silently
   with a plausible-looking small number. It should reject a duration whose
   implied bitrate is outside roughly 64–320 kbps and re-read the full object
   instead.
4. Avatar orphan listing needs wrangler 4 (`r2 object list` does not exist in
   the pinned 3.x).
