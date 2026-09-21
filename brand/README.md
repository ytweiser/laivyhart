# /brand

Static brand images, committed directly rather than uploaded through the admin
(the admin uploader writes to Cloudflare R2 and is for song audio and covers).

Vercel serves the repo root statically (`vercel.json` sets `outputDirectory: "."`
and there is no build step for the app), so every file here is served at
`/brand/<name>` with no config change. The Edge Middleware never sees these
requests: its matcher is `/` alone, so nothing under `/brand` is intercepted.

Expected files, exactly these names:

| file | what it is | used by the page? |
| --- | --- | --- |
| `banner.png` | the full banner, wordmark on the glow background, 3:1 | no — source of `/og-image.png` |
| `banner-bg.png` | the background only, glow and horizon, no text | no — fallback, see below |
| `wordmark.png` | the wordmark alone, transparent background | **yes** |

The homepage banner **draws its own plate in CSS** (`.site-banner-bg` in
`index.html`): a near-black ground, a soft glow rising from the lower centre in
the active theme accent, and a thin curved horizon in a fixed warm gold with a
bloom and a faint reflection. Only the glow follows the palette; the horizon is
gold on every theme, because the wordmark resting on it is. `wordmark.png` is
composited over that plate at every width, unchanged.

`banner-bg.png` is kept as the fallback if the drawn plate ever has to be
reverted, and `banner.png` stays as the source the share image is cut from.
Neither is fetched by the page, so neither is precached.

Keep the originals byte for byte: do not resize or recompress them. If a file is
actually a JPEG rather than a PNG, keep its real extension and update the name in
both this table and the `BRAND` list in `sw.js`.

Each one also has a **WebP display derivative** beside it, built by
`scripts/make-brand-webp.mjs` and committed: `banner.webp` and `banner-bg.webp`
at 1600px, `wordmark.webp` at 1200px with its alpha intact. `wordmark.webp` is
what the homepage renders; the PNG stays untouched as the source file and as the
fallback for a browser that cannot decode WebP. The two banner derivatives are
kept alongside their PNGs and are no longer rendered.

| | PNG | WebP |
| --- | --- | --- |
| banner | 1278 KB | 52 KB |
| banner-bg | 1267 KB | 29 KB |
| wordmark | 649 KB | 67 KB |
| total | 3.12 MB | 148 KB |

`sw.js` precaches `wordmark.webp` into the asset cache, separately from the
shell and tolerantly: a file that is missing or renamed is skipped instead of
failing the service worker install. Nothing else here is precached — the PNGs
because almost nobody fetches them, the two banner WebPs because nothing
renders them at all. All of them are still served, and are cached on first use
by the normal stale-while-revalidate path.
