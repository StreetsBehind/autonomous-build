export const meta = {
  name: 'decompose',
  description: 'Turn plan.md + plan.lock.json into a blessed atomic bead DAG. Fans out pours per feature, reworks every bead to the 95 quality bar (split/wire/tighten), adversarially cross-checks DAG vs plan, audits topology, emits BLESSED|NEEDS-FIX verdict + decomposeReport.md. Subsumes /compose, /quality-pass, /split.',
  whenToUse: 'After /vision has produced plan.md + plan.lock.json in an app repo. Run before /build-batch; the report is a human-review gate between the two.',
  phases: [
    { title: 'Pre-flight',           detail: 'Verify plan, formulas, jankurai, repo state' },
    { title: 'Parse plan',           detail: 'Extract features + cross-deps; init beads + jankurai if fresh repo' },
    { title: 'Pour',                 detail: 'One agent per feature pours its formula(s) and writes step metadata' },
    { title: 'Quality rework',       detail: 'Score every bead (full rubric) then rework sub-95 beads (split/wire/tighten); loop to the 95 bar, up to 3 passes' },
    { title: 'Fidelity cross-check', detail: 'Three independent verifiers (plan→dag, dag→plan, must-have→dag) + reconciler' },
    { title: 'Dep audit',            detail: 'Cycles, ready-set sanity, implicit conflicts, cross-deps applied' },
    { title: 'Baseline',             detail: 'On BLESSED: accept scaffold jankurai baseline (loud auto-accept on --auto-bless)' },
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
  // phase: which build phase to decompose (epic 0ms). Default 1 — the only phase of a
  // single-phase plan, so the bare `/decompose` behaves exactly as before. --phase N>1
  // re-enters a repo that already holds prior (built, closed) phases and pours ONLY the
  // slice tagged for phase N under a dedicated phase epic (JIT per-phase decomposition).
  const out = { plan: 'plan.md', dryRun: false, autoBless: false, phase: 1 };
  if (!s) return out;
  const tokens = (typeof s === 'string') ? s.trim().split(/\s+/).filter(Boolean) : (Array.isArray(s) ? s : []);
  // 3ch: honor flags ONLY as a leading contiguous run — stop at the first non-flag
  // (prose) token. A headless/Workflow invocation passes a natural-language wrapper as
  // the args string; a literal `--no-file`/`--auto-bless` mentioned in that prose — even
  // inside a negation like "do NOT pass --no-file" — must NOT flip the mode bit. Real
  // callers (/orchestrate, the /decompose shell) pass flags as leading tokens, so this
  // is lossless for them while making accidental mid-prose flag tokens inert.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--plan' && tokens[i + 1]) { out.plan = tokens[++i]; }
    else if (tokens[i] === '--no-file') { out.dryRun = true; }
    // --auto-bless: opt-in. On a HIGH-confidence BLESSED (no advisory warnings),
    // signal auto-chain into /build-batch instead of stopping at the human gate.
    // Default (flag absent) keeps the human-review gate. (lbq.1)
    else if (tokens[i] === '--auto-bless') { out.autoBless = true; }
    else if (tokens[i] === '--phase' && tokens[i + 1]) { const n = parseInt(tokens[++i], 10); if (Number.isInteger(n) && n >= 1) out.phase = n; }
    else { break; } // first non-flag token ends flag parsing; the rest is prose, not flags
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
5. This run decomposes **phase ${parsedArgs.phase}** (epic 0ms; default 1 = the only phase of a single-phase plan). Run \`bd info\`.
   - If it ERRORS (no beads DB yet): set isFreshRepo=true. This is valid ONLY at phase 1. At phase > 1, fail with "no beads DB — phase ${parsedArgs.phase} re-entry needs phase 1 to have run first" (you cannot decompose a later phase onto a repo with no prior phases).
   - If it SUCCEEDS: set isFreshRepo=false, then run \`bd list --status=open --json\`.
     - At **phase 1**: a fresh app repo must have NO open beads — if the array is non-empty, fail with "repo already has open beads — /decompose phase 1 is for fresh app repos; for re-pour delete .beads/ first then rerun".
     - At **phase > 1**: prior built phases (now closed) and the umbrella app epic are EXPECTED — do NOT refuse on their presence (that is the whole point of re-entry). Refuse ONLY if THIS phase was already decomposed: look for an OPEN epic whose title starts with "Phase ${parsedArgs.phase}" (the phase epic this run would create). If such an epic already exists with open beads, fail with "phase ${parsedArgs.phase} already has open beads — it is already decomposed (resume the build, do not re-decompose)". Otherwise proceed.
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
const Context = { ...preflight.context, dryRun: parsedArgs.dryRun, phase: parsedArgs.phase };
log(`Pre-flight OK — app=${Context.appName}, planSource=${Context.planSource}, phase=${Context.phase}, isFreshRepo=${Context.isFreshRepo}, formulas=${Context.formulas.length}, dryRun=${Context.dryRun}`);

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
   - **Scope to phase ${Context.phase} (epic 0ms):** keep ONLY featureOrder[] entries whose \`phase\` equals ${Context.phase} (an entry with no \`phase\` field defaults to phase 1). This is the slice this run pours; a single-phase plan (no phase tags) at the default phase 1 keeps every feature, exactly as before. Keep a crossFeatureDependency only when BOTH endpoints are in this slice — an edge onto a prior, already-built phase is already satisfied, so drop it from pour-time wiring (do not fail on it). The returned \`features\`/\`crossDeps\` MUST contain only this phase's slice.
2. If Context.phase == 1 AND Context.isFreshRepo AND NOT Context.dryRun:
   a. \`bd init\`
   b. \`bd setup claude --project\`
   c. \`bd hooks install\`
   d. \`mkdir -p target/jankurai\`
   e. \`jankurai adopt . --profile auto --mode observe --out target/jankurai/adoption-plan.json --md target/jankurai/adoption-plan.md\`
   f. \`jankurai init . --level agents --yes\`
   g. \`jankurai audit . --mode advisory --json target/jankurai/repo-score.json --md target/jankurai/repo-score.md\`
   h. **Do NOT accept a baseline here (superseded by igu.2).** Step (g) only *measures* the scaffold score (advisory, into the gitignored \`target/jankurai/\`). lbq.14 used to auto-stamp that score as \`agent/baselines/main.repo-score.json\` and commit it *before* the verdict — freezing a never-blessed floor in exactly the unattended window, on runs that might be NEEDS-FIX. Baseline acceptance now rides the BLESSED verdict: the dedicated Baseline phase (Phase 8, after synthesis) accepts it only on a BLESSED run, after a human-review gate (attended) or with a loud trusted-by-policy note (\`--auto-bless\` walk-away). Leave \`target/jankurai/repo-score.json\` on disk for that phase; do not write or commit anything under \`agent/\` in this step.
   (At phase > 1 this whole step is skipped — the repo was bootstrapped + Jankurai-scaffolded by phase 1; do NOT re-init or re-scaffold.)
3. Create the epic this run's beads hang under (skip if Context.dryRun):
   - At **phase 1**: create the app-level epic \`bd create "${Context.appName}" --type=epic --priority=1 --description "See plan.md"\`. Capture the returned ID as appEpicId.
   - At **phase > 1**: the app-level umbrella epic already exists from phase 1 — find it (\`bd list --type=epic --json\`, the epic titled "${Context.appName}"). Create a PHASE epic under it: \`bd create "Phase ${Context.phase}: <short slice goal>" --type=epic --priority=1 --parent <appUmbrellaEpicId> --description "Phase ${Context.phase} slice — see plan.lock.json phases[]"\`. Set appEpicId to the PHASE epic's ID so this run's Phase-3 pours land under it, isolated from prior phases' (closed) beads.
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

// decompose-3 — pre-pour cycle check over the plan's cross-feature dependency
// edges. A crossDeps entry { blocked, blocker } means `blocked` depends on
// `blocker`; a cycle in that dependency graph can never be poured into an acyclic
// DAG, and was otherwise only caught by Phase 7's assertTopology AFTER a full
// pour + wiring pass had already mutated bd (a wasted run; fix is a /vision
// re-author). Catching it here fails fast, before any bd write — in dry-run too,
// since the edges come from the parsed plan, not the poured graph. Pure JS,
// mirrors assertTopology's colour-DFS; returns the cycle path (empty = acyclic).
// Scoped to cross-feature edges only: tier edges are acyclic by construction and
// formula-internal deps aren't known pre-pour.
function detectCrossDepCycle(crossDeps) {
  const adj = {};
  const nodes = new Set();
  for (const e of (Array.isArray(crossDeps) ? crossDeps : [])) {
    if (!e || typeof e.blocked !== 'string' || typeof e.blocker !== 'string') continue;
    nodes.add(e.blocked); nodes.add(e.blocker);
    (adj[e.blocked] = adj[e.blocked] || []).push(e.blocker);
  }
  const colour = {}; // undefined=unseen, 1=in-stack, 2=done
  const stack = [];
  let cyclePath = [];
  const dfs = (n) => {
    colour[n] = 1; stack.push(n);
    for (const d of (adj[n] || [])) {
      if (colour[d] === 1) { if (!cyclePath.length) cyclePath = [...stack.slice(stack.indexOf(d)), d]; return true; }
      if (colour[d] === undefined && dfs(d)) return true;
    }
    colour[n] = 2; stack.pop();
    return false;
  };
  for (const n of nodes) { if (colour[n] === undefined && dfs(n)) break; }
  return cyclePath;
}

const crossDepCycle = detectCrossDepCycle(ParsedPlan.crossDeps);
if (crossDepCycle.length) {
  log(`[PRE-POUR] crossFeatureDependencies cycle detected: ${crossDepCycle.join(' -> ')} — failing before any pour mutates bd`);
  return {
    verdict: 'NEEDS-FIX',
    phase: 'pre-pour-cycle-check',
    failedReason: `crossFeatureDependencies contains a dependency cycle: ${crossDepCycle.join(' -> ')}. A cyclic cross-feature dependency set can never be poured into an acyclic DAG — fix the plan's cross-feature deps and re-run /decompose.`,
    reportPath: null
  };
}

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
      - TRANSIENT-FAULT RETRY (decompose-4): pour agents run in PARALLEL, so a failure whose error text matches (case-insensitive) a transient store fault — "database is locked", "lock", "i/o timeout", "resource busy", "timeout", "connection reset" — is almost certainly jsonl/db contention from concurrent pours/checkouts, NOT a plan defect. Sleep a short JITTERED interval to avoid a thundering-herd retry (\`sleep $((2 + RANDOM % 3))\`, i.e. 2–4s) and retry the SAME command ONCE. Do NOT run \`bd doctor --fix\` here (it would itself contend with the other in-flight parallel pours). Only if the retry ALSO fails transiently do you fail the pour. Never retry a PERMANENT fault (see below) — re-running cannot fix a plan defect.
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

If \`bd mol pour\` fails with a PERMANENT cause — required-var error, off-enum / undeclared variable, formula-not-found, or formula validation — return status="failed" IMMEDIATELY with the error message preserved; do NOT retry (re-running cannot fix a plan defect — fail loudly so /vision fixes the plan). A TRANSIENT store fault gets the single jittered sleep-and-retry from step 2a first, and only fails if that retry also faults. Do NOT throw (T7).

Do NOT \`bd create\` outside \`bd mol pour\` (T6: formula precedence).
`, { label: `pour-${feature.name}`, phase: 'Pour', schema: pourSchema, agentType: 'general-purpose' }));

const pourResults = await parallel(pourTasks);
const pourOk = pourResults.filter(r => r && r.status === 'ok');
const pourFailed = pourResults.filter(r => !r || r.status === 'failed');
log(`Pour: ${pourOk.length}/${ParsedPlan.features.length} ok, ${pourFailed.length} failed`);

// Apply cross-feature deps sequentially (orchestrator does this, not an agent —
// it's pure resolve-name-to-id + one bd call per edge, and we want it
// serialized so concurrent bd writes don't race on the jsonl).
//
// featureToPourRoot is the AUTHORITATIVE feature-name → pour-root-ID map. It is
// computed once here and THREADED into Phase 6 (fidelity) and Phase 7 (dep audit).
// Downstream verifiers must NOT re-derive name→ID by title matching: molecule-epic
// titles are formula names ("crud-feature", "integration-http"), never feature
// names, so a title search always misses and reports edges absent even when they
// were wired (autonomous-build-3fr.3 — this was the run-2 "0/28 applied" false
// negative). crossDepWiring carries Phase 3's verified result forward so the report
// counts what Phase 3 actually wired, not what a title-guessing re-derivation found.
const featureToPourRoot = {};
for (const r of pourOk) {
  if (r.pourRoot) featureToPourRoot[r.feature] = r.pourRoot;
}
let crossDepWiring = { verifiedPresent: 0, attempted: 0, verified: [], missing: [], skipped: [], errors: [] };
if (!Context.dryRun && ParsedPlan.crossDeps.length > 0) {
  const crossDepSchema = {
    type: 'object',
    required: ['attempted', 'verifiedPresent', 'verified', 'missing', 'skipped', 'errors'],
    properties: {
      attempted:       { type: 'number' },
      verifiedPresent: { type: 'number' },
      verified: { type: 'array', items: { type: 'object' } },
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
4. VERIFY the edge is present — do NOT trust the add's exit code. Run \`bd show <blockedId> --json\` and confirm <blockerId> appears in its dependency/blocked-by list (try \`bd dep show <blockedId>\` as a fallback if the JSON shape is unclear). Only if the edge is confirmed present do you count it toward "verifiedPresent" AND record it under "verified" as { "blocked": "<name>", "blocker": "<name>", "blockedId": "...", "blockerId": "..." } — this resolved list is the authoritative input Phase 6/7 reuse to avoid re-resolving by title, so always include the IDs you actually wired. If add succeeded but verification shows the edge absent (the smbuild failure mode — likely a pourRoot-vs-molecule-epic ID mismatch), retry the add once with the molecule-epic IDs you can see in \`bd list --status=open --json\`; if still absent, record it under "missing" with the resolved IDs and what you observed.
5. Capture any command errors under "errors".

Report the VERIFIED-PRESENT count, never the attempted count, as the headline. Return JSON:
{ "attempted": <n>, "verifiedPresent": <n>, "verified": [{ "blocked": "...", "blocker": "...", "blockedId": "...", "blockerId": "..." }], "missing": [{ "edge": {...}, "blockedId": "...", "blockerId": "...", "observed": "..." }], "skipped": [{ "edge": {...}, "reason": "..." }], "errors": [{ "edge": {...}, "msg": "..." }] }
`, { label: 'wire-cross-deps', phase: 'Pour', schema: crossDepSchema, agentType: 'general-purpose' });
  crossDepWiring = {
    verifiedPresent: depAgent?.verifiedPresent ?? 0,
    attempted:       depAgent?.attempted ?? 0,
    verified:        depAgent?.verified || [],
    missing:         depAgent?.missing || [],
    skipped:         depAgent?.skipped || [],
    errors:          depAgent?.errors || []
  };
  log(`Cross-deps wired: ${crossDepWiring.verifiedPresent}/${crossDepWiring.attempted} verified present, ${crossDepWiring.missing.length} missing, ${crossDepWiring.errors.length} errors`);
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
let concernEnforcement = { poured: [], missingFormula: [], skippedCoveredByFeature: [], errors: [], nfrPoured: [], nfrMissingFormula: [], floorPoured: [], floorMissingFormula: [], floorApplies: null };
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
      nfrMissingFormula:       { type: 'array', items: { type: 'object' } },
      floorApplies:            { type: 'object' },                        // { declaresAuth, declaresData }
      floorPoured:             { type: 'array', items: { type: 'object' } },
      floorMissingFormula:     { type: 'array', items: { type: 'object' } },
      successMetricBead:       { type: ['object', 'null'] },              // { formula, pourRoot } | null
      successMetricMissingFormula: { type: ['object', 'null'] }           // { steps, recommendedFormula } | null
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

FINALLY, the MANDATORY PRODUCTION FLOOR (lbq.8 — production-readiness is not opt-in per-feature). Today only the app skeleton is always poured; auth/authz/observability/audit/IaC enter only if a product must-have happens to map to them, so a real app ships without them. Enforce a floor:
8. Determine what the app DECLARES from the lock: \`declaresData\` = \`dataModel[]\` is non-empty; \`declaresAuth\` = \`stack.auth\` is present OR a \`concerns[]\` authn/authz entry is \`addressed\` OR any must-have implies user accounts / per-user data.
9. The floor (each item applies only under its condition):
   - declaresData → **observability**, **audit-log**, **iac-deploy** (a data-backed app must be observable, auditable, and deployable).
   - declaresAuth → additionally **authz** (access-control enforcement) and **abuse-surface** (input-validation / rate-limit on any exposed surface).
   For EACH applicable floor item: if it is ALREADY realized — an \`addressed\` concern poured above, or a product feature whose bead covers it — record nothing (no double-pour). Otherwise pour its enforcement formula (same formula-selection + var-validation rules as above): record under "floorPoured" ({floorItem, formula, pourRoot, acSummary}). If NO installed formula fits → record under "floorMissingFormula" ({floorItem, recommendedFormula}) — DO NOT hand-create (T6). A missing floor formula is a mandatory-floor gap (NEEDS-FIX), not a silent pass.
   If neither declaresData nor declaresAuth (a genuinely stateless, no-auth tool), the floor is empty — record floorApplies and move on.

FINALLY, the SUCCESS-METRIC E2E ACCEPTANCE BEAD (lbq.17). The lock's \`successMetric.steps[]\` is the user's ONE definition of done — the cross-feature journey. Today it has no bead and is never verified as a path. Pour exactly ONE end-to-end acceptance bead:
10. If \`successMetric.steps[]\` is non-empty: select an e2e/integration-test formula (the one whose purpose is a cross-feature end-to-end journey test). Bind the ordered \`steps[]\` as the journey the test walks — each step becomes an assertion in the test's acceptance/testPlan. Reparent the pour root under ${ParsedPlan.appEpicId} and cite "success metric" in its description. Record under "successMetricBead" ({formula, pourRoot, stepCount}). If NO e2e formula fits → record "successMetricMissingFormula" ({steps, recommendedFormula: "<one-line description, e.g. e2e-acceptance: walks the success-metric journey end-to-end asserting each step>"}) — DO NOT hand-create (T6). If \`successMetric.steps[]\` is empty, set successMetricBead = null (nothing to verify).

Return JSON:
{
  "poured": [{ "concernId": "...", "formula": "...", "pourRoot": "...", "acSummary": "..." }, ...],
  "missingFormula": [{ "concernId": "...", "evidence": "...", "recommendedFormula": "..." }, ...],
  "skippedCoveredByFeature": [{ "concernId": "...", "feature": "..." }, ...],
  "errors": [{ "concernId": "...", "msg": "..." }, ...],
  "nfrPoured": [{ "nfrId": "...", "category": "...", "formula": "...", "pourRoot": "...", "acSummary": "..." }, ...],
  "nfrMissingFormula": [{ "nfrId": "...", "category": "...", "statement": "...", "target": "...", "recommendedFormula": "..." }, ...],
  "floorApplies": { "declaresAuth": <bool>, "declaresData": <bool> },
  "floorPoured": [{ "floorItem": "...", "formula": "...", "pourRoot": "...", "acSummary": "..." }, ...],
  "floorMissingFormula": [{ "floorItem": "...", "recommendedFormula": "..." }, ...],
  "successMetricBead": { "formula": "...", "pourRoot": "...", "stepCount": <n> } | null,
  "successMetricMissingFormula": { "steps": [...], "recommendedFormula": "..." } | null
}
`, { label: 'concern-enforcement', phase: 'Concern enforcement', schema: ceSchema, agentType: 'general-purpose' });
  concernEnforcement = ce || concernEnforcement;
  // normalize the optional arrays so downstream gate logic never NPEs
  concernEnforcement.nfrPoured = concernEnforcement.nfrPoured || [];
  concernEnforcement.nfrMissingFormula = concernEnforcement.nfrMissingFormula || [];
  concernEnforcement.floorPoured = concernEnforcement.floorPoured || [];
  concernEnforcement.floorMissingFormula = concernEnforcement.floorMissingFormula || [];
  concernEnforcement.successMetricBead = concernEnforcement.successMetricBead || null;
  concernEnforcement.successMetricMissingFormula = concernEnforcement.successMetricMissingFormula || null;
  log(`Concern+NFR+floor enforcement: ${concernEnforcement.poured.length} concern-poured, ${concernEnforcement.nfrPoured.length} nfr-poured, ${concernEnforcement.floorPoured.length} floor-poured, ${concernEnforcement.missingFormula.length + concernEnforcement.nfrMissingFormula.length + concernEnforcement.floorMissingFormula.length} missing-formula, ${concernEnforcement.skippedCoveredByFeature.length} covered-by-feature, ${concernEnforcement.errors.length} errors`);
  log(`Success-metric e2e bead: ${concernEnforcement.successMetricBead ? concernEnforcement.successMetricBead.pourRoot : (concernEnforcement.successMetricMissingFormula ? 'MISSING FORMULA (NEEDS-FIX)' : 'none (no steps)')}`);
  if (concernEnforcement.floorApplies) log(`Production floor: declaresAuth=${concernEnforcement.floorApplies.declaresAuth}, declaresData=${concernEnforcement.floorApplies.declaresData}`);
}

// ---------------------------------------------------------------------------
// Phase 4+5 — Quality-rework loop (Layer 2, epic autonomous-build-onv.3)
// ---------------------------------------------------------------------------
// Replaces the old read-only `Atomize(4) + Quality(5)` pair with ONE closed
// rework-to-bar loop. The old flow scored with the FULL rubric but bailed
// read-only (emitting remediations + wouldReach95 nobody applied), while the
// only mutating phase (atomize) ran FIRST with a NARROWER sizing rubric — so
// monoliths the full rubric flagged were never split and sub-95 beads were
// never reworked. Now each pass SCORES (full rubric) then REWORKS the sub-95
// beads by applying THAT bead's own remediations (split / wire / tighten),
// re-discovering + re-scoring the mutated set on the next pass, up to MAX_REWORK.
//
// Downstream contracts preserved EXACTLY (verdict + report read these):
//   - qualityResults / scoredCount / qualityVacuous / qualityUndercovered /
//     totalOpenNonEpic — the FINAL pass's values, same shapes as before.
//   - AtomizeSummary { iterations, atomized, unsplittable, persistentlyOversized }
//     populated from the loop's TERMINAL state.
const MAX_REWORK = 3;

// Schemas (shared across passes).
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

const reworkSchema = {
  type: 'object',
  required: ['beadId', 'action'],
  properties: {
    beadId:      { type: 'string' },
    action:      { enum: ['split', 'tighten', 'wire', 'unreworkable'] },
    newChildren: { type: 'array', items: { type: 'object' } },   // only on split
    seam:        { type: 'string' },                              // only on split
    attempted:   { type: 'array', items: { type: 'string' } },    // only on unreworkable (seams tried)
    reason:      { type: 'string' }                               // unreworkable / context
  }
};

// Helper: discover the scoring-epic set + ground-truth open-non-epic count.
// CRITICAL: pours create app-epic → molecule-root-epic → task; the rework loop
// ALSO splits beads (creating new ones, closing old ones), so this MUST re-run at
// the start of every pass over the freshly-mutated DB — a naive "app epic's direct
// children" scan misses molecule-root epics (how smbuild scored zero beads and
// passed vacuously). (Self-contained: no external spec needed.)
const discoverEpics = (pass) => agent(`
Discover the scoring-epic set for /decompose Quality-rework pass ${pass}.

Context: app epic = ${ParsedPlan.appEpicId}. Pour roots from Phase 3 (the molecule-root epics, reparented under the app epic): ${JSON.stringify(pourOk.map(r => r.pourRoot).filter(Boolean))}.

Steps:
1. Run \`bd list --status=open --json\`. Split into epics (issue_type=="epic") and non-epics. (This reflects any beads SPLIT in a prior rework pass — new children are open, superseded sources are closed — so always re-read live; do not assume the Phase-3 pour set.)
2. Set totalOpenNonEpic = count of open non-epic beads. This is the GROUND TRUTH the orchestrator uses to detect under-scoring — it must be exact.
3. Return the set of "scoring epics" = every open epic that DIRECTLY parents at least one open non-epic bead (check each epic via \`bd list --parent <id> --status=open --json\`, or by reading parent links in the snapshot). This deliberately includes molecule-root epics AND any deeper sub-epics that directly parent tasks — do not stop at the app epic's direct children. If the app epic itself directly parents non-epic beads, include it too.
4. Sanity check: if totalOpenNonEpic > 0 but you found zero scoring epics, re-examine the parent links — every open non-epic bead has SOME parent epic, so a non-empty pour set must yield at least one scoring epic. Return what you actually find; the orchestrator cross-checks against totalOpenNonEpic.

Return JSON: { "epics": [{ "id": "...", "title": "..." }, ...], "totalOpenNonEpic": <n> }
`, { label: `epic-discovery-pass${pass}`, phase: 'Quality rework', schema: epicDiscoverySchema, agentType: 'general-purpose' });

// Helper: score every open child of one epic with the FULL rubric (read-only).
const scoreEpic = (e, pass) => agent(`
You are the quality-score agent for /decompose Quality-rework pass ${pass}, epic=${e.id}. (Self-contained: all instructions are inline below; you run in the app repo cwd, where the workflow spec is not present.)

For every open child of epic ${e.id} (\`bd list --parent ${e.id} --status=open --json\`), apply the FULL /quality-pass rubric. Start each bead at 100, floor at 0, apply ALL applicable penalties:

SIZING:
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

For every bead < 95, propose SPECIFIC remediations: paste proposed schemas, enumerate exact files, name exact test cases. The rework pass applies these, so they must be actionable. Sum projected penalty clearance; set wouldReach95=true if the sum brings score ≥ 95.

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
`, { label: `quality-${e.id}-pass${pass}`, phase: 'Quality rework', schema: qualityScoreSchema, agentType: 'general-purpose' });

phase('Quality rework');

// Terminal-state accumulators for AtomizeSummary (populated by the rework passes).
const atomizedAccum = [];        // every split performed { source, status:'atomized', children, seam }
const unsplittableAccum = [];    // beads the rework tried to split but couldn't seam
let reworkPassesRun = 0;

// Final-pass quality state (overwritten each pass; the LAST pass's values are the
// contract values the verdict reads). Declared with `let` so the loop can reassign.
let qualityResults = [];
let scoredCount = 0;
let totalOpenNonEpic = 0;
let qualityVacuous = false;
let qualityUndercovered = false;

for (let pass = 1; pass <= MAX_REWORK; pass++) {
  reworkPassesRun = pass;

  // (1) Re-discover the epic/bead set from bd. Splits in a prior pass mutate the
  //     set (new children open, sources closed), so this is MANDATORY before scoring.
  const epicDiscovery = await discoverEpics(pass);
  const epics = epicDiscovery?.epics || [];
  totalOpenNonEpic = epicDiscovery?.totalOpenNonEpic ?? 0;

  // (2) Score every open non-epic bead, per-epic, FULL rubric (read-only).
  qualityResults = (await parallel(epics.map((e) => () => scoreEpic(e, pass)))).filter(Boolean);
  scoredCount = qualityResults.flatMap(r => r.scores).length;
  // A non-empty pour set that scored zero beads is the smbuild vacuous-pass bug:
  // `every()` over an empty score set returns true, so the gate "passed" without
  // scoring anything. Treat zero-scored-with-beads-present, or scoring fewer beads
  // than exist, as a quality coverage gap that forces NEEDS-FIX.
  qualityVacuous = totalOpenNonEpic > 0 && scoredCount === 0;
  qualityUndercovered = scoredCount < totalOpenNonEpic;

  const allScores = qualityResults.flatMap(r => r.scores);
  const subBar = allScores.filter(s => s.score < 95);
  log(`Quality rework pass ${pass}/${MAX_REWORK}: ${qualityResults.length} epics scored, ${scoredCount}/${totalOpenNonEpic} open non-epic beads scored, ${subBar.length} below 95${qualityVacuous ? ' [VACUOUS — no beads scored despite a non-empty pour set]' : qualityUndercovered ? ' [UNDER-COVERED — fewer beads scored than exist]' : ''}`);

  // (3) Stop if every bead clears the bar (and the pass actually scored something).
  if (subBar.length === 0 && !qualityVacuous) {
    log(`Quality rework: all beads >= 95 on pass ${pass}; loop done.`);
    break;
  }

  // (4) Dry run: read-only — score once, report the sub-95 set, do NOT mutate.
  if (Context.dryRun) {
    log(`Quality rework: dry run — scored only, no rework applied (${subBar.length} beads would be reworked).`);
    break;
  }

  // (5) Last pass: do not rework again (nothing would re-score it). Beads still
  //     <95 stay in qualityResults with their real score → allBeadsAt95=false →
  //     NEEDS-FIX, the correct terminal signal. Don't loop forever; don't fake 95s.
  if (pass === MAX_REWORK) {
    log(`Quality rework: ${subBar.length} bead(s) still < 95 after the final pass ${pass}/${MAX_REWORK} — left as the NEEDS-FIX signal.`);
    break;
  }

  // (6) Rework the sub-95 beads in PARALLEL — one agent per bead, each applying
  //     THAT bead's own remediations (split / wire / tighten) per the rubric class.
  log(`Quality rework pass ${pass}: reworking ${subBar.length} sub-95 bead(s)`);
  const reworkTasks = subBar.map((s) => () => agent(`
You are the quality-rework agent for /decompose Quality-rework pass ${pass}, bead=${s.beadId}. (Self-contained: all instructions are inline below; you run in the app repo cwd, where the workflow spec is not present.)

This bead scored ${s.score}/100 on the FULL quality rubric. Bring it to the 95 bar by applying ITS OWN remediations — pick the ONE action that resolves the dominant penalties. Do NOT add new scope (T4): only make the EXISTING intent concrete; never invent features, ACs, or files the bead did not already imply.

Bead score + penalties + remediations to apply:
${JSON.stringify(s, null, 2)}

Context: ${JSON.stringify(Context, null, 2)}

Choose the action from the penalty classes present:

A. OVERSIZED / MONOLITH — penalties from SIZING (ACs > 6, Files > 5, cross-layer reach > 2). SPLIT along a clean seam:
   1. \`bd show ${s.beadId} --json\` — capture title, ACs (parse Acceptance section), labels, priority, metadata (testPlanFile, testPlanCases, filesTouched), incoming deps, outgoing deps, parent epic.
   2. Identify the seam. Try in this order; first match wins:
      - Cross-layer: description spans {UI, API, DB} AND ACs partition cleanly → seam="API boundary" or "schema vs app code"
      - Per-entity: title is a list ("Habits, Goals, Streaks CRUD") → seam="per-entity"
      - Read-vs-write: ACs split between reads (GET, list) and writes (POST, update, delete) → seam="read path vs write path"
      - Happy-vs-edge: ACs split between happy-path and explicit edge-cases → seam="happy path vs edge cases"
   3. If no seam fits (ACs straddle every candidate): return { "beadId": "${s.beadId}", "action": "unreworkable", "attempted": [<seams tried>], "reason": "no clean seam — <one sentence>" }. Do NOT invent a seam (T1).
   4. Propose N children:
      - Title = source title + seam term (e.g. "Habits CRUD (DB+API)" + "Habits CRUD (UI)").
      - ACs partitioned along the seam — each source AC lands in EXACTLY one child. NO new ACs (T4).
      - filesTouched partitioned — child ownership sets MUST be disjoint.
      - Dep mode: sequential (UI consumes API) OR parallel (independent subsystems).
   5. Re-audit each proposed child against the SAME sizing rubric. If any child still scores < 95 on SIZING, return { "action": "unreworkable", "attempted": [<seam>], "reason": "seam still produces oversized children" }. Do NOT retry with another seam in this run — that's the next pass's job.
   6. Mutate:
      - \`bd create\` each child with --parent=<parentEpic>, --labels=<source labels comma-joined>, --priority=<source priority>, --body-file=<tmp.json>.
      - Write filesTouched (and testPlanFile/testPlanCases per the source) metadata to each child.
      - Rewire deps (sequential: \`bd dep add child[i+1] child[i]\`; preserve incoming blockers on first; preserve outgoing dependents on last. parallel: all children get all incoming + all outgoing).
      - Close source: \`bd close ${s.beadId} --reason "superseded by <new-ids joined>"\`.
   7. Return { "beadId": "${s.beadId}", "action": "split", "seam": "<used seam>", "newChildren": [{ "id": "...", "title": "...", "score": <n> }, ...] }.

B. DEPENDENCY-GRAPH MISMATCH — the "Dependency-graph mismatch" penalty (bead asserts "after X" / "depends on X" in its text but no \`bd dep\` edge exists). WIRE the missing edge:
   1. From the bead description and the remediation, identify the blocker bead it should depend on (resolve the named prior bead/feature to a bead ID via \`bd list --status=open --json\` — match by title/feature).
   2. \`bd dep add ${s.beadId} <blockerId>\` (this bead is blocked, the named one is the blocker). VERIFY the edge landed via \`bd show ${s.beadId} --json\` — do NOT trust the exit code; retry once if absent.
   3. If the asserted dependency is spurious (the text says "after X" but X is not a real bead / the order is wrong), instead EDIT the description to drop the false ordering claim (\`bd update ${s.beadId}\`). Do NOT fabricate a dep edge to a bead that should not block it (T1).
   4. Return { "beadId": "${s.beadId}", "action": "wire", "reason": "<edge added: ${s.beadId} -> <blockerId>, or false-ordering claim removed>" }.

C. VAGUE / UNDERSPEC — SPEC-CONCRETENESS or CONTEXT-COMPLETENESS penalties (vague AC, missing file paths, missing API contract, missing testPlanFile, undefined domain terms, open questions/TBD). TIGHTEN IN PLACE — make the EXISTING intent concrete, add NO new scope (T4):
   1. \`bd show ${s.beadId} --json\` — read the current description/acceptance + metadata.
   2. Apply the remediations: rewrite vague ACs into testable assertions WITH thresholds; add the exact file paths the bead already implies; paste the request/response shape for any endpoint it already names; resolve "TBD"/open questions to a concrete decision consistent with the plan; define undefined domain terms inline. Do NOT add a NEW acceptance criterion or a NEW file the bead did not already imply — only concretize what is there.
   3. \`bd update ${s.beadId}\` the description/acceptance accordingly. Write metadata for any missing fields the remediation names: \`bd update ${s.beadId} --metadata "@<tmp.json>"\` with testPlanFile, testPlanCases, filesTouched (derived from the now-concrete ACs/files).
   4. Return { "beadId": "${s.beadId}", "action": "tighten", "reason": "<one-sentence summary of what was concretized>" }.

If the bead carries penalties from MULTIPLE classes, prefer A (split) when SIZING penalties dominate (an oversized bead can't be tightened to the bar); otherwise apply C (tighten) and fold any dep-wire from B into the same run. If you genuinely cannot bring this bead to 95 by any of A/B/C (e.g. it needs a plan amendment or a formula that does not exist), return { "beadId": "${s.beadId}", "action": "unreworkable", "reason": "<why — names the missing plan/formula input>" }. Do NOT throw (T7); do NOT fabricate a passing state.

Return JSON matching: { "beadId": "${s.beadId}", "action": "split"|"tighten"|"wire"|"unreworkable", "newChildren"?: [...], "seam"?: "...", "attempted"?: [...], "reason"?: "..." }
`, { label: `rework-${s.beadId}-pass${pass}`, phase: 'Quality rework', schema: reworkSchema, agentType: 'general-purpose' }));

  const waveResults = (await parallel(reworkTasks)).filter(Boolean);
  let nSplit = 0, nTighten = 0, nWire = 0, nUnreworkable = 0;
  for (const r of waveResults) {
    if (!r) continue;
    if (r.action === 'split') {
      nSplit++;
      // Normalize into the legacy atomize shape so AtomizeSummary.atomized is unchanged.
      atomizedAccum.push({ source: r.beadId, status: 'atomized', children: r.newChildren || [], seam: r.seam });
    } else if (r.action === 'unreworkable') {
      nUnreworkable++;
      unsplittableAccum.push({ source: r.beadId, status: 'unsplittable', attempted: r.attempted || [], reason: r.reason });
    } else if (r.action === 'wire') {
      nWire++;
    } else if (r.action === 'tighten') {
      nTighten++;
    }
  }
  log(`Quality rework pass ${pass}: ${nSplit} split, ${nTighten} tightened, ${nWire} wired, ${nUnreworkable} unreworkable — re-scoring next pass`);
}

// AtomizeSummary — built from the loop's TERMINAL state so the verdict (which gates
// on persistentlyOversized.length===0 && unsplittable.length===0) is UNCHANGED:
//   - atomized              = all splits performed across passes
//   - unsplittable          = beads the rework tried to split but couldn't seam (action 'unreworkable')
//   - persistentlyOversized = beads STILL scoring <95 on SIZING penalties after the final pass
//                             (the final qualityResults is the terminal scored set)
const SIZING_RULE_RX = /size|acs?\b|acceptance|file|cross-?layer|testplancases|oversiz|monolith/i;
const persistentlyOversized = qualityResults
  .flatMap(r => r.scores)
  .filter(s => s.score < 95 && Array.isArray(s.penalties)
    && s.penalties.some(p => SIZING_RULE_RX.test(typeof p === 'string' ? p : (p && (p.rule || p.evidence) || ''))))
  .map(s => ({ id: s.beadId, title: s.title, score: s.score, penalties: s.penalties }));

const AtomizeSummary = {
  iterations: reworkPassesRun,
  atomized: atomizedAccum,
  unsplittable: unsplittableAccum,
  persistentlyOversized
};
log(`Quality rework done: ${reworkPassesRun} pass(es) — ${AtomizeSummary.atomized.length} atomized, ${AtomizeSummary.unsplittable.length} unsplittable, ${AtomizeSummary.persistentlyOversized.length} persistently oversized; final scored=${scoredCount}/${totalOpenNonEpic}, ${qualityResults.flatMap(r => r.scores).filter(s => s.score < 95).length} below 95`);

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
- Phase 3 feature-name → pour-root-ID map (AUTHORITATIVE — resolve feature names to bead IDs with THIS, never by title; molecule-epic titles are formula names like "crud-feature"/"integration-http", not feature names): ${JSON.stringify(featureToPourRoot)}
- This run is **phase ${Context.phase}** (epic 0ms). Verify coverage ONLY for THIS phase's slice — the features poured this run: ${JSON.stringify(ParsedPlan.features.map((f) => f.name))}. A featureOrder[] entry tagged for a LATER phase (\`phase\` > ${Context.phase}) is not poured yet by design (JIT per-phase decomposition) — do NOT flag it as a gap. (An untagged feature defaults to phase 1.)

YOUR QUESTION: does every feature in THIS phase's slice (listed above) have at least one open bead implementing it? Does every cross-feature dep within this slice map to a real \`bd dep\` edge?

For each plan feature, find the bead(s) that implement it: the pour-root in the map above IS that feature's molecule epic, so the feature is covered by that root and its children. A feature absent from the map never poured — mark it a gap. (Only fall back to title/description matching for a feature with no map entry.)

For each cross-dep, resolve both endpoint names to bead IDs via the map above. A name absent from the map means that feature never poured — mark edgePresent:false (real coverage gap), do NOT title-search for it. For resolved pairs, run \`bd show <blockedId> --json\` and check whether <blockerId> appears in its dependency/blocked-by list.

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

This run is **phase ${Context.phase}** (epic 0ms). Each mustHaves[] entry carries a \`phase\` (default 1).

For EACH entry in mustHaves[]:
1. Determine its phase = the entry's \`phase\` field (an entry with no \`phase\` defaults to 1).
2. Covering feature(s): use \`coverage[]\` if it maps this must-have to featureOrder entries; otherwise map semantically (must-have text → featureOrder[].name).
3. Implementing bead(s): match the covering feature name(s) to open bead titles/descriptions.
4. Classify status:
   - If the must-have's phase > ${Context.phase} (a FUTURE phase): "deferred" — its beads do not exist yet BY DESIGN (JIT per-phase decomposition). A future-phase must-have is a deliberate deferral, NOT a gap.
   - If the must-have's phase < ${Context.phase} (a PRIOR, already-built phase): "covered" — it was realized in an earlier phase's build; out of scope for this slice (do not flag).
   - If the must-have's phase == ${Context.phase} (THIS phase): "covered" iff ≥1 open bead implements a covering feature; else "gap".
   - Also "deferred" if the lock EXPLICITLY marks this must-have deferred / out-of-v1 (a defer field or a non-goal note naming it).
Be conservative: a THIS-phase must-have you cannot confidently map to a bead AND that is not explicitly deferred is a "gap".

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

// ea1: reconcile verifier C's conservative must-have gaps against the AUTHORITATIVE
// featureToPourRoot map + verifier A's proven feature coverage. C is independent and
// string-matches must-have→bead, so when a covering feature poured an epic whose children
// are named by implementation detail (not the must-have's wording) it flags a FALSE gap.
// But A already proved feature→pour-root; a must-have whose covering feature poured a real
// root IS covered by that root + its children. Downgrade those rows to "covered" and
// recompute C's verdict, so a demonstrably-covered must-have can't force a false NEEDS-FIX.
// We keep adversarial independence for the plan↔dag direction — this only credits the
// must-have→bead inheritance A already computed. Pure (no workflow globals) so
// tests/decompose/reconcile-musthave.test.mjs can exercise it.
function reconcileMustHaveGaps(verifierA, verifierC, featureToPourRoot) {
  const out = { matrix: [], traceable: verifierC && verifierC.traceable, credits: [] };
  if (!verifierC || !Array.isArray(verifierC.matrix)) return out;
  const poured = Object.keys(featureToPourRoot || {});
  // C may truncate/extend the exact featureOrder name; match exact, then bidirectional
  // containment against a feature that actually poured a root.
  const matchPoured = (name) => {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    return poured.find((key) => { const kn = key.trim().toLowerCase(); return kn === n || kn.includes(n) || n.includes(kn); }) || null;
  };
  const aCovered = new Set(
    ((verifierA && Array.isArray(verifierA.features)) ? verifierA.features : [])
      .filter((f) => f && f.status === 'covered' && Array.isArray(f.beads) && f.beads.length)
      .map((f) => String(f.name || '').trim().toLowerCase())
  );
  out.matrix = verifierC.matrix.map((row) => {
    if (!row || row.status !== 'gap') return row;
    const feats = Array.isArray(row.features) ? row.features : [];
    let creditedFeature = null, rootKey = null;
    for (const fn of feats) {
      const k = matchPoured(fn);
      if (k) { creditedFeature = fn; rootKey = k; break; }
      if (aCovered.has(String(fn || '').trim().toLowerCase())) { creditedFeature = fn; break; }
    }
    if (!creditedFeature) return row; // genuine gap — no covering feature poured a root
    const rootId = rootKey ? featureToPourRoot[rootKey] : null;
    out.credits.push({ mustHave: row.mustHave, feature: creditedFeature, root: rootId });
    const beads = rootId ? [rootId, ...(Array.isArray(row.beads) ? row.beads : [])] : (Array.isArray(row.beads) ? row.beads : []);
    return { ...row, status: 'covered', beads, reconciled: true, reconcileNote: `covered via poured feature "${creditedFeature}"${rootId ? ` (root ${rootId})` : ''}` };
  });
  if (out.traceable === 'gap') {
    out.traceable = out.matrix.some((r) => r && r.status === 'gap') ? 'gap' : 'complete';
  }
  return out;
}

// Reconcile bin — pure synthesis, can be inline JS rather than another agent.
// A feature-cited "addressed" concern with no implementing bead is a fidelity
// gap (bfo.9): it forces NEEDS-FIX exactly like coverage-gap. It is reported
// independently so the offending concern is named even when coverage/traceability
// also fail (the concern section in the report keys off concernGap, not the bin).
const concernGap = !!(verifierA && verifierA.concernTrace && verifierA.concernTrace.traceable === 'gap');
// A dropped must-have (in the vision, absent from the DAG, not deliberately deferred)
// forces NEEDS-FIX exactly like a coverage gap — but only AFTER reconciling C against the
// authoritative feature→pour-root map (ea1). "n/a" (md-only plan) and "complete" pass.
const cReconciled = reconcileMustHaveGaps(verifierA, verifierC, featureToPourRoot);
if (verifierC) { verifierC.matrix = cReconciled.matrix; verifierC.traceable = cReconciled.traceable; }
if (cReconciled.credits.length) {
  log(`Fidelity reconcile (ea1): credited ${cReconciled.credits.length} must-have(s) whose covering feature poured a root — ${cReconciled.credits.map((m) => `${m.mustHave} → ${m.feature}`).join('; ')}`);
}
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
// Tier-ordering wiring (Layer 2, epic autonomous-build-onv) — wire bead-level
// foundational -> platform -> feature -> enforcement ordering edges so a feature
// bead can't land in `bd ready` ahead of the scaffold/floor it depends on. This
// is the generate half of the three-layer enforcement; the deterministic topology
// assertion (below, in Phase 7) is the assert half.
// ---------------------------------------------------------------------------

// SYNC: mirrors deriveFeatureTier in workflows/vision.js (FEATURE_TIERS + TIER_RULES + tierOfFormula).
// Keep the mapping in lockstep — /vision stamps `tier` into the lock from the SAME rules; this is the
// fallback derivation for old locks with no `tier`, and the resolver decompose uses to group pours.
const FEATURE_TIERS = ['foundational', 'platform', 'feature', 'enforcement'];
const TIER_RULES = {
  foundational: ['app-skeleton', 'otel-bootstrap', 'otel', 'observability'],
  platform: ['tenant-boot', 'oidc-client', 'oidc', 'openfga', 'authz', 'authn', 'audit-chain',
             'terraform', 'iac', 'migration', 'composer-grammar', 'secrets'],
  // feature is the DEFAULT (anything unmatched); enforcement is the suffix/substring check below.
};
function tierOfFormula(name) {
  const n = (typeof name === 'string') ? name.toLowerCase() : '';
  if (!n) return 'feature';
  // enforcement checked first per-formula (a formula whose name screams enforcement is enforcement),
  // but the entry-level min in deriveFeatureTier still demotes it under any more-foundational sibling.
  if (n.includes('concern-enforcement') || n.includes('e2e-acceptance') || n.endsWith('-acceptance')) return 'enforcement';
  if (TIER_RULES.foundational.some((p) => n.includes(p))) return 'foundational';
  if (TIER_RULES.platform.some((p) => n.includes(p))) return 'platform';
  return 'feature';
}
// deriveFeatureTier(formulas): most-foundational tier (min over FEATURE_TIERS) among the entry's formulas.
function deriveFeatureTier(formulas) {
  const list = (Array.isArray(formulas) ? formulas : []).filter((f) => typeof f === 'string' && f.trim());
  if (!list.length) return 'feature';
  let best = FEATURE_TIERS.length - 1; // most-derived = enforcement
  for (const f of list) {
    const idx = FEATURE_TIERS.indexOf(tierOfFormula(f));
    if (idx >= 0 && idx < best) best = idx;
  }
  return FEATURE_TIERS[best];
}
// tierOf(featureName): the lock's `tier` is authoritative (present on locks from the updated /vision);
// otherwise derive from the feature entry's formula picks. Defaults to 'feature' for an unknown name.
const featureByName = {};
for (const f of (ParsedPlan.features || [])) { if (f && f.name) featureByName[f.name] = f; }
function tierOf(featureName) {
  const f = featureByName[featureName];
  if (f && FEATURE_TIERS.includes(f.tier)) return f.tier;          // lock tier authoritative
  if (f) return deriveFeatureTier(f.formulas);                     // fallback: derive from formulas
  return 'feature';
}

// Group the poured features by tier (FEATURE_TIERS order). Each entry: { tier, pourRoot, children:[beadId] }.
// pourOk[].children is [{ id, title, metadata }] (Phase 3 snapshot) — the tier-wiring agent re-reads live
// children from bd, but we capture the snapshot ids here too so beadId->tier covers them as a floor.
const tieredEpics = pourOk
  .filter((r) => r.pourRoot)
  .map((r) => ({ tier: tierOf(r.feature), pourRoot: r.pourRoot, feature: r.feature,
                 children: (r.children || []).map((c) => (c && c.id) ? c.id : c).filter(Boolean) }));
const tiersPresent = FEATURE_TIERS.filter((t) => tieredEpics.some((e) => e.tier === t));
log(`Tier grouping: ${tieredEpics.length} epics across ${tiersPresent.length} non-empty tiers (${tiersPresent.join(' < ') || 'none'})`);

// beadId -> tier, computed in JS from tieredEpics (pourRoot epic + its snapshot children share the
// feature's tier). Passed into the tier-wiring agent AND the dep-audit agent so each open bead can be
// labelled by its epic's tier without re-deriving. The dep-audit agent extends this over live children.
const beadTierMap = {};
for (const e of tieredEpics) {
  beadTierMap[e.pourRoot] = e.tier;
  for (const id of e.children) beadTierMap[id] = e.tier;
}

let TierWiring = { skipped: true, reason: null, wired: [], verified: 0, attempted: 0, missing: [], errors: [], tiers: tiersPresent };
if (Context.dryRun || tiersPresent.length < 2) {
  TierWiring.reason = Context.dryRun ? 'dry run — no mutation' : `only ${tiersPresent.length} non-empty tier(s) — no cross-tier edges to wire`;
  log(`Tier-ordering wiring: SKIPPED (${TierWiring.reason})`);
} else {
  const tierWiringSchema = {
    type: 'object',
    required: ['wired', 'verified', 'attempted', 'missing', 'errors'],
    properties: {
      wired:     { type: 'array', items: { type: 'object' } },   // [{ blocked, blocker }]
      verified:  { type: 'number' },
      attempted: { type: 'number' },
      missing:   { type: 'array', items: { type: 'object' } },
      errors:    { type: 'array', items: { type: 'object' } }
    }
  };
  const tierWiringAgent = await agent(`
You are the tier-ordering wiring agent for /decompose (Layer 2, epic autonomous-build-onv). You wire bead-level dependency edges so that a HIGHER-tier epic's entry beads depend on each LOWER-tier epic's terminal beads — materializing the foundational -> platform -> feature -> enforcement build order as actual \`bd dep\` edges (epics gate by parent-child, NOT dependency, so the order must be a per-BEAD edge to actually block readiness). (Self-contained: all instructions are inline; you run in the app repo cwd, where the workflow spec is not present.)

The epics, grouped by tier (ordered most- to least-foundational; only NON-EMPTY tiers, already in build order):
${JSON.stringify(tieredEpics.map((e) => ({ tier: e.tier, pourRoot: e.pourRoot, feature: e.feature })), null, 2)}

Non-empty tiers in build order: ${JSON.stringify(tiersPresent)}

STEP 1 — For EACH epic above, compute its ENTRY beads and TERMINAL beads from the LIVE DB:
  a. List that epic's OPEN non-epic children: \`bd list --parent <pourRoot> --status=open --json\` (these are the SIBLING children — the only beads whose intra-epic edges matter here).
  b. For each child, \`bd show <child> --json\` and read its dependency/blocked-by edges, RESTRICTED to other SIBLING children of the same epic (ignore edges to beads outside this epic).
  c. ENTRY beads = sibling children that do NOT depend on any sibling child (nothing in-epic blocks them). TERMINAL beads = sibling children that NO sibling child depends on (nothing in-epic waits on them). A singleton child (no intra-epic edges) is BOTH an entry and a terminal. An epic with no open children contributes neither.

STEP 2 — For each CONSECUTIVE non-empty tier pair (Lower tier L immediately before Higher tier H in the build order above): for EVERY entry bead E of EVERY epic in H, and EVERY terminal bead Tm of EVERY epic in L, add the edge "E depends on Tm":
  a. \`bd dep add <E> <Tm>\` (E is blocked, Tm is the blocker). SERIALIZE these writes — run them one at a time, never in parallel, so concurrent bd writes don't race on the jsonl. Increment "attempted" per edge you attempt.
  b. VERIFY the edge actually landed — do NOT trust the add's exit code. \`bd show <E> --json\` and confirm <Tm> appears in E's dependency/blocked-by list (\`bd dep show <E>\` is a fallback if the JSON shape is unclear). Only a CONFIRMED edge counts toward "verified" and goes into "wired" as { "blocked": "<E>", "blocker": "<Tm>" }.
  c. If the add reports success but verification shows the edge absent, retry the add ONCE; if still absent, record under "missing" as { "blocked": "<E>", "blocker": "<Tm>", "observed": "<what bd show returned>" }.
  d. Any command error → record under "errors" as { "edge": { "blocked": "<E>", "blocker": "<Tm>" }, "msg": "<error>" }. Do NOT throw (T7).

Wire ONLY consecutive tier pairs — the transitive chain (foundational -> platform -> feature -> enforcement) is materialized link by link; do NOT also wire foundational->feature directly (it's implied transitively and would just add redundant edges).

Return JSON:
{ "wired": [{ "blocked": "<E>", "blocker": "<Tm>" }, ...], "verified": <n>, "attempted": <n>, "missing": [{ "blocked": "...", "blocker": "...", "observed": "..." }, ...], "errors": [{ "edge": {...}, "msg": "..." }, ...] }
`, { label: 'tier-ordering-wiring', phase: 'Dep audit', schema: tierWiringSchema, agentType: 'general-purpose' });
  TierWiring = {
    skipped: false,
    reason: null,
    wired:     tierWiringAgent?.wired || [],
    verified:  tierWiringAgent?.verified ?? 0,
    attempted: tierWiringAgent?.attempted ?? 0,
    missing:   tierWiringAgent?.missing || [],
    errors:    tierWiringAgent?.errors || [],
    tiers:     tiersPresent
  };
  log(`Tier-ordering wiring: ${TierWiring.verified}/${TierWiring.attempted} cross-tier edges verified present, ${TierWiring.missing.length} missing, ${TierWiring.errors.length} errors (tiers ${tiersPresent.join(' < ')})`);
}

// ---------------------------------------------------------------------------
// Phase 7 — Dep audit (sequential, 1 agent)
// ---------------------------------------------------------------------------
phase('Dep audit');

const depAuditSchema = {
  type: 'object',
  required: ['cycles', 'emptyReady', 'implicitConflicts', 'crossDepsApplied', 'missingCrossDeps', 'beadGraph'],
  properties: {
    cycles:            { type: 'array' },
    emptyReady:        { type: 'boolean' },
    implicitConflicts: { type: 'array' },
    crossDepsApplied:  { type: 'array' },
    missingCrossDeps:  { type: 'array' },
    beadGraph: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'tier', 'deps'],
        properties: {
          id:   { type: 'string' },
          tier: { enum: ['foundational', 'platform', 'feature', 'enforcement', 'unknown'] },
          deps: { type: 'array', items: { type: 'string' } }
        }
      }
    }
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
4. Cross-dep verification: for each entry in ${JSON.stringify(ParsedPlan.crossDeps)}, resolve both endpoint names to bead IDs using this AUTHORITATIVE Phase 3 name→pour-root map: ${JSON.stringify(featureToPourRoot)} — do NOT resolve by title (molecule-epic titles are formula names like "crud-feature"/"integration-http", never feature names, so a title search always misses). A name absent from the map = that feature never poured; mark its edges applied:false. For resolved pairs, confirm the edge via \`bd show <blockedId> --json\`. Phase 3 already wired + verified these edges: ${JSON.stringify(crossDepWiring.verified)} — surface under missingCrossDeps only edges genuinely absent from the live DB, not edges you merely failed to resolve by title.
5. BEAD GRAPH (topology assertion input — the orchestrator runs a deterministic pure-JS check over this, so it must be COMPLETE and ACCURATE). For EVERY open NON-epic bead (\`bd list --status=open --json\` filtered to issue_type != "epic"), emit one row { "id", "tier", "deps" }:
   - "deps" = the bead IDs THIS bead directly depends on (its blockers — what must finish first). Read from \`bd show <id> --json\` (dependency/blocked-by edges) or the snapshot's dependency edges. List ONLY direct deps (not transitive), and ONLY deps that are themselves open non-epic beads (drop edges to epics or closed beads). Empty array if it depends on nothing.
   - "tier" = the bead's build-order tier. Use this beadId→tier map computed by the orchestrator from the poured epics: ${JSON.stringify(beadTierMap)}. If the bead's id is a key, use that tier. If it is NOT in the map (e.g. a bead created by Phase 4 atomize or a Phase 3.5 enforcement/floor pour), find its parent epic (\`bd show <id> --json\` → parent) and inherit the tier of that epic from the same map (the epic's pourRoot is a map key); for a Phase 3.5 enforcement/floor/e2e bead whose epic is the app epic or otherwise unmapped, label it "enforcement" if its title/description reads as a concern/floor/e2e-acceptance enforcement bead, else "unknown". Never guess a tier that contradicts the map.
   Cover ALL open non-epic beads — the orchestrator cross-checks this against the live bead count.

Return JSON:
{
  "cycles": [<cycle paths>],
  "emptyReady": <bool>,
  "implicitConflicts": [{ "beadA": "...", "beadB": "...", "overlap": ["..."] }, ...],
  "crossDepsApplied": [{ "blocked": "...", "blocker": "...", "applied": <bool> }, ...],
  "missingCrossDeps": [...],
  "beadGraph": [{ "id": "...", "tier": "foundational|platform|feature|enforcement|unknown", "deps": ["<beadId>", ...] }, ...]
}
`, { label: 'dep-audit', phase: 'Dep audit', schema: depAuditSchema, agentType: 'general-purpose' });

log(`Dep audit: cycles=${(DepAuditResult?.cycles || []).length}, emptyReady=${DepAuditResult?.emptyReady}, implicitConflicts=${(DepAuditResult?.implicitConflicts || []).length}`);

// ---------------------------------------------------------------------------
// Topology assertion (Layer 2, epic autonomous-build-onv — the ASSERT half).
// Deterministic, pure-JS gate over the beadGraph the dep-audit agent gathered:
// no LLM judgement, no bd/fs/shell here. Builds adjacency from beadGraph and
// requires (1) acyclic, (2) tier-monotonic (a bead only depends on its own tier
// or lower), (3) every non-foundational bead transitively reaches a foundational
// bead, (4) the initial ready set (zero-dep beads) ⊆ foundational tier. Any
// violation → topologyValid=false → blocks BLESSED. A dry run / skip leaves the
// graph empty, so topologyValid stays undefined and never spuriously fails.
// ---------------------------------------------------------------------------
function assertTopology(beadGraph, tiersSeen) {
  const nodes = Array.isArray(beadGraph) ? beadGraph.filter((n) => n && typeof n.id === 'string') : [];
  const tierIndex = (t) => FEATURE_TIERS.indexOf(t); // -1 for 'unknown'/absent
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  const adj = {};      // id -> [dep ids that exist as nodes]
  for (const n of nodes) {
    adj[n.id] = (Array.isArray(n.deps) ? n.deps : []).filter((d) => typeof d === 'string' && byId[d]);
  }
  const hasFoundation = (Array.isArray(tiersSeen) ? tiersSeen : []).includes('foundational')
    || nodes.some((n) => n.tier === 'foundational');

  // (1) acyclic — DFS with colour marks.
  let acyclic = true;
  const cyclePath = [];
  const colour = {}; // 0=unseen,1=in-stack,2=done
  const stack = [];
  const dfs = (id) => {
    colour[id] = 1; stack.push(id);
    for (const d of adj[id] || []) {
      if (colour[d] === 1) { acyclic = false; if (!cyclePath.length) cyclePath.push(...stack.slice(stack.indexOf(d)), d); return; }
      if (colour[d] === undefined && dfs(d)) return true;
      if (!acyclic) return true;
    }
    colour[id] = 2; stack.pop();
    return false;
  };
  for (const n of nodes) { if (colour[n.id] === undefined) { if (dfs(n.id)) break; } }

  // (2) tier-monotonic — every edge A->B with both tiers known requires tierIndex(A) >= tierIndex(B).
  const tierViolations = [];
  for (const n of nodes) {
    const ai = tierIndex(n.tier);
    if (ai < 0) continue; // unknown source tier — can't assert
    for (const d of adj[n.id]) {
      const bi = tierIndex(byId[d].tier);
      if (bi < 0) continue; // unknown dep tier — can't assert
      if (ai < bi) tierViolations.push({ bead: n.id, beadTier: n.tier, dep: d, depTier: byId[d].tier });
    }
  }

  // (3) reachesFoundation — only meaningful if a foundational tier exists. Every non-foundational
  //     bead must have a transitive dep path into SOME foundational bead.
  const orphans = [];
  if (hasFoundation) {
    const reaches = {}; // memoized: id -> reaches a foundational bead transitively
    const reach = (id, seen) => {
      if (reaches[id] !== undefined) return reaches[id];
      if (seen.has(id)) return false; // cycle guard
      seen.add(id);
      let r = false;
      for (const d of adj[id] || []) {
        if (byId[d].tier === 'foundational') { r = true; break; }
        if (reach(d, seen)) { r = true; break; }
      }
      seen.delete(id);
      reaches[id] = r;
      return r;
    };
    for (const n of nodes) {
      if (n.tier === 'foundational') continue;
      if (!reach(n.id, new Set())) orphans.push({ bead: n.id, tier: n.tier });
    }
  }

  // (4) initialReadyOk — the zero-dep beads (the would-be initial `bd ready` set) must be
  //     foundational-only when a foundational tier exists.
  const initialViolations = [];
  let initialReadyOk = true;
  if (hasFoundation) {
    for (const n of nodes) {
      if ((adj[n.id] || []).length === 0 && n.tier !== 'foundational') {
        initialViolations.push({ bead: n.id, tier: n.tier });
      }
    }
    initialReadyOk = initialViolations.length === 0;
  }

  const topologyValid = acyclic && tierViolations.length === 0 && initialReadyOk && orphans.length === 0;
  return {
    nodeCount: nodes.length,
    hasFoundation,
    acyclic,
    cyclePath,
    tierMonotonic: tierViolations.length === 0,
    tierViolations,
    reachesFoundation: orphans.length === 0,
    orphans,
    initialReadyOk,
    initialViolations,
    topologyValid
  };
}

const topology = assertTopology(DepAuditResult?.beadGraph || [], tiersPresent);
if (DepAuditResult) {
  DepAuditResult.topologyValid = topology.topologyValid;
  DepAuditResult.topologyViolations = {
    cyclePath: topology.cyclePath,
    tierViolations: topology.tierViolations,
    orphans: topology.orphans,
    initialViolations: topology.initialViolations
  };
}
log(`Topology assertion: valid=${topology.topologyValid} (${topology.nodeCount} beads, foundation=${topology.hasFoundation}) — acyclic=${topology.acyclic}, tierMonotonic=${topology.tierMonotonic} (${topology.tierViolations.length} viol), reachesFoundation=${topology.reachesFoundation} (${topology.orphans.length} orphans), initialReadyOk=${topology.initialReadyOk} (${topology.initialViolations.length} viol)`);

// ---------------------------------------------------------------------------
// Phase 8 — Synthesis & verdict (verdict + autoChain in JS, then the Baseline
// phase, then the write-report agent under the Synthesis phase).
// ---------------------------------------------------------------------------

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
  (concernEnforcement.floorMissingFormula || []).length === 0 &&
  !concernEnforcement.successMetricMissingFormula &&   // the definition of done must be an executable test (lbq.17)
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
  !DepAuditResult?.emptyReady &&
  // Layer 2 topology assertion (onv): an explicit `false` (a real topology
  // violation — cycle, tier inversion, orphan, or a non-foundational bead in the
  // initial ready set) blocks BLESSED. `!== false` so a dryRun/skip (where the
  // beadGraph is empty and topologyValid is undefined) does not spuriously fail.
  (DepAuditResult?.topologyValid !== false);

const verdict = blessed ? 'BLESSED' : 'NEEDS-FIX';

// ---------------------------------------------------------------------------
// Confidence + auto-chain (lbq.1) — computed BEFORE baseline acceptance + the
// report so both can see whether this is an attended run or an --auto-bless
// walk-away. BLESSED is mechanical; "high confidence" additionally means zero
// advisory warnings (no implicit filesTouched conflicts, no missing cross-dep
// edges). A BLESSED-with-advisories never auto-chains even under --auto-bless —
// the human-review gate stays the DEFAULT; --auto-bless is the opt-in that lets
// a clean BLESSED flow straight into the build. decompose does NOT spawn
// /build-batch itself (no recursive workflow nesting) — it emits the signal.
// ---------------------------------------------------------------------------
const advisoryWarnings =
  (DepAuditResult?.implicitConflicts || []).length +
  (DepAuditResult?.missingCrossDeps || []).length +
  // tier-ordering edges that were attempted but didn't land (advisory: the
  // topology assertion below is the BLOCKING check; an un-landed tier edge that
  // matters shows up there as a tier/initial-ready violation, so this is just a
  // "glance at the wiring" nudge on an otherwise-BLESSED run).
  (TierWiring?.missing || []).length +
  (TierWiring?.errors || []).length;
const confidence = !blessed ? 'n/a' : (advisoryWarnings === 0 ? 'high' : 'review-recommended');
const autoChain = parsedArgs.autoBless && confidence === 'high' && !Context.dryRun;
// beadCount proxies the ready non-epic beads at launch; the worker count is a hint.
const blessedBeadCount = pourOk.reduce((n, r) => n + (r.children?.length || 0), 0);
const suggestedWorkers = Math.min(4, Math.max(1, blessedBeadCount || 1));
const suggestedBuildBatch = `/build-batch --workers ${suggestedWorkers}`;

// ---------------------------------------------------------------------------
// Baseline acceptance (igu.2, supersedes lbq.14 / D2 + rule 7).
// The Jankurai regression ratchet in hooks/post-build-gate.{sh,ps1} only fires
// when agent/baselines/main.repo-score.json exists. We accept the scaffold's
// whole-repo audit as that baseline — but ONLY on a BLESSED verdict (a never-
// blessed floor was the lbq.14 bug) and ONLY when not a dry run. On the attended
// path the human blesses the floor by reviewing decomposeReport.md before running
// /build-batch; on the --auto-bless walk-away path (autoChain) we auto-accept and
// record a conspicuous "trusted-by-policy, not by human" note, because a never-
// accepted baseline means a ratchet that never fires in exactly the unattended
// window we are trying to protect.
// ---------------------------------------------------------------------------
phase('Baseline');

const baselineSchema = {
  type: 'object',
  required: ['status', 'accepted'],
  properties: {
    status:          { enum: ['ok', 'failed'] },
    accepted:        { type: 'boolean' },
    baselineScore:   { type: ['number', 'null'] },
    trustedByPolicy: { type: 'boolean' },
    policyWritten:   { type: 'boolean' },
    note:            { type: ['string', 'null'] },
    failedReason:    { type: ['string', 'null'] }
  }
};

// Baseline is a phase-1 (fresh-repo) operation (epic 0ms): phase 1 scaffolds the repo and accepts the
// starting floor; later phases ride that same baseline (the gate's high-water re-stamp moves it up during
// builds), so re-accepting at phase > 1 would re-stamp a mid-build floor — skip it.
let baselineResult = {
  status: 'ok',
  accepted: false,
  baselineScore: null,
  trustedByPolicy: false,
  policyWritten: false,
  note: (blessed && Context.phase > 1) ? `phase ${Context.phase} — baseline already accepted at phase 1; not re-accepted` : null,
  failedReason: blessed ? (Context.dryRun ? 'dry run — no baseline written' : null) : 'verdict NEEDS-FIX — no baseline accepted'
};

if (blessed && !Context.dryRun && Context.phase === 1) {
  baselineResult = await agent(`
You are the baseline-acceptance agent for /decompose Phase 8. You run ONLY on a BLESSED verdict. (Self-contained: all instructions are inline; you run in the app repo cwd, where the workflow spec is not present — do NOT try to read workflows/decompose.spec.md.)

Context:
- App: ${Context.appName}
- Path: ${autoChain
    ? 'WALK-AWAY (--auto-bless, high-confidence BLESSED). NO human will read decomposeReport.md before this baseline becomes the regression-ratchet floor.'
    : 'ATTENDED. A human reviews decomposeReport.md and blesses the floor by choosing to run /build-batch; this run does not auto-chain.'}

Goal: accept the scaffold's whole-repo Jankurai audit as agent/baselines/main.repo-score.json — the trusted starting floor the build must not regress below. This happens AFTER the BLESSED verdict (superseding lbq.14, which froze a never-blessed floor before the verdict).

Steps:
1. \`mkdir -p agent/baselines target/jankurai\`.
2. Capture a fresh WHOLE-REPO audit straight to the baseline path:
   \`jankurai audit . --json agent/baselines/main.repo-score.json --md target/jankurai/repo-score.md\`
   This is a full audit (NOT --changed-fast). Its EXIT CODE may be nonzero on a sub-85 scaffold — that is EXPECTED and is NOT a failure here; you only need the receipt on disk.
3. Validate the receipt: it must parse as JSON and have a numeric top-level \`score\` field. If it is \`{}\` or has no numeric score, that is the bug lbq.14 warned about — return { "status": "failed", "accepted": false, "failedReason": "baseline audit produced no parseable score" }. Capture the numeric score as baselineScore.
4. Write the tracking policy from \`jankurai govern\` (documentation only — JANKURAI_GATING_PROPOSAL rule 9: the gate's BLOCK decision reads only the ratchet and IGNORES this floor, so the 85 minimum_score never blocks in v1):
   a. \`jankurai govern . --out target/jankurai/govern-policy.json\` (govern emits JSON).
   b. Read that JSON and translate its recommended policy into \`agent/audit-policy.toml\` as valid TOML, with this exact header comment block then the keys from the govern JSON (minimum_score, fail_on, advisory_on, and the exception timebox days from exception_policy.timebox_days):
\`\`\`toml
# agent/audit-policy.toml — derived from \`jankurai govern\` at /decompose (igu.2).
# TRACKING / DOCUMENTATION ONLY. The post-build gate's BLOCK decision reads only
# the ratchet (score_delta / new_hard_findings / new_caps) and IGNORES this
# minimum_score floor (docs/JANKURAI_GATING_PROPOSAL.md rule 9). Do NOT wire the
# floor into the gate without revisiting that decision — a flat 85 floor deadlocks
# a sub-85 scaffold (the lbq.14 / witness trap).
minimum_score = <govern.minimum_score>
fail_on = [<govern.fail_on quoted>]
advisory_on = [<govern.advisory_on quoted>]
exception_timebox_days = <govern.exception_policy.timebox_days>
\`\`\`
   c. If \`jankurai govern\` is unavailable or errors, SKIP the policy (set policyWritten=false) — it is non-blocking. Otherwise set policyWritten=true.
5. .gitignore care: the tracked artifacts under \`agent/\` must NOT be swallowed, while \`target/jankurai/\` (generated receipts) MUST stay ignored. Ensure cwd \`.gitignore\` ignores \`target/\` (or at minimum \`target/jankurai/\`). If any pattern would ignore \`agent/\` (e.g. a broad \`agent\` or \`*/\` rule), add an explicit negation (\`!agent/\`, \`!agent/baselines/\`, \`!agent/audit-policy.toml\`). VERIFY with git: \`git check-ignore agent/baselines/main.repo-score.json agent/audit-policy.toml\` must report NEITHER as ignored, and \`git check-ignore target/jankurai/repo-score.md\` MUST report it ignored. Fix .gitignore until both hold.
6. Commit the tracked baseline artifacts in their OWN commit, staging EXPLICITLY (never \`git add -A\`/\`--all\`):
   \`git add agent/baselines/main.repo-score.json .gitignore\` (and \`git add agent/audit-policy.toml\` if written).
   Commit message depends on the path:
   ${autoChain ? `   WALK-AWAY path — use a HEREDOC body and the loud marker:
       chore: accept jankurai baseline [TRUSTED-BY-POLICY, NOT BY HUMAN]

       Auto-accepted on the --auto-bless walk-away path: NO human read
       decomposeReport.md before this score-<N> whole-repo baseline became the
       regression-ratchet floor for the build. Trusted by policy, not by review.
       Re-inspect agent/baselines/main.repo-score.json if this run is later audited.
   Set note to "[TRUSTED-BY-POLICY, NOT BY HUMAN] baseline auto-accepted at score <N> on the --auto-bless walk-away path" and trustedByPolicy=true.`
    : `   ATTENDED path:
       chore: accept initial jankurai baseline (blessed at decompose)

       Whole-repo scaffold score <N> accepted as the regression-ratchet starting
       floor. Blessed via the /decompose human-review gate (verdict BLESSED): the
       human blesses this floor by reviewing decomposeReport.md before /build-batch.
   Set note to null and trustedByPolicy=false.`}
   If the commit fails (no git identity / nothing staged), do NOT crash — set accepted=true only if the file exists; capture the git error in failedReason but still return status "ok" with accepted reflecting whether agent/baselines/main.repo-score.json is on disk (a written-but-uncommitted baseline is still better than none).
7. Return: { "status": "ok", "accepted": true, "baselineScore": <N>, "trustedByPolicy": ${autoChain}, "policyWritten": <bool>, "note": <string|null>, "failedReason": <string|null> }.

On an unrecoverable error (audit unparseable per step 3): return { "status": "failed", "accepted": false, "failedReason": "<message>" }. Do not swallow exceptions (T7).
`, { label: 'accept-baseline', phase: 'Baseline', schema: baselineSchema, agentType: 'general-purpose' });
}

// Loud surfacing: a BLESSED DAG whose baseline could not be accepted means the
// ratchet won't be live for the first beads (the exact gap igu reopens). We do
// NOT retroactively flip the DAG verdict (the DAG itself is sound), but we record
// and log it so the report and the orchestrator can see the ratchet is not armed.
const baselineAccepted = !!baselineResult?.accepted;
if (blessed && !Context.dryRun && !baselineAccepted) {
  log(`[WARN] BLESSED but baseline NOT accepted (${baselineResult?.failedReason || 'unknown'}) — the Jankurai ratchet will SKIP (not block) on early beads until a baseline exists.`);
} else if (baselineAccepted) {
  log(`[BASELINE] accepted at score ${baselineResult?.baselineScore ?? '?'}${baselineResult?.trustedByPolicy ? ' [TRUSTED-BY-POLICY, NOT BY HUMAN — --auto-bless walk-away]' : ' (blessed at decompose)'}`);
}

phase('Synthesis');

const synthesisPayload = {
  appName: Context.appName,
  appEpicId: ParsedPlan.appEpicId,
  planSource: Context.planSource,
  dryRun: Context.dryRun,
  verdict,
  confidence,
  autoChain,
  baseline: { ...baselineResult, accepted: baselineAccepted },
  pours: { ok: pourOk, failed: pourFailed },
  concernEnforcement,
  atomize: AtomizeSummary,
  quality: qualityResults,
  fidelity: FidelityResult,
  depAudit: DepAuditResult,
  crossDepWiring,
  tierWiring: TierWiring,   // Layer 2 onv: cross-tier ordering edges wired (generate half)
  topology                  // Layer 2 onv: deterministic topology assertion (assert half)
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
**Phases run:** preflight, parse-plan, pour (<N> features), quality-rework (<atomize.iterations> passes, <M> atomized, <K> epics scored), fidelity (A+B+C+reconcile), dep-audit, synthesis

## Verdict reasoning
<one paragraph: why blessed, or what blocks it>

## Coverage (Phase 6.A — plan-to-dag)
- <feature name> → <beadId(s)> ✓
- <feature name> → **GAP** (no bead)
- Cross-feature deps applied: <crossDepWiring.verifiedPresent — the edges Phase 3 wired AND verified by bead ID; this is the authoritative count, NOT a title-based re-count>
- Cross-feature deps missing: <crossDepWiring.missing + crossDepWiring.skipped — each with its reason; an unpoured endpoint feature is the usual cause>

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

## Per-epic quality (Phase 4+5 — final rework pass)
### <epicId> — <title>
- <beadId> — <title> — <score>/100 ✓
- <beadId> — <title> — <score>/100 ⚠
  - Penalties: <list with rule + evidence>
  - Remediations: <numbered list>
  - Projected after remediation: <score>/100

## Rework / atomization (Phase 4+5)
- Rework passes run: <atomize.iterations>/3
- Atomized (split to the bar): <source → children list>
- Unsplittable (surfaced for human): <list with bead, attempted seams, reason>
- Persistently oversized after the final pass (still < 95 on sizing): <list>

## Pours (Phase 3)
- Successful: <N>
- Failed: <list with feature + error>

## Concern + NFR + production-floor enforcement (Phase 3.5)
<render from concernEnforcement; omit the whole section if planSource != lock>
- Production floor: <floorApplies.declaresAuth / declaresData — which floor applies>
- Concern enforcement beads poured: <concernEnforcement.poured: concernId → formula → pourRoot>
- NFR enforcement beads poured: <concernEnforcement.nfrPoured: nfrId (category) → formula → pourRoot>
- Production-floor beads poured: <concernEnforcement.floorPoured: floorItem → formula → pourRoot>
- Covered by an existing feature/concern (no separate bead): <skippedCoveredByFeature>
- Success-metric e2e acceptance bead: <successMetricBead: formula → pourRoot (the §8 definition-of-done journey, now an executable test), or "none (no steps)">
- **MISSING FORMULA (forces NEEDS-FIX):** <missingFormula + nfrMissingFormula + floorMissingFormula + successMetricMissingFormula — each names the concern/NFR/floor item/success-metric with no enforcement formula and the recommendedFormula that should exist. An unenforced NFR, a missing production-floor capability, or a success metric with no executable test is work whose "done" is undefined.>
- Errors: <errors>

## Dep audit (Phase 7)
- Cycles: <none | list>
- Ready set on launch: <count> non-epic beads
- Implicit conflicts (filesTouched overlap, no dep): <list>

## Tier ordering + topology (Phase 7 — Layer 2, onv)
<render from tierWiring + topology; if tierWiring.skipped, state the skip reason (dry run or <2 non-empty tiers) and note the topology assertion did not run / passed vacuously>
- Tiers present (build order): <tierWiring.tiers joined with " < ">
- Cross-tier ordering edges wired: <tierWiring.verified>/<tierWiring.attempted> verified present (foundational → platform → feature → enforcement; entry beads of each higher tier depend on terminal beads of the lower tier)
- Tier-wiring shortfalls: <tierWiring.missing + tierWiring.errors — each named; advisory unless they manifest as a topology violation below>
- **Topology assertion (deterministic, pure-JS gate):** valid=<topology.topologyValid> over <topology.nodeCount> beads (foundation present=<topology.hasFoundation>)
  - Acyclic: <topology.acyclic — yes/no; if no, show topology.cyclePath>
  - Tier-monotonic (a bead only depends on its own tier or lower): <topology.tierMonotonic — yes/no; if no, list topology.tierViolations as "<bead>(<beadTier>) → <dep>(<depTier>)">
  - Reaches foundation (every non-foundational bead transitively depends into a foundational bead): <topology.reachesFoundation — yes/no; if no, list topology.orphans>
  - Initial ready set ⊆ foundational (no bead jumps a tier into `bd ready`): <topology.initialReadyOk — yes/no; if no, list topology.initialViolations>
  - <if topology.topologyValid is false: this is a BLOCKING failure — the DAG would build out of order; forces NEEDS-FIX. Name the exact missing/inverted edges so the fix is mechanical.>

## Jankurai baseline (Phase 8)
<render from baseline; omit this whole section if verdict is NEEDS-FIX or dryRun>
- Baseline accepted: <baseline.accepted — yes/no>
- Whole-repo scaffold score: <baseline.baselineScore>/100 (the regression-ratchet starting floor; the build must not regress below it — see hooks/post-build-gate)
- Trust: <if baseline.trustedByPolicy: **⚠ TRUSTED-BY-POLICY, NOT BY HUMAN** — auto-accepted on the --auto-bless walk-away path; no human reviewed this floor before it armed the ratchet. else: blessed via this human-review gate (you bless it by proceeding to /build-batch).>
- Tracking policy (agent/audit-policy.toml from \`jankurai govern\`): <baseline.policyWritten — written/skipped> (documentation only; its 85 floor never blocks in v1 — ratchet rule 9)
- <if baseline.accepted is false: **⚠ ratchet NOT armed** — <baseline.failedReason>; the gate will SKIP (not block) the ratchet on early beads until a baseline exists>

## Next steps
<if BLESSED:>
The DAG is ready. To start the build:

    /build-batch --workers <suggested-N>

Suggested workers: <min(4, ready_count)>. Higher values yield diminishing returns once the merge queue dominates.
<if baseline.trustedByPolicy: ⚠ This run auto-accepted the Jankurai baseline WITHOUT human review (--auto-bless). The score-<N> floor now arms the regression ratchet for the whole build — glance at agent/baselines/main.repo-score.json if you want to re-bless the starting line.>
<if confidence == 'high'>: This is a HIGH-confidence BLESSED (no advisory warnings). Re-running /decompose with \`--auto-bless\` (or driving via the orchestrator) would chain straight into the build without stopping here — use it for a true walk-away run.
<if confidence == 'review-recommended'>: BLESSED, but advisory warnings are present (implicit conflicts / missing cross-deps below) — \`--auto-bless\` deliberately will NOT auto-chain this; glance at the warnings first.

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
// (confidence / autoChain / advisoryWarnings / suggested* were computed before
// the Baseline phase so the baseline-accept agent and the report could see them.)
// ---------------------------------------------------------------------------
const finalResult = {
  verdict,
  confidence,                 // 'high' | 'review-recommended' | 'n/a'
  advisoryWarnings,
  autoChain,                  // true only when --auto-bless AND high-confidence BLESSED
  suggestedBuildBatch,        // the command the orchestrator/turn should run on autoChain
  baselineAccepted,           // false when NEEDS-FIX/dry-run, or when accept failed on a BLESSED run
  baselineScore: baselineResult?.baselineScore ?? null,
  baselineTrustedByPolicy: !!baselineResult?.trustedByPolicy,  // --auto-bless walk-away: no human blessed the floor
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
    DepAuditResult?.emptyReady ? 'dep-audit (empty ready set)' : null,
    // Layer 2 topology assertion (onv): only an explicit false is a failure
    // (undefined = dryRun/skip, never a fail). Name which invariant broke.
    (DepAuditResult?.topologyValid === false) ? `dep-audit (topology: ${[
      !topology.acyclic ? 'cycle' : null,
      topology.tierViolations.length ? `${topology.tierViolations.length} tier-inversion(s)` : null,
      topology.orphans.length ? `${topology.orphans.length} orphan(s) (no path to foundation)` : null,
      topology.initialViolations.length ? `${topology.initialViolations.length} non-foundational bead(s) in initial ready set` : null
    ].filter(Boolean).join(', ')})` : null
  ].filter(Boolean)
};

log(`Decompose ${verdict} (confidence=${confidence}, advisories=${advisoryWarnings}) — ${finalResult.beadCount} beads, report=${finalResult.reportPath}`);
if (autoChain) {
  log(`[AUTO-BLESS] high-confidence BLESSED + --auto-bless → orchestrator should chain into: ${suggestedBuildBatch}`);
  if (baselineResult?.trustedByPolicy) {
    log(`[AUTO-BLESS] baseline auto-accepted at score ${baselineResult?.baselineScore ?? '?'} [TRUSTED-BY-POLICY, NOT BY HUMAN] — no human reviewed the ratchet floor`);
  }
} else if (verdict === 'BLESSED') {
  log(`[GATE] BLESSED${confidence === 'review-recommended' ? ' (review recommended — advisory warnings present)' : ''} — human gate: review ${finalResult.reportPath}, then run ${suggestedBuildBatch}${parsedArgs.autoBless ? ' (--auto-bless did not chain: advisory warnings present)' : ''}`);
}
return finalResult;
