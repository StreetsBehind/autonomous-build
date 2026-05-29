// CI ratchet for vision-eval (autonomous-build-4vj.4). Reads a fresh scorecard
// (produced by a workflow run — typically target/vision-eval/scorecard.latest.json)
// and the blessed baseline, then exits with a jankurai-style code so a CI step can
// gate on it WITHOUT spawning agents itself:
//
//   0 = PASS   (within tolerance of / better than baseline)
//   1 = BLOCK  (a gated metric regressed beyond tolerance)
//   2 = SKIP   (no/unblessed baseline, or unreadable inputs — can't evaluate)
//
//   node tests/vision-eval/ratchet.mjs <scorecard.json> [--baseline <path>]
//
// Reuses the same compareToBaseline the workflow uses (via the globalThis bridge),
// so the in-workflow gate and this standalone gate can never disagree.
import { readFileSync } from 'node:fs';
import '../../workflows/vision-eval.js';

const ve = globalThis.__visionEval;
if (!ve || typeof ve.compareToBaseline !== 'function') {
  console.error('FAIL: workflows/vision-eval.js did not expose globalThis.__visionEval.');
  process.exit(2);
}

const argv = process.argv.slice(2);
let scorecardPath = null, baselinePath = 'agent/baselines/vision-eval.json';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--baseline' && argv[i + 1]) baselinePath = argv[++i];
  else if (!scorecardPath) scorecardPath = argv[i];
}
if (!scorecardPath) {
  console.error('usage: node tests/vision-eval/ratchet.mjs <scorecard.json> [--baseline <path>]');
  process.exit(2);
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const scorecard = readJson(scorecardPath);
if (!scorecard) { console.error(`scorecard unreadable: ${scorecardPath}`); process.exit(2); }
const baseline = readJson(baselinePath);

const cmp = ve.compareToBaseline(scorecard, baseline);
console.log(`vision-eval ratchet: ${cmp.status.toUpperCase()} — ${cmp.reason}`);
for (const m of Object.keys(cmp.deltas)) {
  const d = cmp.deltas[m];
  if (!d.skipped) console.log(`  ${m}: baseline=${d.baseline} current=${d.current} delta=${d.delta} (tol ${d.tol})`);
}
for (const r of cmp.regressions) console.log(`  REGRESSION ${r.metric}: ${r.current} below ${r.baseline} - ${r.tol}`);

process.exit(cmp.status === 'block' ? 1 : cmp.status === 'skip' ? 2 : 0);
