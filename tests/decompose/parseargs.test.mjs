// Smoke test for workflows/decompose.js parseArgs (autonomous-build-3ch).
//
// Guards the regression where parseArgs token-scanned the WHOLE args string for
// --no-file/--auto-bless, so a headless/Workflow wrapper whose prose merely MENTIONED
// a flag (even inside a negation like "do NOT pass --no-file") silently flipped the
// mode bit — skipping the bd-init bootstrap and degrading a REAL pour into a no-DB
// dry-run. The fix honors flags only as a leading contiguous run, stopping at the
// first non-flag (prose) token.
//
// decompose.js is a workflow script (top-level `log`/`rawArgs` runtime globals), so it
// is not importable under plain node. We extract the pure `parseArgs` function from the
// source text and evaluate it in isolation — this tests the ACTUAL shipped function, so
// it cannot drift from a hand-maintained copy.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '..', 'workflows', 'decompose.js'), 'utf8');

// parseArgs is a top-level function; its closing brace is the first `}` at column 0
// after the declaration (every inner block brace is inline). Non-greedy up to `\n}`.
const m = src.match(/function parseArgs\(s\)\s*\{[\s\S]*?\n\}/);
if (!m) { console.error('FAIL: could not locate parseArgs in workflows/decompose.js'); process.exit(1); }
const parseArgs = new Function('return (' + m[0] + ')')();

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('ok    ' + name); }
  else { failed++; console.error('FAIL  ' + name); }
}

// The regression repro (smbuild, 2026-05-29): a wrapper prompt mentioning the flags
// inside a negation must run a REAL pour.
const repro = 'Run this as a REAL pour — do NOT pass --no-file and do NOT pass --auto-bless.';
check('3ch: prose mention (negated) does NOT set dryRun', parseArgs(repro).dryRun === false);
check('3ch: prose mention (negated) does NOT set autoBless', parseArgs(repro).autoBless === false);

// Leading, intentional flags are still honored.
check('--no-file (leading) sets dryRun', parseArgs('--no-file').dryRun === true);
check('--auto-bless (leading) sets autoBless', parseArgs('--auto-bless').autoBless === true);
check('--phase 2 (leading) sets phase=2', parseArgs('--phase 2').phase === 2);
check('multiple leading flags all apply', (() => {
  const o = parseArgs('--no-file --auto-bless --phase 3');
  return o.dryRun === true && o.autoBless === true && o.phase === 3;
})());

// A flag appearing AFTER a non-flag (prose) token is inert — the protection.
check('flag after a prose token is ignored', parseArgs('please run a real pour --no-file').dryRun === false);

// Bare invocation and defaults.
check('empty args → real pour defaults', (() => {
  const o = parseArgs('');
  return o.dryRun === false && o.autoBless === false && o.phase === 1;
})());

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
