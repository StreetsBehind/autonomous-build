// Smoke test for workflows/decompose.js reconcileMustHaveGaps (autonomous-build-ea1).
//
// Guards the false `musthave-gap` NEEDS-FIX: verifier C is independent + conservative and
// string-matches must-have→bead, so when a covering feature poured an epic whose children
// are named by implementation detail (not the must-have's wording), C flags a gap on work
// that demonstrably exists. The reconcile step now cross-checks C's gaps against the
// AUTHORITATIVE featureToPourRoot map (and verifier A's proven coverage) and downgrades a
// must-have whose covering feature poured a real root to "covered".
//
// decompose.js is a workflow script (top-level runtime globals), not importable under node;
// we extract the pure reconcileMustHaveGaps function from source and run it in isolation.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '..', 'workflows', 'decompose.js'), 'utf8');

const m = src.match(/function reconcileMustHaveGaps\([\s\S]*?\n\}/);
if (!m) { console.error('FAIL: could not locate reconcileMustHaveGaps in workflows/decompose.js'); process.exit(1); }
const reconcileMustHaveGaps = new Function('return (' + m[0] + ')')();

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('ok    ' + name); }
  else { failed++; console.error('FAIL  ' + name); }
}

// Fixtures mirror the smbuild M9 evidence: the covering feature's full featureOrder name
// poured epic smbuild-mol-0zm, but verifier C recorded the must-have with a truncated
// feature name and no beads (children are implementation-named).
const featureToPourRoot = {
  'Tamper-evident audit chain (smbuild-audit blessed writer + Object-Lock anchor)': 'smbuild-mol-0zm',
  'Invoicing': 'smbuild-mol-inv',
};
const verifierA = {
  coverage: 'complete',
  features: [
    { name: 'Tamper-evident audit chain (smbuild-audit blessed writer + Object-Lock anchor)', beads: ['smbuild-mol-0zm', 'smbuild-mol-dp3'], status: 'covered' },
    { name: 'Invoicing', beads: ['smbuild-mol-inv'], status: 'covered' },
  ],
};

// Case 1 — the regression: M9 flagged 'gap' by C, but its covering feature poured a root.
const vC1 = { traceable: 'gap', matrix: [
  { mustHave: 'M9', status: 'gap', features: ['Tamper-evident audit chain'], beads: [] },
  { mustHave: 'M1', status: 'covered', features: ['Invoicing'], beads: ['smbuild-mol-inv'] },
] };
const r1 = reconcileMustHaveGaps(verifierA, vC1, featureToPourRoot);
const m9 = r1.matrix.find((x) => x.mustHave === 'M9');
check('M9 false gap reconciled to covered', m9.status === 'covered');
check('M9 credited the poured root (smbuild-mol-0zm)', Array.isArray(m9.beads) && m9.beads.includes('smbuild-mol-0zm'));
check("C's traceable recomputed gap→complete", r1.traceable === 'complete');
check('exactly one reconcile credit recorded for M9', r1.credits.length === 1 && r1.credits[0].mustHave === 'M9');
check('an already-covered row is untouched', r1.matrix.find((x) => x.mustHave === 'M1').status === 'covered');

// Case 2 — a genuine gap (covering feature never poured) must STILL block.
const vC2 = { traceable: 'gap', matrix: [
  { mustHave: 'M7', status: 'gap', features: ['Feature that never poured'], beads: [] },
] };
const r2 = reconcileMustHaveGaps(verifierA, vC2, featureToPourRoot);
check('genuine gap stays a gap', r2.matrix[0].status === 'gap');
check("C's traceable stays gap on a real gap", r2.traceable === 'gap');
check('no false credit for a real gap', r2.credits.length === 0);

// Case 3 — md-only plan: n/a passes through untouched.
const r3 = reconcileMustHaveGaps(verifierA, { traceable: 'n/a', matrix: [] }, featureToPourRoot);
check('n/a traceable passes through', r3.traceable === 'n/a');

// Case 4 — credit via verifier A coverage even when the pour map lacks the key.
const r4 = reconcileMustHaveGaps(verifierA, { traceable: 'gap', matrix: [
  { mustHave: 'Mx', status: 'gap', features: ['Invoicing'], beads: [] },
] }, {});
check('credit falls back to verifier A coverage when pour map empty', r4.matrix[0].status === 'covered' && r4.traceable === 'complete');

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
