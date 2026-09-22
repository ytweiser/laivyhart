# /brand

Static brand images, committed directly rather than uploaded through the admin
(the admin uploader writes to Cloudflare R2 and is for song audio and covers).

Vercel serves the repo root statically (`vercel.json` sets `outputDirectory: "."`
and there is no build step for the app), so every file here is served at
`/brand/<name>` with no config change. The Edge Middleware never sees these
requests: its matcher is `/` alone, so nothing under `/brand` is intercepted.

Expected files, exactly these names:

| file | what it is |
| --- | --- |
| `banner.png` | the full banner, wordmark on the glow background, 3:1 |
| `banner-bg.png` | the background only, glow and horizon, no text, for compositing |
| `wordmark.png` | the wordmark alone, transparent background |
| `plate-bordeaux.png` | per-theme background plate, flared horizon + gold sunburst, no text |
| `plate-royal.png` | same, Royal Blue |
| `plate-emerald.png` | same, Emerald |
| `plate-gold.png` | same, Gold |

The four plates are named for the **`data-color` keys** in `COLORS`
(`index.html`), not for their display labels — so Royal Blue is `plate-royal`.
Getting this exact is what lets the banner pick one with a plain
`` `brand/plate-${colorTheme}.webp` ``. All four are 2172x724 (3:1), 8-bit RGB
PNG, no alpha — the same canvas as `banner-bg.png`. Their sunburst stays gold on
every theme; only the scene behind it changes color.

Keep the originals byte for byte: do not resize or recompress them. If a file is
actually a JPEG rather than a PNG, keep its real extension and update the name in
both this table and the `BRAND` list in `sw.js`.

Each one also has a **WebP display derivative** beside it, built by
`scripts/make-brand-webp.mjs` and committed: `banner.webp`, `banner-bg.webp` and
the four `plate-*.webp` at 1600px, `wordmark.webp` at 1200px with its alpha
intact. Those are what the homepage renders; the PNGs above stay untouched as
the source files and as the fallback for a browser that cannot decode WebP. The
plates are encoded at q86 rather than banner-bg's q82 because the sunburst's
fine rays are the first thing a low quality smears.

| | PNG | WebP |
| --- | --- | --- |
| banner | 1278 KB | 52 KB |
| banner-bg | 1267 KB | 29 KB |
| wordmark | 649 KB | 67 KB |
| plate-bordeaux | 1873 KB | 107 KB |
| plate-royal | 1538 KB | 56 KB |
| plate-emerald | 1734 KB | 85 KB |
| plate-gold | 1669 KB | 82 KB |
| total | 9.77 MB | 478 KB |

`sw.js` precaches the **WebP** files into the asset cache, separately from the
shell and tolerantly: a file that is missing or renamed is skipped instead of
failing the service worker install — all seven, ~478 KB. The PNGs are not
precached, since almost nobody fetches them; they are cached on first use by the
normal stale-while-revalidate path. That includes the four plate PNGs: at
6.6 MB, and covering all four themes when a visitor only ever renders one, they
are exactly the kind of weight this list exists to keep out of the install.
