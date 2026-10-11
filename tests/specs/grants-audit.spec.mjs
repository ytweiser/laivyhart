/* ============================================================
   1B-4 -- the standing audit against drift. Replays every sql/*.sql
   migration (tests/lib/grants-model.mjs) to compute the CURRENT grant
   state of every function in public, purely from the committed SQL text
   -- no live database connection and no credentials, which is deliberate:
   this project's own rule is that a service-role key lives only in the
   Worker, so a check that needs one does not belong in this harness.

   Fails the suite if:
   - any function is anon-callable but not on tests/sql/anon-allowlist.txt
     (a new migration granted anon something nobody classified).
   - any function on the allowlist is NOT anon-callable (the allowlist
     drifted stale the other way -- promised access that was quietly
     revoked).
   - any SECURITY DEFINER function does not set search_path.

   What this does NOT catch: the two live functions (delete_category,
   rename_category) that have no `create function` anywhere in sql/ at
   all -- they exist in the project but not in its migration history, so
   there is nothing for a text-based model to find. Locked down live by
   028_hardening.sql regardless; flagged in that migration's own report,
   not something a static check over committed files can ever see.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../lib/report.mjs';
import { computeGrantModel } from '../lib/grants-model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadAllowlist() {
  const text = readFileSync(join(ROOT, 'tests', 'sql', 'anon-allowlist.txt'), 'utf8');
  return new Set(
    text.split('\n')
      .map((line) => line.replace(/#.*/, '').trim())
      .filter(Boolean),
  );
}

export async function run() {
  const r = makeReporter('grants-audit.spec.mjs');
  const model = computeGrantModel();
  const allowlist = loadAllowlist();

  r.section('no function in public is anon-callable without being on tests/sql/anon-allowlist.txt');
  const existing = [...model.entries()].filter(([, v]) => v.exists);
  const anonCallable = existing.filter(([, v]) => v.anon).map(([name]) => name).sort();
  const undocumented = anonCallable.filter((name) => !allowlist.has(name));
  r.check('every anon-callable function is on the allowlist', undocumented.length === 0, undocumented);

  r.section('every allowlisted function is actually anon-callable (the allowlist itself has not gone stale)');
  const anonCallableSet = new Set(anonCallable);
  const staleAllowlistEntries = [...allowlist].filter((name) => !anonCallableSet.has(name));
  r.check('no allowlist entry has silently lost anon access', staleAllowlistEntries.length === 0, staleAllowlistEntries);

  r.section('every SECURITY DEFINER function sets search_path');
  const missingSearchPath = existing.filter(([, v]) => v.securityDefiner && !v.hasSearchPath).map(([name]) => name);
  r.check('no SECURITY DEFINER function is missing search_path', missingSearchPath.length === 0, missingSearchPath);

  r.section('sanity: the model actually found a realistic number of functions (the parser is not silently matching nothing)');
  r.check('at least 50 functions tracked', existing.length >= 50, existing.length);

  return r;
}
