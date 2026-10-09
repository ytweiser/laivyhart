/* ============================================================
   A minimal static file server standing in for Vercel: serves the real
   repo root (so the harness exercises the real index.html, theme.css,
   middleware-adjacent static JSON, etc.) and applies the same rewrites
   vercel.json declares, so /artist/:handle, /listen, /song/:slug and /settings
   all resolve to index.html exactly as they do in production.

   This does NOT run middleware.js (that is Vercel Edge Middleware, a
   separate runtime) -- middleware.js is verified separately, directly in
   Node, by importing its exported `decide()` function. See
   tests/middleware.spec.mjs.
   ============================================================ */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml', '.txt': 'text/plain',
};

// Mirrors vercel.json's `rewrites` array. Keep in sync if that file changes.
function rewrite(pathname) {
  if (/^\/artist\/[^/.]+\/?$/.test(pathname)) return '/index.html';
  if (/^\/song\/[^/.]+\/?$/.test(pathname)) return '/index.html';
  if (/^\/d\/[^/.]+\/?$/.test(pathname)) return '/index.html';
  if (['/listen', '/settings', '/upload', '/auth/callback'].includes(pathname)) return '/index.html';
  if (pathname === '/about') return '/about.html';
  if (pathname === '/terms') return '/terms.html';
  return pathname;
}

export function serve(port) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let pathname = rewrite(decodeURIComponent(url.pathname));
      if (pathname === '/') pathname = '/index.html';
      const filePath = join(REPO_ROOT, pathname);
      const st = await stat(filePath).catch(() => null);
      if (!st || !st.isFile()) { res.writeHead(404); res.end('not found: ' + pathname); return; }
      const body = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
