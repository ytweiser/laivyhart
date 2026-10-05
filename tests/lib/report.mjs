// A tiny shared pass/fail counter + printer, so every spec reports the same
// way and run-all.mjs can sum totals across files without parsing stdout.
export function makeReporter(title) {
  let passed = 0, failed = 0;
  const failures = [];
  if (title) console.log(`\n=== ${title} ===`);
  function check(label, cond, detail) {
    if (cond) { passed++; console.log('  PASS  ' + label); }
    else {
      failed++;
      failures.push(label + (detail ? ('  -- ' + String(detail)) : ''));
      console.log('  FAIL  ' + label + (detail ? ('  -- ' + String(detail)) : ''));
    }
  }
  function section(name) { console.log(`\n--- ${name} ---`); }
  return { check, section, failures, get passed() { return passed; }, get failed() { return failed; } };
}
