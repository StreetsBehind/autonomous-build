---
name: decompose
description: Take a plan.md + plan.lock.json and produce a blessed atomic bead DAG. Fans out formula pours per feature, atomizes oversized beads, scores each bead, adversarially cross-checks the DAG against the source plan, audits dep topology, and emits a BLESSED|NEEDS-FIX verdict + decomposeReport.md. Use when the user says "decompose", "/decompose", or invokes the workflow after /vision has produced plan.md. Subsumes /compose, /quality-pass, /split.
---

# decompose

The pre-build stage of the pipeline, implemented as a **dynamic workflow** (see https://code.claude.com/docs/en/workflows). Takes the structured plan from `/vision` and produces a buildable bead DAG that has been atomized, scored, and cross-checked against the plan before the human authorizes `/build-batch`.

This workflow replaces `skills/compose/`, `skills/quality-pass/`, and `skills/split/` — their behaviors are subsumed by Phases 3, 5, and 4 respectively.

## How this spec runs

This file is a **workflow spec**, not a skill. The canonical script lives at `workflows/decompose.js` in this repo (hand-authored, not first-run-generated) and is hardlinked to `~/.claude/workflows/decompose.js` by `install.ps1`. The hand-authored pattern is deliberate: `/decompose` is the load-bearing pre-build stage, and a reviewed JS script is more trustworthy than "whatever the model emitted that one time we saved it." Edits to behavior happen here AND in the JS — both files are source-of-truth, kept in sync.

When this spec changes meaningfully, the JS in `workflows/decompose.js` must change to match in the same commit (T3: atomic bead, atomic commit). Spec-only edits with no JS counterpart are a workflow bug.

**Agent prompts must be self-contained.** Every agent spawned by `decompose.js` runs with the *app repo* as cwd, where this spec does not exist (only the `.js` ships to `~/.claude/workflows/`; `.spec.md` is repo-only). So agent prompts must embed all instructions (and the report schema) inline — they must NOT tell an agent to read `workflows/decompose.spec.md`, a bare relative path that resolves to the app cwd and is never found. This spec is the source-of-truth for *maintainers*; the running agents only ever see their inlined prompt.

**Why a workflow instead of a three-skill chain:** independent agents per feature parallelize the pour step (compose was sequential); intermediate per-feature/per-bead state stays in script variables instead of bloating Claude's context; the adversarial fidelity cross-check (two agents must agree before the DAG is blessed) gives evidence-grounded coverage verification that no single-pass skill could provide; the verdict (`BLESSED` vs `NEEDS-FIX`) is mechanical, not a judgment call buried in chat.

---

## Inputs

The workflow accepts these arguments (parsed from the `/decompose` invocation; all optional):

| Arg | Default | Meaning |
| --- | --- | --- |
| `--plan <path>` | `plan.md` in cwd | Path to plan.md. `plan.lock.json` is resolved next to it. |
| `--no-file` | false | Dry-run: skip Phase 3 pours and Phase 4 mutations; emit the report describing what *would* be poured. Used for spec changes the human wants to inspect before mutating bd. |

The workflow expects to run **in the app repo's root**, not in `autonomous-build`. There is no `--self` analog for decompose — there is no plan.md for the workflow repo itself.

---

## Phase 1 — Pre-flight (sequential, 1 agent)

Verify the run is viable. Produces a `Context` object the rest of the workflow consumes. Any failure stops the workflow with a clear message (T1, T7).

**Agent:** `preflight`
**Tools:** `Bash`, `Read`, `Glob`
**Steps:**
1. `plan.md` exists at `--plan` path. If not, fail with "no plan.md — run `/vision` first."
2. Resolve `plan.lock.json` next to `plan.md`. Prefer the lock; if absent, set `planSource='md'` and emit a deprecation warning ("plan.lock.json missing — falling back to plan.md regex parse; rerun /vision to generate the lock").
3. If `planSource=='lock'`: validate `schemaVersion == 2` (current). A `schemaVersion == 1` lock is rejected with a migration message ("plan.lock.json is schemaVersion 1; this workflow needs schemaVersion 2 — rerun `/vision` to regenerate a v2 lock"). Any other version fails loud with the version found — this workflow only understands schema 2. (v2 added `mustHaves[]`/`successMetric`/`coverage[]`/`concerns[]`; see `docs/PLAN_LOCK.md`.)
4. If `planSource=='lock'` AND `lock.incomplete == true`: fail with the blocking `openQuestions` list. Do not paper over (T7).
5. `bd info` — if it errors, set `isFreshRepo=true` (Phase 2 will run `bd init`). If it succeeds and the repo already has open beads, fail with "this repo already has a beads DB — `/decompose` is for fresh app repos; for re-pour use `/vision` then delete `.beads/` first."
6. For each formula referenced in `lock.featureOrder[].formulas` (or parsed from plan.md): it must appear in `bd formula list`. Note that `bd formula list` requires an openable beads DB, which a fresh app repo does not yet have (check 5 deliberately relies on `bd info` erroring). Do **not** run `bd formula list` bare from cwd — list against a throwaway empty DB scoped to that one command so the app repo's fresh state is untouched: `TMPDB=$(mktemp -d); ( cd "$TMPDB" && bd init >/dev/null 2>&1 ); BEADS_DIR="$TMPDB/.beads" bd formula list; rm -rf "$TMPDB"`. The user search path `~/.beads/formulas/` (and project `.beads/formulas/`) is scanned regardless of `BEADS_DIR`. If any named formula is missing, fail with the list (T1: do not guess).
7. `jankurai version` must succeed. If missing, fail with the install command.

**Output:** `Context = { planPath, lockPath, planSource, plan: <parsed lock or md>, formulas: [<names>], appName: <basename of cwd>, isFreshRepo, dryRun: <bool from --no-file> }`

**Failure:** any failure stops; print the missing prereq and exit. Do not attempt recovery (T1).

---

## Phase 2 — Parse plan + initialize repo (sequential, 1 agent)

Extract the structured feature list and cross-feature deps from the plan. Bootstrap beads + Jankurai if this is a fresh repo.

**Agent:** `parse-plan`
**Tools:** `Bash`, `Read`, `Write`
**Steps:**
1. Read `plan.lock.json` (preferred) or regex-parse `plan.md` §"Feature order" + §"Cross-feature dependencies" (legacy fallback).
2. Extract `features = [{ name, formulas: [<name>], vars: {<k>:<v>} }, ...]` and `crossDeps = [{ blocked: <feature-name>, blocker: <feature-name> }, ...]`.
3. If `Context.isFreshRepo`:
   - `bd init`
   - `bd setup claude --project`
   - `bd hooks install`
   - `jankurai adopt . --profile auto --mode observe --out target/jankurai/adoption-plan.json --md target/jankurai/adoption-plan.md`
   - `jankurai init . --level agents --yes` (creates `AGENTS.md` at repo root)
   - `jankurai audit . --mode advisory --json target/jankurai/repo-score.json --md target/jankurai/repo-score.md` (baseline; ratchet not enabled yet)
4. Create the app-level epic: `bd create "<appName>" --type=epic --priority=1 --description "See plan.md"`. Capture `appEpicId`.
5. If `Context.dryRun`, skip steps 3 + 4 (do not mutate bd or filesystem); set `appEpicId='<dry-run>'`.

**Output:** `ParsedPlan = { features: [...], crossDeps: [...], appEpicId }`

**Failure:** parse failure (missing required fields) → stop. `bd init` / `jankurai init` failure → stop with the underlying error preserved (T7: no swallowed exceptions).

---

## Phase 3 — Pour beads per feature (parallel fan-out, N agents)

One agent per feature in `ParsedPlan.features`. Each agent pours its formula, reparents the molecule under the app epic, and writes step-derived metadata to the spawned children. **No cross-feature reasoning at this phase** — keep pours isolated.

**Agent:** `pour-feature` (N = `len(ParsedPlan.features)`)
**Tools:** `Bash`, `Read`
**Inputs per agent:** `{ feature: { name, formulas, vars }, appEpicId, dryRun }`
**Steps per agent:**
1. For each formula in `feature.formulas`:
   0. **Validate `feature.vars` against the formula contract before pouring.** Read `~/.beads/formulas/<formula>.formula.toml`, collect declared `[vars.*]` names and any enumerated allowed value sets. If a `feature.vars` key is not a declared variable, or a value falls outside a declared enum, return `{ status: 'failed', error }` — **do not** rename the key to a near-miss var or coerce the value into the enum (T1: do not guess). This is the guard that stops the smbuild failure mode where two pour agents silently renamed `auth_scheme`→`auth_strategy` and poured off-enum values.
   a. If `dryRun`: `bd mol pour <formula> --var ... --dry-run`, return planned issues without mutating.
   b. Otherwise: `bd mol pour <formula> --var ... 2>&1`. Parse `Root issue: (\S+)` from stdout to get `pourRoot`.
   c. `bd dep add <pourRoot> <appEpicId> --type parent-child` (reparent under app epic — `bd mol pour` has no `--parent` flag, verified 2026-05-28).
   d. Walk the formula TOML at `~/.beads/formulas/<formula>.formula.toml` and the cooked output. For each spawned child, write step-derived metadata via `bd update <id> --metadata "@<tempfile.json>"`. Fields: `testPlanFile`, `testPlanCases`, `testPlanCoverage` (from `[steps.testPlan]`), `filesTouched` (from the step's inline `files = [...]`). Apply variable substitution to all paths.
   e. Skip metadata write for steps that declare neither `[steps.testPlan]` nor `files` — that's a valid signal (coordination/decision bead).
2. Capture spawned child IDs from `bd show <pourRoot> --json` → `dependents[].id`.

**Output per agent:** `PourResult = { feature: <name>, pourRoot: <id> | "<dry-run>", children: [{id, title, metadata}], status: 'ok' | 'failed', error?: <message> }`

**Failure:** if `bd mol pour` fails (missing required vars, formula validation error), the agent returns `{ status: 'failed', feature, error }` instead of throwing (T7). Synthesis reports it; verdict is NEEDS-FIX.

**Concurrency:** N agents, capped at the runtime's 16-concurrent limit. For N > 16, the runtime schedules in batches automatically.

After all `pour-feature` agents complete, the orchestrator script also applies `crossDeps` sequentially (one `bd dep add` per cross-feature edge; resolve feature names → pour-root IDs via the union of `PourResult.pourRoot` values). The wiring agent must **verify each edge landed** by re-querying (`bd show <blockedId> --json` / `bd dep show`) rather than trusting the `bd dep add` exit code, and report the **verified-present** count, not the attempted count. An add that "succeeds" but leaves the edge absent (a pourRoot-vs-molecule-epic ID mismatch was the smbuild cause) is retried once against the visible molecule-epic IDs, then recorded as `missing`. Phase 7's dep audit independently reconciles declared vs present edges.

---

## Phase 3.5 — Concern + NFR + production-floor enforcement pours (lock only; bfo.10 / lbq.16 / lbq.8)

**Agent:** `concern-enforcement` **Tools:** `Read`, `Bash`

Three sources of non-feature work otherwise evaporate into advisory `tenets.md` prose — never a bead, never scored, never gated:

1. **Addressed concerns** (`concerns[]`) whose evidence is *not* a `featureOrder[]` entry (it cites a tenet/gate/stack-pin or a bare target). The product-feature pours don't cover them.
2. **First-class NFRs** (`nfrs[]`) — measurable requirements (performance, security, privacy, compliance, data-residency, availability) with no home in the 10-concern vocabulary, e.g. "data stays in my region". This is the `lbq.16` field.
3. **The mandatory production floor** (`lbq.8`) — production-readiness is NOT opt-in per product feature. Determine what the app declares: `declaresData` (non-empty `dataModel[]`), `declaresAuth` (`stack.auth`, an addressed authn/authz concern, or a must-have implying accounts). `declaresData` ⇒ floor `{observability, audit-log, iac-deploy}`; `declaresAuth` ⇒ additionally `{authz, abuse-surface}`. Each applicable floor item not already realized by a concern/feature is poured. A stateless no-auth tool has an empty floor.

For each (skipping any already delivered by a product feature or an addressed concern — no double-pour), select an **enforcement formula** matching the concern class / NFR category / floor item and pour a dedicated bead whose **AC comes from the target** and **testPlan from `verify`**, reparented under the app epic. **T6/T1:** never hand-create via `bd create` and never remap to a near-miss formula — if no installed formula fits, record it under `missingFormula` / `nfrMissingFormula` / `floorMissingFormula` with a `recommendedFormula` description. `excluded` concerns are skipped.

**Gate:** any `missingFormula` / `nfrMissingFormula` / `floorMissingFormula` (or enforcement-pour error) means a required target or production-floor capability will never be tested — this forces **NEEDS-FIX** (`concernEnforcementClean` in the verdict), surfaced in the report's "Concern + NFR + production-floor enforcement" section. Skipped entirely when `planSource != lock`.

---

## Phase 4 — Atomize oversized beads (parallel fan-out, iterative)

Walk every bead created in Phase 3. For each bead whose sizing score is < 95, spawn an atomize agent. This phase may loop (up to 3 iterations) because an atomization can in principle produce a child that itself needs splitting.

### Sizing rubric (mirrors /quality-pass + /split)

Start at 100, apply penalties, floor at 0:

| Signal | Detection | Penalty |
| --- | --- | --- |
| Acceptance criteria > 6 | Count `- ` / `* ` lines in Acceptance section | −10 |
| Files in description > 5 | Count `\b[\w/.-]+\.(ts|tsx|js|jsx|py|sql|md|toml|yaml|json|rs|go|java|kt|swift|rb|php|html|css)\b` | −10 |
| Cross-layer reach > 2 | Mentions of {UI, API, DB, test} layers — penalty per extra | −15 each |
| testPlanCases missing / 0 | `metadata.testPlanCases` null or zero | −5 |

A bead is **oversized** if score < 95.

### Spawn pattern

**Agent:** `atomize` (one per oversized bead per iteration)
**Tools:** `Bash`, `Read`, `Grep`, `Glob`
**Inputs per agent:** `{ beadId, dryRun }`
**Steps per agent:**
1. `bd show <beadId> --json` → capture title, ACs, labels, priority, metadata (testPlanFile, filesTouched), incoming deps, outgoing deps, parent epic.
2. **Identify the seam.** Try in this order; the first match wins:
   - Cross-layer: if description spans {UI, API, DB} and ACs partition cleanly along one boundary → seam = "API boundary" or "schema vs app code"
   - Per-entity: if title is a list ("Habits, Goals, Streaks CRUD") → seam = "per-entity"
   - Read vs write: if ACs split between reads (GET, list) and writes (POST, update, delete) → seam = "read path vs write path"
   - Happy vs edge: if ACs split between happy-path and explicit edge-cases → seam = "happy path vs edge cases"
3. If no seam fits cleanly (ACs straddle every candidate seam), return `{ status: 'unsplittable', beadId, attempted: [<seams tried>], reason: <one sentence> }`. **Do not invent a seam.** (T1: escalate over guess.)
4. Propose N children with:
   - Title = source title + seam term (e.g. "Habits CRUD (DB+API)" + "Habits CRUD (UI)").
   - ACs partitioned along the seam — each source AC lands in exactly one child. **No new ACs.** (T4: scope discipline.)
   - `filesTouched` partitioned — child ownership sets must be disjoint.
   - Dep mode: sequential (UI consumes API) or parallel (independent subsystems).
5. **Re-audit each proposed child** against the sizing rubric. If any child still scores < 95, return `{ status: 'unsplittable', beadId, attempted: [<seam>], reason: "seam still produces oversized children" }`. Surface for human resolution — do not retry with a different seam in the same agent run (that's the next iteration's job, with the same seam mechanic).
6. If `dryRun`: return the proposal without mutating.
7. Mutate (only if not dryRun):
   - `bd create` each child with `--parent=<sourceParentEpic>`, `--labels=<source labels>`, `--priority=<source priority>`, `--body-file=<tmp.json>` (multi-line ACs).
   - Write `filesTouched` metadata for each child.
   - Rewire deps:
     - Inter-child (sequential): `bd dep add <child[i+1]> <child[i]>` for each adjacent pair.
     - Preserve incoming: source's external blockers → first child (sequential) or all children (parallel).
     - Preserve outgoing: source's external dependents → last child (sequential) or all children (parallel).
   - Close source: `bd close <beadId> --reason "superseded by <new-ids joined>"`.

**Output per agent:** `AtomizeResult = { source: <beadId>, status: 'atomized' | 'unsplittable', children?: [{id, title, score}], seam?, reason? }`

### Iteration

After the first wave of `atomize` agents completes:
1. Re-walk the open bead set, re-apply the sizing rubric.
2. If new oversized beads exist (unlikely but possible — defense in depth), fan out another wave.
3. Cap at **3 iterations total**. After iteration 3, any remaining oversized beads are surfaced as `{ status: 'persistently-oversized', beadId, score, iterations: 3 }` and force `NEEDS-FIX` in synthesis.

**Output:** `AtomizeSummary = { iterations: <n>, atomized: [<AtomizeResult>...], unsplittable: [<AtomizeResult>...], persistentlyOversized: [...] }`

---

## Phase 5 — Quality scoring (parallel fan-out, K agents)

One agent per epic in the DAG (app-level epic + each pour-root epic from Phase 3). Each agent runs `/quality-pass`'s per-bead rubric across its epic's children and returns scores + remediations.

**Epic discovery must reach the molecule-root epics.** Pours produce `app-epic → molecule-root-epic → task`, so the discovery step enumerates *every* open epic that directly parents an open non-epic bead — molecule-root epics and any deeper sub-epics, not just the app epic's direct children. It also returns `totalOpenNonEpic` (an exact count of all open non-epic beads) as ground truth. If a non-empty pour set yields zero scoring epics, that is a discovery bug, not a clean DAG. (smbuild scored **zero** beads here and the gate passed vacuously — this is the guard against that.)

**Agent:** `quality-score` (K = number of open epics after Phase 4)
**Tools:** `Bash`, `Read`, `Grep`, `Glob`
**Inputs per agent:** `{ epicId }`
**Steps per agent:**
1. `bd list --parent <epicId> --status=open --json` → child beads.
2. For each child, apply the full /quality-pass rubric:
   - **Sizing penalties** (same as Phase 4 rubric)
   - **Spec concreteness penalties** — vague AC ("works correctly", "handles errors gracefully"), missing file paths, missing API contracts, missing testPlanFile, unstated edge cases.
   - **Context completeness penalties** — no links to prior beads/specs, undefined domain terms, dep-graph mismatch, open questions left for builder.
   - **Risk-signal penalties** — new external library, schema migration coupled to UI, browser verification without harness, "and/also/plus" in title suggesting two beads merged.
3. For each penalty applied, record the exact phrase or absence that triggered it (a bare number is unfalsifiable — /quality-pass's invariant).
4. For each bead < 95, propose **specific remediations** (not generic advice). Example remediations: paste the proposed schema, enumerate exact files, name exact test cases. Sum the projected penalty clearance; if ≥ 95, mark `wouldReach95: true`.

**Output per agent:** `EpicScoreResult = { epicId, scores: [{beadId, title, score, penalties: [{rule, amount, evidence}], remediations: [...], wouldReach95: <bool>}] }`

**Failure:** unreadable bead → record `{ score: null, error }`; do not crash. Synthesis flags as a data-source failure (T7).

---

## Phase 6 — Adversarial fidelity cross-check (parallel: 3 verifiers + 1 reconcile)

The load-bearing phase that makes `/decompose` worth more than the sum of compose+quality-pass+split. Three independent agents verify the DAG from different directions — plan→DAG coverage, DAG→plan traceability, and vision-must-have→DAG — and all must agree before the DAG is BLESSED on fidelity. A/B only check plan↔DAG; a must-have dropped during `/vision` distillation (in the lock's `mustHaves[]` but absent from `featureOrder`) is invisible to them — verifier C closes that hole.

### Spawn pattern

**Agent A:** `verify-plan-to-dag` (plan-direction coverage)
**Tools:** `Read`, `Bash`
**Inputs:** plan.md, plan.lock.json (if present), full open-bead snapshot (`bd list --status=open --json`)
**Question:** does every feature in `plan.featureOrder` have at least one open bead implementing it? Does every entry in `plan.crossFeatureDependencies` map to a real `bd dep` edge? **And (anti-rubber-stamp, bfo.9):** does every `concerns[]` entry with `status == "addressed"` whose `evidence` cites a *feature* trace to ≥1 open bead implementing that feature? Evidence citing a tenet/gate/stack-pin/formula is accepted as-is (always present, weaker check); `excluded` concerns are not checked. A feature-cited "addressed" concern with no implementing bead is a lie the DAG exposes — a fidelity gap. (If `planSource != 'lock'`, concern traceability is vacuously `complete`.)
**Output:** `{ coverage: 'complete' | 'incomplete', features: [{name, beads: [<ids>], status: 'covered' | 'gap'}], crossDeps: [{blocked, blocker, edgePresent: <bool>}], concernTrace: { traceable: 'complete' | 'gap', concerns: [{concernId, evidenceKind: 'feature'|'tenet'|'gate'|'stack-pin'|'formula', citedFeature: <name|null>, beads: [<ids>], covered: <bool>}] }, note: <one sentence> }`

**Agent B:** `verify-dag-to-plan` (DAG-direction traceability)
**Tools:** `Read`, `Bash`
**Inputs:** same as A
**Question:** does every bead in the DAG (excluding the app-level epic) trace back to a plan feature? Flag beads with no plan citation as scope-drift candidates.
**Output:** `{ traceability: 'clean' | 'drift', beads: [{id, title, citedFeature: <name | null>}], drifted: [<ids of beads with no plan citation>], note: <one sentence> }`

**Agent C:** `verify-musthave-to-dag` (vision must-have → DAG traceability)
**Tools:** `Read`, `Bash`
**Inputs:** plan.lock.json (`mustHaves[]` and, if present, `coverage[]`), full open-bead snapshot
**Question:** is every vision must-have realized by ≥1 open bead, or DELIBERATELY deferred? For each `mustHaves[]` entry: find covering feature(s) (via `coverage[]` if present, else semantic map to `featureOrder[].name`), then the implementing bead(s). Classify `covered` / `deferred` (lock explicitly marks it out-of-v1) / `gap` (neither). A `gap` is a must-have that silently dropped during distillation. If `planSource != 'lock'` there are no structured must-haves — return `traceable: 'n/a'`.
**Output:** `{ traceable: 'complete' | 'gap' | 'n/a', matrix: [{mustHave, status: 'covered'|'deferred'|'gap', features: [<names>], beads: [<ids>]}], note: <one sentence> }`

A, B, and C run in **parallel** on the same inputs (3 agents total). They must reach conclusions **independently** — none sees the others' output. The runtime fan-out provides this isolation by construction.

### Reconciliation

**Agent:** `reconcile-fidelity`
**Tools:** none — pure synthesis from A and B outputs
**Inputs:** outputs of A and B
**Bins:**

| Bin | Condition | Disposition |
| --- | --- | --- |
| `pass` | A.coverage == 'complete' AND B.traceability == 'clean' AND A.concernTrace.traceable == 'complete' | fidelity passes; no remediation needed |
| `coverage-gap` | A reports `incomplete` (one or more features have no bead) | fidelity fails; surface gaps; recommend `/vision` rerun OR manual pour of missing formulas |
| `concern-gap` | A.coverage == 'complete' AND B.traceability == 'clean' BUT A.concernTrace.traceable == 'gap' (a feature-cited `addressed` concern has no implementing bead) | fidelity fails; name the offending concern(s); recommend `/vision` rerun to correct the evidence OR pour the missing feature. The `concernGap` flag is also surfaced independently in the report, so the offending concern is named even when `coverage-gap`/`traceability-drift` is the headline bin |
| `musthave-gap` | A.coverage == 'complete' AND B.traceability == 'clean' AND no concern-gap BUT C.traceable == 'gap' (a vision must-have has no implementing bead and was not deliberately deferred) | fidelity fails; name the dropped must-have(s); recommend `/vision` rerun to restore the feature OR an explicit deferral in the lock. The `mustHaveGap` flag is surfaced independently in the report (must-have traceability matrix), so the dropped must-have is named even when another bin is the headline |
| `traceability-drift` | B reports `drift` (one or more beads have no plan citation) | fidelity fails; surface drifted beads; recommend either close as scope creep OR amend `plan.md` to declare the feature |
| `both-fail` | A and B both fail with non-overlapping concerns | fidelity fails; surface both verdicts; the DAG has both gaps and drift |
| `disagree` | A and B fail with conflicting evidence (e.g. A says feature X is covered by bead Y; B says bead Y traces to feature Z, not X) | fidelity fails; surface BOTH verifier outputs verbatim under a "FIDELITY DISAGREEMENT" section in the report; **the human resolves**, the workflow does not auto-pick (T1) |

**Output:** `FidelityResult = { bin, details: { coverage: <A.output>, traceability: <B.output> }, blockingForBlessed: <bool> }`

If `bin != 'pass'`, the final verdict is **NEEDS-FIX** regardless of other phases.

### Why the adversarial pattern

Single-pass coverage checking has a known failure mode: the agent reads the plan and the DAG, sees a bead-to-feature mapping that "looks right," and reports coverage as complete. Two independent agents working from opposite directions catch:

- Beads that *look like* feature X but actually implement feature Z (A counts it for X; B traces it to Z; reconcile catches the mismatch as `disagree`).
- Features that have multiple beads partially implementing them but no single bead carrying the full AC (A sees plausible-looking beads and reports `complete`; B finds none of them cite the feature → `disagree`).
- Beads with no plan source that were added during pours (A doesn't notice; B flags as drift).

The cost is two agents instead of one. The benefit is `BLESSED` means something.

---

## Phase 7 — Dep audit (sequential, 1 agent)

Topological sanity check on the DAG. Catches cycles, empty ready sets, and implicit file-conflict pairs that `/build-batch` would otherwise discover the hard way.

**Agent:** `dep-audit`
**Tools:** `Bash`
**Steps:**
1. `bd dep cycles` — must report no cycles. Any cycle is a hard blocker (T1: escalate).
2. `bd ready --json` — must return at least one non-epic issue. Empty ready set means the DAG is malformed (everything blocked).
3. **Implicit conflict scan:** for every pair of beads (B1, B2) where neither depends on the other (transitively), check whether `B1.metadata.filesTouched` and `B2.metadata.filesTouched` intersect. If yes, surface as `{ beadA: B1.id, beadB: B2.id, overlap: [<paths>] }`. These would race in `/build-batch`'s filesTouched conflict filter — not a hard fail, but worth flagging.
4. **Cross-dep verification:** confirm every entry in `ParsedPlan.crossDeps` has a corresponding `bd dep` edge. Missing edges mean Phase 3 dropped a cross-feature dep (a Phase 3 bug or a plan parse error).

**Output:** `DepAuditResult = { cycles: [<cycle paths>], emptyReady: <bool>, implicitConflicts: [...], crossDepsApplied: [...], missingCrossDeps: [...] }`

**Failure:** cycles or `emptyReady=true` → blocking for BLESSED. Implicit conflicts + missing cross-deps are advisory (logged in report, do not block verdict alone — but synthesis weights them into the recommendation).

---

## Phase 8 — Synthesis & verdict (sequential, 1 agent)

Aggregate Phase 3–7 outputs, compute the overall verdict, write `decomposeReport.md`, and return the verdict to the runtime.

**Agent:** `write-report`
**Tools:** `Write`, `Read`, `Bash`
**Steps:**
1. Aggregate `PourResult[]`, `AtomizeSummary`, `EpicScoreResult[]`, `FidelityResult`, `DepAuditResult`.
2. Compute verdict:
   - **BLESSED** iff: every `PourResult.status == 'ok'` AND `AtomizeSummary.persistentlyOversized.length == 0` AND `AtomizeSummary.unsplittable.length == 0` AND every bead in every `EpicScoreResult.scores` has `score >= 95` AND the quality pass actually covered the beads (`scoredCount > 0` when `totalOpenNonEpic > 0`, and `scoredCount >= totalOpenNonEpic`) AND `FidelityResult.bin == 'pass'` AND `DepAuditResult.cycles.length == 0` AND `DepAuditResult.emptyReady == false`. The "every bead ≥ 95" check is vacuously true on an empty score set, so the coverage clause is load-bearing — a run that scored zero beads is NEEDS-FIX, never a silent pass.
   - **NEEDS-FIX** otherwise. The report explains exactly which condition failed.
3. Write `decomposeReport.md` in cwd per the schema below.
4. Return `{ verdict, reportPath, summary }` to the runtime.

### Report schema

```markdown
# Decompose: <app-name> (<date>)

**Verdict:** <BLESSED | NEEDS-FIX>
**Plan source:** <plan.lock.json | plan.md (deprecation: rerun /vision)>
**Beads created:** <N> (<X> epics, <Y> tasks)
**App epic:** <id>
**Phases run:** preflight, parse-plan, pour (<N> features), atomize (<iterations> iters, <M> atomized), quality (<K> epics scored), fidelity (A+B+reconcile), dep-audit, synthesis

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
- <concernId> — addressed by feature "<name>" → **GAP** (no bead implements it)
- <concernId> — addressed by tenet/gate/stack-pin/formula → accepted as-is
- <omit this section if planSource is not lock or concerns[] is empty>

## Fidelity verdict (Phase 6 reconcile)
- Bin: <pass | coverage-gap | traceability-drift | concern-gap | both-fail | disagree>
- <if concernGap: name each feature-cited `addressed` concern with no implementing bead (forces NEEDS-FIX even when coverage/traceability are clean)>
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

After fixes, re-run `/decompose --no-file` to preview the state, then `/decompose` to re-pour.
```

5. If `dryRun`, prefix the report title with `(DRY RUN) ` and skip the "Next steps" section.

The write-report agent returns a **structured** object (validated by a schema: `{ status, reportPath, verdict, reportMarkdown? }`), not free text — otherwise the orchestrator cannot read `reportPath` back and `finalResult.reportPath` stays `null` even though the file was written (the smbuild symptom). On a successful write, `finalResult.reportPath` is set to the returned path.

**Failure:** if writing the report fails (disk full, path invalid), retry once; on second failure, return `{ status: 'failed', reportPath: null, reportMarkdown }` so the orchestrator can dump the inlined markdown to the log and exit with `verdict='NEEDS-FIX'`. Loud failure, not silent (T7).

---

## Run-completion behavior

When the workflow finishes:
- Returns to the conversation: `{ verdict: 'BLESSED' | 'NEEDS-FIX', reportPath, appEpicId, beadCount, failedPhases: [...] }`.
- The orchestrator turn prints a one-line summary:
  - BLESSED: `"Decompose: BLESSED — <N> beads under <appEpicId>. Run /build-batch when ready. Report: <path>"`
  - NEEDS-FIX: `"Decompose: NEEDS-FIX — <reason>. Report: <path>"`

There is **no auto-chain into `/build-batch`**. The human reads the report and decides whether to invoke the build. This gate is deliberate — a bad plan can burn N workers' worth of Opus tokens before producing visible damage.

---

## Stopping conditions

- Pre-flight prereq missing → Phase 1 stops; print the missing prereq.
- `plan.lock.json` is incomplete with blocking openQuestions → Phase 1 stops.
- Repo already has open beads → Phase 1 refuses (decompose is for fresh repos).
- A pour fails on required-var error → Phase 3 surfaces; verdict NEEDS-FIX.
- An atomize finds no clean seam → Phase 4 surfaces `unsplittable`; verdict NEEDS-FIX.
- Atomize loop hits 3 iterations with beads still oversized → verdict NEEDS-FIX with `persistentlyOversized` list.
- `bd dep cycles` reports a cycle → Phase 7 blocks BLESSED.
- A bd command itself errors mid-workflow (jsonl lock, schema bug) → catch, record in report under "FAILED" section; verdict NEEDS-FIX with loud warning (T7).

---

## Do not

- Do not edit `plan.md` or `plan.lock.json`. The plan is read-only. Drift means re-run `/vision`, not patch in flight (T10).
- Do not auto-resolve fidelity disagreements. Surface both verifier verdicts and let the human pick (T1).
- Do not bless a DAG with `unsplittable` or `persistentlyOversized` beads via a workaround. The seam was genuinely missing or the formula is wrong; escalate, do not improvise.
- Do not skip Phase 6 cross-check because the pours looked clean. Single-pass coverage checks have a track record of false-positives; the adversarial pattern is the load-bearing reason this workflow exists.
- Do not call `bd create` outside of `bd mol pour` (T6: formula precedence). If a feature needs a bead the formula library doesn't produce, surface in the report as "Missing formula" and recommend a new formula in `autonomous-build/formulas/` — do not improvise the bead by hand.
- Do not commit `target/jankurai/` receipts. Phase 2's `jankurai init` adds them to `.gitignore`; verify.
- Do not auto-invoke `/build-batch` on BLESSED. The human gate between decompose and build is intentional.
- Do not run Phase 4 atomize on closed beads. The atomize candidate set is scoped to open beads only (a `superseded` bead from a prior iteration is closed by definition).

---

## Save-as-workflow + sync checklist

Hand-authored JS pattern — this spec is NOT regenerated on first invocation. The canonical script lives at `workflows/decompose.js` in this repo.

**Initial install (after A2 lands `workflows/decompose.js`):**
1. `./install.ps1` — hardlinks `workflows/decompose.js` to `~/.claude/workflows/decompose.js`.
2. `/decompose` is now invokable from any app repo (this workflow is project-agnostic — it operates on cwd).
3. The smoke test (sibling bead A3) validates end-to-end.

**Spec changes:** edit this file AND `workflows/decompose.js` in the same commit (T3). Spec-only edits are a workflow bug; JS-only changes that diverge from the spec are also a workflow bug. The two stay in lockstep.

---

## Relationship to other skills + workflows

- **Replaces** `skills/compose/`, `skills/quality-pass/`, `skills/split/` — all three are subsumed. The skill directories are deleted by `autonomous-build-mvh.1.4` once docs are updated (bead `autonomous-build-mvh.3`).
- **Consumes** `plan.md` + `plan.lock.json` produced by `/vision`.
- **Feeds** `/build-batch` (the sibling workflow conversion under `autonomous-build-mvh.2`). The BLESSED DAG is its input. A NEEDS-FIX DAG should not be dispatched — `/build-batch`'s preflight phase will refuse if quality scores are below threshold (separate bead, not yet specified).
- The human reads `decomposeReport.md` and decides when to invoke `/build-batch`.
