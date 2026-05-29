// Pure-JS unit checks for the /vision workflow logic (autonomous-build-ih5.2).
// Loads the checker functions from the workflow script and runs the embedded
// self-test suite — NO agents, deterministic, fast. This is what proves
// "a coherent vision validates / an empty one returns NEEDS-INPUT" and the
// applicability derivation table without spending live /vision agents.
//
//   node tests/vision/selftest.mjs
//
// The import is side-effect-safe: workflows/vision.js guards every agent() call
// behind `typeof agent === 'function'` (undefined under node) and, in that node
// branch, publishes the pure checkers on globalThis.__vision. (The workflow
// runtime forbids `export` other than `meta`, hence the bridge rather than a
// named import — same pattern as tests/vision-eval/selftest.mjs.)
import '../../workflows/vision.js';

const v = globalThis.__vision;
if (!v || typeof v.runSelftest !== 'function') {
  console.error('FAIL: workflows/vision.js did not expose globalThis.__vision — check the node bridge.');
  process.exit(1);
}

const r = v.runSelftest();
for (const c of r.results) console.log(`${c.pass ? 'ok  ' : 'FAIL'}  ${c.name}`);
console.log(`\n${r.passed}/${r.total} checks passed`);
process.exit(r.ok ? 0 : 1);
