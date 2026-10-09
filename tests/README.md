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

That's the one command. It starts a local static file server (serving the
real repo's `index.html`, `theme.css`, `js/*.js`, etc. — the real app code,
not a mock of it), launches one headless Chromium, runs every spec in
`specs/`, and prints a combined pass/fail count with a non-zero exit code on
any failure.

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
  a static check that no IP header is ever read, and (ACT-2) the daily
  email's "Yesterday on Laivy Hart" section.
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
  `dedications_public`: a live named dedication, an anonymous one ("From
  someone", never a name), a removed-or-unknown code (identical "no longer
  available" message either way), the Play button handing off to the real
  player, and 1280px/390px rendering.

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
