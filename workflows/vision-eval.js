export const meta = {
  name: 'vision-eval',
  description: 'Scale harness that grades /vision output against the hand-authored oracle corpus in tests/vision-eval/. Runs each fixture vision.md through /vision K times, then scores the plan.lock.json with mechanical pure-JS layers — L1 contract validation, L2 expectation assertions vs the manifest, L3 K-run stability — plus opt-in LLM layers: L4 evidence-quality judge (--judge → vaguenessRate) and L5 downstream propagation (--propagate → /decompose --dry-run + bfo.9 leakage). Emits a per-fixture table + a ratcheted scorecard. Implements autonomous-build-4vj.2 (L1-L3), 4vj.4 (scorecard ratchet), 4vj.3 (L4 judge), 4vj.5 (L5 propagation).',
  whenToUse: 'When you want a numbers-on-a-dashboard answer to "is /vision deterministic / in line with the oracle?". Cheap grading, but the inputs are heavy: a full run is fixtures*k /vision passes (10*5=50 by default), and --judge adds an adversarial panel per addressed concern. Use --k 1 / --only for a cheap smoke, --judge (periodic) for the vagueness rate, --selftest to CI the harness logic with no agents.',
  phases: [
    { title: 'Enumerate',          detail: 'List fixture slugs under the corpus root (1 agent)' },
    { title: 'Run + grade',        detail: 'Per fixture: read manifest, run /vision K times headless, grade L1/L2/L3 in pure JS' },
    { title: 'Report',             detail: 'Assemble + log the per-fixture result table' },
    { title: 'Evidence judge',     detail: 'L4 (opt-in --judge): adversarial panel per addressed-concern evidence → vagueness rate' },
    { title: 'Propagation (L5)',   detail: 'L5 (opt-in --propagate): sampled BLESSED locks through /decompose --dry-run → bfo.9 leakage report' },
    { title: 'Scorecard + ratchet', detail: 'Build scorecard (incl. vaguenessRate), diff vs blessed baseline, write artifact, fail on regression' }
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
    tolPass: DEFAULT_TOLS.pass, tolStability: DEFAULT_TOLS.stability,
    judge: false, judgePanel: 3, judgeSample: 0,
    propagate: false, propagateSample: 1
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
    // L4 evidence-quality judge (autonomous-build-4vj.3). Opt-in + periodic per the cost
    // model: the panel is fixtures*addressedConcerns*panelSize heavy agents on top of the
    // run cost, so default OFF; vaguenessRate stays null (ungated) unless --judge is set.
    else if (tokens[i] === '--judge') { out.judge = true; }
    else if (tokens[i] === '--judge-panel' && tokens[i + 1]) { const n = parseInt(tokens[++i], 10); if (Number.isFinite(n) && n >= 1) out.judgePanel = n; }
    else if (tokens[i] === '--judge-sample' && tokens[i + 1]) { const n = parseInt(tokens[++i], 10); if (Number.isFinite(n) && n >= 0) out.judgeSample = n; }
    // L5 downstream propagation (autonomous-build-4vj.5). The most expensive, least frequent
    // layer: it runs sampled BLESSED locks through /decompose --dry-run and checks the bfo.9
    // forward-coverage invariant. Opt-in + small-sample; report-only (does not gate CI).
    else if (tokens[i] === '--propagate') { out.propagate = true; }
    else if (tokens[i] === '--propagate-sample' && tokens[i + 1]) { const n = parseInt(tokens[++i], 10); if (Number.isFinite(n) && n >= 1) out.propagateSample = n; }
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

// ===========================================================================
// L4 — evidence-quality judge (autonomous-build-4vj.3). The ONE thing L1–L3
// cannot mechanically check: is an `addressed` concern's evidence FALSIFIABLE
// (cites a feature/formula/tenet/gate/stack-pin) or rubber-stamped vagueness?
// Collection + majority + tally are PURE JS (selftestable); only the per-item
// verdict is an LLM judge (injected, so the pipeline is unit-testable with a
// synthetic judge). Output feeds the scorecard's reserved `vaguenessRate`.
// ===========================================================================

// Collect every addressed-concern evidence string across K parsed runs.
// Returns [{ runIdx, concernId, evidence }] — one entry per addressed concern per run.
function collectAddressedEvidence(planLocks) {
  const items = [];
  (planLocks || []).filter(isObj).forEach((pl, runIdx) => {
    (isArr(pl.concerns) ? pl.concerns : []).forEach(c => {
      if (c && c.status === 'addressed' && nonEmptyStr(c.evidence)) {
        items.push({ runIdx, concernId: c.concernId || '(unknown)', evidence: c.evidence });
      }
    });
  });
  return items;
}

// Dedupe identical evidence so the panel never judges the same string K times
// (cost). Key = slug::concernId::evidence; carries a `count` of how many runs
// produced it. Items without a slug dedupe on concernId::evidence alone.
function dedupeEvidence(items) {
  const by = new Map();
  for (const it of (items || []).filter(isObj)) {
    const key = `${it.slug || ''}::${it.concernId || ''}::${it.evidence || ''}`;
    if (by.has(key)) { by.get(key).count++; }
    else { by.set(key, Object.assign({ count: 1 }, it)); }
  }
  return [...by.values()];
}

// Majority vote across a judge panel. Each verdict: { falsifiable: bool }.
// Evidence is VAGUE (fails the bar) unless a STRICT majority of judges call it
// falsifiable — an even split breaks toward vague (an unclear pass is not a pass).
function judgePanelMajority(verdicts) {
  const v = (verdicts || []).filter(isObj);
  if (!v.length) return { falsifiable: false, vague: true, votes: { falsifiable: 0, vague: 0, n: 0 } };
  const fals = v.filter(x => x.falsifiable === true).length;
  const vague = v.length - fals;
  const isFalsifiable = fals > vague; // strict majority; tie -> vague
  return { falsifiable: isFalsifiable, vague: !isFalsifiable, votes: { falsifiable: fals, vague, n: v.length } };
}

// Tally a vagueness rate from per-item panel results.
// judged item: { concernId, evidence, panel: { falsifiable, vague } }.
// vaguenessRate = fraction of addressed-evidence items whose panel says VAGUE.
function tallyVagueness(judged) {
  const items = (judged || []).filter(isObj);
  const total = items.length;
  const vague = items.filter(it => it.panel && it.panel.vague === true).length;
  const perConcern = {};
  for (const it of items) {
    const id = it.concernId || '(unknown)';
    if (!perConcern[id]) perConcern[id] = { total: 0, vague: 0 };
    perConcern[id].total++;
    if (it.panel && it.panel.vague === true) perConcern[id].vague++;
  }
  return {
    total, vague,
    vaguenessRate: total ? Math.round((vague / total) * 1000) / 1000 : null,
    perConcern
  };
}

// ===========================================================================
// L5 — downstream propagation (autonomous-build-4vj.5). The end-to-end question:
// do BLESSED plans survive /decompose, and did the bfo.9 forward-coverage gate
// catch lying concerns? These pure-JS functions are an INDEPENDENT oracle that
// re-checks the bfo.9 invariant over a /decompose --dry-run DAG and reports
// leakage as a metric (the live decompose run is the only LLM part; the check is
// pure, so "a lying concern is caught" is unit-testable without agents).
// ===========================================================================

// Parse an addressed-concern evidence string for a featureOrder[] name it cites.
// Mirrors bfo.9: evidence that cites a feature must map to a bead; evidence citing
// only a tenet/gate/stack-pin cites no feature → returns null (exempt, nothing to map).
function citedFeature(evidence, featureOrder) {
  const e = String(evidence || '').toLowerCase();
  const names = (isArr(featureOrder) ? featureOrder : [])
    .map(f => (isObj(f) ? f.name : f)).filter(nonEmptyStr)
    .sort((a, b) => b.length - a.length); // longest-first so "Account login" wins over "login"
  for (const n of names) if (e.includes(n.toLowerCase())) return n;
  return null;
}

// Normalize a dry-run bead's feature into the set of feature names it carries
// (either a `feature` field or one/more `feature:<name>` labels).
function beadFeatures(bead) {
  if (!isObj(bead)) return [];
  const out = [];
  if (nonEmptyStr(bead.feature)) out.push(bead.feature);
  for (const l of (isArr(bead.labels) ? bead.labels : [])) {
    const m = /^feature:(.+)$/.exec(String(l));
    if (m) out.push(m[1]);
  }
  return out;
}

// The L5 propagation oracle. Given a blessed plan.lock and the bead DAG a
// /decompose --dry-run emitted, assert the bfo.9 invariant INDEPENDENTLY and
// report leakage: every addressed-concern evidence that cites a feature must map
// to >=1 bead, and every must-have must map (via its coverage[].features) to >=1
// bead. Returns counts + the specific leaks + a leakageRate.
function checkPropagation(planLock, beads) {
  const pl = isObj(planLock) ? planLock : {};
  const bd = isArr(beads) ? beads.filter(isObj) : [];
  const featuresWithBead = new Set();
  for (const b of bd) for (const f of beadFeatures(b)) featuresWithBead.add(f);

  // concerns: every addressed concern whose evidence cites a feature -> >=1 bead.
  const concernLeaks = [];
  let concernsCited = 0;
  for (const c of (isArr(pl.concerns) ? pl.concerns : [])) {
    if (!isObj(c) || c.status !== 'addressed') continue;
    const feat = citedFeature(c.evidence, pl.featureOrder);
    if (!feat) continue; // cites a tenet/gate/stack-pin (or nothing) -> exempt
    concernsCited++;
    if (!featuresWithBead.has(feat)) concernLeaks.push({ concernId: c.concernId, citedFeature: feat, evidence: c.evidence });
  }

  // must-haves: every must-have -> >=1 bead, resolved via its coverage[].features.
  const coverage = isArr(pl.coverage) ? pl.coverage : [];
  const mustHaveLeaks = [];
  let mustHavesChecked = 0;
  for (const m of (isArr(pl.mustHaves) ? pl.mustHaves : [])) {
    if (!isObj(m) || !nonEmptyStr(m.id)) continue;
    mustHavesChecked++;
    const feats = coverage.filter(c => isObj(c) && c.mustHaveId === m.id).flatMap(c => isArr(c.features) ? c.features : []);
    if (!feats.some(f => featuresWithBead.has(f))) mustHaveLeaks.push({ mustHaveId: m.id, coveringFeatures: feats });
  }

  const totalChecked = concernsCited + mustHavesChecked;
  const totalLeaks = concernLeaks.length + mustHaveLeaks.length;
  return {
    ok: totalLeaks === 0,
    beadCount: bd.length,
    concernsCited, concernLeaks,
    mustHavesChecked, mustHaveLeaks,
    leakageRate: totalChecked ? Math.round((totalLeaks / totalChecked) * 1000) / 1000 : null
  };
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
// `vaguenessRate` is the L4 judge result (autonomous-build-4vj.3) — null when the
// judge did not run (--judge off), which keeps the ratchet's vaguenessRate check a
// quiet skip. Back-compatible: existing 2-arg callers get null, exactly as before.
function buildScorecard(rows, scope, vaguenessRate = null) {
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
      vaguenessRate: (typeof vaguenessRate === 'number') ? vaguenessRate : null // L4 (autonomous-build-4vj.3); null when --judge off → ratchet skips it.
    },
    fixtures
  };
}

// ===========================================================================
// L4 judge prompt. Self-contained: embeds the docs/PLAN_CONCERNS.md "Evidence —
// what counts" bar INLINE (the judge agent runs headless and must not depend on
// reading the repo). SYNC: keep EVIDENCE_BAR in step with docs/PLAN_CONCERNS.md
// §"Evidence — what counts" (same documented-sync rule as CONCERN_IDS/GATE_TOKENS).
// ===========================================================================
const EVIDENCE_BAR = `An "addressed" concern's evidence must point at something a verifier can check EXISTS. Falsifiable evidence is ONE of:
  1. a featureOrder[] entry (by name) that delivers the concern,
  2. a formula that encodes it (e.g. oidc-client-rust, otel-bootstrap-rust),
  3. a tenet, by number (e.g. "T7: no swallowed exceptions"),
  4. the quality gate (hooks/post-build-gate.{sh,ps1}),
  5. a DEFAULT_STACK.md pin.
A BARE ASSERTION ("handled", "we handle auth", "we take security seriously", "standard practices", "users log in", "permissions enforced", "we use env vars") is NOT evidence — it is unfalsifiable and FAILS the bar. Naming a concrete mechanism cited to one of the five anchors above passes; a vibe does not.`;

function evidenceJudgePrompt(item, judgeIdx) {
  return `
You are evidence judge #${judgeIdx} on an adversarial panel for the /vision plan-quality eval. Judge ONE concern's "addressed" evidence: is it FALSIFIABLE, or rubber-stamped vagueness? Be skeptical — default to NOT falsifiable when it is a bare claim with no checkable anchor.

THE BAR (verbatim from docs/PLAN_CONCERNS.md "Evidence — what counts"):
${EVIDENCE_BAR}

THE EVIDENCE UNDER JUDGEMENT:
- concernId: ${JSON.stringify(item.concernId)}
- evidence:  ${JSON.stringify(item.evidence)}

Decide: does this evidence cite at least one of the five falsifiable anchors (a named feature, a named formula, a numbered tenet, the gate, or a DEFAULT_STACK pin) concretely enough that a verifier could check it exists? A bare assertion fails.
Return JSON ONLY: { "falsifiable": true|false, "reason": "<one sentence: which anchor it cites, or why it is a bare assertion>" }.
`.trim();
}

// ===========================================================================
// L5 decompose-dry-run prompt (headless /decompose). Same pattern as
// runVisionPrompt: the agent executes the /decompose PROCEDURE headlessly in
// --dry-run — it derives the bead DAG and returns it, WITHOUT creating any beads
// or writing any files. checkPropagation then re-verifies coverage independently.
// ===========================================================================
function decomposeDryRunPrompt(slug, planLock) {
  return `
You are executing the /decompose skill HEADLESSLY in --dry-run for the L5 propagation eval (fixture "${slug}"). There is NO human, and you must CREATE NO BEADS and WRITE NO FILES — this is a dry run that only DERIVES and RETURNS the DAG.

INPUTS (read the procedure):
- workflows/decompose.spec.md (the /decompose procedure — follow Phases 2-3 to derive the DAG).
- The blessed plan.lock.json under test (inline below — treat it as the app's plan lock):
${JSON.stringify(planLock)}

DERIVE THE DAG (decompose Phases 2-3, dry-run):
- From featureOrder[] and crossFeatureDependencies[], derive one bead per feature slice (one formula pour each). Split a bead that would pour more than one formula (Phase 3).
- Each bead carries: a title, the formula name it pours, and the plan feature it implements as a "feature:<name>" label (the SAME feature name from featureOrder[] — verbatim, this is load-bearing for the coverage check).
- Apply the cross-feature dependency edges as blocks/blocked-by (you do not need to return edges for this eval, only the feature mapping).

RULES:
- Do NOT run \`bd create\`, do NOT touch any .beads store, do NOT write files. Derive in-memory only.
- Do NOT invent features that are not in featureOrder[]; do NOT drop a feature that is in featureOrder[]. The DAG must reflect the plan as written (a missing feature is exactly the leakage L5 exists to detect — do not paper over it).

OUTPUT (raw JSON only, no prose/fences):
{ "beads": [ { "title": "<bead title>", "feature": "<the featureOrder name it implements>", "formula": "<formula name>" }, ... ],
  "decomposeOk": <true if the forward-coverage gate (every must-have + every feature-citing addressed concern maps to >=1 bead) would PASS, else false>,
  "error": <null, or a one-line reason decompose could not derive a DAG> }
`.trim();
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

  // 14-21. L4 evidence-quality judge (autonomous-build-4vj.3). The LLM verdict is
  // injected, so the collection/majority/tally machinery is fully unit-testable.
  // collectAddressedEvidence pulls addressed evidence and skips excluded concerns.
  const evLock = JSON.parse(JSON.stringify(goodLock)); // 9 addressed + 1 excluded (perf-envelope)
  const collected = collectAddressedEvidence([evLock]);
  check('L4 collectAddressedEvidence pulls addressed concerns only (skips excluded)',
    collected.length === 9 && collected.every(e => e.concernId !== 'perf-envelope'));

  // dedupeEvidence collapses identical (slug,concernId,evidence) tuples across K runs.
  const dupSrc = [
    { slug: '01', concernId: 'authn', evidence: 'feature Login via oidc-client-rust' },
    { slug: '01', concernId: 'authn', evidence: 'feature Login via oidc-client-rust' },
    { slug: '01', concernId: 'authz', evidence: 'we handle auth' }
  ];
  const deduped = dedupeEvidence(dupSrc);
  check('L4 dedupeEvidence collapses identical evidence across runs (with count)',
    deduped.length === 2 && deduped.find(d => d.concernId === 'authn').count === 2);

  // judgePanelMajority: strict majority falsifiable -> falsifiable; tie or minority -> vague.
  check('L4 panel majority falsifiable -> not vague',
    judgePanelMajority([{ falsifiable: true }, { falsifiable: true }, { falsifiable: false }]).vague === false);
  check('L4 panel majority vague -> vague',
    judgePanelMajority([{ falsifiable: false }, { falsifiable: false }, { falsifiable: true }]).vague === true);
  check('L4 panel even split breaks toward vague',
    judgePanelMajority([{ falsifiable: true }, { falsifiable: false }]).vague === true);

  // ACCEPTANCE (4vj.3): a deliberately vague evidence string ("we handle auth") is
  // flagged by the panel. We drive the REAL pipeline (judgePanelMajority + tallyVagueness)
  // with a synthetic judge faithfully applying the bar, proving the machinery flags it.
  const syntheticJudge = (item) => {
    // a falsifiable anchor: a known formula name, a Txx tenet, "feature ", the gate, the stack pin.
    const e = String(item.evidence || '');
    const falsifiable = /-(rust|model)\b|oidc-client|otel-bootstrap|openfga|\bT\d+\b|\bfeature\b|post-build-gate|DEFAULT_STACK|p\d{2}\s*<|entities? in Data model/i.test(e);
    return { falsifiable, reason: falsifiable ? 'cites an anchor' : 'bare assertion' };
  };
  const judgeItems = [
    { concernId: 'authn', evidence: "feature 'Account login' via oidc-client-rust" },
    { concernId: 'observability', evidence: "feature 'Telemetry' via otel-bootstrap-rust" },
    { concernId: 'authz', evidence: 'we handle auth' } // <- deliberately vague
  ];
  const judgedItems = judgeItems.map(it => ({
    ...it,
    panel: judgePanelMajority(Array.from({ length: 3 }, () => syntheticJudge(it)))
  }));
  const tally = tallyVagueness(judgedItems);
  check('L4 ACCEPTANCE: panel flags the deliberately vague "we handle auth" string',
    judgedItems.find(j => j.concernId === 'authz').panel.vague === true &&
    judgedItems.find(j => j.concernId === 'authn').panel.vague === false);
  check('L4 tallyVagueness computes the rate (1 of 3 vague -> 0.333) + perConcern',
    tally.total === 3 && tally.vague === 1 && tally.vaguenessRate === 0.333 &&
    tally.perConcern.authz.vague === 1 && tally.perConcern.authn.vague === 0);
  check('L4 all-falsifiable evidence -> vaguenessRate 0',
    tallyVagueness([{ concernId: 'authn', evidence: 'x', panel: judgePanelMajority([{ falsifiable: true }]) }]).vaguenessRate === 0);

  // 22-24. scorecard carries vaguenessRate; the ratchet gates it as an "above" metric.
  check('scorecard back-compat: 2-arg buildScorecard leaves vaguenessRate null',
    buildScorecard(rowsA, 'k=5').aggregate.vaguenessRate === null);
  check('scorecard records an injected vaguenessRate',
    buildScorecard(rowsA, 'k=5', 0.25).aggregate.vaguenessRate === 0.25);
  const vagueBase = Object.assign({}, buildScorecard(rowsA, 'k=5', 0.1), { blessed: true });
  check('ratchet BLOCKs a vaguenessRate rise beyond tolerance',
    compareToBaseline(buildScorecard(rowsA, 'k=5', 0.3), vagueBase).status === 'block');
  check('ratchet tolerates a sub-tolerance vaguenessRate rise',
    compareToBaseline(buildScorecard(rowsA, 'k=5', 0.15), vagueBase).status === 'pass');

  // 25-30. L5 downstream propagation (autonomous-build-4vj.5). The /decompose run is the
  // only LLM part; the bfo.9 re-check is pure JS, so the "lying concern" acceptance is
  // unit-testable with a synthetic DAG.
  const propLock = {
    schemaVersion: 2, app: { name: 'Demo' },
    mustHaves: [{ id: 'M1', text: 'log in' }, { id: 'M2', text: 'see telemetry' }],
    featureOrder: [{ name: 'Account login', formulas: ['oidc-client-rust'] }, { name: 'Telemetry', formulas: ['otel-bootstrap-rust'] }],
    coverage: [{ mustHaveId: 'M1', features: ['Account login'], how: 'x' }, { mustHaveId: 'M2', features: ['Telemetry'], how: 'y' }],
    concerns: [
      { concernId: 'authn', status: 'addressed', evidence: "feature 'Account login' via oidc-client-rust" },
      { concernId: 'observability', status: 'addressed', evidence: "feature 'Telemetry' via otel-bootstrap-rust" },
      { concernId: 'error-handling', status: 'addressed', evidence: 'T7: no swallowed exceptions' } // cites a tenet -> exempt
    ],
    incomplete: false
  };
  // citedFeature: finds a feature name; returns null for tenet-only evidence.
  check('L5 citedFeature finds a cited featureOrder name',
    citedFeature("feature 'Account login' via oidc-client-rust", propLock.featureOrder) === 'Account login');
  check('L5 citedFeature returns null for tenet/gate/stack-pin evidence (exempt)',
    citedFeature('T7: no swallowed exceptions', propLock.featureOrder) === null);

  // Full DAG -> no leaks; the tenet-citing concern is exempt (not counted).
  const fullDag = [
    { title: 'Account login', labels: ['feature:Account login'] },
    { title: 'Telemetry', feature: 'Telemetry' }
  ];
  const propOk = checkPropagation(propLock, fullDag);
  check('L5 checkPropagation: complete DAG has no leaks + exempts tenet-cited concern',
    propOk.ok === true && propOk.concernsCited === 2 && propOk.leakageRate === 0);

  // ACCEPTANCE (4vj.5): a deliberately LYING concern (Telemetry addressed, but no bead
  // carries feature:Telemetry) is caught and reported.
  const lyingDag = [{ title: 'Account login', labels: ['feature:Account login'] }]; // Telemetry bead dropped
  const propLeak = checkPropagation(propLock, lyingDag);
  check('L5 ACCEPTANCE: a lying concern (feature with no bead) is caught + reported',
    propLeak.ok === false &&
    propLeak.concernLeaks.some(l => l.concernId === 'observability' && l.citedFeature === 'Telemetry'));
  check('L5 also reports the must-have whose feature has no bead',
    propLeak.mustHaveLeaks.some(l => l.mustHaveId === 'M2') && propLeak.leakageRate > 0);
  check('L5 beadFeatures parses both feature field and feature:<name> labels',
    beadFeatures({ feature: 'A', labels: ['feature:B', 'other'] }).sort().join(',') === 'A,B');

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
      return parallel(runThunks).then(texts => {
        const cleanTexts = texts.filter(t => t != null);
        const row = gradeFixture(slug, prev.manifest, cleanTexts, CONCERN_IDS);
        // L4/L5 prep (pure JS, cheap): reuse this fixture's runs so neither layer
        // re-runs /vision. Only when the relevant layer is enabled.
        if (A.judge || A.propagate) {
          const parsed = cleanTexts.map(extractJson).filter(isObj);
          // L4: stash addressed-concern evidence for the judge panel.
          if (A.judge) row.addressedEvidence = collectAddressedEvidence(parsed).map(e => Object.assign({ slug }, e));
          // L5: stash the first BLESSED lock (schema-valid + complete) for /decompose.
          if (A.propagate) {
            const blessed = parsed.find(pl => validatePlanLock(pl, CONCERN_IDS).ok && pl.incomplete === false);
            if (blessed) row.blessedLock = blessed;
          }
        }
        return row;
      });
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

  // ---- Phase 3.5: L4 evidence-quality judge (autonomous-build-4vj.3, opt-in) ----
  // The one thing L1–L3 cannot check: is each addressed concern's evidence falsifiable
  // or rubber-stamped vagueness? Adversarial panel (default 3) per evidence item, majority
  // vote, then a vagueness rate. Cost-disciplined: dedupe identical strings; --judge-sample
  // caps the item count (periodic / small-sample per the cost model). Off by default.
  let vaguenessRate = null;
  if (A.judge) {
    phase('Evidence judge');
    let evItems = dedupeEvidence(clean.flatMap(r => r.addressedEvidence || []));
    const totalItems = evItems.length;
    let sampled = false;
    if (A.judgeSample > 0 && evItems.length > A.judgeSample) {
      // deterministic sample (no Math.random — forbidden): stable-sort by key, take first N.
      evItems = evItems
        .slice()
        .sort((a, b) => `${a.slug}:${a.concernId}:${a.evidence}`.localeCompare(`${b.slug}:${b.concernId}:${b.evidence}`))
        .slice(0, A.judgeSample);
      sampled = true;
    }
    if (!evItems.length) {
      log('L4 evidence judge: no addressed-concern evidence to judge (all runs blocked or excluded).');
    } else {
      const judgeSchema = { type: 'object', required: ['falsifiable'], properties: { falsifiable: { type: 'boolean' }, reason: { type: 'string' } } };
      const judged = await parallel(evItems.map((item) => () =>
        parallel(Array.from({ length: A.judgePanel }, (_, j) => () =>
          agent(evidenceJudgePrompt(item, j + 1), { label: `judge:${item.slug}:${item.concernId}#${j + 1}`, phase: 'Evidence judge', schema: judgeSchema })
        )).then(verdicts => Object.assign({}, item, { panel: judgePanelMajority(verdicts.filter(Boolean)) }))
      ));
      const tally = tallyVagueness(judged.filter(Boolean));
      vaguenessRate = tally.vaguenessRate;
      log(`L4 evidence judge: ${tally.vague}/${tally.total} addressed-evidence items judged VAGUE → vaguenessRate=${vaguenessRate}` +
        `${sampled ? ` (sampled ${evItems.length} of ${totalItems} — periodic/small-sample)` : ''} · panel=${A.judgePanel}`);
      const offenders = Object.entries(tally.perConcern).filter(([, v]) => v.vague > 0).map(([id, v]) => `${id} ${v.vague}/${v.total}`);
      if (offenders.length) log(`  vague-by-concern: ${offenders.join(', ')}`);
    }
  }

  // ---- Phase 3.6: L5 downstream propagation (autonomous-build-4vj.5, opt-in) ----
  // The most expensive, least frequent layer: run a small sample of BLESSED locks
  // through /decompose --dry-run and re-check the bfo.9 forward-coverage invariant
  // INDEPENDENTLY, reporting leakage. Report-only — does NOT gate CI by default.
  let propagation = null;
  if (A.propagate) {
    phase('Propagation (L5)');
    const candidates = clean.filter(r => r.blessedLock).slice(0, A.propagateSample);
    if (!candidates.length) {
      log('L5 propagation: no BLESSED plan.lock in the sampled runs (need a complete, schema-valid lock) — nothing to propagate.');
    } else {
      const dagSchema = {
        type: 'object', required: ['beads'],
        properties: {
          beads: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, feature: { type: ['string', 'null'] }, formula: { type: ['string', 'null'] } } } },
          decomposeOk: { type: 'boolean' },
          error: { type: ['string', 'null'] }
        }
      };
      const results = await parallel(candidates.map(r => () =>
        agent(decomposeDryRunPrompt(r.slug, r.blessedLock), { label: `propagate:${r.slug}`, phase: 'Propagation (L5)', schema: dagSchema })
          .then(d => ({ slug: r.slug, lock: r.blessedLock, dag: d }))
      ));
      propagation = { sampled: candidates.length, sample: [] };
      for (const res of results.filter(Boolean)) {
        const beads = (res.dag && isArr(res.dag.beads)) ? res.dag.beads : [];
        const prop = checkPropagation(res.lock, beads);
        propagation.sample.push(Object.assign({ slug: res.slug, decomposeOk: !!(res.dag && res.dag.decomposeOk), decomposeError: (res.dag && res.dag.error) || null }, prop));
        log(`L5 ${res.slug}: ${beads.length} beads · ${prop.concernLeaks.length} concern-leak(s) · ${prop.mustHaveLeaks.length} must-have-leak(s) · leakageRate=${prop.leakageRate} · decomposeOk=${!!(res.dag && res.dag.decomposeOk)}`);
        for (const cl of prop.concernLeaks) log(`    LEAK concern "${cl.concernId}" cites feature "${cl.citedFeature}" but NO bead carries feature:${cl.citedFeature} (lying concern)`);
        for (const ml of prop.mustHaveLeaks) log(`    LEAK must-have "${ml.mustHaveId}" maps to no emitted bead (covering features: ${(ml.coveringFeatures || []).join(', ') || 'none'})`);
        if (res.dag && res.dag.error) log(`    decompose dry-run note: ${res.dag.error}`);
      }
      const totalLeaks = propagation.sample.reduce((a, s) => a + s.concernLeaks.length + s.mustHaveLeaks.length, 0);
      log(`L5 propagation summary: ${propagation.sample.length} plan(s) decomposed, ${totalLeaks} total leak(s). Report-only (does not gate CI).`);
    }
  }

  // ---- Phase 4: scorecard + baseline ratchet ----
  phase('Scorecard + ratchet');
  const baseRead = await agent(`
Read the file ${A.baselinePath} if it exists.
- If it exists and parses as JSON, return {"found": true, "baseline": <the parsed object>}.
- If it does NOT exist, return {"found": false}.
Do not create or modify the file.
`.trim(), { label: 'read-baseline', phase: 'Scorecard + ratchet', schema: { type: 'object', required: ['found'], properties: { found: { type: 'boolean' }, baseline: { type: 'object' } } } });

  const baseline = (baseRead && baseRead.found) ? baseRead.baseline : null;
  const scorecard = buildScorecard(clean, scope, vaguenessRate);
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
  log(A.judge
    ? `L4 evidence-judge ran: vaguenessRate=${vaguenessRate} (gated as an "above" metric once a blessed baseline carries one). L5 propagation is 4vj.5.`
    : 'NOTE: L4 evidence-judge (vaguenessRate) is OFF — pass --judge to populate it (periodic; heavy). L5 propagation is 4vj.5.');

  // The gate: a regression fails the run (the "exit non-zero" CI hook). Skip when
  // blessing a new baseline or when --no-gate is set.
  if (cmp.status === 'block' && !A.noGate && !A.updateBaseline) {
    throw new Error(`vision-eval REGRESSION vs baseline: ${cmp.regressions.map(r => `${r.metric} ${r.current}<${r.baseline}-${r.tol}`).join('; ')}`);
  }
  return { rows: clean, scope, scorecard, ratchet: cmp, vaguenessRate, propagation };
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
    collectAddressedEvidence, dedupeEvidence, judgePanelMajority, tallyVagueness, evidenceJudgePrompt,
    citedFeature, beadFeatures, checkPropagation, decomposeDryRunPrompt,
    CONCERN_IDS, GATE_TOKENS, DEFAULT_TOLS, EVIDENCE_BAR
  };
}
