---
name: decompose
description: Take a plan.md + plan.lock.json and produce a blessed atomic bead DAG. Fans out formula pours per feature, reworks every bead to the 95 quality bar (split/wire/tighten), adversarially cross-checks the DAG against the source plan, audits dep topology, and emits a BLESSED|NEEDS-FIX verdict + decomposeReport.md. Use when the user says "decompose", "/decompose", or invokes the workflow after /vision has produced plan.md. Subsumes /compose, /quality-pass, /split.
---

# decompose

The pre-build stage of the pipeline, implemented as a **dynamic workflow** (see https://code.claude.com/docs/en/workflows). Takes the structured plan from `/vision` and produces a buildable bead DAG that has been reworked to the quality bar (split, dep-wired, and tightened) and cross-checked against the plan before the human authorizes `/build-batch`.

This workflow replaces `skills/compose/`, `skills/quality-pass/`, and `skills/split/` — their behaviors are subsumed: compose by Phase 3 (pour), and quality-pass + split by the unified **Phase 4+5 Quality-rework loop** (score with the full rubric, then rework sub-95 beads — split / wire / tighten — to the 95 bar).

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
| `--no-file` | false | Dry-run: skip Phase 3 pours and the Phase 4+5 rework mutations (the loop scores once, read-only); emit the report describing what *would* be poured/reworked. Used for spec changes the human wants to inspect before mutating bd. |
| `--auto-bless` | false | Opt-in: on a **high-confidence** BLESSED (no advisory warnings), set `autoChain: true` so the orchestrator chains straight into `/build-batch` instead of stopping at the human-review gate. Never auto-chains a `review-recommended` BLESSED or a dry run. See "Run-completion behavior". |
| `--phase <N>` | `1` | Which build phase to decompose (epic `autonomous-build-0ms`). Default `1` = the only phase of a single-phase plan, so bare `/decompose` is unchanged. With `--phase N`, the workflow pours **only** the slice of `featureOrder[]`/`mustHaves[]` tagged `phase == N` (entries without a `phase` field default to 1), under a dedicated **phase epic**. Phase 1 bootstraps the repo (`bd init`, Jankurai scaffold, baseline); phases > 1 re-enter an existing repo and skip bootstrap. This is JIT per-phase decomposition — phase N+1's beads do not exist until `--phase N+1` runs. |

Flags are honored **only as a leading contiguous run** — `parseArgs` stops at the first non-flag token (autonomous-build-3ch). A headless/Workflow invocation passes a natural-language wrapper as the args string, so a literal `--no-file`/`--auto-bless` appearing *inside that prose* — even within a negation like "do NOT pass `--no-file`" — must NOT flip the mode bit (the old whole-string token scan silently degraded a REAL pour into a no-DB dry-run). Real callers (`/orchestrate`, the `/decompose` shell) pass flags as leading tokens, so this is lossless for them. Guarded by `tests/decompose/parseargs.test.mjs`.

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
5. **Phase-aware repo gate (epic 0ms).** This run decomposes **phase `N`** (`--phase`, default 1). `bd info` — if it errors, set `isFreshRepo=true` (valid only at phase 1; Phase 2 will run `bd init`). At phase > 1 a missing beads DB is an error (phase 1 must have run first). If `bd info` succeeds (`isFreshRepo=false`): at **phase 1**, fail if the repo already has open beads ("`/decompose` phase 1 is for fresh app repos; for re-pour delete `.beads/` first then rerun"). At **phase > 1**, prior built (closed) phases + the umbrella app epic are *expected* — do **not** refuse on them; refuse **only** if *this* phase was already decomposed (an open epic titled `Phase N…` already exists). This is what lets the JIT per-phase loop re-enter a repo that already holds earlier phases.
6. For each formula referenced in `lock.featureOrder[].formulas` (or parsed from plan.md): it must appear in `bd formula list`. Note that `bd formula list` requires an openable beads DB, which a fresh app repo does not yet have (check 5 deliberately relies on `bd info` erroring). Do **not** run `bd formula list` bare from cwd — list against a throwaway empty DB scoped to that one command so the app repo's fresh state is untouched: `TMPDB=$(mktemp -d); ( cd "$TMPDB" && bd init >/dev/null 2>&1 ); BEADS_DIR="$TMPDB/.beads" bd formula list; rm -rf "$TMPDB"`. The user search path `~/.beads/formulas/` (and project `.beads/formulas/`) is scanned regardless of `BEADS_DIR`. If any named formula is missing, fail with the list (T1: do not guess).
7. `jankurai version` must succeed. If missing, fail with the install command.

**Output:** `Context = { planPath, lockPath, planSource, plan: <parsed lock or md>, formulas: [<names>], appName: <basename of cwd>, isFreshRepo, dryRun: <bool from --no-file> }`

**Failure:** any failure stops; print the missing prereq and exit. Do not attempt recovery (T1).

---

## Phase 2 — Parse plan + initialize repo (sequential, 1 agent)

Extract the structured feature list and cross-feature deps from the plan. Bootstrap beads + Jankurai **only at phase 1** (a fresh repo); later phases re-enter an already-scaffolded repo.

**Agent:** `parse-plan`
**Tools:** `Bash`, `Read`, `Write`
**Steps:**
1. Read `plan.lock.json` (preferred) or regex-parse `plan.md` §"Feature order" + §"Cross-feature dependencies" (legacy fallback).
2. Extract `features = [{ name, formulas: [<name>], vars: {<k>:<v>} }, ...]` and `crossDeps = [{ blocked: <feature-name>, blocker: <feature-name> }, ...]`. **Scope to phase `N` (epic 0ms):** keep only `featureOrder[]` entries tagged `phase == N` (no `phase` field ⇒ phase 1), and only cross-deps whose **both** endpoints are in this slice (a backward edge onto an already-built prior phase is already satisfied — drop it from pour-time wiring). At the default phase 1 of a single-phase plan this keeps every feature, unchanged.
3. **Bootstrap — phase 1 only.** If `Context.phase == 1` AND `Context.isFreshRepo` (and not dry-run):
   - `bd init`
   - `bd setup claude --project`
   - `bd hooks install`
   - `jankurai adopt . --profile auto --mode observe --out target/jankurai/adoption-plan.json --md target/jankurai/adoption-plan.md`
   - `jankurai init . --level agents --yes` (creates `AGENTS.md` at repo root)
   - `jankurai audit . --mode advisory --json target/jankurai/repo-score.json --md target/jankurai/repo-score.md` (this **measures** the scaffold score, advisory-only, into the gitignored `target/jankurai/`).
   - **Do NOT accept a baseline here (igu.2, supersedes lbq.14).** lbq.14 used to auto-stamp this score as `agent/baselines/main.repo-score.json` and commit it *before* the verdict — freezing a never-blessed floor in the unattended window, even on runs that turn out NEEDS-FIX. Baseline acceptance now rides the BLESSED verdict in **Phase 8** (after synthesis): accepted only on BLESSED, after the human-review gate (attended) or with a loud trusted-by-policy note (`--auto-bless` walk-away). This step writes nothing under `agent/`.
   At **phase > 1** this whole bootstrap is **skipped** — the repo was initialized + Jankurai-scaffolded by phase 1.
4. Create the epic this run's beads hang under:
   - **Phase 1:** the app-level umbrella epic — `bd create "<appName>" --type=epic --priority=1 --description "See plan.md"`. Capture `appEpicId`.
   - **Phase > 1:** find the existing umbrella epic (`bd list --type=epic --json`, titled `<appName>`), then create a **phase epic** under it — `bd create "Phase N: <slice goal>" --type=epic --priority=1 --parent <umbrella> --description "Phase N slice — see plan.lock phases[]"` — and set `appEpicId` to the **phase epic's** ID so Phase 3 pours land under it, isolated from prior phases.
5. If `Context.dryRun`, skip steps 3 + 4 (do not mutate bd or filesystem); set `appEpicId='<dry-run>'`.

**Output:** `ParsedPlan = { features: [...], crossDeps: [...], appEpicId }` (features/crossDeps scoped to phase `N`)

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

After all `pour-feature` agents complete, the orchestrator script also applies `crossDeps` sequentially (one `bd dep add` per cross-feature edge; resolve feature names → pour-root IDs via the union of `PourResult.pourRoot` values). This name → pour-root map is the **authoritative** resolution of feature names to bead IDs; the script builds it once (`featureToPourRoot`) and **threads it into Phase 6 (fidelity) and Phase 7 (dep audit)** so those verifiers resolve cross-dep endpoints by the same map. Downstream verifiers must **not** re-resolve by title: a molecule-epic's title is its formula name (`crud-feature`, `integration-http`), never the feature name, so a title search never matches — that was the run-2 smbuild "0/28 applied" false negative (`autonomous-build-3fr.3`): the edges between two *poured* features were wired but reported absent because the verifier re-derived names by title. The wiring agent must **verify each edge landed** by re-querying (`bd show <blockedId> --json` / `bd dep show`) rather than trusting the `bd dep add` exit code, report the **verified-present** count (not the attempted count), and return the resolved verified edges (`verified[]`, each with `blockedId`/`blockerId`) as the input Phase 6/7 reuse. An add that "succeeds" but leaves the edge absent (a pourRoot-vs-molecule-epic ID mismatch) is retried once against the visible molecule-epic IDs, then recorded as `missing`. The report's "Cross-feature deps applied" count is sourced from this `verifiedPresent`, not from a downstream title re-count. Phase 7's dep audit independently reconciles declared vs present edges using the same map.

---

## Phase 3.5 — Concern + NFR + production-floor enforcement pours (lock only; bfo.10 / lbq.16 / lbq.8)

**Agent:** `concern-enforcement` **Tools:** `Read`, `Bash`

Three sources of non-feature work otherwise evaporate into advisory `tenets.md` prose — never a bead, never scored, never gated:

1. **Addressed concerns** (`concerns[]`) whose evidence is *not* a `featureOrder[]` entry (it cites a tenet/gate/stack-pin or a bare target). The product-feature pours don't cover them.
2. **First-class NFRs** (`nfrs[]`) — measurable requirements (performance, security, privacy, compliance, data-residency, availability) with no home in the 10-concern vocabulary, e.g. "data stays in my region". This is the `lbq.16` field.
3. **The mandatory production floor** (`lbq.8`) — production-readiness is NOT opt-in per product feature. Determine what the app declares: `declaresData` (non-empty `dataModel[]`), `declaresAuth` (`stack.auth`, an addressed authn/authz concern, or a must-have implying accounts). `declaresData` ⇒ floor `{observability, audit-log, iac-deploy}`; `declaresAuth` ⇒ additionally `{authz, abuse-surface}`. Each applicable floor item not already realized by a concern/feature is poured. A stateless no-auth tool has an empty floor.

For each (skipping any already delivered by a product feature or an addressed concern — no double-pour), select an **enforcement formula** matching the concern class / NFR category / floor item and pour a dedicated bead whose **AC comes from the target** and **testPlan from `verify`**, reparented under the app epic. **T6/T1:** never hand-create via `bd create` and never remap to a near-miss formula — if no installed formula fits, record it under `missingFormula` / `nfrMissingFormula` / `floorMissingFormula` with a `recommendedFormula` description. `excluded` concerns are skipped.

4. **The success-metric e2e acceptance bead** (`lbq.17`) — the lock's `successMetric.steps[]` is the user's one definition of done, the cross-feature journey. Pour exactly ONE end-to-end acceptance bead from an e2e/integration formula, binding the ordered steps as the journey the test walks (each step → an assertion). Empty steps ⇒ none. No fitting formula ⇒ `successMetricMissingFormula` (NEEDS-FIX) — "done" must be an executable test, not a coverage mapping.

**Gate:** any `missingFormula` / `nfrMissingFormula` / `floorMissingFormula` / `successMetricMissingFormula` (or enforcement-pour error) means a required target, production-floor capability, or the success-metric definition-of-done will never be tested — this forces **NEEDS-FIX** (`concernEnforcementClean` in the verdict), surfaced in the report's enforcement section. Skipped entirely when `planSource != lock`.

---

## Phase 4+5 — Quality-rework loop (score + rework to the bar; Layer 2, epic autonomous-build-onv.3)

The old flow was `atomize(4) → score(5) → verdict`: atomize was the *only* mutating phase, ran FIRST with a NARROW sizing rubric, while scoring used the FULL rubric but was read-only — it emitted `remediations` + `wouldReach95` and bailed. So monoliths the full rubric flagged (`<95` on spec/context penalties, not just sizing) were never split, and sub-95 beads were never reworked. Phases 4 and 5 are now ONE closed **rework-to-bar loop**: score (full rubric) → rework the sub-95 beads → re-discover + re-score the mutated set → repeat, up to `MAX_REWORK = 3` passes. Splitting, dep-wiring, and AC-tightening become the *same* loop driven by the *same* 95 bar.

```
for pass in 1..MAX_REWORK (=3):
   re-discover the epic/bead set from bd            (splits mutate the set — MANDATORY each pass)
   score every open non-epic bead, per-epic, FULL rubric  (read-only)
   if every score >= 95: break
   if dryRun: break                                  (read-only — score once, report, no mutation)
   if pass == MAX_REWORK: break                       (bound it — a still-<95 bead is the NEEDS-FIX signal)
   rework the sub-95 beads in PARALLEL (one agent per bead, each applying THAT bead's own remediations)
   (next pass re-scores the mutated set)
```

### Rubric (full /quality-pass, mirrors the old Phases 4+5)

Start each bead at 100, apply penalties, floor at 0:

| Class | Signals |
| --- | --- |
| **Sizing** | ACs > 6 (−10); files > 5 (−10); cross-layer reach > 2 (−15 per extra layer); `metadata.testPlanCases` missing/0 (−5) |
| **Spec concreteness** | vague AC without thresholds ("works correctly", "handles errors gracefully") (−5 each); missing file paths for new code (−10); API contract missing (endpoint named, no request/response shape) (−10); `testPlanFile` missing (−10); edge cases unstated (−5) |
| **Context completeness** | no links to prior beads/specs (−5); undefined domain terms (−5); dependency-graph mismatch (asserts "after X" but no `bd dep` edge, or vice versa) (−10); open questions / TBD left for builder (−5 each) |
| **Risk signals (additive)** | new external library/API (−10); schema migration coupled to UI in one bead (−15); browser verification, no harness (−10); "and/also/plus" in title/AC suggesting two beads merged (−5) |

A bead **passes the bar** at score ≥ 95. For every penalty, the scorer records the exact phrase/absence that triggered it (a bare number is unfalsifiable). For every bead < 95 it proposes **specific** remediations (paste the schema, enumerate the files, name the test cases) — the rework agent applies these, so they must be actionable.

### Score step (read-only, per-epic fan-out)

**Epic discovery must reach the molecule-root epics, and re-run every pass.** Pours produce `app-epic → molecule-root-epic → task`, and the rework passes ALSO split beads (new children open, superseded sources closed) — so the discovery step re-reads the live DB at the start of every pass and enumerates *every* open epic that directly parents an open non-epic bead (molecule-root epics + deeper sub-epics, not just the app epic's direct children). It also returns `totalOpenNonEpic` (exact count of all open non-epic beads) as ground truth. A non-empty pour set that yields zero scoring epics is a discovery bug, not a clean DAG (smbuild scored **zero** beads here and the gate passed vacuously — this is the guard).

**Agent:** `epic-discovery-pass<N>` then `quality-<epicId>-pass<N>` (K = open epics this pass)
**Tools:** `Bash`, `Read`, `Grep`, `Glob`
Each `quality-score` agent runs the full rubric over `bd list --parent <epicId> --status=open --json` and returns `EpicScoreResult = { epicId, scores: [{beadId, title, score, penalties: [{rule, amount, evidence}], remediations: [...], wouldReach95}] }`. **Read-only — it mutates nothing.**

### Rework step (parallel, one agent per sub-95 bead — only when NOT dryRun and NOT the final pass)

**Agent:** `rework-<beadId>-pass<N>` (one per sub-95 bead)
**Tools:** `Bash`, `Read`, `Grep`, `Glob`
**Inputs per agent:** the bead's own score + penalties + remediations.
Each agent picks the ONE action that resolves its dominant penalties and **adds no new scope (T4)** — it only makes the EXISTING intent concrete:

- **A. Oversized / monolith** (SIZING penalties dominate: ACs > 6, files > 5, cross-layer reach > 2) → **SPLIT along a clean seam** (the old atomize logic): `bd show` the bead; identify the seam (cross-layer → per-entity → read-vs-write → happy-vs-edge, first match wins; no fit → `unreworkable`, do not invent a seam, T1); propose children with ACs partitioned (each source AC lands in exactly one child, NO new ACs, T4) and disjoint `filesTouched`; re-audit each child against the sizing rubric (still < 95 → `unreworkable` "seam still produces oversized children"); then mutate — `bd create` each child (`--parent`/`--labels`/`--priority`/`--body-file`), write metadata, rewire deps (sequential: `bd dep add child[i+1] child[i]`, preserve incoming on first + outgoing on last; parallel: all children get all incoming + outgoing), and `bd close <source> --reason "superseded by <ids>"`.
- **B. Dependency-graph mismatch** (the −10 dep-graph penalty: text asserts "after X" but no `bd dep` edge) → **WIRE the missing edge**: resolve the named blocker to a bead ID, `bd dep add <bead> <blocker>` and VERIFY it landed (don't trust the exit code, retry once). If the asserted ordering is spurious, instead EDIT the description to drop the false claim — do not fabricate a dep to a bead that should not block it (T1).
- **C. Vague / underspec** (SPEC-CONCRETENESS or CONTEXT-COMPLETENESS: vague AC, missing file paths, missing API contract, missing `testPlanFile`, undefined domain terms, open questions/TBD) → **TIGHTEN IN PLACE**: `bd update <bead>` the description/acceptance to concretize what is already there (testable ACs with thresholds, the exact file paths the bead implies, the request/response shape for an endpoint it names, a concrete decision for each TBD, inline domain definitions) and `bd update --metadata` the missing fields (`testPlanFile`, `testPlanCases`, `filesTouched`). **No new ACs / files the bead did not already imply (T4).**

When a bead carries penalties from multiple classes: prefer **A** (split) when sizing dominates (an oversized bead can't be tightened to the bar), else apply **C** and fold any **B** dep-wire into the same run. A bead that genuinely cannot reach 95 by any of A/B/C (needs a plan amendment or a nonexistent formula) returns `unreworkable` with the missing input named — do not throw (T7), do not fabricate a passing state.

**Output per agent:** `{ beadId, action: 'split' | 'tighten' | 'wire' | 'unreworkable', newChildren?: [...], seam?, attempted?: [...], reason? }`.

### Termination + AtomizeSummary (terminal state)

The loop is bounded at `MAX_REWORK = 3`. It stops early when every bead clears the bar, or on the first pass in a dry run (read-only). A bead still < 95 after the final pass keeps its **real** score in `qualityResults` (so `allBeadsAt95 = false` → NEEDS-FIX, the correct terminal signal) — the loop never fabricates a 95. The downstream contracts are preserved exactly:

- `qualityResults` / `scoredCount` / `qualityVacuous` / `qualityUndercovered` / `totalOpenNonEpic` are the **final pass's** values, with the same shapes as the old Phase 5 (so the `allBeadsAt95` + `qualityOk` verdict clauses are unchanged).
- `AtomizeSummary = { iterations: <passes run>, atomized: [<every split>], unsplittable: [<beads the rework tried to split but couldn't seam>], persistentlyOversized: [<beads still <95 on SIZING penalties after the final pass>] }` is built from the loop's **terminal** state, so the verdict's `AtomizeSummary.persistentlyOversized.length == 0 && AtomizeSummary.unsplittable.length == 0` clause and the report's Atomization section are unchanged.

**dryRun:** in a dry run the loop scores ONCE and reports the would-be-reworked set — it mutates nothing (rework, split, wire, and tighten are all guarded behind `!Context.dryRun`), preserving the old read-only dry-run behavior.

---

## Phase 6 — Adversarial fidelity cross-check (parallel: 3 verifiers + 1 reconcile)

The load-bearing phase that makes `/decompose` worth more than the sum of compose+quality-pass+split. Three independent agents verify the DAG from different directions — plan→DAG coverage, DAG→plan traceability, and vision-must-have→DAG — and all must agree before the DAG is BLESSED on fidelity. A/B only check plan↔DAG; a must-have dropped during `/vision` distillation (in the lock's `mustHaves[]` but absent from `featureOrder`) is invisible to them — verifier C closes that hole.

### Spawn pattern

**Agent A:** `verify-plan-to-dag` (plan-direction coverage)
**Tools:** `Read`, `Bash`
**Inputs:** plan.md, plan.lock.json (if present), full open-bead snapshot (`bd list --status=open --json`), **and the Phase 3 `featureToPourRoot` name → pour-root map** (the authoritative feature-name → bead-ID resolution — resolve cross-dep endpoints and feature→bead coverage with this, never by title-matching molecule epics, whose titles are formula names).
**Question:** does every feature in `plan.featureOrder` have at least one open bead implementing it? Does every entry in `plan.crossFeatureDependencies` map to a real `bd dep` edge? (Resolve each cross-dep endpoint name to its bead ID via the `featureToPourRoot` map; a name absent from the map is an unpoured feature → real gap, not a title-search miss — `autonomous-build-3fr.3`.) **And (anti-rubber-stamp, bfo.9):** does every `concerns[]` entry with `status == "addressed"` whose `evidence` cites a *feature* trace to ≥1 open bead implementing that feature? Evidence citing a tenet/gate/stack-pin/formula is accepted as-is (always present, weaker check); `excluded` concerns are not checked. A feature-cited "addressed" concern with no implementing bead is a lie the DAG exposes — a fidelity gap. (If `planSource != 'lock'`, concern traceability is vacuously `complete`.)
**Output:** `{ coverage: 'complete' | 'incomplete', features: [{name, beads: [<ids>], status: 'covered' | 'gap'}], crossDeps: [{blocked, blocker, edgePresent: <bool>}], concernTrace: { traceable: 'complete' | 'gap', concerns: [{concernId, evidenceKind: 'feature'|'tenet'|'gate'|'stack-pin'|'formula', citedFeature: <name|null>, beads: [<ids>], covered: <bool>}] }, note: <one sentence> }`

**Agent B:** `verify-dag-to-plan` (DAG-direction traceability)
**Tools:** `Read`, `Bash`
**Inputs:** same as A
**Question:** does every bead in the DAG (excluding the app-level epic) trace back to a plan feature? Flag beads with no plan citation as scope-drift candidates.
**Output:** `{ traceability: 'clean' | 'drift', beads: [{id, title, citedFeature: <name | null>}], drifted: [<ids of beads with no plan citation>], note: <one sentence> }`

**Agent C:** `verify-musthave-to-dag` (vision must-have → DAG traceability)
**Tools:** `Read`, `Bash`
**Inputs:** plan.lock.json (`mustHaves[]` and, if present, `coverage[]`), full open-bead snapshot
**Question:** is every vision must-have for **this phase** realized by ≥1 open bead, or DELIBERATELY deferred? For each `mustHaves[]` entry, first read its `phase` (default 1). Classify **phase-aware (epic 0ms)**: a must-have tagged for a **future** phase (`phase > N`) is `deferred` — its beads do not exist yet by design (JIT decomposition), not a gap; one from a **prior** phase (`phase < N`) is `covered` (built earlier, out of scope); one for **this** phase (`phase == N`) is `covered` iff ≥1 open bead implements a covering feature (via `coverage[]` if present, else semantic map to `featureOrder[].name`), else `gap`. An explicit lock deferral / out-of-v1 marker is also `deferred`. A `gap` is a this-phase must-have that silently dropped during distillation. If `planSource != 'lock'` there are no structured must-haves — return `traceable: 'n/a'`.
**Output:** `{ traceable: 'complete' | 'gap' | 'n/a', matrix: [{mustHave, status: 'covered'|'deferred'|'gap', features: [<names>], beads: [<ids>]}], note: <one sentence> }`

A, B, and C run in **parallel** on the same inputs (3 agents total). They must reach conclusions **independently** — none sees the others' output. The runtime fan-out provides this isolation by construction.

### Reconciliation

**Agent:** `reconcile-fidelity`
**Tools:** none — pure synthesis (inline JS) from A, B, and C outputs
**Inputs:** outputs of A, B, and C, plus the authoritative `featureToPourRoot` map (used to reconcile C's must-have gaps — see `musthave-gap` below)
**Bins:**

| Bin | Condition | Disposition |
| --- | --- | --- |
| `pass` | A.coverage == 'complete' AND B.traceability == 'clean' AND A.concernTrace.traceable == 'complete' | fidelity passes; no remediation needed |
| `coverage-gap` | A reports `incomplete` (one or more features have no bead) | fidelity fails; surface gaps; recommend `/vision` rerun OR manual pour of missing formulas |
| `concern-gap` | A.coverage == 'complete' AND B.traceability == 'clean' BUT A.concernTrace.traceable == 'gap' (a feature-cited `addressed` concern has no implementing bead) | fidelity fails; name the offending concern(s); recommend `/vision` rerun to correct the evidence OR pour the missing feature. The `concernGap` flag is also surfaced independently in the report, so the offending concern is named even when `coverage-gap`/`traceability-drift` is the headline bin |
| `musthave-gap` | A.coverage == 'complete' AND B.traceability == 'clean' AND no concern-gap BUT C.traceable == 'gap' (a vision must-have has no implementing bead and was not deliberately deferred) — **after reconciliation (ea1)**: before trusting C's gap, the reconcile step (`reconcileMustHaveGaps`) cross-checks each C `gap` against the authoritative `featureToPourRoot` map and A's proven feature coverage. C is independent + conservative and string-matches must-have→bead, so a covering feature that poured an epic whose **children are implementation-named** (not the must-have's wording) reads as a false gap; if that covering feature actually poured a real root (or A marked it covered), the must-have is credited to that root + its children and downgraded to `covered`. Only the survivors are a true `musthave-gap`. | fidelity fails; name the dropped must-have(s); recommend `/vision` rerun to restore the feature OR an explicit deferral in the lock. The `mustHaveGap` flag is surfaced independently in the report (must-have traceability matrix), so the dropped must-have is named even when another bin is the headline |
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

## Tier-ordering wiring (Layer 2, epic autonomous-build-onv — runs between Phase 6 and Phase 7)

Materialize the build-order tiers (`foundational < platform < feature < enforcement`) as **bead-level** dependency edges, so a feature bead cannot land in `bd ready` ahead of the scaffold/floor it depends on. Epics gate by *parent-child*, not dependency, so the ordering must be a per-**bead** edge to actually block readiness (the smbuild root cause: a leaf feature bead was `ready` before the app-skeleton epic and built first, and the Jankurai ratchet correctly rejected it).

**Tier derivation (SYNC with `/vision`).** `decompose.js` mirrors `deriveFeatureTier` / `FEATURE_TIERS` / `TIER_RULES` / `tierOfFormula` from `workflows/vision.js` (kept in lockstep — a SYNC comment marks it). `tierOf(featureName)` is: the lock's `featureOrder[].tier` is **authoritative** when present (the updated `/vision` stamps it); otherwise the tier is *derived* from the entry's formula picks (most-foundational = min over `FEATURE_TIERS` among its formulas), so an old lock with no `tier` still orders correctly. Unknown name → `feature`.

**Generate (the wiring agent `tier-ordering-wiring`, phase label `Dep audit`).** The script groups the Phase-3 pour roots by tier into `tieredEpics` (`{ tier, pourRoot, children }`). **Skipped** (mutation only) when `Context.dryRun` OR fewer than 2 non-empty tiers exist (nothing to order) — `TierWiring.skipped = true`, logged. Otherwise one agent:
- For each epic, reads its open children's **intra-epic** dep edges (`bd show <child> --json`, restricted to sibling children) to compute that epic's **ENTRY** beads (no dep on a sibling child) and **TERMINAL** beads (no sibling child depends on them); a singleton child is both.
- For each **consecutive** non-empty tier pair (Lower `L` immediately before Higher `H`): for every entry bead `E` of every `H`-epic and every terminal bead `Tm` of every `L`-epic, `bd dep add <E> <Tm>` (E depends on Tm) and **VERIFY** via `bd show <E> --json` (don't trust the exit code), retrying once. Writes are serialized. Only consecutive pairs are wired — the full chain is materialized link-by-link; the transitive `foundational → feature` edge is implied, not duplicated.
- Returns `{ wired: [{blocked, blocker}], verified, attempted, missing: [...], errors: [...] }` → stored as `TierWiring`. `missing` + `errors` feed the advisory-warnings tally (the *blocking* check is the topology assertion below).

## Phase 7 — Dep audit (sequential, 1 agent) + topology assertion (deterministic)

Topological sanity check on the DAG. Catches cycles, empty ready sets, and implicit file-conflict pairs that `/build-batch` would otherwise discover the hard way — **and** runs the Layer-2 topology assertion (the *assert* half of epic onv) as a pure-JS gate.

**Agent:** `dep-audit`
**Tools:** `Bash`
**Steps:**
1. `bd dep cycles` — must report no cycles. Any cycle is a hard blocker (T1: escalate).
2. `bd ready --json` — must return at least one non-epic issue. Empty ready set means the DAG is malformed (everything blocked).
3. **Implicit conflict scan:** for every pair of beads (B1, B2) where neither depends on the other (transitively), check whether `B1.metadata.filesTouched` and `B2.metadata.filesTouched` intersect. If yes, surface as `{ beadA: B1.id, beadB: B2.id, overlap: [<paths>] }`. These would race in `/build-batch`'s filesTouched conflict filter — not a hard fail, but worth flagging.
4. **Cross-dep verification:** confirm every entry in `ParsedPlan.crossDeps` has a corresponding `bd dep` edge. Resolve endpoint names to bead IDs via the Phase 3 `featureToPourRoot` map (passed in), **not** by title — molecule-epic titles are formula names, so a title search never matches and falsely reports every edge missing (`autonomous-build-3fr.3`). A name absent from the map = an unpoured feature (real gap). Phase 3 passes its `verified[]` edge list as a cross-check; surface only edges genuinely absent from the live DB. A genuinely missing poured-to-poured edge means Phase 3 dropped a cross-feature dep (a Phase 3 bug); a missing edge with an unpoured endpoint is a coverage gap, not a wiring bug.
5. **Bead graph (topology-assertion input):** emit one `{ id, tier, deps }` row for **every** open non-epic bead — `deps` = its direct blockers (open non-epic only), `tier` = looked up from the orchestrator-supplied `beadId → tier` map (computed in JS from `tieredEpics`); a bead not in the map (a Phase 4+5 rework split child / Phase-3.5 enforcement pour) inherits its parent epic's tier, or `unknown` / `enforcement` for an unmapped enforcement bead. This is the data the deterministic assertion runs over — it must be complete and accurate.

**Output:** `DepAuditResult = { cycles, emptyReady, implicitConflicts, crossDepsApplied, missingCrossDeps, beadGraph: [{id, tier, deps}], topologyValid: <bool>, topologyViolations: {...} }`

### Topology assertion (pure JS, no agent — runs in the orchestrator body)

The HARD CONSTRAINT: the workflow JS sandbox has no shell / `bd` / filesystem, so the *gather* (the `beadGraph`) is done inside the dep-audit agent, and the *assertion* is a deterministic pure-JS pass over that returned JSON. It builds adjacency from `beadGraph` and computes:

- **`acyclic`** — no cycle (DFS); reports the cycle path.
- **`tierMonotonic`** — for every edge `A → dep(B)` with both tiers known, `tierIndex(A) >= tierIndex(B)` (a bead only depends on its own tier or lower); collects inversions. Unknown-tier endpoints are not asserted on.
- **`reachesFoundation`** — only when a `foundational` tier exists: every non-foundational bead transitively reaches a foundational bead; collects orphans.
- **`initialReadyOk`** — only when a `foundational` tier exists: the zero-dep beads (the would-be initial `bd ready` set) are **foundational-only** (nothing dispatchable jumps a tier); collects violations.
- **`topologyValid`** = `acyclic && no tier inversions && initialReadyOk && no orphans`.

The collected violation lists are attached as `DepAuditResult.topologyViolations` for the report; `DepAuditResult.topologyValid` is set from the result. On a dry run / skip the `beadGraph` is empty and `topologyValid` is `true` vacuously, but the verdict uses `!== false` so it never spuriously blocks (and an empty graph also has no violations to report).

**Failure:** cycles or `emptyReady=true` → blocking for BLESSED. **An explicit `topologyValid === false` is blocking** (a cycle, tier inversion, orphan, or non-foundational bead in the initial ready set — the DAG would build out of order); it forces NEEDS-FIX and is named in the report's "Tier ordering + topology" section with the exact offending edges. Implicit conflicts, missing cross-deps, and tier-wiring shortfalls (`TierWiring.missing`/`errors`) are advisory (logged + tallied into `advisoryWarnings`, do not block verdict alone — but they manifest as a topology violation if they actually broke the order).

---

## Phase 8 — Synthesis & verdict (sequential, 1 agent)

Aggregate Phase 3–7 outputs, compute the overall verdict, write `decomposeReport.md`, and return the verdict to the runtime.

**Agent:** `write-report`
**Tools:** `Write`, `Read`, `Bash`
**Steps:**
1. Aggregate `PourResult[]`, `AtomizeSummary` + `qualityResults` (the Phase 4+5 rework loop's terminal state), `FidelityResult`, `DepAuditResult`.
2. Compute verdict:
   - **BLESSED** iff: every `PourResult.status == 'ok'` AND `AtomizeSummary.persistentlyOversized.length == 0` AND `AtomizeSummary.unsplittable.length == 0` AND every bead in every `qualityResults[].scores` (the final rework pass) has `score >= 95` AND the quality pass actually covered the beads (`scoredCount > 0` when `totalOpenNonEpic > 0`, and `scoredCount >= totalOpenNonEpic`) AND `FidelityResult.bin == 'pass'` AND `DepAuditResult.cycles.length == 0` AND `DepAuditResult.emptyReady == false` AND `DepAuditResult.topologyValid !== false` (Layer 2, onv — an explicit `false` from the topology assertion blocks; `undefined` from a dry-run/skip does not). The "every bead ≥ 95" check is vacuously true on an empty score set, so the coverage clause is load-bearing — a run that scored zero beads is NEEDS-FIX, never a silent pass.
   - **NEEDS-FIX** otherwise. The report explains exactly which condition failed.
3. **Baseline acceptance** (igu.2, separate `accept-baseline` agent; runs only when `verdict == BLESSED` AND not a dry run). Confidence/`autoChain` are computed *before* this so it knows whether the run is attended or a walk-away:
   - Capture a fresh **whole-repo** audit straight to the baseline path: `jankurai audit . --json agent/baselines/main.repo-score.json` (full, not `--changed-fast`; its exit code is advisory — nonzero on a sub-85 scaffold is expected). Validate the receipt has a numeric top-level `score`; a `{}`/non-parseable score is a FAIL (the lbq.14 trap), not an acceptable baseline.
   - Write `agent/audit-policy.toml` from `jankurai govern` (govern emits JSON → translate the recommended `minimum_score`/`fail_on`/`advisory_on`/timebox into TOML). **Documentation/tracking only** — the gate's BLOCK decision reads only the ratchet and ignores this floor (rule 9), so the 85 `minimum_score` never blocks in v1. Best-effort: skip if govern errors.
   - `.gitignore` care: ensure tracked `agent/` artifacts are NOT swallowed while `target/jankurai/` stays ignored; verify with `git check-ignore`.
   - Commit the tracked artifacts in their OWN commit (explicit `git add`, never `-A`). **Attended path** (`autoChain == false`): `chore: accept initial jankurai baseline (blessed at decompose)` — the human blesses the floor by reviewing `decomposeReport.md` before `/build-batch`. **Walk-away path** (`autoChain == true`, `--auto-bless`): `chore: accept jankurai baseline [TRUSTED-BY-POLICY, NOT BY HUMAN]` + a conspicuous report note — no human read the report before this floor armed the ratchet; auto-accepted because a never-accepted baseline means a ratchet that never fires in exactly the unattended window.
   - On a BLESSED run where acceptance fails, the DAG verdict is NOT flipped (the DAG is sound), but `baselineAccepted=false` is recorded and logged loudly — the gate will then SKIP (not block) the ratchet on early beads.
   - **High-water-mark advance (rule 7)** is owned by the *gate*, not decompose: on a green commit where the new whole-repo score exceeds `baseline_score`, `hooks/post-build-gate.{sh,ps1}` re-stamps the baseline upward (one-way, never lowered; `GATE_RESTAMP=off` suppresses it for build-batch's parallel workers). Decompose only sets the trusted *starting* line.
4. Write `decomposeReport.md` in cwd per the schema below (includes a "Jankurai baseline" section rendering the acceptance result + trust note).
5. Return `{ verdict, confidence, autoChain, baselineAccepted, baselineScore, baselineTrustedByPolicy, reportPath, ... }` to the runtime.

### Report schema

```markdown
# Decompose: <app-name> (<date>)

**Verdict:** <BLESSED | NEEDS-FIX>
**Plan source:** <plan.lock.json | plan.md (deprecation: rerun /vision)>
**Beads created:** <N> (<X> epics, <Y> tasks)
**App epic:** <id>
**Phases run:** preflight, parse-plan, pour (<N> features), quality-rework (<iterations> passes, <M> atomized, <K> epics scored), fidelity (A+B+C+reconcile), dep-audit, synthesis

## Verdict reasoning
<one paragraph: why blessed, or what blocks it>

## Coverage (Phase 6.A — plan-to-dag)
- <feature name> → <beadId(s)> ✓
- <feature name> → **GAP** (no bead)
- Cross-feature deps applied: <count> (sourced from Phase 3 `crossDepWiring.verifiedPresent` — edges wired AND verified by bead ID, not a title re-count)
- Cross-feature deps missing: <list from `crossDepWiring.missing` + `skipped`, each with its reason — an unpoured endpoint feature is the usual cause>

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

## Per-epic quality (Phase 4+5 — final rework pass)
### <epicId> — <title>
- <beadId> — <title> — <score>/100 ✓
- <beadId> — <title> — <score>/100 ⚠
  - Penalties: <list with rule + evidence>
  - Remediations: <numbered list>
  - Projected after remediation: <score>/100

## Rework / atomization (Phase 4+5)
- Rework passes run: <n>/3
- Atomized (split to the bar): <source → children list>
- Unsplittable (surfaced for human): <list with bead, attempted seams, reason>
- Persistently oversized after the final pass (still < 95 on sizing): <list>

## Pours (Phase 3)
- Successful: <N>
- Failed: <list with feature + error>

## Dep audit (Phase 7)
- Cycles: <none | list>
- Ready set on launch: <count> non-epic beads
- Implicit conflicts (filesTouched overlap, no dep): <list>

## Tier ordering + topology (Phase 7 — Layer 2, onv)
- Tiers present (build order): <tierWiring.tiers joined " < ">
- Cross-tier ordering edges wired: <tierWiring.verified>/<tierWiring.attempted> verified present (or "skipped — <reason>")
- Tier-wiring shortfalls: <tierWiring.missing + errors — advisory unless they manifest below>
- **Topology assertion (deterministic):** valid=<topology.topologyValid> over <nodeCount> beads — acyclic / tier-monotonic / reaches-foundation / initial-ready-⊆-foundational, each with its violation list. A `false` is a BLOCKING failure (forces NEEDS-FIX) naming the exact inverted/missing edges.

## Jankurai baseline (Phase 8)
<omit if NEEDS-FIX or dryRun>
- Baseline accepted: <yes/no> — whole-repo scaffold score <N>/100 (the regression-ratchet starting floor)
- Trust: <**⚠ TRUSTED-BY-POLICY, NOT BY HUMAN** (auto-accepted on --auto-bless; no human reviewed the floor) | blessed via this human-review gate>
- Tracking policy (`agent/audit-policy.toml` from `jankurai govern`): <written/skipped> (documentation only; 85 floor never blocks in v1 — rule 9)
- <if not accepted: **⚠ ratchet NOT armed** — <reason>; gate SKIPs the ratchet on early beads until a baseline exists>

## Next steps
<if BLESSED:>
The DAG is ready. To start the build:

    /build-batch --workers <suggested-N>

Suggested workers: <min(4, ready_count)>. Higher values yield diminishing returns once the merge queue dominates.
<if baseline trusted-by-policy: ⚠ baseline was auto-accepted WITHOUT human review (--auto-bless); inspect agent/baselines/main.repo-score.json to re-bless the starting line.>

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
- Returns to the conversation: `{ verdict, confidence, advisoryWarnings, autoChain, suggestedBuildBatch, baselineAccepted, baselineScore, baselineTrustedByPolicy, reportPath, appEpicId, beadCount, failedPhases: [...] }`.
- The orchestrator turn prints a one-line summary:
  - BLESSED: `"Decompose: BLESSED (confidence=<high|review-recommended>) — <N> beads under <appEpicId>. <auto-chaining | Run /build-batch when ready>. Report: <path>"`
  - NEEDS-FIX: `"Decompose: NEEDS-FIX — <reason>. Report: <path>"`

**Auto-chain is opt-in; the human-review gate is the default (lbq.1).** By default there is no auto-chain into `/build-batch` — the human reads the report and decides. That gate is deliberate: a bad plan can burn N workers' worth of Opus tokens. But it must not be the *only* path, or a walk-away run returns with zero app code written. So:

- **Confidence.** `BLESSED` is mechanical (all phase checks pass). `confidence` adds a second bar: `high` = BLESSED **and** zero advisory warnings (no implicit `filesTouched` conflicts, no missing cross-dep edges); `review-recommended` = BLESSED with advisories present; `n/a` = NEEDS-FIX.
- **`--auto-bless`.** When passed AND `confidence == 'high'` AND not a dry run, the workflow sets `autoChain: true` and returns `suggestedBuildBatch`. The **orchestrator / calling turn** then runs that build — `/decompose` itself never spawns `/build-batch` (no recursive workflow nesting; "one orchestrator at a time"). A `review-recommended` BLESSED never auto-chains even with `--auto-bless`; it falls back to the human gate. Without the flag, `autoChain` is always `false`.
- **Baseline trust on the walk-away path (igu.2 / D2).** On `autoChain`, Phase 8's baseline acceptance auto-accepts the scaffold score as the ratchet floor with a loud `[TRUSTED-BY-POLICY, NOT BY HUMAN]` commit + report note (`baselineTrustedByPolicy: true`). On the attended path the same floor is blessed by the human reviewing the report before `/build-batch` (`baselineTrustedByPolicy: false`). Either way the ratchet is armed before the first feature bead builds — the never-accepted-baseline gap lbq.14 reopened is closed.

---

## Stopping conditions

- Pre-flight prereq missing → Phase 1 stops; print the missing prereq.
- `plan.lock.json` is incomplete with blocking openQuestions → Phase 1 stops.
- Repo already has open beads → **phase 1** refuses (decompose phase 1 is for fresh repos); **phase > 1** refuses only if *this* phase was already decomposed (an open `Phase N…` epic exists), and otherwise re-enters (epic 0ms).
- `--phase N > 1` on a repo with no beads DB → refuses (phase 1 must have run first).
- A pour fails on required-var error → Phase 3 surfaces; verdict NEEDS-FIX.
- A rework split finds no clean seam → Phase 4+5 surfaces `unsplittable` (the rework agent's `unreworkable` action); verdict NEEDS-FIX.
- Rework loop hits `MAX_REWORK = 3` passes with beads still < 95 → verdict NEEDS-FIX: sizing-penalised survivors land in `persistentlyOversized`, the rest keep their real sub-95 score in `qualityResults` (so `allBeadsAt95` is false). The loop never fabricates a 95.
- `bd dep cycles` reports a cycle → Phase 7 blocks BLESSED.
- A bd command itself errors mid-workflow (jsonl lock, schema bug) → catch, record in report under "FAILED" section; verdict NEEDS-FIX with loud warning (T7).

---

## Do not

- Do not edit `plan.md` or `plan.lock.json`. The plan is read-only. Drift means re-run `/vision`, not patch in flight (T10).
- Do not auto-resolve fidelity disagreements. Surface both verifier verdicts and let the human pick (T1).
- Do not bless a DAG with `unsplittable` or `persistentlyOversized` beads via a workaround. The seam was genuinely missing or the formula is wrong; escalate, do not improvise.
- Do not skip Phase 6 cross-check because the pours looked clean. Single-pass coverage checks have a track record of false-positives; the adversarial pattern is the load-bearing reason this workflow exists.
- Do not call `bd create` outside of `bd mol pour` (T6: formula precedence). If a feature needs a bead the formula library doesn't produce, surface in the report as "Missing formula" and recommend a new formula in `autonomous-build/formulas/` — do not improvise the bead by hand.
- Do not commit `target/jankurai/` receipts — they are local generated outputs and must stay `.gitignore`d. The tracked exceptions are the Phase 8 baseline artifacts `agent/baselines/main.repo-score.json` and `agent/audit-policy.toml`, which ARE committed (in their own commit); Phase 8's `.gitignore` care keeps `target/jankurai/` ignored while ensuring `agent/` is not swallowed — verify with `git check-ignore`.
- Do not auto-invoke `/build-batch` on BLESSED. The human gate between decompose and build is intentional.
- Do not run the Phase 4+5 rework on closed beads. Each pass re-discovers the OPEN bead set before scoring, so a `superseded` source from a prior pass's split (closed by definition) is never re-scored or re-reworked.

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
