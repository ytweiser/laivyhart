# CLAUDE.md

Project-level instructions for Claude Code working in this repo.

## Testing rules

While working on a prompt, run only the spec files for the areas you changed
(`node run-all.mjs --only <names>`). Run the full suite exactly once, at the
end, right before committing. If that final run fails, fix and re-run only
the failing specs, then the full suite once more. Never run the full suite
more than twice per prompt.
