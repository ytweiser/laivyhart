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

`sw.js` precaches these into the asset cache, separately from the shell and
tolerantly: a file that is missing or renamed is skipped instead of failing the
service worker install.
