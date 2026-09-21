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

Keep the originals byte for byte: do not resize or recompress them. If a file is
actually a JPEG rather than a PNG, keep its real extension and update the name in
both this table and the `BRAND` list in `sw.js`.

Each one also has a **WebP display derivative** beside it, built by
`scripts/make-brand-webp.mjs` and committed: `banner.webp` and `banner-bg.webp`
at 1600px, `wordmark.webp` at 1200px with its alpha intact. Those are what the
homepage renders; the PNGs above stay untouched as the source files and as the
fallback for a browser that cannot decode WebP.

| | PNG | WebP |
| --- | --- | --- |
| banner | 1278 KB | 52 KB |
| banner-bg | 1267 KB | 29 KB |
| wordmark | 649 KB | 67 KB |
| total | 3.12 MB | 148 KB |

`sw.js` precaches the **WebP** files into the asset cache, separately from the
shell and tolerantly: a file that is missing or renamed is skipped instead of
failing the service worker install. The PNGs are not precached, since almost
nobody fetches them; they are cached on first use by the normal
stale-while-revalidate path.
