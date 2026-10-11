# laivyhart.com local verification harness

Offline, local, deterministic. Never touches the live site, never opens Tzvi's
real browser, never hits the real Supabase project — everything it exercises
is stubbed from `fixtures.mjs`, a small fully-fictional dataset (no real
artist, song, or commenter appears anywhere here).

## Run everything

```
cd tests
npm install                      # once, pulls in playwright-core
node_modules/.bin/playwright-core install chromium   # once, downloads a local Chromium build
node run-all.mjs
```

That's the one command. It runs every spec in `specs/` against the real
repo's `index.html`, `theme.css`, `js/*.js`, etc. (the real app code, not a
mock of it) and prints a combined pass/fail count with a non-zero exit code
on any failure.

## TEST-1: parallel runs

`run-all.mjs` is an orchestrator, not a test runner itself: it forks a pool
of worker processes (default: CPU cores minus one), hands each one a slice
of the spec list, and each worker starts its own local static server, its
own headless Chromium (launched once and reused across that worker's own
specs, same as the old single-process run reused its one browser across
everything), and runs its specs in sequence against them
(`lib/worker-entry.mjs`). A separate OS process per worker, not threads or
concurrent promises in one process, is what actually isolates module-level
state (a JWKS cache, an auto-increment id, ...) between specs that might
otherwise run at the same moment.

```
node run-all.mjs                           # full suite, default worker count
node run-all.mjs --jobs 4                  # cap the pool at 4 workers
node run-all.mjs --only your-song-page,idea-credit   # just these specs (comma-separated short names; see the SPECS list at the top of run-all.mjs for every name)
LAIVY_TEST_PORT=9000 node run-all.mjs       # base port each worker's server counts up from (default 8743)
```

Output keeps the same meaning as the old single-process run: a `TOTAL: N
passed, M failed` line, and on any failure a list underneath with the
owning spec named for each one (`- [spec-name] check label`). Console
output from different workers' specs can interleave on screen since they
really do run at the same time; that final summary is always the accurate,
non-interleaved source of truth.

Before this (single process, every spec one after another): **125.3s**.
After (parallel pool, 15 workers on a 16-core machine): **~24-27s**, a
~5x speedup confirmed across three repeated full runs (566 passed, 0
failed each time). The 10 slowest spec files in the old serial run, for
reference (any one of these is also now a reasonable `--only` target while
working on that area):

| spec | time |
|---|---|
| settings | 15.2s |
| rating | 13.6s |
| artist-page | 13.5s |
| admin-song-ideas | 10.4s |
| dedicate | 9.9s |
| your-song-page | 9.0s |
| song-page | 7.9s |
| activity | 6.9s |
| admin-pulse | 6.1s |
| admin-dedications | 6.0s |

Parallelizing surfaced one real bug worth knowing about: a fixed
`page.waitForTimeout(400)` in `dedication-page.spec.mjs` was long enough to
mask a race under the old serial run's lighter load, but flaked once 15
Chromium instances were competing for CPU at once. Every fixed sleep in
every spec (105 `waitForTimeout` call sites across 17 files) has since been
replaced with a wait for the actual element, DOM condition, network
response, or (where nothing else was observable, e.g. `navigator.sendBeacon`
or an in-page debounce timer) a bounded poll -- not a longer guess. That is
also just a more reliable harness regardless of parallelism.

One known limitation, not fixed here because it is outside what a single
`run-all.mjs` invocation needs to guarantee: two separate, simultaneous
invocations of `node run-all.mjs` on the same machine (two terminals, two
CI jobs) will collide on the same deterministic port range. Pass a
different `LAIVY_TEST_PORT` to each if that ever comes up; the old
single-process harness had the same single-port limitation already, just
over a narrower range.

## What's here

- `fixtures.mjs` — the synthetic dataset: three fictional artists (Nova Ash,
  Sable Ridge, Brand New Artist) and their songs, crafted to cover every
  Honors/Success/Picks/Follow/search edge case (a song below the Honors
  weeks-on-chart threshold, a song with only live badges, a Hebrew title,
  etc.). Also `ARTISTS_JSON_ROWS`, the equivalent static-snapshot shape
  (`scripts/snapshot-songs.mjs`'s own output), used only by the
  outage-fallback scenario.
- `lib/server.mjs` — a minimal static server applying the same rewrites
  `vercel.json` declares (`/artist/:handle`, `/listen`, `/song/:slug`,
  `/settings` → `index.html`).
- `lib/browser.mjs` — shared Chromium launch/page setup: blocks
  laivyhart.com/Google Tag Manager/R2/wsrv.nl (no real egress needed or
  wanted), sets `laivy-no-track`, blocks service workers (see the comment
  in there for why — a real bug this harness caught once already).
- `lib/stub-supabase.mjs` — intercepts every Supabase REST/RPC call the site
  makes and answers from the fixtures. `artist_picks` is kept as a real
  in-memory mutable copy per page load (the one table the UI actually
  mutates and immediately re-reads); everything else is a static fixture
  with minimal, deliberate query-awareness (`eq.`/`in.`/`ilike.` filters,
  `.maybeSingle()`'s bare-object-vs-array shape) — not a full PostgREST
  reimplementation.
- `lib/stub-static.mjs` — stubs `/songs.json`, `/artists.json`,
  `/channels.json`, `/settings.json` with the fixtures, for the one
  scenario (Supabase totally down) that needs the build-time snapshot
  rather than the live tables.
- `lib/auth.mjs` — fakes a signed-in supabase-js session by writing a
  well-formed, not-yet-expired session directly into the
  `sb-<project-ref>-auth-token` localStorage key before the page's first
  script runs. No real Supabase Auth call, no real JWT signature (nothing
  here ever sends it anywhere but this harness's own stubs).
- `lib/report.mjs` — the shared pass/fail counter/printer every spec uses.
- `lib/worker-entry.mjs` (TEST-1), one forked worker's entry point: starts
  its own server and browser once, runs its assigned slice of specs against
  them in sequence, and reports back over the fork's own IPC channel (never
  stdout, which each spec's own PASS/FAIL lines already use).
- `specs/homepage.spec.mjs` — regression check that artist-page work never
  touched the homepage rails (shared functions like `railCardHTML`,
  `setupRailAffordances`).
- `specs/artist-page.spec.mjs` — `/artist/:handle`: real data, owner view,
  Follow (signed-out/third-party/error paths), a rich case (picks by a
  second artist, 3 comments, recommendations), an empty-artist case, four
  viewport widths, and the Supabase-outage snapshot fallback.
- `specs/search.spec.mjs` — the site search box's new "Artists" result
  group.
- `specs/settings.spec.mjs` — `/settings` ("My page"): My songs (all
  statuses, Edit/Withdraw), My picks (add/six-cap/unpublished-refused/
  reorder/remove), the bio editor, Following + Unfollow.
- `specs/middleware.spec.mjs` — `middleware.js`'s `decide()`/SSR, exercised
  directly in Node (no browser) against the same fixtures via two small
  generated import shims (Node's ESM loader requires an explicit
  `with { type: 'json' }` attribute this repo's actual bundler target does
  not; no logic is changed, just that attribute added).
- `specs/song-page.spec.mjs` — `/song/:slug`: the compact Follow pill
  (signed-out/signed-in/error/own-song), and a 390px layout check.
- `specs/legal-pages.spec.mjs` — `/privacy.html` returns 200 and is linked
  from the homepage footer, the sign-in modal and `terms.html`; neither legal
  page has a leftover `[ALL-CAPS]` placeholder.
- `specs/rating.spec.mjs` — the words/music star ratings: signed-out gets the
  sign-in prompt (not an age-gate message), a one-minute-old account can
  still rate, the reflection invite copy, and the heart label/count spacing
  at 390px.
- `specs/activity.spec.mjs` — `js/activity.js` (ACT-1), exercised through the
  real song page with `lib/stub-activity.mjs` intercepting `POST /event`:
  `laivy-no-track` and Global Privacy Control both suppress everything,
  queueing/flush shape, and play milestones firing once each (not on seek
  spam).
- `specs/worker-activity.spec.mjs` — the Worker's `POST /event` route
  (ACT-1), exercised directly in Node against the real
  `worker/src/index.js`: caps (25 events, 16 KB, meta trimming), unknown
  event types dropped, the JWT-verification path (valid and invalid tokens),
  a static check that no IP header is ever read, (ACT-2) the daily email's
  "Yesterday on Laivy Hart" section, and (SONG-1) its "Song ideas yesterday"
  section, including the no-crash fallback when that key is absent.
- `specs/admin-pulse.spec.mjs` — the admin Pulse tab (ACT-2), signed in as an
  admin with every `pulse_*` RPC stubbed: overview tiles/feed/top lists/
  retention, and the song, member and visitor drilldowns.
- `specs/homepage-pulse.spec.mjs` — the public Pulse box (ACT-2): absent and
  nothing fetched with the switch off, present and rendering lines with the
  switch on, and the admin-only `?preview=pulse` override (present for an
  admin, still absent for a signed-in non-admin).
- `specs/admin-dedications.spec.mjs` — the admin Dedications tab (DED-1),
  signed in as an admin with `admin_list_dedications`/`admin_remove_dedication`
  stubbed: the list (song, recipient, occasion, message, sender, time), the
  anonymous tag (shown even though the admin sees the real sender name), the
  Live/Removed/All filters, and the remove-with-reason flow, including its
  error path.
- `specs/dedicate.spec.mjs`, the Dedicate button, sheet and success state
  (DED-2): signed-out opens sign-in with the reason and returns to the song;
  client-side form validation (empty recipient, "Other" with no description)
  never reaches `create_dedication`; a successful submission shows the three
  share actions with the exact expected WhatsApp text/link and a working
  Copy link (real clipboard permission granted); a server rejection shows
  inline without faking success; the song page's Dedications strip shows
  named/anonymous senders and hides entirely with none; 390px layout.
- `specs/dedication-page.spec.mjs`, `/d/<code>` client-rendered from
  `dedications_public`: a live named dedication (headline, line, message,
  sender line), an anonymous in_memory one ("Dedicated by someone who
  cares", never a name), a removed-or-unknown code (identical "no longer
  available" message either way), the Play button handing off to the real
  player, and 1280px/390px rendering.
- `specs/dedication-occasions.spec.mjs` (DED-3): the canonical headline/
  line/sender-line/share-text table in index.html, called directly in-page
  rather than round-tripped through the form 21 times: every occasion's
  headline and line, the sender line's "With love"/"Dedicated by" (in_memory)
  split and its anonymous form, the WhatsApp/share text per occasion
  including the in_memory exception, and the grouped (optgroup) dropdown.
- `specs/admin-song-ideas.spec.mjs` (SONG-1): the admin "Your Song" tab,
  signed in as an admin with `admin_list_song_ideas`/`admin_week_picks`/
  `admin_set_song_idea_status` stubbed: the list (idea text, submitter name
  and email, credit and anonymous tag, hearts), the status filters, the
  week-picks header (a gentle note past 3, not a block), the Pick/In the
  studio/Not this week actions, the Released song picker (including the
  refusal to confirm with nothing chosen), and the Copy button.
- `specs/your-song-page.spec.mjs` (SONG-2): `/your-song` end to end --
  every section renders (hero, three steps, the box, This week, FAQ); the
  box copy has no topic examples (the placeholder and helper line checked
  exactly); signed-out Submit opens sign-in and saves the typed text to
  sessionStorage, restored (and cleared) on the next load; signed-in Submit
  prefills the credit field and succeeds to the "Thank you" pane with both
  links; "Made from your ideas" stays hidden with no credited song and
  shows one once a song carries `idea_credit`; 1280px/390px rendering.
- `specs/your-song-ideas-board.spec.mjs` (SONG-2): `/your-song/ideas` --
  cards (idea text, credit, hearts, "Made into a song" when released) with
  no user id anywhere in the markup, the Newest/Most hearted tabs actually
  reordering, a signed-out heart opening sign-in instead of hearting, and a
  signed-in heart toggling the count and the filled state both ways.
- `specs/idea-credit.spec.mjs` (SONG-2): "Idea by [name]" on the song page
  links to a real artist profile when the credit name exactly matches one
  (`artists_public`), stays plain text for a credit with no match and
  always for "Anonymous" (never even looked up), and the line is absent
  entirely when the song carries no idea credit.
- `specs/worker-song-idea-notify.spec.mjs` (SONG-2): the Worker's
  `POST /notify/song-idea`, exercised directly against the real
  `worker/src/index.js` the way `worker-activity.spec.mjs` exercises
  `/event`: a non-POST method, a missing/invalid token, a verified
  non-admin (403, no email sent), the "picked" and "released" subjects and
  bodies (the song link and "Idea by" credit for "released"), and
  `notify_email: false` skipping the send entirely.
- `specs/canonical-origin.spec.mjs` (CANON-1): a filesystem scan over every
  file this site serves or produces at build time (skipping `tests/` and
  `worker/`, the two places that intentionally keep both the bare and www
  hosts), asserting none of them contain the old `https://www.laivyhart.com`
  form. The canonical-tag and og:url checks for `/`, `/song/:slug`,
  `/artist/:handle` and `/d/:code` live in `middleware.spec.mjs` instead,
  next to the rest of that route's SSR checks.
- `specs/worker-geo.spec.mjs` (HOME-1): `worker/src/geo.js`'s
  `resolveDisplayLocation()`, exercised directly (no browser): real
  coordinates resolve to the nearest decent-size (population >= 100,000)
  city (a Giv'at Shmuel-area point lands on a Tel Aviv-metro city, a US
  suburb lands on a nearby large city, a city already on the list resolves
  to itself), missing coordinates fall back through `cf.city` then
  `cf.region` then country alone, and the module never reads or returns a
  latitude, longitude or IP.
- `specs/homepage-ticker.spec.mjs` (HOME-1): the ticker band on `/` and
  `/listen` -- real `public_ticker()` rows render linked with
  display_city/display_country, padding kicks in under 6 real items
  (recent releases, then "#1 this week"), the band hides entirely with
  nothing to show at all, hover (CSS) and touch (a JS pause class) both
  stop the scroll, `prefers-reduced-motion` renders static and fades
  through one item at a time, and no identity field ever reaches the DOM.
- `specs/homepage-get-involved.spec.mjs` (HOME-1): the homepage "Get
  involved" box beside the #1 song -- three actions render only when
  `contribute_cta_enabled` is on (same gate as before), "Send a song idea"
  links to `/your-song`, and "Dedicate a song" opens the sign-in modal
  (with the right reason and a `next` that carries a `dedicate=1` marker)
  when signed out or the song picker (search, Recent, Popular) when signed
  in, handing a chosen song straight to the existing dedicate sheet. Also
  covers the signed-out round trip through `/auth/callback?next=/?dedicate=1`
  reopening the picker automatically once signed in.
- `specs/your-song-nav.spec.mjs` (HOME-1): "Your Song" in the main nav for
  everyone (`site_settings.your_song_nav_enabled`, now on), signed in and
  out, and that the switch itself still works if ever turned back off; plus
  a static sweep confirming the old "we pick three" wording is gone from
  `your-song.html`, `admin.html` and `middleware.js`.

## Adding a scenario

Reuse `lib/browser.mjs`'s `newPage()`/`collectErrors()` and
`lib/stub-supabase.mjs`'s `wireSupabaseStubs(page, overrides)` — pass only
the fixtures you need to change (e.g. `{ artistPicks: [...] }`); everything
else falls back to the committed fixtures. Use `lib/report.mjs`'s
`makeReporter()` for pass/fail output so `run-all.mjs`'s totals pick it up
automatically once you add your spec's `run()` export to `run-all.mjs`.

## A bug this harness already caught once

`setupRailAffordances()` was hardcoded to `#homepage`, so the artist page's
rails never actually got their edge-fade/arrow wiring (only native
touch/trackpad scroll worked) — this harness is why it was parameterized.
The `swap_my_pick_positions` SQL function's first draft also had a real
swap bug (both rows ended up at the same position) that an aborting SQL
test caught before it ever reached this harness or production.
