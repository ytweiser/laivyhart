/* ============================================================
   1B-4 -- replays every sql/*.sql migration, in order, to compute the
   CURRENT grant state of every function in public: who (anon,
   authenticated) can execute it, whether it is SECURITY DEFINER, and
   whether it sets search_path. Pure static analysis of the committed SQL
   text -- no live database connection, no credentials, nothing to leak
   or misuse. That is deliberate: a service-role key belongs only in the
   Worker (an established rule in this project, confirmed across many
   prior migrations' own comments), so this check earns its "standing
   audit" status by never needing one -- it reads the same SQL files any
   migration review already reads, and computes what apply_migration
   would actually leave behind.

   Tracked per function, by NAME only (not full argument signature --
   this project has exactly one overloaded function, pulse_member, and
   both overloads always get the identical class/grant treatment, so
   name-level tracking loses no real fidelity here while staying simple).

   Ordering matters: GRANT/REVOKE are not idempotent-cumulative, a later
   statement for the same function overrides an earlier one, so files are
   processed in their numeric sql/NNN_*.sql order and statements within
   a file in the order they appear on the page.
   ============================================================ */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SQL_DIR = join(ROOT, 'sql');

function sqlFilesInOrder() {
  return readdirSync(SQL_DIR)
    .filter((f) => /^\d+[a-z]?_.*\.sql$/.test(f))
    .sort((a, b) => {
      const na = parseFloat(a.match(/^(\d+)([a-z]?)_/)[1] + '.' + (a.match(/^(\d+)([a-z]?)_/)[2].charCodeAt(0) || 0));
      const nb = parseFloat(b.match(/^(\d+)([a-z]?)_/)[1] + '.' + (b.match(/^(\d+)([a-z]?)_/)[2].charCodeAt(0) || 0));
      return na - nb;
    });
}

/* Builds the final { name -> state } map. state: { exists, anon,
   authenticated, securityDefiner, hasSearchPath }. */
export function computeGrantModel() {
  const fns = new Map();
  let defaultGrantsAnonAuthenticated = true; // this project's confirmed starting default

  const ensure = (name) => {
    if (!fns.has(name)) {
      fns.set(name, {
        exists: false, anon: defaultGrantsAnonAuthenticated, authenticated: defaultGrantsAnonAuthenticated,
        securityDefiner: false, hasSearchPath: false,
      });
    }
    return fns.get(name);
  };

  for (const file of sqlFilesInOrder()) {
    const text = readFileSync(join(SQL_DIR, file), 'utf8');

    // Every statement type is matched separately, but a single file can
    // (027_listen_grouping.sql does) DROP and then CREATE the same
    // function on the same page -- applying "every create" then "every
    // drop" as two separate passes would let the drop's reset clobber a
    // create that actually came AFTER it in the file. So: collect every
    // match from every pattern with its position, sort by position, and
    // apply them in that true document order, same as Postgres would.
    const events = [];

    // ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM
    // PUBLIC, ANON, AUTHENTICATED -- flips the default for every function
    // CREATED from this point forward (does not retroactively change one
    // already created).
    const defaultRe = /alter\s+default\s+privileges[\s\S]*?revoke\s+execute\s+on\s+functions\s+from[^;]*\banon\b[^;]*\bauthenticated\b/gi;
    let m;
    while ((m = defaultRe.exec(text))) events.push({ pos: m.index, type: 'default' });

    // CREATE [OR REPLACE] FUNCTION public.name(...) ... ) <returns ...>
    // language ... [security definer] [set search_path ...] as $tag$ --
    // non-greedy up to the function's own "as $tag$"/"as '...'" body
    // opener, so each match stays scoped to one function's own signature
    // clause, never spilling into its body or the next function.
    const createRe = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\([\s\S]*?\bas\s+(?:\$[a-zA-Z_]*\$|'[\s\S]*?')/gi;
    while ((m = createRe.exec(text))) {
      events.push({
        pos: m.index, type: 'create', name: m[1],
        securityDefiner: /security\s+definer/i.test(m[0]),
        hasSearchPath: /search_path/i.test(m[0]),
      });
    }

    // DROP FUNCTION [IF EXISTS] public.name(...) -- resets its grants
    // entirely back to whatever the CURRENT default privileges give a
    // brand-new function (the real Postgres behavior this project's own
    // pulse_feed drop+recreate in 027_listen_grouping.sql relies on).
    const dropRe = /drop\s+function\s+(?:if\s+exists\s+)?public\.(\w+)\s*\(/gi;
    while ((m = dropRe.exec(text))) events.push({ pos: m.index, type: 'drop', name: m[1] });

    // REVOKE { ALL | EXECUTE } ON FUNCTION public.name(...) FROM <roles>
    const revokeRe = /revoke\s+(?:all|execute)\s+on\s+function\s+public\.(\w+)\s*\([^)]*\)\s*from\s+([^;]+);/gi;
    while ((m = revokeRe.exec(text))) events.push({ pos: m.index, type: 'revoke', name: m[1], roles: m[2].toLowerCase() });

    // GRANT EXECUTE ON FUNCTION public.name(...) TO <roles>
    const grantRe = /grant\s+execute\s+on\s+function\s+public\.(\w+)\s*\([^)]*\)\s*to\s+([^;]+);/gi;
    while ((m = grantRe.exec(text))) events.push({ pos: m.index, type: 'grant', name: m[1], roles: m[2].toLowerCase() });

    events.sort((a, b) => a.pos - b.pos);

    for (const e of events) {
      if (e.type === 'default') {
        defaultGrantsAnonAuthenticated = false;
      } else if (e.type === 'create') {
        const f = ensure(e.name);
        f.exists = true;
        f.securityDefiner = e.securityDefiner;
        f.hasSearchPath = e.hasSearchPath;
      } else if (e.type === 'drop') {
        fns.set(e.name, {
          exists: false, anon: defaultGrantsAnonAuthenticated, authenticated: defaultGrantsAnonAuthenticated,
          securityDefiner: false, hasSearchPath: false,
        });
      } else if (e.type === 'revoke') {
        const f = ensure(e.name);
        if (/\bpublic\b/.test(e.roles) || /\banon\b/.test(e.roles)) f.anon = false;
        if (/\bauthenticated\b/.test(e.roles)) f.authenticated = false;
      } else if (e.type === 'grant') {
        const f = ensure(e.name);
        if (/\banon\b/.test(e.roles)) f.anon = true;
        if (/\bauthenticated\b/.test(e.roles)) f.authenticated = true;
      }
    }
  }

  return fns;
}
