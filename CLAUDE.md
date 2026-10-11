# CLAUDE.md

Project-level instructions for Claude Code working in this repo.

## Testing rules

While working on a prompt, run only the spec files for the areas you changed
(`node run-all.mjs --only <names>`). Run the full suite exactly once, at the
end, right before committing. If that final run fails, fix and re-run only
the failing specs, then the full suite once more. Never run the full suite
more than twice per prompt.

## Database function permissions

Every new or recreated database function must end with explicit
`REVOKE ... FROM PUBLIC, anon` and `GRANT ... TO` only the roles it needs.
Dropping and recreating a function resets its grants; re-apply them.
Add anon-callable functions to `tests/sql/anon-allowlist.txt` with a
one-line reason, in the same commit that grants it -- `grants-audit.spec.mjs`
fails the suite otherwise.
