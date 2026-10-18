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
  retention, and the song, member and visitor drilldowns. PULSE-2:
  `pulseProgressLabel()`/`pulseFeedVerbHTML()` (every furthest_pct branch),
  the live feed and the member/visitor history both reading "finished" /
  "listened to N%" for a listen (never the old "kept listening to"), and
  two separate listens of the same song rendering as two distinct lines.
  The SQL grouping itself (`_pulse_listen_rows()`, the 30-minute ticker/
  Pulse-box collapse) is verified live against the project, not here --
  this harness has no real Postgres to exercise it against.
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
- `specs/play-continuation.spec.mjs` (PLAY-1): the music never stops. A stubbed
  silent WAV per song; a /listen row, a `/song/<slug>` page and a `/d/<code>`
  page each roll into radio on `ended` (labelled "Radio", logged as
  `play_start` with `meta.source = 'autoplay'`); one run lets the clip end on
  its own; no repeat inside the last 15 (41-song pool) or half the pool (9
  songs); Mood radio stays in its channel; Keep playing after each song off stops and is
  remembered; an artist Play all finishes in order before radio; Media
  Session metadata; the share button's canonical `/song/<slug>` URL.
- `specs/share-og.spec.mjs` (PLAY-1): middleware.js's real default export under
  a WhatsApp, a phone-browser and no user agent: exactly one og:image per song
  and dedication page, the song's `og/<id>.jpg`, with the 600x600 JPEG tag set
  and twitter card; the square wsrv fallback; a song approved after the last
  deploy (live lookup); `/song/<id>` and `/?song=` redirects; home keeps the
  logo, artists keep the avatar.
- `specs/worker-og-upload.spec.mjs` (PLAY-1): the Worker's
  `/upload/cover?og_for=<song-id>`: own song only, uuid only, 200 KB cap,
  plain cover uploads unchanged.
- `specs/image-compress.spec.mjs` (IMG-1): `js/image-compress.js` and every
  picture upload. A >3 MB test photo stored sideways (EXIF orientation 6) with
  a GPS block comes out upright, under 300 KB, longest side 1200, with no
  EXIF/XMP/IPTC; a small picture is not enlarged; the avatar is a 400 px
  square; HEIC this browser cannot decode, a PDF and a corrupt file get the
  "isn't supported" message; over 20 MB is refused. The contributor form,
  the admin song editor and the avatar on My page each show "Ready, N KB"
  and send that compressed file (decoded and measured at the stubbed Worker),
  plus the 600x600 og/ copy for covers.
- `specs/stations.spec.mjs` (RADIO-2): the mood stations. The /listen row
  (RADIO first, then every channel in order; the old Mood radio dropdown
  gone); a mood tap plays a song from that mood, highlights it alone and
  filters the list; RADIO returns to all songs; nothing lit off radio; the
  station line ("On Radio: All songs" / "On Radio: <mood>" / "Playing:
  <queue>") under the play controls; Change station opens, switches, closes
  (pick, Escape, close button, outside tap); the takeover glow and its
  reduced-motion form; the mini-player's "Radio · <mood>"; a 375 px screen
  (one sideways-scrolling line, fade, search box on screen); and 4.5:1 text
  contrast for every station button in all 4 colors x light/dark.
- `specs/share-text.spec.mjs` (SHARE-1): what a song or dedication share
  sends, through the real buttons (song Share with and without a native
  sheet, the dedication success pane's WhatsApp/Copy/Share, the /d/<code>
  page's Share). Song: note + title as the song page shows it + ", by
  <artist>", the inspiration in quotes (left out when empty; cut at a full
  sentence, else a whole word, with "…" within ~280 characters), then the
  canonical /song/<slug> link alone as the last line. Dedication: note +
  the phrase table's headline (SHARE-1b: for Something else, followed by
  ": <the write-in>", trimmed, as typed; the /d page itself unchanged), the
  message in quotes, its sender line (none when anonymous), the canonical
  /d/<code> link. Normal, anonymous,
  no message, In memory, Something else, a Hebrew title and a Hebrew
  message; wa.me text decodes back exactly; the native sheet gets the link
  once, as url, never also in text; one emoji, the note. The single
  og:image for /song/ and /d/ stays share-og.spec.mjs's.
- `specs/sleep-timer.spec.mjs` (SLEEP-1): the sleep timer, on Playwright's
  fake clock. Once paused, no setTimeout/setInterval fires at all (a phone
  throttling every timer), so anything that still fires on time did so from
  the audio's own timeupdate events. Every option's deadline and label, Off
  shown only while running, Off cancels, a new pick replaces the old, a
  reload clears it; the mini-player's moon and time left; time up fading
  over ~10s then pausing with the volume put back (and a hand pause
  mid-fade); the iPhone case (volume writes ignored: pause at the time, no
  fade); time up while paused (only the timer clears); End of this song
  stopping both radio and a Play all queue; Keep playing never touched; the
  sleep_timer_set/sleep_timer_fired calls; and 4.5:1 contrast for every
  sleep control (and, since PLAYER-4, the Keep playing label) in all 4
  colors x light/dark. PLAYER-4: Sleep at the right end of the play
  controls row, centered with play, above "What did you think?", station
  line right under the row, at 1280 and 375 px; at 300 px the long label
  wraps to its own line under the buttons; buttons never shrink, no
  sideways scroll; no Autoplay switch left in the panel. (The switch itself,
  now in the Sleep menu, is covered in play-continuation.spec.mjs.)
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
- `specs/homepage-show-some-hart.spec.mjs` (HOME-1, renamed in HOME-2,
  numbered cards in HOME-2b): the homepage "Show some Hart" box beside the
  #1 song -- the heading, "Three ways to put your heart into the music.",
  and three cards in order ("Dedicate a song", "Send us your song idea"
  linking to `/your-song`, "Upload your song" opening sign-in with
  `next=/upload`), each with a big faded number 1-3 (aria-hidden, 15% at
  rest, 25% on hover/focus, no transition with reduced motion) and no
  icons; the "Two ways" form numbered 1 and 2 when upload is left out; only
  when `contribute_cta_enabled` is on; no "Get involved" anywhere. Every
  skin in light and dark at 375 and 1280 px: heading on one line, cards
  fit, each circle about 1.6x its card and cut by its top, bottom and left
  while the digit stays whole, and all text at 4.5:1+ even over a number.
  "Dedicate a song" opens the sign-in modal (with the right reason and a
  `next` that carries a `dedicate=1` marker) when signed out or the song
  picker (search, Recent, Popular) when signed in, handing a chosen song
  straight to the existing dedicate sheet. Also covers the signed-out round
  trip through `/auth/callback?next=/?dedicate=1` reopening the picker
  automatically once signed in. HOME-3: the gold heart after the heading
  (inline SVG, aria-hidden, the heading still reads "Show some Hart"):
  right after "Hart" on the one heading line, about cap height, 3:1+
  against the box in every skin at both widths; tilted 8deg; still at rest;
  one 0.8s double beat (scale 1.12) on hover or a card's keyboard focus,
  with nothing around it moving; and animation-name none under reduced
  motion (theme.css's global 0.001ms rule alone would also leave nothing
  running, so the check is on the name, not just on running animations).
- `specs/your-song-nav.spec.mjs` (HOME-1): "Your Song" in the main nav for
  everyone (`site_settings.your_song_nav_enabled`, now on), signed in and
  out, and that the switch itself still works if ever turned back off; plus
  a static sweep confirming the old "we pick three" wording is gone from
  `your-song.html`, `admin.html` and `middleware.js`.
- `specs/now-playing-layout.spec.mjs` (LISTEN-1): the now-playing panel's
  reordered layout -- progress, prev/play/next, heart then words/music
  stars, Dedicate+Share, Dedications strip, all above the lyrics now; the
  lyrics are no longer a fixed-height, internally-scrolling box (the old
  drag handle is gone entirely); nothing inside the panel has its own
  vertical scroller; the comments are reachable by scrolling the page; and
  the language toggle still sits with the lyrics heading.
- `specs/site-header.spec.mjs` (LISTEN-1): the shared `#route-header` +
  ticker band for the routes that used to render into a bare root with no
  header at all (`/artist/:handle`, `/d/:code`, `/settings`, `/upload`),
  each with a Home link that actually navigates; confirms `/` and `/listen`
  still use their own existing header and never double up; and the
  `/listen` list header's Radio + Mood radio (left/first, filled/prominent)
  vs. Songs/Playlists (right/quieter) at 1280 and 390.
- `specs/select-contrast.spec.mjs` (LISTEN-1): every native `<select>`'s
  opened dropdown ("white on white") -- color-scheme set on the control and
  option/optgroup contrast (background vs. text, including the optgroup
  label) checked live via `getComputedStyle` across all 8 color x lighting
  combinations, each required to clear 4.5:1 (worst case printed to the
  console: gold-light, ~12.7:1 at the time this was written).
- Dedication preview/counter fixes (LISTEN-1) live inside the specs that
  already owned that surface rather than a new file:
  `dedicate.spec.mjs` ("Something else" preview clean when empty/filled/
  typed-with-trailing-punctuation; the message counter showing 280 on an
  empty box, the real typed length after typing/deleting, unaffected by
  switching occasion, and reset -- not stale -- on reopening),
  `dedication-occasions.spec.mjs` (the same fix at the `dedLine()` level,
  directly), and `middleware.spec.mjs` (the SSR `og:description` for the
  same empty-box case).
- `specs/grants-audit.spec.mjs` (1B-4): the standing audit against grant
  drift. Replays every `sql/*.sql` migration in order (`lib/grants-model.mjs`)
  to compute the current EXECUTE grant state of every function in public,
  purely from the committed SQL text -- no live database connection or
  credentials, deliberately, since this project's own rule is that a
  service-role key lives only in the Worker. Fails if any function is
  anon-callable without being on `tests/sql/anon-allowlist.txt`, if an
  allowlisted function has quietly lost anon access, or if any SECURITY
  DEFINER function is missing `search_path`. What it cannot see: two live
  functions (`delete_category`, `rename_category`) with no `create function`
  anywhere in `sql/` at all -- not in this project's migration history,
  so nothing for a text-based model to find; locked down live by
  `028_hardening.sql` regardless, and flagged in that migration's own
  report, not something a static check over committed files ever could be.

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
