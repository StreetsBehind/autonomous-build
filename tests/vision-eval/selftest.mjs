// Pure-JS unit checks for the vision-eval harness logic (autonomous-build-4vj.2).
// Loads the checker functions from the workflow script and runs the embedded
// self-test suite — NO agents, deterministic, fast. This is what proves the
// acceptance criterion "a deliberately wrong manifest fails L2" without spending
// the ~50 live /vision agents a full corpus run costs.
//
//   node tests/vision-eval/selftest.mjs
//
// The import is side-effect-safe: workflows/vision-eval.js guards every agent()
// call behind `typeof agent === 'function'` (undefined under node) and, in that
// node branch, publishes the pure checkers on globalThis.__visionEval. (The
// workflow runtime forbids `export` other than `meta`, hence the bridge rather
// than a named import.)
import '../../workflows/vision-eval.js';

const ve = globalThis.__visionEval;
if (!ve || typeof ve.runSelftest !== 'function') {
  console.error('FAIL: workflows/vision-eval.js did not expose globalThis.__visionEval — check the node bridge.');
  process.exit(1);
}

const r = ve.runSelftest();
for (const c of r.results) console.log(`${c.pass ? 'ok  ' : 'FAIL'}  ${c.name}`);
console.log(`\n${r.passed}/${r.total} checks passed`);
process.exit(r.ok ? 0 : 1);
