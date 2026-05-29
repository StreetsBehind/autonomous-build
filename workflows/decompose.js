export const meta = {
  name: 'decompose',
  description: 'Turn plan.md + plan.lock.json into a blessed atomic bead DAG. Fans out pours per feature, atomizes oversized beads, scores quality, adversarially cross-checks DAG vs plan, audits topology, emits BLESSED|NEEDS-FIX verdict + decomposeReport.md. Subsumes /compose, /quality-pass, /split.',
  whenToUse: 'After /vision has produced plan.md + plan.lock.json in an app repo. Run before /build-batch; the report is a human-review gate between the two.',
  phases: [
    { title: 'Pre-flight',           detail: 'Verify plan, formulas, jankurai, repo state' },
    { title: 'Parse plan',           detail: 'Extract features + cross-deps; init beads + jankurai if fresh repo' },
    { title: 'Pour',                 detail: 'One agent per feature pours its formula(s) and writes step metadata' },
    { title: 'Atomize',              detail: 'Split oversized beads along clean seams; iterate up to 3 times' },
    { title: 'Quality scoring',      detail: 'Per-epic agent scores every child against the buildability rubric' },
    { title: 'Fidelity cross-check', detail: 'Three independent verifiers (plan→dag, dag→plan, must-have→dag) + reconciler' },
    { title: 'Dep audit',            detail: 'Cycles, ready-set sanity, implicit conflicts, cross-deps applied' },
    { title: 'Synthesis',            detail: 'Aggregate, compute verdict, write decomposeReport.md' }
  ]
};

// ---------------------------------------------------------------------------
// Args
// The runtime exposes user invocation args as a string. Common globals tried
// in priority order; if none exist, defaults kick in. If the runtime uses a
// different convention, the smoke test (autonomous-build-mvh.1.3) catches it
// and the fix is a one-line change here.
// ---------------------------------------------------------------------------
const rawArgs =
  (typeof args !== 'undefined') ? args :
  (typeof userArgs !== 'undefined') ? userArgs :
  (typeof input !== 'undefined') ? input : '';

const parsedArgs = parseArgs(rawArgs);
log(`decompose args: ${JSON.stringify(parsedArgs)}`);

function parseArgs(s) {
  const out = { plan: 'plan.md', dryRun: false };
  if (!s) return out;
  const tokens = (typeof s === 'string') ? s.trim().split(/\s+/).filter(Boolean) : (Array.isArray(s) ? s : []);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--plan' && tokens[i + 1]) { out.plan = tokens[++i]; }
    else if (tokens[i] === '--no-file') { out.dryRun = true; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 1 — Pre-flight (sequential, 1 agent)
// ---------------------------------------------------------------------------
phase('Pre-flight');

const preflightSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { enum: ['ok', 'failed'] },
    failedReason: { type: 'string' },
    context: {
      type: 'object',
      required: ['planPath', 'planSource', 'appName', 'isFreshRepo', 'formulas'],
      properties: {
        planPath:    { type: 'string' },
        lockPath:    { type: ['string', 'null'] },
        planSource:  { enum: ['lock', 'md'] },
        appName:     { type: 'string' },
        isFreshRepo: { type: 'boolean' },
        formulas:    { type: 'array', items: { type: 'string' } }
      }
    }
  }
};

const preflight = await agent(`
You are the pre-flight agent for the /decompose dynamic workflow. (Self-contained: all instructions are inline below — you run in the app repo cwd, where the workflow spec is not present.)

Run these checks IN ORDER and return JSON matching the schema:

1. Verify ${parsedArgs.plan} exists in cwd. If not, return { "status": "failed", "failedReason": "no ${parsedArgs.plan} — run /vision first" }.
2. Resolve plan.lock.json next to ${parsedArgs.plan}. If absent → set planSource="md". If present → set planSource="lock".
3. If planSource="lock", read plan.lock.json and verify schemaVersion == 2. If schemaVersion == 1, fail with { "status": "failed", "failedReason": "plan.lock.json is schemaVersion 1; this workflow needs schemaVersion 2 — rerun /vision to regenerate a v2 lock" }. For any other version, fail with the version found. (v2 added mustHaves[]/successMetric/coverage[]/concerns[].)
4. If planSource="lock" AND lock.incomplete == true, fail with the blocking openQuestions list joined into failedReason.
5. Run \`bd info\`. If it errors → isFreshRepo=true. If it succeeds → run \`bd list --status=open --json\`. If the result is a non-empty array, fail with "repo already has open beads — /decompose is for fresh app repos; for re-pour delete .beads/ first then rerun".
6. Enumerate formulas referenced in plan: from lock.featureOrder[].formulas if lock, else regex-parse plan.md §"Feature order" for backtick-quoted formula names. Then verify each named formula exists via \`bd formula list\`. IMPORTANT: \`bd formula list\` requires an openable beads database to run, but a fresh app repo has none yet (check 5 above relies on \`bd info\` erroring). So do NOT run \`bd formula list\` bare from cwd — instead create a throwaway empty database used ONLY for the listing, scoped to that one command so it never touches the app repo or its fresh state: \`TMPDB=$(mktemp -d); ( cd "$TMPDB" && bd init >/dev/null 2>&1 ); BEADS_DIR="$TMPDB/.beads" bd formula list; rm -rf "$TMPDB"\`. The user-level search path \`~/.beads/formulas/\` (and the project \`.beads/formulas/\`) is scanned regardless of BEADS_DIR, so formulas installed there resolve. Verify each named formula appears in the output. If any are missing, fail with the list of missing formula names.
7. Run \`jankurai version\`. If exit≠0, fail with "jankurai not installed — see README install section".

If all 7 pass, return:
{
  "status": "ok",
  "context": {
    "planPath": "${parsedArgs.plan}",
    "lockPath": "<resolved lock path or null>",
    "planSource": "<lock|md>",
    "appName": "<basename of cwd>",
    "isFreshRepo": <bool>,
    "formulas": ["<formula name>", ...]
  }
}

Use Bash, Read, Glob. Be thorough — failures stop the whole workflow (T1, T7).
`, { label: 'preflight', phase: 'Pre-flight', schema: preflightSchema });

if (!preflight || preflight.status !== 'ok') {
  return {
    verdict: 'NEEDS-FIX',
    phase: 'pre-flight',
    failedReason: preflight?.failedReason || 'preflight returned null',
    reportPath: null
  };
}
const Context = { ...preflight.context, dryRun: parsedArgs.dryRun };
log(`Pre-flight OK — app=${Context.appName}, planSource=${Context.planSource}, isFreshRepo=${Context.isFreshRepo}, formulas=${Context.formulas.length}, dryRun=${Context.dryRun}`);

// ---------------------------------------------------------------------------
// Phase 2 — Parse plan + initialize repo (sequential, 1 agent)
// ---------------------------------------------------------------------------
phase('Parse plan');

const parseSchema = {
  type: 'object',
  required: ['status', 'features', 'crossDeps', 'appEpicId'],
  properties: {
    status:    { enum: ['ok', 'failed'] },
    failedReason: { type: 'string' },
    appEpicId: { type: 'string' },
    features: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'formulas'],
        properties: {
          name:     { type: 'string' },
          formulas: { type: 'array', items: { type: 'string' } },
          vars:     { type: 'object' }
        }
      }
    },
    crossDeps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['blocked', 'blocker'],
        properties: { blocked: { type: 'string' }, blocker: { type: 'string' } }
      }
    }
  }
};

const parseResult = await agent(`
You are the parse-plan agent for /decompose. (Self-contained: all instructions are inline below; you run in the app repo cwd, where the workflow spec is not present.)

Context (from pre-flight):
${JSON.stringify(Context, null, 2)}

Steps:
1. Parse the plan:
   - If Context.planSource == "lock": read \`${Context.lockPath || 'plan.lock.json'}\`. Extract \`featureOrder[]\` (name, formulas, vars) and \`crossFeatureDependencies\` (blocked, blocker).
   - If Context.planSource == "md": regex-parse plan.md §"Feature order" (lines like "1. Habits CRUD — formulas: \`[crud-feature]\`, vars: \`{entity=Habit}\`") and §"Cross-feature dependencies".
2. If Context.isFreshRepo AND NOT Context.dryRun:
   a. \`bd init\`
   b. \`bd setup claude --project\`
   c. \`bd hooks install\`
   d. \`mkdir -p target/jankurai\`
   e. \`jankurai adopt . --profile auto --mode observe --out target/jankurai/adoption-plan.json --md target/jankurai/adoption-plan.md\`
   f. \`jankurai init . --level agents --yes\`
   g. \`jankurai audit . --mode advisory --json target/jankurai/repo-score.json --md target/jankurai/repo-score.md\`
3. Create the app-level epic (skip if Context.dryRun): \`bd create "${Context.appName}" --type=epic --priority=1 --description "See plan.md"\`. Capture the returned ID.
4. If Context.dryRun, set appEpicId to "<dry-run>".

Return:
{
  "status": "ok",
  "appEpicId": "<id or <dry-run>>",
  "features": [{ "name": "...", "formulas": ["..."], "vars": {...} }, ...],
  "crossDeps": [{ "blocked": "...", "blocker": "..." }, ...]
}

On parse failure, init failure, or bd error: return { "status": "failed", "failedReason": "<message preserving original error>" }. Do not swallow exceptions (T7).
`, { label: 'parse-plan', phase: 'Parse plan', schema: parseSchema });

if (!parseResult || parseResult.status !== 'ok') {
  return {
    verdict: 'NEEDS-FIX',
    phase: 'parse-plan',
    failedReason: parseResult?.failedReason || 'parse returned null',
    reportPath: null
  };
}
const ParsedPlan = parseResult;
log(`Parse OK — ${ParsedPlan.features.length} features, ${ParsedPlan.crossDeps.length} cross-deps, appEpic=${ParsedPlan.appEpicId}`);

// ---------------------------------------------------------------------------
// Phase 3 — Pour beads per feature (parallel fan-out)
// ---------------------------------------------------------------------------
phase('Pour');

const pourSchema = {
  type: 'object',
  required: ['feature', 'status'],
  properties: {
    feature:  { type: 'string' },
    status:   { enum: ['ok', 'failed'] },
    pourRoot: { type: ['string', 'null'] },
    children: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title'],
        properties: {
          id:       { type: 'string' },
          title:    { type: 'string' },
          metadata: { type: 'object' }
        }
      }
    },
    error: { type: 'string' }
  }
};

const pourTasks = ParsedPlan.features.map((feature) => () => agent(`
You are the pour-feature agent for /decompose, feature="${feature.name}". (Self-contained: all instructions are inline below; you run in the app repo cwd, where the workflow spec is not present.)

Context: ${JSON.stringify(Context, null, 2)}
appEpicId: ${ParsedPlan.appEpicId}
Feature spec: ${JSON.stringify(feature)}

For each formula in feature.formulas (usually 1, sometimes more), do:

0. VALIDATE feature.vars against the formula contract BEFORE pouring. Read the formula TOML at \`~/.beads/formulas/<formula>.formula.toml\` and collect its declared \`[vars.*]\` names; for any var whose description enumerates a closed set of allowed values (e.g. "'api-key' | 'basic' | ... | 'none'"), collect that allowed set. Then, for every key in feature.vars:
   - If the key is NOT a declared variable of this formula → return status="failed" with error "undeclared variable '<key>' for formula <formula> (declared: <list>)".
   - If the value is outside the variable's enumerated allowed set → return status="failed" with error "off-enum value '<value>' for variable '<key>' in formula <formula> (allowed: <list>)".
   Do NOT rename the key to a near-miss declared var, do NOT remap or coerce the value into the enum, do NOT pour with a substituted guess. Improvising a binding violates T1 (do not guess) — fail honestly and let /vision fix the plan. This validation is exactly what should have caught the smbuild auth_scheme→auth_strategy mismatch instead of two agents silently renaming it.

1. If Context.dryRun: \`bd mol pour <formula> --dry-run --var k=v ...\`. Capture the planned issues; do NOT mutate. Return one PourResult per formula with status="ok" and children populated from the dry-run output (id may be "<dry-run-1>", etc.).
2. Otherwise:
   a. \`bd mol pour <formula> --var k=v ... 2>&1\`. Parse \`Root issue: (\\S+)\` from stdout → pourRoot.
   b. \`bd dep add <pourRoot> ${ParsedPlan.appEpicId} --type parent-child\` to reparent under app epic.
   c. Walk the formula TOML at \`~/.beads/formulas/<formula>.formula.toml\`. For each step, identify any \`[steps.testPlan]\` block and any inline \`files = [...]\` field. Build a map of step.title (after variable substitution) → { testPlan?, files? }.
   d. \`bd show <pourRoot> --json\` → walk \`dependents[].id\` to get spawned child IDs and their titles.
   e. For each child, look up step metadata by title. If non-empty, write to a temp JSON file and \`bd update <child.id> --metadata "@<tempfile>"\`. Fields: testPlanFile, testPlanCases, testPlanCoverage (from [steps.testPlan]), filesTouched (from files = [...]). Apply variable substitution to all string values.
   f. Skip metadata write for steps with neither testPlan nor files — that's a valid signal (coordination bead).

Return JSON:
{
  "feature": "${feature.name}",
  "status": "ok" | "failed",
  "pourRoot": "<id>" | null,
  "children": [{ "id": "...", "title": "...", "metadata": {...} }, ...],
  "error": "<only if failed>"
}

If \`bd mol pour\` fails (required-var error, formula validation), return status="failed" with the error message preserved. Do NOT throw (T7).

Do NOT \`bd create\` outside \`bd mol pour\` (T6: formula precedence).
`, { label: `pour-${feature.name}`, phase: 'Pour', schema: pourSchema, agentType: 'general-purpose' }));

const pourResults = await parallel(pourTasks);
const pourOk = pourResults.filter(r => r && r.status === 'ok');
const pourFailed = pourResults.filter(r => !r || r.status === 'failed');
log(`Pour: ${pourOk.length}/${ParsedPlan.features.length} ok, ${pourFailed.length} failed`);

// Apply cross-feature deps sequentially (orchestrator does this, not an agent —
// it's pure resolve-name-to-id + one bd call per edge, and we want it
// serialized so concurrent bd writes don't race on the jsonl).
if (!Context.dryRun && ParsedPlan.crossDeps.length > 0) {
  const featureToPourRoot = {};
  for (const r of pourOk) {
    if (r.pourRoot) featureToPourRoot[r.feature] = r.pourRoot;
  }
  const crossDepSchema = {
    type: 'object',
    required: ['attempted', 'verifiedPresent', 'missing', 'skipped', 'errors'],
    properties: {
      attempted:       { type: 'number' },
      verifiedPresent: { type: 'number' },
      missing:  { type: 'array', items: { type: 'object' } },
      skipped:  { type: 'array', items: { type: 'object' } },
      errors:   { type: 'array', items: { type: 'object' } }
    }
  };

  const depAgent = await agent(`
You are the cross-dep wiring agent for /decompose Phase 3. Apply each cross-feature dep as a single \`bd dep add\` call, then VERIFY each edge actually landed. (Self-contained: no external spec needed.)

Edges to apply:
${JSON.stringify(ParsedPlan.crossDeps, null, 2)}

Name → pourRoot mapping:
${JSON.stringify(featureToPourRoot, null, 2)}

For each edge { blocked, blocker }:
1. Resolve blocked → blockedId via the map (or pass through if already a bead ID). If the name has no mapping, record it under "skipped" with reason "unresolved name" and move on.
2. Resolve blocker → blockerId the same way.
3. Run \`bd dep add <blockedId> <blockerId>\`. Increment "attempted".
4. VERIFY the edge is present — do NOT trust the add's exit code. Run \`bd show <blockedId> --json\` and confirm <blockerId> appears in its dependency/blocked-by list (try \`bd dep show <blockedId>\` as a fallback if the JSON shape is unclear). Only if the edge is confirmed present do you count it toward "verifiedPresent". If add succeeded but verification shows the edge absent (the smbuild failure mode — likely a pourRoot-vs-molecule-epic ID mismatch), retry the add once with the molecule-epic IDs you can see in \`bd list --status=open --json\`; if still absent, record it under "missing" with the resolved IDs and what you observed.
5. Capture any command errors under "errors".

Report the VERIFIED-PRESENT count, never the attempted count, as the headline. Return JSON:
{ "attempted": <n>, "verifiedPresent": <n>, "missing": [{ "edge": {...}, "blockedId": "...", "blockerId": "...", "observed": "..." }], "skipped": [{ "edge": {...}, "reason": "..." }], "errors": [{ "edge": {...}, "msg": "..." }] }
`, { label: 'wire-cross-deps', phase: 'Pour', schema: crossDepSchema, agentType: 'general-purpose' });
  log(`Cross-deps wired: ${depAgent?.verifiedPresent ?? 0}/${depAgent?.attempted ?? 0} verified present, ${(depAgent?.missing || []).length} missing, ${(depAgent?.errors || []).length} errors`);
}

// ---------------------------------------------------------------------------
// Phase 3.5 — Concern + NFR enforcement pours (bfo.10 / lbq.16)
// Two sources of non-feature work that otherwise evaporate into advisory
// tenets.md prose — never a bead, never scored, never gated:
//   (a) An "addressed" concern whose evidence is NOT an existing featureOrder
//       entry (cites a tenet/gate/stack-pin or a bare target). [bfo.10]
//   (b) A first-class lock `nfrs[]` entry — a measurable NFR (perf, security,
//       privacy, compliance, data-residency, availability) that has no home in
//       the 10-concern vocabulary ("data stays in my region"). [lbq.16]
// For each, pour a dedicated enforcement bead (concrete AC from the target +
// testPlan from the verify) so it becomes testable, scored, gated work.
// T6 (formula precedence): pour from an enforcement formula, NEVER hand-create
// via bd create; if no formula fits, surface "Missing formula" and force
// NEEDS-FIX. No double-pour: a concern/NFR already delivered by a product
// feature's Phase 3 pour is skipped.
// ---------------------------------------------------------------------------
let concernEnforcement = { poured: [], missingFormula: [], skippedCoveredByFeature: [], errors: [], nfrPoured: [], nfrMissingFormula: [] };
if (Context.planSource === 'lock') {
  phase('Concern enforcement');
  const ceSchema = {
    type: 'object',
    required: ['poured', 'missingFormula', 'skippedCoveredByFeature', 'errors'],
    properties: {
      poured:                  { type: 'array', items: { type: 'object' } },
      missingFormula:          { type: 'array', items: { type: 'object' } },
      skippedCoveredByFeature: { type: 'array', items: { type: 'object' } },
      errors:                  { type: 'array', items: { type: 'object' } },
      nfrPoured:               { type: 'array', items: { type: 'object' } },
      nfrMissingFormula:       { type: 'array', items: { type: 'object' } }
    }
  };
  const ce = await agent(`
You are the concern-enforcement agent for /decompose Phase 3.5 (bfo.10). (Self-contained: all instructions are inline below; you run in the app repo cwd, where the workflow spec is not present.)

PURPOSE: make every "addressed" concern that is NOT delivered by a product feature into testable, gated work — pour a dedicated enforcement bead with a concrete AC and a test plan. An NFR like "data stays in my region" or "p99 < 200ms" otherwise evaporates into prose, never scored, never gated.

INPUTS:
- Read the lock at ${Context.lockPath || 'plan.lock.json'}. Use its \`concerns[]\` and \`featureOrder[].name\` lists.
- App epic id: ${ParsedPlan.appEpicId}. Reparent every poured root under it.
- dryRun: ${Context.dryRun}.

FOR EACH \`concerns[]\` entry with \`status == "addressed"\`:
1. Classify the evidence:
   - If it cites (names or clearly maps to) a \`featureOrder[].name\` → that product feature's Phase 3 pour ALREADY produces the implementing bead. Record under "skippedCoveredByFeature" ({concernId, feature}) and DO NOT pour — no double-pour.
   - Otherwise (evidence cites a tenet like "T7", the quality gate, a DEFAULT_STACK pin, a formula name, or a bare NFR target such as "p99 < 200ms") → this concern needs a DEDICATED enforcement bead. Proceed to step 2.
   (\`status == "excluded"\` concerns are skipped entirely — nothing to enforce.)
2. Select a concern-enforcement formula. Run \`bd formula list\` (against a throwaway DB if the repo's is fresh: \`TMPDB=$(mktemp -d); ( cd "$TMPDB" && bd init >/dev/null 2>&1 ); BEADS_DIR="$TMPDB/.beads" bd formula list; rm -rf "$TMPDB"\`). Pick the formula whose purpose is enforcing this class of concern (e.g. a load/latency-test formula for \`perf-envelope\`, a data-residency/retention formula for \`data-lifecycle\`, a rate-limit/input-validation formula for \`abuse-surface\`). Read its \`[vars.*]\` contract with \`bd formula show <name>\`.
   - If NO installed formula fits this concern → record under "missingFormula" ({concernId, evidence, recommendedFormula: "<one-line description of the formula that should exist, e.g. concern-enforcement-perf: pours a load test asserting a p99 latency target>"}) and move on. DO NOT hand-create the bead with \`bd create\` and DO NOT remap to a near-miss formula (T6 + T1).
3. Pour the chosen formula, binding ONLY its declared vars (validate against the \`[vars.*]\` contract exactly as Phase 3 does — no invented keys, no off-enum values). Bind the concern's target/evidence into the formula's vars so the poured bead carries a concrete, falsifiable AC and a testPlan.
   - If dryRun: \`bd mol pour <formula> --dry-run --var ...\` — capture the planned bead, do not mutate.
   - Else: \`bd mol pour <formula> --var ... 2>&1\`, parse \`Root issue: (\\S+)\` → pourRoot, then \`bd dep add <pourRoot> ${ParsedPlan.appEpicId} --type parent-child\`. Set the bead's description to cite the concernId (so it is discoverable as the enforcement of that concern; the Phase 6 concern-traceability check treats NFR/tenet evidence as accepted-as-is, so this does not regress fidelity).
   - Record under "poured" ({concernId, formula, pourRoot, acSummary}).
4. On any \`bd\` error, record under "errors" ({concernId, msg}) instead of throwing (T7).

THEN, FOR EACH \`nfrs[]\` entry in the lock (the first-class measurable NFRs — may be absent/empty, in which case skip this block):
5. If an existing \`featureOrder[]\` feature already delivers this NFR (its statement clearly maps to a feature that has a Phase-3 bead), record under "skippedCoveredByFeature" ({concernId: nfr.id, feature}) and do NOT pour — no double-pour.
6. Otherwise select an enforcement formula matching \`nfr.category\` (e.g. a load/latency-test formula for "performance", a data-residency/retention formula for "data-residency"/"compliance", an input-validation/rate-limit formula for "security", a privacy/PII formula for "privacy"). Read its \`[vars.*]\` contract with \`bd formula show <name>\`.
   - If NO installed formula fits → record under "nfrMissingFormula" ({nfrId: nfr.id, category, statement, target, recommendedFormula: "<one-line description of the formula that should exist>"}) and move on. DO NOT hand-create via \`bd create\`, DO NOT remap to a near-miss formula (T6 + T1).
7. Pour the chosen formula, binding ONLY its declared vars (validate exactly as Phase 3). Bind \`nfr.target\` into the AC and \`nfr.verify\` into the testPlan so the poured bead is concrete and falsifiable. Reparent under ${ParsedPlan.appEpicId}. Set the description to cite \`nfr.id\` + \`nfr.statement\`. Record under "nfrPoured" ({nfrId: nfr.id, category, formula, pourRoot, acSummary}). On \`bd\` error → "errors" ({concernId: nfr.id, msg}).

Return JSON:
{
  "poured": [{ "concernId": "...", "formula": "...", "pourRoot": "...", "acSummary": "..." }, ...],
  "missingFormula": [{ "concernId": "...", "evidence": "...", "recommendedFormula": "..." }, ...],
  "skippedCoveredByFeature": [{ "concernId": "...", "feature": "..." }, ...],
  "errors": [{ "concernId": "...", "msg": "..." }, ...],
  "nfrPoured": [{ "nfrId": "...", "category": "...", "formula": "...", "pourRoot": "...", "acSummary": "..." }, ...],
  "nfrMissingFormula": [{ "nfrId": "...", "category": "...", "statement": "...", "target": "...", "recommendedFormula": "..." }, ...]
}
`, { label: 'concern-enforcement', phase: 'Concern enforcement', schema: ceSchema, agentType: 'general-purpose' });
  concernEnforcement = ce || concernEnforcement;
  // normalize the optional NFR arrays so downstream gate logic never NPEs
  concernEnforcement.nfrPoured = concernEnforcement.nfrPoured || [];
  concernEnforcement.nfrMissingFormula = concernEnforcement.nfrMissingFormula || [];
  log(`Concern+NFR enforcement: ${concernEnforcement.poured.length} concern-poured, ${concernEnforcement.nfrPoured.length} nfr-poured, ${concernEnforcement.missingFormula.length + concernEnforcement.nfrMissingFormula.length} missing-formula, ${concernEnforcement.skippedCoveredByFeature.length} covered-by-feature, ${concernEnforcement.errors.length} errors`);
}

// ---------------------------------------------------------------------------
// Phase 4 — Atomize oversized beads (iterative parallel)
// ---------------------------------------------------------------------------
phase('Atomize');

const atomizeSchema = {
  type: 'object',
  required: ['source', 'status'],
  properties: {
    source:   { type: 'string' },
    status:   { enum: ['atomized', 'unsplittable'] },
    children: { type: 'array', items: { type: 'object' } },
    seam:     { type: 'string' },
    attempted:{ type: 'array', items: { type: 'string' } },
    reason:   { type: 'string' }
  }
};

const atomizeIterationCap = 3;
const atomizedAccum = [];
const unsplittableAccum = [];
let persistentlyOversized = [];

for (let iter = 1; iter <= atomizeIterationCap; iter++) {
  // Identify oversized beads via a scout agent (cheap, single agent reads all open beads).
  const scout = await agent(`
You are the atomize-scout agent for /decompose Phase 4, iteration ${iter}/${atomizeIterationCap}. (Self-contained: all instructions are inline below; you run in the app repo cwd, where the workflow spec is not present.)

Run \`bd list --status=open --json\` and filter out epics (issue_type == "epic"). For each remaining bead, compute the SIZING score:

  Start at 100, floor at 0.
  - ACs > 6 (count "- " / "* " lines in Acceptance section of description): -10
  - File paths > 5 (count tokens matching \`\\b[\\w/.-]+\\.(ts|tsx|js|jsx|py|sql|md|toml|yaml|json|rs|go|java|kt|swift|rb|php|html|css)\\b\`): -10
  - Cross-layer reach > 2 (mentions of {UI/component, API/endpoint, DB/migration, test}, -15 per extra layer beyond 2)
  - metadata.testPlanCases missing or 0: -5

Return JSON: { "oversized": [{ "id": "...", "title": "...", "score": <n>, "penalties": ["..."] }, ...] }

If Context.dryRun, also include the sizing computation for beads that would be created by the dry-run pours (use the pour-result data from earlier phases — passed below).

Context: ${JSON.stringify(Context, null, 2)}
${Context.dryRun ? `Dry-run pours: ${JSON.stringify(pourResults, null, 2)}` : ''}
`, { label: `atomize-scout-iter${iter}`, phase: 'Atomize', agentType: 'general-purpose' });

  const oversized = scout?.oversized || [];
  if (oversized.length === 0) {
    log(`Atomize iter ${iter}: no oversized beads; phase done.`);
    break;
  }
  log(`Atomize iter ${iter}: ${oversized.length} oversized beads, fanning out`);

  const atomizeTasks = oversized.map((b) => () => agent(`
You are the atomize agent for /decompose Phase 4, bead=${b.id}. (Self-contained: all instructions are inline below; you run in the app repo cwd, where the workflow spec is not present.)

Bead to atomize: ${JSON.stringify(b)}
Context: ${JSON.stringify(Context, null, 2)}

Steps:
1. \`bd show ${b.id} --json\` — capture title, ACs (parse Acceptance section), labels, priority, metadata (testPlanFile, filesTouched), incoming deps, outgoing deps, parent epic.
2. Identify the seam. Try in this order; first match wins:
   - Cross-layer: description spans {UI, API, DB} AND ACs partition cleanly → seam="API boundary" or "schema vs app code"
   - Per-entity: title is a list ("Habits, Goals, Streaks CRUD") → seam="per-entity"
   - Read-vs-write: ACs split between reads (GET, list) and writes (POST, update, delete) → seam="read path vs write path"
   - Happy-vs-edge: ACs split between happy-path and explicit edge-cases → seam="happy path vs edge cases"
3. If no seam fits (ACs straddle every candidate): return { "source": "${b.id}", "status": "unsplittable", "attempted": [<seams tried>], "reason": "<one sentence>" }. Do NOT invent a seam (T1).
4. Propose N children:
   - Title = source title + seam term (e.g. "Habits CRUD (DB+API)" + "Habits CRUD (UI)")
   - ACs partitioned along the seam — each source AC lands in exactly one child. NO new ACs (T4).
   - filesTouched partitioned — child ownership sets MUST be disjoint.
   - Dep mode: sequential (UI consumes API) OR parallel (independent subsystems).
5. Re-audit each proposed child against the SAME sizing rubric. If any child still scores < 95, return status="unsplittable" with reason "seam still produces oversized children". Do NOT retry with another seam in this agent run — that's the next iteration's job.
6. If Context.dryRun: return the proposal without mutating.
7. Otherwise mutate:
   - \`bd create\` each child with --parent=<parentEpic>, --labels=<source labels comma-joined>, --priority=<source priority>, --body-file=<tmp.json>.
   - Write filesTouched metadata to each child.
   - Rewire deps (sequential: bd dep add child[i+1] child[i]; preserve incoming on first; preserve outgoing on last. parallel: all children get all incoming + all outgoing).
   - Close source: \`bd close ${b.id} --reason "superseded by <new-ids joined>"\`.

Return JSON:
{
  "source": "${b.id}",
  "status": "atomized" | "unsplittable",
  "children": [{ "id": "...", "title": "...", "score": <n> }, ...]  // only if atomized
  "seam": "<used seam>",  // only if atomized
  "attempted": ["<seam>"], // only if unsplittable
  "reason": "<message>"   // only if unsplittable
}
`, { label: `atomize-${b.id}`, phase: 'Atomize', schema: atomizeSchema, agentType: 'general-purpose' }));

  const waveResults = await parallel(atomizeTasks);
  for (const r of waveResults) {
    if (!r) continue;
    if (r.status === 'atomized') atomizedAccum.push(r);
    else if (r.status === 'unsplittable') unsplittableAccum.push(r);
  }

  if (iter === atomizeIterationCap) {
    // Final iteration — anything still oversized after this wave is persistently oversized.
    const remaining = oversized.filter(o => !waveResults.some(r => r?.source === o.id && r.status === 'atomized'));
    persistentlyOversized = remaining;
  }
}

const AtomizeSummary = {
  iterations: Math.min(atomizeIterationCap, atomizedAccum.length > 0 ? atomizeIterationCap : 1),
  atomized: atomizedAccum,
  unsplittable: unsplittableAccum,
  persistentlyOversized
};
log(`Atomize done: ${AtomizeSummary.atomized.length} atomized, ${AtomizeSummary.unsplittable.length} unsplittable, ${AtomizeSummary.persistentlyOversized.length} persistently oversized`);

// ---------------------------------------------------------------------------
// Phase 5 — Quality scoring (parallel fan-out, K agents)
// ---------------------------------------------------------------------------
phase('Quality scoring');

// Discover the epic set after Phase 4 mutations. (Self-contained: no external spec needed.)
// CRITICAL: pours create app-epic → molecule-root-epic → task. A naive "epics with
// direct non-epic children" scan can return nothing if the scorer's --parent traversal
// misses the molecule-root epics — which is exactly how smbuild scored zero beads and
// passed vacuously. So we (a) enumerate every epic in the app subtree that directly
// parents an open non-epic bead, and (b) return a ground-truth count of ALL open
// non-epic beads so synthesis can detect under-coverage even if discovery under-finds.
const epicDiscoverySchema = {
  type: 'object',
  required: ['epics', 'totalOpenNonEpic'],
  properties: {
    epics: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title'],
        properties: { id: { type: 'string' }, title: { type: 'string' } }
      }
    },
    totalOpenNonEpic: { type: 'number' }
  }
};

const epicDiscovery = await agent(`
Discover the scoring-epic set for /decompose Phase 5.

Context: app epic = ${ParsedPlan.appEpicId}. Pour roots from Phase 3 (the molecule-root epics, reparented under the app epic): ${JSON.stringify(pourOk.map(r => r.pourRoot).filter(Boolean))}.

Steps:
1. Run \`bd list --status=open --json\`. Split into epics (issue_type=="epic") and non-epics.
2. Set totalOpenNonEpic = count of open non-epic beads. This is the GROUND TRUTH the orchestrator uses to detect under-scoring — it must be exact.
3. Return the set of "scoring epics" = every open epic that DIRECTLY parents at least one open non-epic bead (check each epic via \`bd list --parent <id> --status=open --json\`, or by reading parent links in the snapshot). This deliberately includes molecule-root epics AND any deeper sub-epics that directly parent tasks — do not stop at the app epic's direct children. If the app epic itself directly parents non-epic beads, include it too.
4. Sanity check: if totalOpenNonEpic > 0 but you found zero scoring epics, re-examine the parent links — every open non-epic bead has SOME parent epic, so a non-empty pour set must yield at least one scoring epic. Return what you actually find; the orchestrator cross-checks against totalOpenNonEpic.

Return JSON: { "epics": [{ "id": "...", "title": "..." }, ...], "totalOpenNonEpic": <n> }
`, { label: 'epic-discovery', phase: 'Quality scoring', schema: epicDiscoverySchema, agentType: 'general-purpose' });

const epics = epicDiscovery?.epics || [];
const totalOpenNonEpic = epicDiscovery?.totalOpenNonEpic ?? 0;

const qualityScoreSchema = {
  type: 'object',
  required: ['epicId', 'scores'],
  properties: {
    epicId: { type: 'string' },
    scores: {
      type: 'array',
      items: {
        type: 'object',
        required: ['beadId', 'title', 'score', 'penalties'],
        properties: {
          beadId:        { type: 'string' },
          title:         { type: 'string' },
          score:         { type: 'number' },
          penalties:     { type: 'array' },
          remediations:  { type: 'array' },
          wouldReach95:  { type: 'boolean' }
        }
      }
    }
  }
};

const qualityTasks = epics.map((e) => () => agent(`
You are the quality-score agent for /decompose Phase 5, epic=${e.id}. (Self-contained: all instructions are inline below; you run in the app repo cwd, where the workflow spec is not present.)

For every open child of epic ${e.id} (\`bd list --parent ${e.id} --status=open --json\`), apply the FULL /quality-pass rubric. Start each bead at 100, floor at 0, apply ALL applicable penalties:

SIZING (same as Phase 4):
- ACs > 6: -10
- Files > 5: -10
- Cross-layer reach > 2: -15 per extra layer
- testPlanCases missing/0: -5

SPEC CONCRETENESS:
- Vague AC ("works correctly", "handles errors gracefully", "is performant" without thresholds): -5 each
- File paths missing for new code: -10
- API contract missing (endpoint/RPC mentioned but no request/response shape): -10
- testPlanFile missing in metadata: -10
- Edge cases unstated (no "out of scope:" or edge-case enumeration): -5

CONTEXT COMPLETENESS:
- No links to prior beads/specs/code pointers: -5
- Domain terms undefined: -5
- Dependency-graph mismatch (bead asserts "after X" but no bd dep edge, or vice versa): -10
- Open questions left for builder ("?", "TBD", "we should decide"): -5 each

RISK SIGNALS (additive):
- New external library/API integration: -10
- Schema migration coupled to UI in same bead: -15
- Browser verification required, no test harness: -10
- "and/also/plus" in title/AC suggesting two beads merged: -5

For EVERY penalty applied, record the exact phrase or absence that triggered it — a bare number is unfalsifiable.

For every bead < 95, propose SPECIFIC remediations: paste proposed schemas, enumerate exact files, name exact test cases. Sum projected penalty clearance; set wouldReach95=true if the sum brings score ≥ 95.

Return JSON:
{
  "epicId": "${e.id}",
  "scores": [
    {
      "beadId": "...",
      "title": "...",
      "score": <0-100>,
      "penalties": [{ "rule": "...", "amount": <n>, "evidence": "..." }],
      "remediations": ["<specific change>"],
      "wouldReach95": <bool>
    },
    ...
  ]
}

This is read-only: do NOT mutate any bead.
`, { label: `quality-${e.id}`, phase: 'Quality scoring', schema: qualityScoreSchema, agentType: 'general-purpose' }));

const qualityResults = (await parallel(qualityTasks)).filter(Boolean);
const scoredCount = qualityResults.flatMap(r => r.scores).length;
// A non-empty pour set that scored zero beads is the smbuild vacuous-pass bug:
// `every()` over an empty score set returns true, so the gate "passed" without
// scoring anything. Treat zero-scored-with-beads-present, or scoring fewer beads
// than exist, as a quality coverage gap that forces NEEDS-FIX.
const qualityVacuous = totalOpenNonEpic > 0 && scoredCount === 0;
const qualityUndercovered = scoredCount < totalOpenNonEpic;
log(`Quality scoring done: ${qualityResults.length} epics scored, ${scoredCount}/${totalOpenNonEpic} open non-epic beads scored, ${qualityResults.flatMap(r => r.scores).filter(s => s.score < 95).length} below 95${qualityVacuous ? ' [VACUOUS — no beads scored despite a non-empty pour set]' : qualityUndercovered ? ' [UNDER-COVERED — fewer beads scored than exist]' : ''}`);

// ---------------------------------------------------------------------------
// Phase 6 — Adversarial fidelity cross-check (2 verifiers + 1 reconcile)
// ---------------------------------------------------------------------------
phase('Fidelity cross-check');

const coverageSchema = {
  type: 'object',
  required: ['coverage', 'features', 'crossDeps', 'concernTrace'],
  properties: {
    coverage: { enum: ['complete', 'incomplete'] },
    features: { type: 'array' },
    crossDeps: { type: 'array' },
    concernTrace: {
      type: 'object',
      required: ['traceable', 'concerns'],
      properties: {
        traceable: { enum: ['complete', 'gap'] },
        concerns: { type: 'array' }
      }
    },
    note: { type: 'string' }
  }
};

const traceabilitySchema = {
  type: 'object',
  required: ['traceability', 'beads', 'drifted'],
  properties: {
    traceability: { enum: ['clean', 'drift'] },
    beads:    { type: 'array' },
    drifted:  { type: 'array' },
    note:     { type: 'string' }
  }
};

const mustHaveSchema = {
  type: 'object',
  required: ['traceable', 'matrix'],
  properties: {
    traceable: { enum: ['complete', 'gap', 'n/a'] },
    matrix:    { type: 'array' },   // [{ mustHave, status, features, beads }]
    note:      { type: 'string' }
  }
};

const fidelityResults = await parallel([
  // Verifier A: plan → dag
  () => agent(`
You are verifier A (plan → dag coverage) for /decompose Phase 6. (Self-contained: all instructions are inline below; you run in the app repo cwd, where the workflow spec is not present.)

INPUTS:
- Plan: read ${Context.planPath} (and ${Context.lockPath || 'plan.lock.json'} if planSource=lock).
- DAG snapshot: \`bd list --status=open --json\` to see current open beads.
- Cross-deps declared in plan: ${JSON.stringify(ParsedPlan.crossDeps)}

YOUR QUESTION: does every feature in plan.featureOrder have at least one open bead implementing it? Does every cross-feature dep in the plan map to a real \`bd dep\` edge?

For each plan feature, find the bead(s) that implement it by matching feature name to bead titles + descriptions. Be conservative — if you can't confidently map a feature to a bead, mark it as a gap.

For each cross-dep, run \`bd show <blockedId>\` (resolving names to IDs via Phase 3 pours) and check whether <blockerId> appears in its dependencies.

CONCERN TRACEABILITY (anti-rubber-stamp): if the plan is a lock (planSource=lock), read its \`concerns[]\` array. For EACH entry with \`status == "addressed"\`, classify its \`evidence\`:
- If the evidence cites a **feature** (it names or clearly maps to a \`featureOrder[].name\`), this is a falsifiable claim: assert that >=1 open bead implements that feature (reuse the same feature->bead mapping you did above). If a feature-cited "addressed" concern has NO implementing bead, that concern is a LIE the DAG exposes — mark it \`covered: false\` (a gap).
- If the evidence cites a **tenet** (e.g. "T7"), the **quality gate** (hooks/post-build-gate), a **DEFAULT_STACK pin**, or a **formula name** (not a feature), accept it as-is — those are always present; this is a weaker but honest check. Mark \`covered: true\`, \`evidenceKind\` accordingly.
- Concerns with \`status == "excluded"\` are not checked here (no claim to verify).
Set \`concernTrace.traceable = "gap"\` if ANY feature-cited addressed concern has no bead; else "complete". If planSource is not lock, return \`{ "traceable": "complete", "concerns": [] }\` (nothing to check).

You are INDEPENDENT — do NOT see verifier B's reasoning, do NOT see Phase 7's dep audit. Just answer your question.

Return JSON:
{
  "coverage": "complete" | "incomplete",
  "features": [{ "name": "...", "beads": ["..."], "status": "covered" | "gap" }, ...],
  "crossDeps": [{ "blocked": "...", "blocker": "...", "edgePresent": <bool> }, ...],
  "concernTrace": {
    "traceable": "complete" | "gap",
    "concerns": [{ "concernId": "...", "evidenceKind": "feature" | "tenet" | "gate" | "stack-pin" | "formula", "citedFeature": "<name | null>", "beads": ["..."], "covered": <bool> }, ...]
  },
  "note": "<one sentence summary>"
}
`, { label: 'verify-plan-to-dag', phase: 'Fidelity cross-check', schema: coverageSchema, agentType: 'general-purpose' }),

  // Verifier B: dag → plan
  () => agent(`
You are verifier B (dag → plan traceability) for /decompose Phase 6. (Self-contained: all instructions are inline below; you run in the app repo cwd, where the workflow spec is not present.)

INPUTS:
- Plan: read ${Context.planPath} (and ${Context.lockPath || 'plan.lock.json'} if planSource=lock).
- DAG snapshot: \`bd list --status=open --json\` filtered to non-epic beads.

YOUR QUESTION: does every bead in the DAG trace back to a plan feature? Flag any bead whose description/title doesn't clearly cite or derive from a plan section as a scope-drift candidate.

For each non-epic bead, attempt to identify the plan feature it derives from. A bead "traces" if either: (a) the bead description explicitly cites a plan section/feature, or (b) the bead title/description clearly maps to one named feature in plan.featureOrder.

You are INDEPENDENT — do NOT see verifier A's reasoning, do NOT see Phase 5's quality scores. Just answer your question.

Return JSON:
{
  "traceability": "clean" | "drift",
  "beads": [{ "id": "...", "title": "...", "citedFeature": "<name | null>" }, ...],
  "drifted": ["<beadId>", ...],
  "note": "<one sentence summary>"
}
`, { label: 'verify-dag-to-plan', phase: 'Fidelity cross-check', schema: traceabilitySchema, agentType: 'general-purpose' }),

  // Verifier C: vision must-have → dag (catches a must-have dropped during /vision
  // distillation — invisible to A/B, which only check plan↔DAG, never the lock's
  // mustHaves[]). A 12-must-have vision can otherwise ship as a faithful 9-feature
  // app with a green report.
  () => agent(`
You are verifier C (vision must-have → dag traceability) for /decompose Phase 6. (Self-contained: all instructions are inline below; you run in the app repo cwd, where the workflow spec is not present.)

INPUTS:
- planSource is "${Context.planSource}". If it is NOT "lock", you have no structured must-haves to trace — return { "traceable": "n/a", "matrix": [], "note": "md-only plan; no mustHaves[] to trace" } and stop.
- If planSource=lock: read ${Context.lockPath || 'plan.lock.json'}. Use its \`mustHaves[]\` array (the product must-haves /vision distilled) and, if present, \`coverage[]\` (vision's must-have→feature map).
- DAG snapshot: \`bd list --status=open --json\` (non-epic beads).

YOUR QUESTION: is every vision must-have realized by the DAG, or DELIBERATELY deferred? A must-have that silently dropped during /vision distillation — present in the product intent but absent from featureOrder, so no bead — is exactly what this catches.

For EACH entry in mustHaves[]:
1. Covering feature(s): use \`coverage[]\` if it maps this must-have to featureOrder entries; otherwise map semantically (must-have text → featureOrder[].name).
2. Implementing bead(s): match the covering feature name(s) to open bead titles/descriptions.
3. Classify status:
   - "covered": ≥1 open bead implements a covering feature.
   - "deferred": the lock EXPLICITLY marks this must-have deferred / out-of-v1 (a status or defer field, or a non-goal note naming it). A deliberate defer is acceptable.
   - "gap": neither covered nor deliberately deferred — a dropped must-have.
Be conservative: if you cannot confidently map a must-have to a bead AND it is not explicitly deferred, call it "gap".

Set traceable = "gap" if ANY must-have is a gap; else "complete". You are INDEPENDENT — do not see A's or B's reasoning.

Return JSON:
{
  "traceable": "complete" | "gap" | "n/a",
  "matrix": [{ "mustHave": "...", "status": "covered" | "deferred" | "gap", "features": ["..."], "beads": ["..."] }, ...],
  "note": "<one sentence summary>"
}
`, { label: 'verify-musthave-to-dag', phase: 'Fidelity cross-check', schema: mustHaveSchema, agentType: 'general-purpose' })
]);

const verifierA = fidelityResults[0];
const verifierB = fidelityResults[1];
const verifierC = fidelityResults[2];

// Reconcile bin — pure synthesis, can be inline JS rather than another agent.
// A feature-cited "addressed" concern with no implementing bead is a fidelity
// gap (bfo.9): it forces NEEDS-FIX exactly like coverage-gap. It is reported
// independently so the offending concern is named even when coverage/traceability
// also fail (the concern section in the report keys off concernGap, not the bin).
const concernGap = !!(verifierA && verifierA.concernTrace && verifierA.concernTrace.traceable === 'gap');
// A dropped must-have (in the vision, absent from the DAG, not deliberately
// deferred) forces NEEDS-FIX exactly like a coverage gap. "n/a" (md-only plan)
// and "complete" are both fine.
const mustHaveGap = !!(verifierC && verifierC.traceable === 'gap');
let fidelityBin;
if (!verifierA || !verifierB) {
  fidelityBin = 'disagree';
} else {
  const covOk = verifierA.coverage === 'complete';
  const traceOk = verifierB.traceability === 'clean';
  if (covOk && traceOk) {
    fidelityBin = concernGap ? 'concern-gap' : (mustHaveGap ? 'musthave-gap' : 'pass');
  } else if (!covOk && traceOk) {
    fidelityBin = 'coverage-gap';
  } else if (covOk && !traceOk) {
    fidelityBin = 'traceability-drift';
  } else {
    // Both directions failed. Conservatively report both-fail; the report shows
    // both verifier outputs verbatim and the human reads. (A true A-vs-B
    // disagreement is surfaced in the report's disagreement block.)
    fidelityBin = 'both-fail';
  }
}
const FidelityResult = { bin: fidelityBin, A: verifierA, B: verifierB, C: verifierC, concernGap, mustHaveGap, blockingForBlessed: fidelityBin !== 'pass' || concernGap || mustHaveGap };
log(`Fidelity verdict: ${fidelityBin}${concernGap && fidelityBin !== 'concern-gap' ? ' (+ concern-gap)' : ''}${mustHaveGap && fidelityBin !== 'musthave-gap' ? ' (+ musthave-gap)' : ''}`);

// ---------------------------------------------------------------------------
// Phase 7 — Dep audit (sequential, 1 agent)
// ---------------------------------------------------------------------------
phase('Dep audit');

const depAuditSchema = {
  type: 'object',
  required: ['cycles', 'emptyReady', 'implicitConflicts', 'crossDepsApplied', 'missingCrossDeps'],
  properties: {
    cycles:            { type: 'array' },
    emptyReady:        { type: 'boolean' },
    implicitConflicts: { type: 'array' },
    crossDepsApplied:  { type: 'array' },
    missingCrossDeps:  { type: 'array' }
  }
};

const DepAuditResult = await agent(`
You are the dep-audit agent for /decompose Phase 7. (Self-contained: all instructions are inline below; you run in the app repo cwd, where the workflow spec is not present.)

Steps:
1. \`bd dep cycles\` — capture any reported cycles. Empty list is good.
2. \`bd ready --json\` — filter out epics. emptyReady = (filtered list is empty).
3. Implicit conflict scan:
   - Get all open non-epic beads: \`bd list --status=open --json\` filtered.
   - For each pair (B1, B2): if neither depends on the other transitively (\`bd dep\` graph), AND their metadata.filesTouched arrays intersect (treat each entry as a glob; intersect if any pair string-equals OR matches via glob), surface { beadA, beadB, overlap: [<paths>] }.
   - Skip pairs where either bead has no filesTouched (they fall through to the post-merge gate in /build-batch).
4. Cross-dep verification: for each entry in ${JSON.stringify(ParsedPlan.crossDeps)}, resolve names → IDs (via Phase 3 pours) and check the edge exists. Surface missing edges.

Return JSON:
{
  "cycles": [<cycle paths>],
  "emptyReady": <bool>,
  "implicitConflicts": [{ "beadA": "...", "beadB": "...", "overlap": ["..."] }, ...],
  "crossDepsApplied": [{ "blocked": "...", "blocker": "...", "applied": <bool> }, ...],
  "missingCrossDeps": [...]
}
`, { label: 'dep-audit', phase: 'Dep audit', schema: depAuditSchema, agentType: 'general-purpose' });

log(`Dep audit: cycles=${(DepAuditResult?.cycles || []).length}, emptyReady=${DepAuditResult?.emptyReady}, implicitConflicts=${(DepAuditResult?.implicitConflicts || []).length}`);

// ---------------------------------------------------------------------------
// Phase 8 — Synthesis & verdict (sequential, 1 agent)
// ---------------------------------------------------------------------------
phase('Synthesis');

// Verdict computation — done in JS so it's mechanical and auditable.
// allBeadsAt95 alone is not enough: `every()` is vacuously true on an empty
// score set, so we also require the quality pass to have actually covered the
// open non-epic beads (qualityOk), else a zero-scored run would bless silently.
const allBeadsAt95 = qualityResults.every(r => r.scores.every(s => s.score >= 95));
const qualityOk = !qualityVacuous && !qualityUndercovered;
// An "addressed" concern that needs a dedicated enforcement bead but has no
// formula to pour from (bfo.10 / lbq.16) is an unenforced NFR — NEEDS-FIX, not
// a silent pass (T7). Enforcement-pour errors block too.
const concernEnforcementClean =
  (concernEnforcement.missingFormula || []).length === 0 &&
  (concernEnforcement.nfrMissingFormula || []).length === 0 &&
  (concernEnforcement.errors || []).length === 0;
const blessed =
  pourFailed.length === 0 &&
  AtomizeSummary.persistentlyOversized.length === 0 &&
  AtomizeSummary.unsplittable.length === 0 &&
  allBeadsAt95 &&
  qualityOk &&
  fidelityBin === 'pass' &&
  concernEnforcementClean &&
  (DepAuditResult?.cycles || []).length === 0 &&
  !DepAuditResult?.emptyReady;

const verdict = blessed ? 'BLESSED' : 'NEEDS-FIX';

const synthesisPayload = {
  appName: Context.appName,
  appEpicId: ParsedPlan.appEpicId,
  planSource: Context.planSource,
  dryRun: Context.dryRun,
  verdict,
  pours: { ok: pourOk, failed: pourFailed },
  concernEnforcement,
  atomize: AtomizeSummary,
  quality: qualityResults,
  fidelity: FidelityResult,
  depAudit: DepAuditResult
};

// Structured return so the orchestrator can read reportPath back. Without a
// schema the agent returns a bare string and reportResult.reportPath is always
// undefined → finalResult.reportPath stays null even though the file was written
// (the smbuild symptom). The schema forces the structured shape.
const reportSchema = {
  type: 'object',
  required: ['status', 'verdict'],
  properties: {
    status:         { enum: ['ok', 'failed'] },
    reportPath:     { type: ['string', 'null'] },
    verdict:        { type: 'string' },
    reportMarkdown: { type: 'string' }
  }
};

const reportResult = await agent(`
You are the write-report agent for /decompose Phase 8. (Self-contained: the report schema is inlined below — you run in the app repo cwd, where the workflow spec is not present, so do NOT try to read workflows/decompose.spec.md.)

INPUT (aggregated from prior phases):
${JSON.stringify(synthesisPayload, null, 2)}

Steps:
1. Generate the report markdown using EXACTLY this section structure (fill every section from the INPUT above):

\`\`\`markdown
# Decompose: <app-name> (<date>)

**Verdict:** <BLESSED | NEEDS-FIX>
**Plan source:** <plan.lock.json | plan.md (deprecation: rerun /vision)>
**Beads created:** <N> (<X> epics, <Y> tasks)
**App epic:** <id>
**Phases run:** preflight, parse-plan, pour (<N> features), atomize (<iterations> iters, <M> atomized), quality (<K> epics scored), fidelity (A+B+C+reconcile), dep-audit, synthesis

## Verdict reasoning
<one paragraph: why blessed, or what blocks it>

## Coverage (Phase 6.A — plan-to-dag)
- <feature name> → <beadId(s)> ✓
- <feature name> → **GAP** (no bead)
- Cross-feature deps applied: <count>
- Cross-feature deps missing: <list>

## Traceability (Phase 6.B — dag-to-plan)
- Beads with plan citation: <count>
- Drifted beads (no plan source): <list with beadIds and titles>

## Concern traceability (Phase 6.A — anti-rubber-stamp)
- <concernId> — addressed by feature "<name>" → <beadId(s)> ✓
- <concernId> — addressed by feature "<name>" → **GAP** (no bead implements it — the "addressed" claim has no teeth)
- <concernId> — addressed by tenet/gate/stack-pin/formula → accepted as-is
- <omit this section entirely if planSource is not lock or concerns[] is empty>

## Must-have traceability (Phase 6.C — vision → DAG)
<render fidelity.C.matrix as a table — one row per vision must-have:>
| Must-have | Status | Covering feature(s) | Bead(s) |
| --- | --- | --- | --- |
| <mustHave> | covered ✓ / deferred ⏸ / **GAP** | <features> | <beadIds> |
- <if any row is GAP: this must-have was in the vision but dropped during distillation — it has no bead and was not deliberately deferred. This forces NEEDS-FIX even when plan↔DAG coverage and traceability are otherwise clean.>
- <omit this section entirely if planSource is not lock (fidelity.C.traceable == "n/a") — an md-only plan has no structured mustHaves[] to trace>

## Fidelity verdict (Phase 6 reconcile)
- Bin: <pass | coverage-gap | traceability-drift | concern-gap | musthave-gap | both-fail | disagree>
- <if concernGap is true: name each feature-cited "addressed" concern that has no implementing bead — this forces NEEDS-FIX even when coverage and traceability are otherwise clean>
- <if mustHaveGap is true: name each vision must-have with status "gap" — this forces NEEDS-FIX>
- <if disagree: FIDELITY DISAGREEMENT block with both verifier outputs verbatim>

## Per-epic quality (Phase 5)
### <epicId> — <title>
- <beadId> — <title> — <score>/100 ✓
- <beadId> — <title> — <score>/100 ⚠
  - Penalties: <list with rule + evidence>
  - Remediations: <numbered list>
  - Projected after remediation: <score>/100

## Atomization (Phase 4)
- Iterations: <n>/3
- Atomized: <source → children list>
- Unsplittable (surfaced for human): <list with bead, attempted seams, reason>
- Persistently oversized after 3 iterations: <list>

## Pours (Phase 3)
- Successful: <N>
- Failed: <list with feature + error>

## Concern + NFR enforcement (Phase 3.5)
<render from concernEnforcement; omit the whole section if planSource != lock>
- Concern enforcement beads poured: <concernEnforcement.poured: concernId → formula → pourRoot>
- NFR enforcement beads poured: <concernEnforcement.nfrPoured: nfrId (category) → formula → pourRoot>
- Covered by an existing feature (no separate bead): <skippedCoveredByFeature>
- **MISSING FORMULA (forces NEEDS-FIX):** <missingFormula + nfrMissingFormula — each names the concern/NFR with no enforcement formula and the recommendedFormula that should exist. An unenforced NFR is a target that will never be tested or gated.>
- Errors: <errors>

## Dep audit (Phase 7)
- Cycles: <none | list>
- Ready set on launch: <count> non-epic beads
- Implicit conflicts (filesTouched overlap, no dep): <list>

## Next steps
<if BLESSED:>
The DAG is ready. To start the build:

    /build-batch --workers <suggested-N>

Suggested workers: <min(4, ready_count)>. Higher values yield diminishing returns once the merge queue dominates.

<if NEEDS-FIX:>
The DAG is not ready. Resolve in this order:
1. <highest-leverage fix from above — usually plan amendment or pour fix>
2. <next fix>
...

After fixes, re-run \`/decompose --no-file\` to preview the state, then \`/decompose\` to re-pour.
\`\`\`

2. Prefix the title with "(DRY RUN) " if synthesisPayload.dryRun is true; skip the "Next steps" section in that case.
3. Write the markdown to \`decomposeReport.md\` in cwd via the Write tool.
4. Return JSON: { "status": "ok", "reportPath": "decomposeReport.md", "verdict": "${verdict}" }.

If Write fails (disk full, permission), retry once. On second failure return:
{ "status": "failed", "verdict": "NEEDS-FIX", "reportPath": null, "reportMarkdown": "<the markdown body inlined>" }

The verdict is already computed — DO NOT recompute. Just render it.
`, { label: 'write-report', phase: 'Synthesis', schema: reportSchema, agentType: 'general-purpose' });

// Loud failure if the report could not be written (T7) — surface the inlined
// markdown so the work isn't silently lost.
if (!reportResult || reportResult.status !== 'ok' || !reportResult.reportPath) {
  log(`Report write did NOT succeed (status=${reportResult?.status ?? 'null'}). Inlined report below:\n${reportResult?.reportMarkdown || '<no markdown returned>'}`);
}

// ---------------------------------------------------------------------------
// Return final result to runtime
// ---------------------------------------------------------------------------
const finalResult = {
  verdict,
  reportPath: reportResult?.reportPath || null,
  appEpicId: ParsedPlan.appEpicId,
  beadCount: pourOk.reduce((n, r) => n + (r.children?.length || 0), 0),
  failedPhases: [
    pourFailed.length > 0 ? `pour (${pourFailed.length} failed)` : null,
    AtomizeSummary.unsplittable.length > 0 ? `atomize (${AtomizeSummary.unsplittable.length} unsplittable)` : null,
    AtomizeSummary.persistentlyOversized.length > 0 ? `atomize (${AtomizeSummary.persistentlyOversized.length} persistently oversized)` : null,
    qualityVacuous ? 'quality (no beads scored — vacuous pass)' : null,
    (!qualityVacuous && qualityUndercovered) ? `quality (only ${scoredCount}/${totalOpenNonEpic} beads scored)` : null,
    (qualityOk && !allBeadsAt95) ? 'quality (some beads < 95)' : null,
    fidelityBin !== 'pass' ? `fidelity (${fidelityBin})` : null,
    (DepAuditResult?.cycles || []).length > 0 ? 'dep-audit (cycles)' : null,
    DepAuditResult?.emptyReady ? 'dep-audit (empty ready set)' : null
  ].filter(Boolean)
};

log(`Decompose ${verdict} — ${finalResult.beadCount} beads, report=${finalResult.reportPath}`);
return finalResult;
