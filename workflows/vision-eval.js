export const meta = {
  name: 'vision-eval',
  description: 'Scale harness that grades /vision output against the hand-authored oracle corpus in tests/vision-eval/. Runs each fixture vision.md through /vision K times, then scores the plan.lock.json with three pure-JS (no-LLM) layers — L1 contract validation, L2 expectation assertions vs the manifest, L3 K-run stability — and emits a per-fixture result table. Implements autonomous-build-4vj.2.',
  whenToUse: 'When you want a numbers-on-a-dashboard answer to "is /vision deterministic / in line with the oracle?". Cheap grading, but the inputs are heavy: a full run is fixtures*k /vision passes (10*5=50 by default). Use --k 1 / --only for a cheap smoke, --selftest to CI the harness logic with no agents.',
  phases: [
    { title: 'Enumerate',          detail: 'List fixture slugs under the corpus root (1 agent)' },
    { title: 'Run + grade',        detail: 'Per fixture: read manifest, run /vision K times headless, grade L1/L2/L3 in pure JS' },
    { title: 'Report',             detail: 'Assemble + log the per-fixture result table' },
    { title: 'Scorecard + ratchet', detail: 'Build scorecard, diff vs blessed baseline, write artifact, fail on regression' }
  ]
};

// ===========================================================================
// Args (same runtime-arg discovery convention as decompose.js / retro.js)
// ===========================================================================
const rawArgs =
  (typeof args !== 'undefined') ? args :
  (typeof userArgs !== 'undefined') ? userArgs :
  (typeof input !== 'undefined') ? input : '';

// Default ratchet tolerances (autonomous-build-4vj.4). Declared before parseArgs so
// its defaults can reference it. "below" metrics (pass-rates, stability) may not drop
// more than this below baseline; vaguenessRate may not rise more than `vague` above it.
// pass-rates are fractions (0..1); stability is percentage points.
const DEFAULT_TOLS = { pass: 0.15, stability: 10, vague: 0.1 };

function parseArgs(s) {
  const out = {
    fixturesDir: 'tests/vision-eval/fixtures', k: 5, only: null, selftest: false,
    baselinePath: 'agent/baselines/vision-eval.json', updateBaseline: false, noGate: false,
    tolPass: DEFAULT_TOLS.pass, tolStability: DEFAULT_TOLS.stability
  };
  const tokens = (typeof s === 'string') ? s.trim().split(/\s+/).filter(Boolean) : (Array.isArray(s) ? s : []);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--fixtures-dir' && tokens[i + 1]) { out.fixturesDir = tokens[++i]; }
    else if (tokens[i] === '--k' && tokens[i + 1]) { const n = parseInt(tokens[++i], 10); if (Number.isFinite(n) && n > 0) out.k = n; }
    else if (tokens[i] === '--only' && tokens[i + 1]) { out.only = tokens[++i].split(',').map(x => x.trim()).filter(Boolean); }
    else if (tokens[i] === '--baseline' && tokens[i + 1]) { out.baselinePath = tokens[++i]; }
    else if (tokens[i] === '--update-baseline') { out.updateBaseline = true; }
    else if (tokens[i] === '--no-gate') { out.noGate = true; }
    else if (tokens[i] === '--tol-pass' && tokens[i + 1]) { const n = parseFloat(tokens[++i]); if (Number.isFinite(n) && n >= 0) out.tolPass = n; }
    else if (tokens[i] === '--tol-stability' && tokens[i + 1]) { const n = parseFloat(tokens[++i]); if (Number.isFinite(n) && n >= 0) out.tolStability = n; }
    else if (tokens[i] === '--selftest') { out.selftest = true; }
  }
  return out;
}

const parsedArgs = parseArgs(rawArgs);

// ===========================================================================
// Constants
// ===========================================================================

// SYNC: docs/PLAN_CONCERNS.md vocabulary (mirrors the inlined const in vision.js).
// When the concern vocabulary changes, update both.
const CONCERN_IDS = [
  'data-model', 'authn', 'authz', 'secrets', 'data-lifecycle',
  'error-handling', 'observability', 'external-integrations', 'perf-envelope', 'abuse-surface'
];

// SYNC: skills/vision/SKILL.md gates + "Stopping conditions". The controlled context
// vocabulary the headless run agent tags each blocking openQuestion with, and the
// patterns L2 matches a fired block against. expect.json's blocking[].gate enum is the
// left column; the run agent is told to put the token in openQuestion.context.
const GATE_TOKENS = {
  'forward-coverage':                 /forward[-\s]?coverage/i,
  'reverse-trace':                    /reverse[-\s]?trace/i,
  'success-metric-oracle':            /success[-\s]?metric/i,
  'concern-decidedness':              /decidedness/i,
  'required-excluded-contradiction':  /required[-\s]?\+?[-\s]?excluded|required.{0,12}excluded|contradiction/i,
  'musthave-nongoal-contradiction':   /non[-\s]?goal|musthave[-\s]?nongoal|forbidden/i,
  'no-matching-formula':              /no[-\s]?matching[-\s]?formula|needs new formula|formula gap/i,
  'missing-product-sections':         /missing[-\s]?product[-\s]?section|empty.{0,12}section|unfilled/i
};

// ===========================================================================
// Pure helpers + checkers. No workflow globals, no side effects — reached by the
// node selftest via the globalThis bridge at the bottom of this file (the workflow
// runtime forbids `export` other than `meta`, so these are plain declarations).
// ===========================================================================

// Pull a JSON object out of a possibly-fenced / prose-wrapped agent reply.
function extractJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text; // already parsed (e.g. structured return)
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // fall back to the outermost {...}
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first !== -1 && last > first) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { return null; }
}

const isArr = Array.isArray;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const nonEmptyStr = (v) => typeof v === 'string' && v.length > 0;

// L1 — contract validation. Mirrors schemas/plan.lock.schema.json hard constraints.
// Returns { ok, errors[] }. `pl` is the parsed plan.lock object (or null if unparseable).
function validatePlanLock(pl, concernIds = CONCERN_IDS) {
  const errors = [];
  if (pl === null) return { ok: false, errors: ['unparseable: run agent did not return valid JSON'] };
  if (!isObj(pl)) return { ok: false, errors: ['not an object'] };

  if (pl.schemaVersion !== 2) errors.push(`schemaVersion must be 2 (got ${JSON.stringify(pl.schemaVersion)})`);

  const requiredKeys = [
    'schemaVersion', 'app', 'mustHaves', 'successMetric', 'stack', 'dataModel',
    'featureOrder', 'coverage', 'concerns', 'crossFeatureDependencies',
    'escalationBudget', 'openQuestions', 'incomplete'
  ];
  for (const k of requiredKeys) if (!(k in pl)) errors.push(`missing required key: ${k}`);

  if (!isObj(pl.app) || !nonEmptyStr(pl.app && pl.app.name)) errors.push('app.name missing/empty');
  if (!isArr(pl.mustHaves)) errors.push('mustHaves must be an array');
  if (!isObj(pl.successMetric) || !isArr(pl.successMetric.steps)) errors.push('successMetric.steps must be an array');
  if (!isObj(pl.stack)) errors.push('stack must be an object');
  if (!isArr(pl.dataModel)) errors.push('dataModel must be an array');
  if (!isArr(pl.featureOrder)) errors.push('featureOrder must be an array');
  if (!isArr(pl.coverage)) errors.push('coverage must be an array');
  if (!isArr(pl.concerns)) errors.push('concerns must be an array');
  if (!isArr(pl.crossFeatureDependencies)) errors.push('crossFeatureDependencies must be an array');
  if (!isObj(pl.escalationBudget)) errors.push('escalationBudget must be an object');
  if (!isArr(pl.openQuestions)) errors.push('openQuestions must be an array');
  if (typeof pl.incomplete !== 'boolean') errors.push('incomplete must be a boolean');

  // mustHaves[] entries
  if (isArr(pl.mustHaves)) pl.mustHaves.forEach((m, i) => {
    if (!isObj(m) || !nonEmptyStr(m.id) || !nonEmptyStr(m.text)) errors.push(`mustHaves[${i}] needs {id,text}`);
  });

  // coverage[] entries
  if (isArr(pl.coverage)) pl.coverage.forEach((c, i) => {
    if (!isObj(c)) { errors.push(`coverage[${i}] not an object`); return; }
    if (!nonEmptyStr(c.mustHaveId)) errors.push(`coverage[${i}].mustHaveId missing`);
    if (!isArr(c.features) || c.features.length < 1) errors.push(`coverage[${i}].features needs >=1 entry`);
    if (!nonEmptyStr(c.how)) errors.push(`coverage[${i}].how missing (anti-vagueness)`);
  });

  // concerns[] entries: status enum + addressed=>evidence / excluded=>reason
  if (isArr(pl.concerns)) pl.concerns.forEach((c, i) => {
    if (!isObj(c)) { errors.push(`concerns[${i}] not an object`); return; }
    if (!nonEmptyStr(c.concernId)) errors.push(`concerns[${i}].concernId missing`);
    if (c.status !== 'addressed' && c.status !== 'excluded') errors.push(`concerns[${i}].status must be addressed|excluded`);
    if (c.status === 'addressed' && !nonEmptyStr(c.evidence)) errors.push(`concerns[${i}] addressed but no evidence`);
    if (c.status === 'excluded' && !nonEmptyStr(c.reason)) errors.push(`concerns[${i}] excluded but no reason`);
  });

  // openQuestions[] entries
  if (isArr(pl.openQuestions)) pl.openQuestions.forEach((q, i) => {
    if (!isObj(q) || !nonEmptyStr(q.question)) errors.push(`openQuestions[${i}].question missing`);
    if (q && typeof q.blockingCompose !== 'boolean') errors.push(`openQuestions[${i}].blockingCompose must be boolean`);
  });

  // incomplete === (any blockingCompose) — the schema's own definition
  const hasBlocking = isArr(pl.openQuestions) && pl.openQuestions.some(q => q && q.blockingCompose === true);
  if (typeof pl.incomplete === 'boolean' && pl.incomplete !== hasBlocking) {
    errors.push(`incomplete (${pl.incomplete}) must equal "any openQuestion.blockingCompose" (${hasBlocking})`);
  }

  // Semantic checks that apply ONLY to non-blocking (complete) runs. A correct blocking
  // run is allowed an undecided concern / uncovered must-have — that is why it blocked.
  if (pl.incomplete === false) {
    if (isArr(pl.concerns)) {
      const decided = new Set(pl.concerns.map(c => c && c.concernId));
      for (const id of concernIds) if (!decided.has(id)) errors.push(`complete plan leaves concern "${id}" undecided`);
    }
    if (isArr(pl.mustHaves) && isArr(pl.coverage)) {
      const covered = new Set(pl.coverage.filter(c => isArr(c.features) && c.features.length >= 1).map(c => c.mustHaveId));
      for (const m of pl.mustHaves) if (m && !covered.has(m.id)) errors.push(`complete plan leaves must-have "${m.id}" uncovered`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// L2 — expectation assertions vs the fixture manifest. Returns a structured result.
function gradeAgainstManifest(pl, manifest, concernIds = CONCERN_IDS) {
  const fail = [];
  const result = { ok: false, verdict: null, concerns: [], mustHaves: [], blocking: null, failures: fail };
  if (!isObj(pl)) { fail.push('unparseable plan.lock'); return result; }

  // (a) verdict
  const verdictOk = (pl.incomplete === true) === (manifest.expectIncomplete === true);
  result.verdict = { expected: !!manifest.expectIncomplete, got: pl.incomplete === true, ok: verdictOk };
  if (!verdictOk) fail.push(`verdict: expected incomplete=${!!manifest.expectIncomplete}, got ${pl.incomplete === true}`);

  // (b) concerns — applicability tier -> required status
  const byId = {};
  if (isArr(pl.concerns)) for (const c of pl.concerns) if (c && c.concernId) byId[c.concernId] = c;
  const app = manifest.concernApplicability || {};
  for (const id of concernIds) {
    const tier = app[id];
    if (tier === 'underivable' || tier === undefined) continue; // fixture 10 / not asserted
    const entry = byId[id];
    let ok = false, detail = '';
    if (!entry) { detail = 'not decided'; }
    else if (tier === 'required') { ok = entry.status === 'addressed'; detail = ok ? '' : `required but status=${entry.status}`; }
    else if (tier === 'excluded') { ok = entry.status === 'excluded'; detail = ok ? '' : `excluded-tier but status=${entry.status}`; }
    else if (tier === 'optional') { ok = entry.status === 'addressed' || entry.status === 'excluded'; detail = ok ? '' : `optional but not decided`; }
    result.concerns.push({ id, tier, ok, detail });
    if (!ok) fail.push(`concern ${id}: ${detail}`);
  }

  // (c) must-haves
  const coveredWithFeature = new Set(
    (isArr(pl.coverage) ? pl.coverage : []).filter(c => isArr(c.features) && c.features.length >= 1).map(c => c.mustHaveId)
  );
  const plMustIds = new Set((isArr(pl.mustHaves) ? pl.mustHaves : []).map(m => m && m.id));
  for (const m of (manifest.mustHaves || [])) {
    let ok, detail = '';
    if (m.mustMapToFeature) {
      ok = coveredWithFeature.has(m.id);
      if (!ok) detail = `${m.id} should map to >=1 feature but does not`;
    } else {
      // adversarial must-have: must NOT be papered over with a feature, and the run must block
      const papered = coveredWithFeature.has(m.id);
      ok = !papered && pl.incomplete === true;
      if (papered) detail = `${m.id} papered over (mapped to a feature instead of blocking)`;
      else if (pl.incomplete !== true) detail = `${m.id} is uncoverable but the run did not block`;
    }
    result.mustHaves.push({ id: m.id, mustMapToFeature: !!m.mustMapToFeature, ok, detail });
    if (!ok) fail.push(`must-have ${detail}`);
  }
  // empty manifest mustHaves (fixture 10): a run must not fabricate must-haves
  if (isArr(manifest.mustHaves) && manifest.mustHaves.length === 0 && plMustIds.size > 0) {
    fail.push(`fabricated ${plMustIds.size} must-have(s) from empty product sections`);
    result.mustHaves.push({ id: '(any)', mustMapToFeature: false, ok: false, detail: 'fabricated must-haves' });
  }

  // (d) blocking — only when the manifest expects a block
  if (manifest.expectIncomplete) {
    const oqs = isArr(pl.openQuestions) ? pl.openQuestions.filter(q => q && q.blockingCompose === true) : [];
    const haystacks = oqs.map(q => `${q.question || ''} ${q.context || ''}`);
    const blockingPresent = pl.incomplete === true && oqs.length >= 1;
    const gateHits = (manifest.blocking || []).map(b => {
      const pat = GATE_TOKENS[b.gate];
      const hit = !!pat && haystacks.some(h => pat.test(h));
      const mhOk = !b.mustHaveId || haystacks.some(h => h.includes(b.mustHaveId));
      return { gate: b.gate, hit, mustHaveId: b.mustHaveId || null, mustHaveRefOk: mhOk };
    });
    result.blocking = { present: blockingPresent, gateHits };
    if (!blockingPresent) fail.push('expected a block but no blocking openQuestion present');
    for (const g of gateHits) {
      if (!g.hit) fail.push(`expected gate "${g.gate}" did not fire (no matching blocking openQuestion)`);
      if (!g.mustHaveRefOk) fail.push(`gate "${g.gate}" should reference ${g.mustHaveId}`);
    }
  }

  result.ok = fail.length === 0;
  return result;
}

// L3 — stability across K parsed runs. content variance is MEASURED, never gated.
function computeStability(planLocks, concernIds = CONCERN_IDS) {
  const runs = (planLocks || []).filter(isObj);
  const n = runs.length;
  const out = {
    runs: n,
    coverageStabilityPct: null,
    verdictStable: null,
    verdictSplit: null,
    entityCountRange: null,
    featureCountRange: null
  };
  if (n < 2) return out; // need >=2 runs to talk about stability

  // coverage-stability: fraction of the ten concerns whose decided status is identical across runs
  let stable = 0;
  for (const id of concernIds) {
    const statuses = runs.map(pl => {
      const c = (isArr(pl.concerns) ? pl.concerns : []).find(x => x && x.concernId === id);
      return c ? c.status : '(absent)';
    });
    if (statuses.every(s => s === statuses[0])) stable++;
  }
  out.coverageStabilityPct = Math.round((stable / concernIds.length) * 1000) / 10;

  // verdict-stability
  const verdicts = runs.map(pl => pl.incomplete === true);
  const trues = verdicts.filter(Boolean).length;
  out.verdictStable = trues === 0 || trues === n;
  out.verdictSplit = `${trues} block / ${n - trues} pass`;

  // content variance (measured)
  const entityCounts = runs.map(pl => (isArr(pl.dataModel) ? pl.dataModel.length : 0));
  const featureCounts = runs.map(pl => (isArr(pl.featureOrder) ? pl.featureOrder.length : 0));
  out.entityCountRange = [Math.min(...entityCounts), Math.max(...entityCounts)];
  out.featureCountRange = [Math.min(...featureCounts), Math.max(...featureCounts)];
  return out;
}

// Roll a fixture's K runs into one printable row.
function gradeFixture(slug, manifest, planLockTexts, concernIds = CONCERN_IDS) {
  const parsed = (planLockTexts || []).map(extractJson);
  const ok = parsed.filter(isObj);
  const l1 = parsed.map(pl => validatePlanLock(pl, concernIds));
  const l2 = parsed.map(pl => gradeAgainstManifest(pl, manifest, concernIds));
  const l3 = computeStability(ok, concernIds);
  const l1Pass = l1.filter(r => r.ok).length;
  const l2Pass = l2.filter(r => r.ok).length;
  const concernOffenders = [...new Set(l2.flatMap(r => r.concerns.filter(c => !c.ok).map(c => c.id)))];
  const gateMisses = [...new Set(l2.flatMap(r => (r.blocking ? r.blocking.gateHits.filter(g => !g.hit).map(g => g.gate) : [])))];
  return {
    slug, k: parsed.length, parsed: ok.length,
    l1Pass, l2Pass,
    l1Errors: [...new Set(l1.flatMap(r => r.errors))],
    l2Failures: [...new Set(l2.flatMap(r => r.failures))],
    concernOffenders, gateMisses,
    coverageStabilityPct: l3.coverageStabilityPct,
    verdictStable: l3.verdictStable,
    verdictSplit: l3.verdictSplit,
    entityCountRange: l3.entityCountRange,
    featureCountRange: l3.featureCountRange
  };
}

function renderTable(rows, scope) {
  const lines = [];
  lines.push(`vision-eval result table — scope: ${scope}`);
  lines.push('fixture                                    | parsed/K | L1    | L2    | covStab% | verdict        | entities | features');
  lines.push('-------------------------------------------+----------+-------+-------+----------+----------------+----------+---------');
  for (const r of rows) {
    const pad = (s, n) => String(s).padEnd(n).slice(0, n);
    const cov = r.coverageStabilityPct == null ? '  n/a' : `${r.coverageStabilityPct}`.padStart(5);
    const verdict = r.verdictStable == null ? 'n/a' : (r.verdictStable ? 'stable' : `SPLIT ${r.verdictSplit}`);
    const ent = r.entityCountRange ? `${r.entityCountRange[0]}-${r.entityCountRange[1]}` : 'n/a';
    const feat = r.featureCountRange ? `${r.featureCountRange[0]}-${r.featureCountRange[1]}` : 'n/a';
    lines.push(`${pad(r.slug, 42)} | ${pad(`${r.parsed}/${r.k}`, 8)} | ${pad(`${r.l1Pass}/${r.k}`, 5)} | ${pad(`${r.l2Pass}/${r.k}`, 5)} | ${pad(cov, 8)} | ${pad(verdict, 14)} | ${pad(ent, 8)} | ${feat}`);
    if (r.concernOffenders.length) lines.push(`    L2 concern offenders: ${r.concernOffenders.join(', ')}`);
    if (r.gateMisses.length) lines.push(`    L2 gate misses: ${r.gateMisses.join(', ')}`);
    if (r.l1Errors.length) lines.push(`    L1: ${r.l1Errors.slice(0, 4).join(' | ')}${r.l1Errors.length > 4 ? ' …' : ''}`);
  }
  return lines.join('\n');
}

// ===========================================================================
// Scorecard + baseline ratchet (autonomous-build-4vj.4). Mirrors the jankurai
// regression-only ratchet (hooks/post-build-gate.sh): a blessed baseline lives
// at agent/baselines/vision-eval.json, the gate fails ONLY on a drop beyond
// tolerance, a missing/unblessed baseline is a quiet SKIP, and the baseline is
// bumped only in a deliberate --update-baseline commit. Pure JS, no agents.
// (DEFAULT_TOLS is defined up in the constants block — parseArgs needs it.)
// ===========================================================================

// Roll the per-fixture rows into a scorecard (per-fixture + aggregate metrics).
function buildScorecard(rows, scope) {
  const clean = (rows || []).filter(isObj);
  const fixtures = {};
  let l1PassSum = 0, l2PassSum = 0, runSum = 0;
  const covs = [], verdicts = [];
  for (const r of clean) {
    const l1Rate = r.k ? r.l1Pass / r.k : null;
    const l2Rate = r.k ? r.l2Pass / r.k : null;
    fixtures[r.slug] = {
      l1PassRate: l1Rate, l2PassRate: l2Rate,
      coverageStabilityPct: r.coverageStabilityPct, verdictStable: r.verdictStable
    };
    l1PassSum += r.l1Pass; l2PassSum += r.l2Pass; runSum += r.k;
    if (typeof r.coverageStabilityPct === 'number') covs.push(r.coverageStabilityPct);
    if (typeof r.verdictStable === 'boolean') verdicts.push(r.verdictStable);
  }
  const mean = (a) => a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null;
  return {
    schemaVersion: 1,
    blessed: false,
    scope: scope || null,
    fixtureCount: clean.length,
    aggregate: {
      l1PassRate: runSum ? Math.round((l1PassSum / runSum) * 1000) / 1000 : null,
      l2PassRate: runSum ? Math.round((l2PassSum / runSum) * 1000) / 1000 : null,
      meanCoverageStabilityPct: mean(covs),
      verdictStabilityPct: verdicts.length ? Math.round((verdicts.filter(Boolean).length / verdicts.length) * 1000) / 10 : null,
      vaguenessRate: null // L4 (autonomous-build-4vj.3) populates this; gated here once present.
    },
    fixtures
  };
}

// Compare a fresh scorecard to a blessed baseline. Regression-only:
//   status 'skip'  — no/ unblessed baseline (can't evaluate; quiet, like jankurai)
//   status 'block' — some gated metric regressed beyond tolerance
//   status 'pass'  — within tolerance of (or better than) the baseline
// "below" metrics (pass-rates, stability) regress when current < baseline - tol;
// the lone "above" metric (vaguenessRate) regresses when current > baseline + tol.
function compareToBaseline(scorecard, baseline, tols = DEFAULT_TOLS) {
  const t = Object.assign({}, DEFAULT_TOLS, tols || {});
  if (!isObj(baseline) || baseline.blessed !== true) {
    return { status: 'skip', reason: !isObj(baseline) ? 'no baseline file' : 'baseline not blessed (blessed!=true)', regressions: [], deltas: {} };
  }
  const cur = (scorecard && scorecard.aggregate) || {};
  const base = (baseline && baseline.aggregate) || {};
  const regressions = [], deltas = {};
  const below = [
    ['l1PassRate', t.pass], ['l2PassRate', t.pass],
    ['meanCoverageStabilityPct', t.stability], ['verdictStabilityPct', t.stability]
  ];
  for (const [m, tol] of below) {
    const b = base[m], c = cur[m];
    if (typeof b !== 'number' || typeof c !== 'number') { deltas[m] = { baseline: b ?? null, current: c ?? null, skipped: true }; continue; }
    const delta = Math.round((c - b) * 1000) / 1000;
    deltas[m] = { baseline: b, current: c, delta, tol };
    if (c < b - tol) regressions.push({ metric: m, baseline: b, current: c, delta, tol });
  }
  // vaguenessRate: "above" metric, only meaningful once L4 populates it.
  {
    const b = base.vaguenessRate, c = cur.vaguenessRate, tol = t.vague;
    if (typeof b === 'number' && typeof c === 'number') {
      const delta = Math.round((c - b) * 1000) / 1000;
      deltas.vaguenessRate = { baseline: b, current: c, delta, tol };
      if (c > b + tol) regressions.push({ metric: 'vaguenessRate', baseline: b, current: c, delta, tol });
    } else {
      deltas.vaguenessRate = { baseline: b ?? null, current: c ?? null, skipped: true };
    }
  }
  return { status: regressions.length ? 'block' : 'pass', reason: regressions.length ? `${regressions.length} metric(s) regressed` : 'within tolerance', regressions, deltas };
}

// ===========================================================================
// --selftest: pure-JS unit checks (NO agents). Exercises L1/L2/L3 + the
// scorecard ratchet against embedded synthetic data, including the acceptance
// checks "a wrong manifest fails L2" and "an injected regression trips the
// gate". Importable + runnable via node tests/vision-eval/selftest.mjs.
// ===========================================================================
function runSelftest() {
  const results = [];
  const check = (name, cond) => { results.push({ name, pass: !!cond }); };

  // A well-formed, complete, non-blocking lock matching a clean manifest.
  const goodLock = {
    schemaVersion: 2,
    app: { name: 'Demo' },
    mustHaves: [{ id: 'M1', text: 'sign in' }, { id: 'M2', text: 'see board' }],
    successMetric: { steps: [{ id: 'S1', text: 'sign in then see board' }] },
    stack: { language: { choice: 'rust', why: 'pinned' } },
    dataModel: [{ entity: 'User', fields: ['id'] }, { entity: 'Board', fields: ['id'] }],
    featureOrder: [{ name: 'Auth', formulas: ['auth-email-password'] }, { name: 'Board', formulas: ['crud-feature'] }],
    coverage: [
      { mustHaveId: 'M1', features: ['Auth'], how: 'auth flow gates access' },
      { mustHaveId: 'M2', features: ['Board'], how: 'board CRUD renders columns' }
    ],
    concerns: CONCERN_IDS.map(id => (id === 'perf-envelope'
      ? { concernId: id, status: 'excluded', reason: 'no scale target stated' }
      : { concernId: id, status: 'addressed', evidence: 'auth-email-password formula + tenet 4' })),
    crossFeatureDependencies: [],
    escalationBudget: { maxSessionCostUsd: 10, maxFailuresPerTask: 2 },
    openQuestions: [],
    incomplete: false
  };

  const cleanManifest = {
    expectIncomplete: false,
    concernApplicability: Object.fromEntries(CONCERN_IDS.map(id => [id, id === 'perf-envelope' ? 'excluded' : 'required'])),
    mustHaves: [{ id: 'M1', mustMapToFeature: true }, { id: 'M2', mustMapToFeature: true }],
    blocking: []
  };

  // 1. good lock passes L1
  check('L1 accepts a well-formed complete lock', validatePlanLock(goodLock).ok);

  // 2. schema-invalid lock fails L1 (wrong schemaVersion + missing key)
  const badL1 = JSON.parse(JSON.stringify(goodLock)); badL1.schemaVersion = 1; delete badL1.concerns;
  check('L1 rejects a schema-invalid lock', !validatePlanLock(badL1).ok);

  // 3. incomplete/openQuestions mismatch fails L1
  const badIncomplete = JSON.parse(JSON.stringify(goodLock)); badIncomplete.incomplete = true;
  check('L1 catches incomplete!=blockingCompose mismatch', !validatePlanLock(badIncomplete).ok);

  // 4. good lock passes L2 against the matching manifest
  check('L2 accepts a lock matching its manifest', gradeAgainstManifest(goodLock, cleanManifest).ok);

  // 5. ACCEPTANCE: a deliberately wrong manifest fails L2 (flip a required concern to excluded-tier
  //    expectation + flip the verdict expectation; the unchanged good lock must now fail).
  const wrongManifest = JSON.parse(JSON.stringify(cleanManifest));
  wrongManifest.concernApplicability['authn'] = 'excluded'; // lock has authn addressed -> mismatch
  wrongManifest.expectIncomplete = true;                    // lock is complete -> verdict mismatch
  check('L2 fails against a deliberately wrong manifest', !gradeAgainstManifest(goodLock, wrongManifest).ok);

  // 6. adversarial: blocking lock that surfaces the right gate passes; one that papers over fails.
  const blockLock = JSON.parse(JSON.stringify(goodLock));
  blockLock.incomplete = true;
  blockLock.coverage = blockLock.coverage.filter(c => c.mustHaveId !== 'M2');
  blockLock.openQuestions = [{ question: 'M2 export is forbidden by a non-goal', blockingCompose: true, context: 'musthave-nongoal-contradiction' }];
  const blockManifest = {
    expectIncomplete: true,
    concernApplicability: cleanManifest.concernApplicability,
    mustHaves: [{ id: 'M1', mustMapToFeature: true }, { id: 'M2', mustMapToFeature: false }],
    blocking: [{ gate: 'musthave-nongoal-contradiction', mustHaveId: 'M2', detail: 'forbidden by non-goal' }]
  };
  check('L2 accepts a correct adversarial block (gate fires, M2 not papered)', gradeAgainstManifest(blockLock, blockManifest).ok);

  const paperLock = JSON.parse(JSON.stringify(goodLock)); // complete, M2 covered -> papered over
  check('L2 fails a run that papers over an adversarial must-have', !gradeAgainstManifest(paperLock, blockManifest).ok);

  // 7. fixture-10 style: fabricated must-haves from an empty manifest fail L2
  const emptyManifest = { expectIncomplete: true, concernApplicability: Object.fromEntries(CONCERN_IDS.map(id => [id, 'underivable'])), mustHaves: [], blocking: [{ gate: 'missing-product-sections', detail: 'empty' }] };
  check('L2 flags fabricated must-haves on an empty-sections fixture', !gradeAgainstManifest(goodLock, emptyManifest).ok);

  // 8. L3 stability: identical runs => 100% + stable verdict; a divergent run => <100%.
  const stable = computeStability([goodLock, JSON.parse(JSON.stringify(goodLock))]);
  check('L3 scores identical runs 100% coverage-stability', stable.coverageStabilityPct === 100 && stable.verdictStable === true);
  const drift = JSON.parse(JSON.stringify(goodLock));
  drift.concerns.find(c => c.concernId === 'observability').status = 'excluded';
  drift.concerns.find(c => c.concernId === 'observability').reason = 'flipped';
  const unstable = computeStability([goodLock, drift]);
  check('L3 scores a divergent run <100% coverage-stability', unstable.coverageStabilityPct < 100);

  // 9-13. Scorecard + baseline ratchet (autonomous-build-4vj.4).
  const rowsA = [
    { slug: '01', k: 5, l1Pass: 5, l2Pass: 5, coverageStabilityPct: 100, verdictStable: true },
    { slug: '08', k: 5, l1Pass: 5, l2Pass: 4, coverageStabilityPct: 90, verdictStable: true }
  ];
  const scA = buildScorecard(rowsA, 'k=5');
  check('scorecard aggregates pass-rates + stability',
    scA.aggregate.l1PassRate === 1 && scA.aggregate.l2PassRate === 0.9 &&
    scA.aggregate.meanCoverageStabilityPct === 95 && scA.aggregate.verdictStabilityPct === 100);

  const blessedBase = Object.assign({}, scA, { blessed: true });
  check('ratchet SKIPs when there is no baseline', compareToBaseline(scA, null).status === 'skip');
  check('ratchet SKIPs when the baseline is not blessed', compareToBaseline(scA, scA).status === 'skip');
  check('ratchet PASSes an unchanged corpus vs a blessed baseline', compareToBaseline(scA, blessedBase).status === 'pass');

  const scRegress = buildScorecard([
    { slug: '01', k: 5, l1Pass: 5, l2Pass: 2, coverageStabilityPct: 100, verdictStable: true },
    { slug: '08', k: 5, l1Pass: 5, l2Pass: 2, coverageStabilityPct: 90, verdictStable: true }
  ], 'k=5'); // l2PassRate 0.4 vs blessed 0.9, drop 0.5 > tol 0.15
  check('ratchet BLOCKs an injected L2 regression', compareToBaseline(scRegress, blessedBase).status === 'block');

  const scDip = buildScorecard([
    { slug: '01', k: 5, l1Pass: 5, l2Pass: 5, coverageStabilityPct: 100, verdictStable: true },
    { slug: '08', k: 5, l1Pass: 5, l2Pass: 3, coverageStabilityPct: 90, verdictStable: true }
  ], 'k=5'); // l2PassRate 0.8 vs 0.9, dip 0.1 < tol 0.15
  check('ratchet tolerates a sub-tolerance dip', compareToBaseline(scDip, blessedBase).status === 'pass');

  const passed = results.filter(r => r.pass).length;
  return { passed, total: results.length, ok: passed === results.length, results };
}

// ===========================================================================
// Run-agent prompt (headless /vision). Self-contained; runs from the cwd
// (autonomous-build repo in meta mode, so it can read the skill + docs + corpus).
// ===========================================================================
function runVisionPrompt(fixturesDir, slug, k) {
  return `
You are executing the /vision skill HEADLESSLY for run #${k} of an eval. There is NO human to talk to.

INPUTS (read them):
- The procedure: skills/vision/SKILL.md (follow it end to end).
- docs/DEFAULT_STACK.md (the pinned stack — resolve silently, never ask).
- docs/PLAN_CONCERNS.md (concern vocabulary + applicability derivation + "addressed means" bars).
- The formula library (bd formula list / bd formula show <name>) for formula picks + var bindings.
- The app vision under test: ${fixturesDir}/${slug}/vision.md  <-- treat THIS as the app's vision.md.

RULES (headless contract):
- No human turns. Where the skill says "quote back / confirm with the user", proceed with the documented defaults.
- Do the step-7 off-stack consult reasoning INLINE in your own head — do NOT spawn sub-agents.
- NEVER invent product content (must-haves, users, features) to fill a gap. If the vision is empty/contradictory/has no matching formula, that is a BLOCK, not something to paper over.
- Where any /vision gate or stopping condition fires (SKILL.md steps 6.6 / 6.7 / 8.6 and the "Stopping conditions" section), set incomplete:true and add the corresponding openQuestions[] entries with blockingCompose:true. Tag each blocking entry's "context" field so it STARTS WITH exactly one of these gate tokens (so the eval can map the block to its gate):
    forward-coverage | reverse-trace | success-metric-oracle | concern-decidedness | required-excluded-contradiction | musthave-nongoal-contradiction | no-matching-formula | missing-product-sections
- Decide ALL ten concerns from docs/PLAN_CONCERNS.md (excluded-by-default ones recorded as status:excluded with the standard reason), UNLESS the vision is too empty to derive applicability (then block via missing-product-sections).

OUTPUT (critical):
- Write NO files. Do not touch the repo.
- Output ONLY the plan.lock.json object as RAW JSON — no markdown fences, no prose before or after. It must conform to schemas/plan.lock.schema.json (schemaVersion:2). This is the artifact under test, so produce your genuine best plan; do not self-censor to look schema-clean.
`.trim();
}

// ===========================================================================
// Orchestration (agents). Guarded so the module is node-importable for selftest.
// ===========================================================================
async function main() {
  const A = parsedArgs;
  const scope = `dir=${A.fixturesDir} k=${A.k}${A.only ? ` only=${A.only.join(',')}` : ' (full corpus)'}`;
  log(`vision-eval starting — ${scope}`);

  // ---- Phase 1: enumerate ----
  phase('Enumerate');
  const enumSchema = {
    type: 'object', required: ['fixtures'],
    properties: { fixtures: { type: 'array', items: { type: 'string' } } }
  };
  const enumerated = await agent(`
List the vision-eval fixtures. Run: ls -1 ${A.fixturesDir}
Return the directory slugs (e.g. "01-multitenant-saas-web") for every entry that is a directory containing BOTH a vision.md and an expect.json. Sorted. Nothing else.
`.trim(), { label: 'enumerate', phase: 'Enumerate', schema: enumSchema });

  let fixtures = (enumerated && isArr(enumerated.fixtures)) ? enumerated.fixtures : [];
  if (A.only) fixtures = fixtures.filter(s => A.only.includes(s));
  if (!fixtures.length) { log('vision-eval: no fixtures matched — nothing to grade.'); return { rows: [], scope }; }
  log(`vision-eval: grading ${fixtures.length} fixture(s) × ${A.k} run(s).`);

  // ---- Phase 2: run + grade (pipeline, no barrier) ----
  phase('Run + grade');
  const manifestSchema = {
    type: 'object', required: ['manifest'],
    properties: { manifest: {
      type: 'object', required: ['expectIncomplete', 'concernApplicability', 'mustHaves', 'blocking'],
      properties: {
        fixture: { type: 'string' },
        expectIncomplete: { type: 'boolean' },
        concernApplicability: { type: 'object' },
        mustHaves: { type: 'array' },
        blocking: { type: 'array' }
      }
    } }
  };

  const rows = await pipeline(
    fixtures,
    // Stage A — read the trusted oracle manifest (schema-constrained on purpose).
    (slug) => agent(`
Read ${A.fixturesDir}/${slug}/expect.json and return it verbatim as {"manifest": <the parsed object>}. Do not alter any field.
`.trim(), { label: `manifest:${slug}`, phase: 'Run + grade', schema: manifestSchema })
      .then(r => ({ slug, manifest: r && r.manifest })),
    // Stage B — K headless /vision runs (NO schema), then pure-JS grading.
    (prev, slug) => {
      if (!prev || !prev.manifest) {
        return { slug, k: 0, parsed: 0, l1Pass: 0, l2Pass: 0, l1Errors: ['manifest unreadable'], l2Failures: [], concernOffenders: [], gateMisses: [], coverageStabilityPct: null, verdictStable: null, verdictSplit: null, entityCountRange: null, featureCountRange: null };
      }
      const runThunks = Array.from({ length: A.k }, (_, k) => () =>
        agent(runVisionPrompt(A.fixturesDir, slug, k + 1), { label: `vision:${slug}#${k + 1}`, phase: 'Run + grade' })
      );
      return parallel(runThunks).then(texts =>
        gradeFixture(slug, prev.manifest, texts.filter(t => t != null), CONCERN_IDS)
      );
    }
  );

  // ---- Phase 3: report ----
  phase('Report');
  const clean = rows.filter(Boolean);
  log('\n' + renderTable(clean, scope) + '\n');
  const l1Total = clean.reduce((a, r) => a + r.l1Pass, 0);
  const l2Total = clean.reduce((a, r) => a + r.l2Pass, 0);
  const runTotal = clean.reduce((a, r) => a + r.k, 0);
  log(`vision-eval summary: L1 ${l1Total}/${runTotal} runs valid · L2 ${l2Total}/${runTotal} runs match oracle · scope: ${scope}`);

  // ---- Phase 4: scorecard + baseline ratchet ----
  phase('Scorecard + ratchet');
  const baseRead = await agent(`
Read the file ${A.baselinePath} if it exists.
- If it exists and parses as JSON, return {"found": true, "baseline": <the parsed object>}.
- If it does NOT exist, return {"found": false}.
Do not create or modify the file.
`.trim(), { label: 'read-baseline', phase: 'Scorecard + ratchet', schema: { type: 'object', required: ['found'], properties: { found: { type: 'boolean' }, baseline: { type: 'object' } } } });

  const baseline = (baseRead && baseRead.found) ? baseRead.baseline : null;
  const scorecard = buildScorecard(clean, scope);
  const cmp = compareToBaseline(scorecard, baseline, { pass: A.tolPass, stability: A.tolStability });

  // Persist: --update-baseline blesses the fresh scorecard AS the baseline (commit it
  // deliberately); otherwise write a non-blessed inspection copy under target/ (untracked).
  const writePath = A.updateBaseline ? A.baselinePath : 'target/vision-eval/scorecard.latest.json';
  const toWrite = JSON.stringify(Object.assign({}, scorecard, { blessed: !!A.updateBaseline }), null, 2);
  await agent(`
Write the following content to ${writePath}, byte for byte (run \`mkdir -p\` on its parent dir first; overwrite if present). Write ONLY this JSON, no edits, no commentary:

${toWrite}

Then confirm the path you wrote.
`.trim(), { label: A.updateBaseline ? 'write-baseline' : 'write-scorecard', phase: 'Scorecard + ratchet' });

  log(`\nvision-eval ratchet: ${cmp.status.toUpperCase()} — ${cmp.reason}`);
  for (const m of Object.keys(cmp.deltas)) {
    const d = cmp.deltas[m];
    if (!d.skipped) log(`  ${m}: baseline=${d.baseline} current=${d.current} delta=${d.delta >= 0 ? '+' : ''}${d.delta} (tol ${d.tol})`);
  }
  for (const r of cmp.regressions) log(`  REGRESSION ${r.metric}: ${r.current} below ${r.baseline} - ${r.tol}`);
  log(A.updateBaseline
    ? `baseline blessed + written to ${A.baselinePath} — review the numbers and commit it in a DEDICATED commit.`
    : `scorecard written to ${writePath} (not blessed). ${cmp.status === 'skip' ? 'No blessed baseline yet → ratchet is report-only.' : ''}`);
  log('NOTE: L4 evidence-judge (vaguenessRate) is autonomous-build-4vj.3; L5 propagation is 4vj.5.');

  // The gate: a regression fails the run (the "exit non-zero" CI hook). Skip when
  // blessing a new baseline or when --no-gate is set.
  if (cmp.status === 'block' && !A.noGate && !A.updateBaseline) {
    throw new Error(`vision-eval REGRESSION vs baseline: ${cmp.regressions.map(r => `${r.metric} ${r.current}<${r.baseline}-${r.tol}`).join('; ')}`);
  }
  return { rows: clean, scope, scorecard, ratchet: cmp };
}

// Entry point — guarded so `node`/`import` (for the selftest harness checks) never
// triggers agent calls and never hits a top-level return.
if (typeof agent === 'function') {
  if (parsedArgs.selftest) {
    const r = runSelftest();
    log(`vision-eval --selftest: ${r.passed}/${r.total} checks passed${r.ok ? '' : ' — FAILURES:'}`);
    for (const c of r.results) if (!c.pass) log(`  FAIL: ${c.name}`);
  } else {
    await main();
  }
} else {
  // node-only bridge: the workflow runtime wraps the body in a function and rejects
  // any `export` other than `meta`, so the pure checkers can't be ESM-exported. Under
  // node (`agent` undefined) we expose them on globalThis for tests/vision-eval/selftest.mjs.
  globalThis.__visionEval = {
    extractJson, validatePlanLock, gradeAgainstManifest, computeStability,
    gradeFixture, renderTable, buildScorecard, compareToBaseline, runSelftest,
    CONCERN_IDS, GATE_TOKENS, DEFAULT_TOLS
  };
}
