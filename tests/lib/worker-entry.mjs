#!/usr/bin/env node
/* ============================================================
   TEST-1: one entry point per forked worker process.

   Receives its port and its slice of the spec list as a JSON blob on
   argv[2] (set by run-all.mjs), launches its own static server and its own
   browser ONCE, runs its specs against them in sequence (reusing both
   across every spec, same as the old single-process run did for the whole
   suite), and reports back over the fork's own IPC channel -- never over
   stdout, which each spec's own console.log output already uses for its
   live PASS/FAIL lines.

   A separate OS process per worker, not threads or shared promises in one
   process, is what actually gives "specs must not share state": every
   worker gets its own fresh copy of every module (its own jwksCache in
   worker/src/index.js, its own pickAutoId in stub-supabase.mjs, etc.) with
   no chance of two specs racing on the same mutable module state.
   ============================================================ */
import { launchBrowser } from './browser.mjs';
import { serve } from './server.mjs';

async function main() {
  const { port, specs } = JSON.parse(process.argv[2]);
  const needsServerOrBrowser = specs.some((s) => s.kind !== 'none');

  const results = [];
  let server = null;
  let browser = null;
  try {
    if (needsServerOrBrowser) {
      server = await serve(port);
      browser = await launchBrowser();
    }
    for (const s of specs) {
      const mod = await import(s.path);
      const t0 = Date.now();
      const res = s.kind === 'browser' ? await mod.run(browser, port)
                : s.kind === 'port' ? await mod.run(port)
                : await mod.run();
      results.push({ name: s.name, passed: res.passed, failed: res.failed, failures: res.failures, ms: Date.now() - t0 });
    }
  } finally {
    if (browser) await browser.close();
    if (server) server.close();
  }
  process.send({ ok: true, results });
}

main().catch((e) => {
  process.send({ ok: false, error: String((e && e.stack) || e) });
  process.exitCode = 1;
});
