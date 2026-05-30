---
name: vision
description: Convert a filled-out vision.md into a concrete plan.md + plan.lock.json (schemaVersion 2) + tenets.md. Hybrid design — a thin skill shell (skills/vision/SKILL.md) runs the product conversation (stack resolve, data model, feature order, formula picks) and invokes this dynamic workflow for the concern fan-out engine (1 agent per applicable concern over a frozen skeleton) + the decidedness/coverage gates + lock assembly. Use after a fresh app repo has a filled-out vision.md.
---

# vision

The product checkpoint of the pipeline, implemented as a **hybrid**: a thin `/vision` **skill** shell (`skills/vision/SKILL.md`) for the parts that need a human product conversation, plus a **dynamic workflow** (`workflows/vision.js`, see https://code.claude.com/docs/en/workflows) for the concern-derivation engine that wants parallelism, independence, and reproducibility. This file is the spec for the **workflow** half (epic `autonomous-build-ih5`).

`/vision` turns a human's loose product brief (`vision.md`) into the structured, machine-checkable contract the rest of the pipeline builds against: `plan.md` (human-readable), `plan.lock.json` (schemaVersion 2, see `schemas/plan.lock.schema.json`), and `tenets.md` (T1–T10 inherited + any app-specific additions).

## How this spec runs

This file is a **workflow spec**, not a skill. The canonical script will live at `workflows/vision.js` in this repo (hand-authored from this spec, the same convention `decompose.js` / `retro.js` / `vision-eval.js` follow — it is **not** first-run-generated) and is linked into `~/.claude/workflows/vision.js` by the installers so the runtime finds it user-globally from any app repo. Keep the spec and the script **in sync in the same commit** — when this spec changes meaningfully, edit `workflows/vision.js` to match. (`workflows/vision.js` is authored by `autonomous-build-ih5.2`–`ih5.4`; this bead, `ih5.1`, authors only the spec.)

**Agent prompts must be self-contained.** Every agent the workflow spawns runs with the *app repo* as cwd, where this spec does not exist (only the `.js` ships to `~/.claude/workflows/`; `.spec.md` is repo-only). So the workflow must **inline** everything an agent needs — the concern vocabulary, the applicability derivation table, and the "Evidence — what counts" bar from `docs/PLAN_CONCERNS.md` — as JS consts in `vision.js`, exactly the documented-sync discipline `vision-eval.js` already uses (`CONCERN_IDS`, `EVIDENCE_BAR`). An agent prompt must never tell an agent to read `docs/PLAN_CONCERNS.md` or `workflows/vision.spec.md` by a bare relative path — it resolves to the app cwd and is never found.

## Why a hybrid (skill shell + workflow), not one or the other

The two halves of `/vision` have opposite needs:

- **The product conversation is interactive.** Reading the vision, resolving an underspecified must-have, deciding a stack deviation, running the step-7 off-stack consult — these may need a human turn ("§3 must-have 4 has no matching formula — add one or drop it?"). A dynamic workflow is headless; it cannot hold that conversation. So the **skill shell keeps Steps 1–5 + 7–8** (read vision, resolve stack, derive data model + feature order, pick formulas, off-stack consult, assemble outputs).
- **The concern derivation wants fan-out.** Deciding ten concerns is ten *independent* judgements against the same frozen skeleton, each wanting the same evidence bar applied the same way. Doing them one-at-a-time in a single context cross-contaminates (the model anchors on the last concern's framing) and is not reproducible. One agent per applicable concern, in parallel, over a **frozen** skeleton, gives independence + reproducibility — the same argument `vision-eval`'s L4 judge panel makes. So the **workflow owns Step 6 + the gates 6.5/6.6/6.7/8.6** (concern fan-out, decidedness, forward-coverage, reverse-trace, must-have↔non-goal).

The seam between them is the **skeleton**: the skill shell produces it (stack + data model + feature order + must-haves + success metric + non-goals), freezes it, and hands it to the workflow; the workflow fans out concern derivation over it, runs the gates, and hands back `concerns[]` + `coverage[]` + `openQuestions[]` + a decidedness verdict; the shell assembles the final three files. The skeleton is frozen so every concern agent reasons against identical inputs (a concern agent must never see another's output, nor mutate the skeleton).

```
skills/vision/SKILL.md (shell)         workflows/vision.js (engine)
  Step 1  intake/validate vision.md
  Steps 2–5 build skeleton ───────────▶ Phase 1  intake/validate (re-validate skeleton contract)
  (freeze skeleton)                      Phase 2  skeleton normalize + applicability derivation
                                         Phase 3  concern fan-out (1 agent / applicable concern)
                                         Phase 4  reconcile + decidedness verdict + assemble
  Steps 7–8 consult + write files ◀──── { concerns[], coverage[], openQuestions[], incomplete }
```

`vision.js` is invokable directly (`/vision` from the shell, or `Workflow vision` for a headless run over a complete skeleton). When invoked with no skeleton — a bare `vision.md` and nobody to converse with — it runs the skeleton-build steps itself in best-effort headless mode (the same contract `vision-eval`'s run agent uses: apply documented defaults, never invent product content, block instead of papering over). That headless path is what makes `/vision` gradeable by `vision-eval`.

---

## Inputs

The workflow accepts these arguments (parsed from the invocation; all optional):

| Arg | Default | Meaning |
| --- | --- | --- |
| `--vision <path>` | `vision.md` in cwd | The human's product brief. Sections §1 problem, §2 users/roles, §3 must-haves, §4 nice-to-haves, §5 non-goals, §6 constraints, §7 tech-preferences, §8 success metric, §9 escalation budget, §10 anything-else (the numbering `templates/vision.md` ships — success metric is §8, non-goals §5). |
| `--skeleton <path>` | none | A frozen skeleton JSON produced by the skill shell (Steps 2–5). When present, Phases 1–2 validate it instead of re-deriving; when absent, the workflow builds the skeleton headlessly (the `vision-eval` path). |
| `--out <path>` | `plan.lock.json` in cwd | Where the assembled lock is written. `plan.md` + `tenets.md` are written next to it. |
| `--no-file` | false | Dry-run: run all four phases and return the would-be lock + verdict, but write nothing. Used to inspect a derivation before it lands. |
| `--replan-from <N>` | none | **/replan** (epic `autonomous-build-0ms`): a scoped re-run. Loads the existing lock + the latest retro, **freezes** phases `< N` (already built) verbatim, and **re-derives** phases `>= N` (re-cut: add/drop/reorder/merge of downstream provisional phases) with the prior build's outcomes as context. See "Replan" below. |

The workflow expects to run **in the app repo's root** (where `vision.md` lives), not in `autonomous-build`. There is no `--self` analog — there is no `vision.md` for the workflow repo itself.

## Replan (`--replan-from N`, epic 0ms)

`/replan` is implemented as a **scoped re-run of `/vision`**, not a separate engine — it reuses the same skeleton/concern/gate/assemble machinery and only changes the boundary conditions:

1. **Pre-load** (a `replan-load` agent, Phase 1): read the existing `plan.lock.json` + the most recent retro for the just-built phase. The frozen phases (`< N`) and prior must-haves + the retro summary are passed into the Phase-2 skeleton prompt as context.
2. **Re-derive** Phases 1–4 normally. The skeleton agent is told phases `< N` are BUILT + FROZEN (do not re-litigate) and to re-cut phases `>= N` in light of what shipped.
3. **Merge** (pure-JS `mergeReplan(existing, rederived, N)`, Phase 4): phases `< N` are taken **verbatim from the existing lock** (status forced to `built`); phases `>= N` come from the re-derivation. **The freeze is enforced here in pure JS** — it holds no matter what the skeleton agent re-proposed for the built phases. Global fields (stack, concerns, escalationBudget) come from the re-derivation. Validated against the schema like any assembled lock.
4. **Dropped-must-have gate:** a must-have that existed at phase `>= N` in the OLD lock but is **absent** from the re-derivation (and not deferred) is a **loud blocking `openQuestion`** (`replan-dropped-musthave:` context), not a silent edit — dropping a must-have is a product decision the human must confirm (the lock comes back `incomplete: true`, so `/decompose` refuses it until resolved). `--replan-from 1` (or below) freezes nothing and is a full re-derivation.

---

## The concern vocabulary (inlined, SYNC with docs/PLAN_CONCERNS.md)

`vision.js` inlines the ten concern ids and the applicability derivation as JS consts (the agents run in the app cwd and cannot read the doc — same rule `vision-eval.js`'s `CONCERN_IDS` follows):

```
CONCERN_IDS = [
  'data-model', 'authn', 'authz', 'secrets', 'data-lifecycle',
  'error-handling', 'observability', 'external-integrations', 'perf-envelope', 'abuse-surface'
]
```

Each concern carries its **default applicability** and its **"resolves to required when…"** rule, transcribed verbatim from the derivation table in `docs/PLAN_CONCERNS.md` §"Applicability — and how it is derived", plus the per-concern **"`addressed` requires (falsifiable)"** bar from §"The concern vocabulary". The falsifiability rule itself (the five valid anchors — feature / formula / numbered tenet / gate / DEFAULT_STACK pin — and "a bare assertion fails") is inlined as `EVIDENCE_BAR`, identical to `vision-eval.js`'s const so the producer and the grader apply the same bar.

> **SYNC rule.** When `docs/PLAN_CONCERNS.md` changes its vocabulary, derivation table, or evidence bar, the inlined consts in `vision.js` change **in the same commit** — the same source-of-truth discipline `decompose.spec.md` ↔ `decompose.js` and `vision-eval.js` already use. A concern-vocabulary change ripples to (at least) `vision.js`, `vision-eval.js`, and `decompose.js`; all move together.

---

## Phase 1 — Intake + validate (sequential, 1 agent)

Verify the run is viable and produce the `Context` the rest of the workflow consumes. Any failure stops the workflow with a clear message (T1, T7) — `/vision` is the product checkpoint, so a failure here is "the vision is underspecified," surfaced for the human, never papered over.

**Agent:** `intake`
**Tools:** `Bash`, `Read`, `Glob`
**Steps:**
1. `--vision` path exists. If not, fail with "no vision.md at `<path>` — `/vision` needs a filled product brief."
2. Parse the vision's sections. **Load-bearing sections** (§1 problem, §3 must-haves, §8 success metric) must be filled — not empty, not template placeholders. If any is empty/placeholder → `{ status: 'needs-input', missing: [<section>], note }`. The skill shell turns `needs-input` into a human question (the product checkpoint); a headless `Workflow vision` run surfaces it as a block (`incomplete: true` with a `missing-product-sections` openQuestion) rather than inventing content (T1).
3. If `--skeleton` was passed, read it and validate it carries the skill-shell outputs (`app`, `mustHaves[]`, `successMetric`, `stack`, `dataModel[]`, `featureOrder[]`, plus the parsed `nonGoals[]`). A malformed skeleton fails loud. If `--skeleton` is absent, set `headless: true` (Phase 2 will build the skeleton itself).
4. Resolve `--out` and the sibling `plan.md` / `tenets.md` paths.

**Output:** `Context = { visionPath, sections: { problem, users, mustHaves, niceToHaves, nonGoals, constraints, techPreferences, successMetric, escalationBudget, anythingElse }, skeleton: <obj|null>, headless: <bool>, outPath, planMdPath, tenetsPath, dryRun }` — keyed by section *name* (the intake agent maps by heading, not by number, so a renumbered vision still parses).

**Failure:** missing vision, unparseable sections, or a malformed `--skeleton` → stop (T1/T7). `needs-input` is a clean structured exit, not a crash.

---

## Phase 2 — Skeleton (sequential, 1 agent)

Produce (or normalize) the **frozen skeleton** the concern fan-out reasons against, and pre-compute each concern's applicability so Phase 3 only spawns agents for the concerns that are actually applicable.

**Agent:** `skeleton`
**Tools:** `Bash`, `Read`
**Steps:**
1. **Skeleton source.**
   - If `Context.skeleton` is present (skill-shell path): normalize it into the canonical shape below; do not re-derive (the human already had that conversation).
   - If `Context.headless` (the `vision-eval` / `Workflow vision` path): derive the skeleton from the vision per the skill's Steps 2–5 — resolve the stack against `docs/DEFAULT_STACK.md` (inlined pins; never deviate without a recorded consult), derive `dataModel[]` from §3 must-haves, derive `featureOrder[]` (build sequence, deps respected: auth before per-user data), and pick formulas per `docs/DEFAULT_STACK.md` §"Stack-native formulas" (prefer the stack-native variant; generic fallback only when no native variant covers the capability). **Never invent product content** — if a must-have has no matching formula, that is a Phase-4 block (`no-matching-formula`), not a guess.
2. **Normalize to the canonical skeleton:**
   ```
   Skeleton = {
     app: { name, slug, summary },
     mustHaves: [{ id, text, deferred?, phase? }],    // ids stable — concerns + coverage bind to them; phase tags the build slice (epic 0ms)
     successMetric: { statement, steps: [<string>] },
     stack: { <layer>: { choice, why }, ... },
     dataModel: [{ entity, fields: [...], relationships: [...] }],
     featureOrder: [{ name, formulas: [...], vars: {...}, mustHaveId?, phase? }],  // phase matches the must-have it delivers
     nonGoals: [<string>],                            // from §5 — Phase 4's musthave-nongoal gate reads this
     agentConsults: [{ decision, rationale, alternatives }],  // any off-stack decisions already made by the shell
     phases?: [{ id, name, goal }]                    // only when split into >1 phase; names/goals for derivePhases (epic 0ms)
   }
   ```

   **Phasing — the trigger+cut heuristic (epic `autonomous-build-0ms`).** The skeleton agent applies the *judgment* of where to cut; pure-JS `derivePhases` assembles the structure. Default to a **single phase**. Propose a multi-phase split only when (a) the must-have set is too big to be one reviewable build, or (b) a subset is not needed for the core end-to-end success-metric flow ("could ship without it"). Cut: **phase 1 = the walking skeleton** (the minimal must-haves that make `successMetric` run end-to-end); later phases = remaining must-haves grouped by dependency layer + cohesion, any risky/off-stack feature isolated into its own phase; cross-phase deps point **backward only**. Tag each `mustHaves[].phase` (and the `featureOrder[].phase` of the feature delivering it) accordingly, and supply `phases: [{id,name,goal}]`. A later-phase must-have is **never dropped** — tagging it is the fix for the vanishing-must-have bug. (`deferred:true` is the legacy spelling of `phase:2`.)
3. **Pre-compute applicability** for each of the ten `CONCERN_IDS`. The split that keeps this testable + honest: the `skeleton` agent emits only the **observable `signals`** it can read off the frozen skeleton + vision sections (booleans — `impliesAccounts`, `multipleHumanRoles`, `multiplePrincipals`, `crossUserData`, `privacyConstraint`, `holdsPii`, `productionOperation`, `externalIntegrations`, `scaleTarget`, `publicSurface`); a **pure-JS `deriveApplicability(signals)`** then applies the inlined derivation table to resolve each concern to `required`, `optional`, or `excluded-by-default`. (The agent reports facts; the rule is code — so the derivation is reproducible and the `--selftest` exercises it with no agents.) **Applicable** = `required` or `optional`; `excluded-by-default` concerns are recorded directly as `status: 'excluded'` with the standard reason (no agent needed) **unless** a signal elevates them.
   - **Oracle-grounded reconciliation (SYNC note):** `docs/PLAN_CONCERNS.md` + `skills/vision/SKILL.md` say a §6 *privacy **or budget*** constraint elevates `secrets`/`data-lifecycle`. The eval oracle (fixture `04-public-unauth-api`) establishes that a **budget** line alone is a cost ceiling, *not* a secret-management signal — elevating `secrets` on budget there would manufacture a false `required+excluded` contradiction. So `deriveApplicability` elevates `secrets` only on `authnRequired || externalIntegrations || privacyConstraint`, and `data-lifecycle` only on `privacyConstraint || holdsPii`. A paid-API budget surfaces instead as `externalIntegrations`. (Reconciled: `docs/PLAN_CONCERNS.md` dropped "budget" from the `secrets` elevator in bead `autonomous-build-lvl`; `skills/vision/SKILL.md` no longer carries the concern-derivation prose post-`ih5.5`.)
4. **Freeze.** The skeleton is immutable from here. Phase 3 agents receive a deep copy; none may mutate it. (The freeze is what makes the ten derivations independent + reproducible.)

**Output:** `FrozenSkeleton` (the object above) + `applicability = { <concernId>: 'required' | 'optional' | 'excluded-by-default' }`.

**Failure:** headless skeleton derivation that hits a must-have with no formula, or a stack deviation with no consult, returns a structured block carried into Phase 4 (do not stop here — Phase 4 owns the verdict so every block is reported together, T7).

---

## Phase 3 — Concern fan-out (parallel fan-out, 1 agent per *applicable* concern)

The engine. One independent agent per **applicable** concern (`applicability != 'excluded-by-default'`), each deciding *its one concern* against the frozen skeleton — `addressed` with falsifiable evidence, or `excluded` with a reason. Agents do **not** see each other's output (the runtime fan-out provides the isolation by construction); none mutates the skeleton.

**Agent:** `concern` (one per applicable concern; typically 3–8 of the 10)
**Tools:** `Read`, `Bash`
**Inputs per agent:** `{ concernId, applicability, frozenSkeleton, visionSections, EVIDENCE_BAR, concernBar }` — `concernBar` is this concern's inlined "`addressed` requires (falsifiable)" line.
**Steps per agent:**
1. Decide `status`: is this concern `addressed` by the skeleton, or legitimately `excluded`?
2. If `addressed`: produce **falsifiable evidence** meeting `EVIDENCE_BAR` — cite a `featureOrder[].name`, a formula, a numbered tenet, the gate, or a `DEFAULT_STACK` pin. A bare assertion is not allowed (it is exactly what `vision-eval` L4 flags); if the only honest evidence would be a bare assertion, the concern is **not** actually addressed → either `excluded` with a reason, or (if it should be addressed but the skeleton has no feature for it) emit a `blockingQuestion`.
3. If `excluded`: produce a one-line `reason`.
4. If the concern **cannot be decided** from the skeleton + vision (genuinely underspecified), return a `blockingQuestion` instead of guessing (feeds the Phase-4 decidedness gate).
5. If `addressed` evidence cites a feature, also emit the implied `coverage` link (`{ mustHaveId, features }`) when the concern maps to a must-have, so Phase 4 can assemble `coverage[]`.

**Output per agent:**
```
ConcernResult = {
  concernId,
  status: 'addressed' | 'excluded',
  evidence?: <string>,           // required when addressed (falsifiable)
  reason?: <string>,             // required when excluded
  applicability,                 // echoed from input
  coverageLink?: { mustHaveId, features: [<name>] },   // when addressed-by-feature
  blockingQuestion?: { question, context }              // when undecidable; context starts with a gate token (see below)
}
```

**Concurrency:** ≤10 agents, well under the runtime's 16-concurrent cap; let it parallelize freely. Excluded-by-default concerns are *not* spawned — Phase 4 folds them in directly as `status: 'excluded'`.

**Failure (T7):** a concern agent that errors returns `{ concernId, status: 'failed', reason }` rather than throwing; Phase 4 treats a failed derivation as undecided (a blocking openQuestion, never a silent drop).

---

## Phase 4 — Reconcile + decidedness verdict + assemble (sequential, pure-JS + 1 write-agent)

Collect the Phase-3 results, fold in the excluded-by-default concerns, run the four gates, compute the decidedness verdict, build the `plan.lock.json` object, and render `plan.md` + `tenets.md`. **Everything except the file write is pure JS** (reconcile, gates, lock assembly, schema validation, plan.md/tenets.md rendering) — deterministic, reproducible, and selftestable with no agents, the same discipline the gates already use and the property `vision-eval`'s L3 stability layer grades. The **lone Phase-4 agent is a dumb file-writer**: it receives the already-built, already-validated lock/plan.md/tenets.md content and writes it verbatim (the sandbox has no filesystem). Building the machine contract in code, not in an agent, is what keeps the lock identical across runs and what lets the `--selftest` exercise the whole Verify path (complete → COMPLETE+valid; required+excluded → NEEDS-INPUT+`incomplete:true`) without spending an agent.

### Gates (the controlled `openQuestions[].context` vocabulary)

Each gate that fires appends a blocking `openQuestion` whose `context` **starts with** a controlled gate token, so downstream (`/decompose` pre-flight, `vision-eval` L2) can map a block to its gate. The token set is the **same vocabulary** `vision-eval.js`'s `GATE_TOKENS` matches (SYNC with `skills/vision/SKILL.md` gates):

| Gate | Token | Fires when |
| --- | --- | --- |
| **6.5 decidedness** | `concern-decidedness` | any applicable concern is undecided (a Phase-3 `blockingQuestion` or `status: 'failed'`). |
| **6.6 forward-coverage** | `forward-coverage` | a **phase-1** §3 must-have maps to no `featureOrder[]` feature. A future-phase (`phase >= 2`) must-have with no feature yet is a deliberate deferral (covered-in-phase-N, epic 0ms), **not** a gap — it does not fire. |
| **6.7 reverse-trace** | `reverse-trace` | a `featureOrder[]` feature traces to no §3 must-have / declared infra need (scope creep). |
| **8.6 musthave-nongoal** | `musthave-nongoal-contradiction` | a §3 must-have contradicts a §5 non-goal (internally inconsistent vision). Conservative substring check, **negation-aware on both sides**: the non-goal strips a leading negator and a must-have occurrence that is itself negated (e.g. "…no free-form code generation") agrees with the non-goal and does not fire — only a non-negated occurrence is a real contradiction (g63). Errs toward not-firing; a false block of a coherent plan is the worse failure for the stability harness — deeper semantic detection is future work. |
| (also) **required+excluded** | `required-excluded-contradiction` | a **signal-elevated** applicable concern is decided `excluded` — the vision implied the product needs it (e.g. accounts ⇒ `authn`) but the plan excluded it. Does **not** fire for the *decide-only* concerns (`data-model`, `error-handling`, `external-integrations`), where `excluded` is a valid decision ("none", "stateless CLI"). This is the acceptance's contradiction scan. |
| (also) **no formula** | `no-matching-formula` | a must-have's feature has no installed formula (carried from Phase 2; a formula-less `featureOrder[]` entry is also caught here at assembly and dropped from the lock). |
| (also) **empty product** | `missing-product-sections` | load-bearing sections were empty (carried from Phase 1's `needs-input` on the headless path). |

`incomplete` is **defined** as "any `openQuestion.blockingCompose === true`" — the same definition `schemas/plan.lock.schema.json` and `vision-eval`'s L1 enforce. The verdict is not a separate boolean; it falls out of the gate results.

### Steps

1. **Reconcile (pure JS):** merge the Phase-3 `ConcernResult[]` with the excluded-by-default concerns into the lock's `concerns[]`. The lock status enum is `addressed | excluded` **only** — an undecided concern cannot be represented in the lock, so it surfaces as a blocking `openQuestion` (decidedness) instead, and a blocking plan may carry fewer than ten `concerns[]` entries (that is why `vision-eval`'s L1 only requires all-ten-decided on a *complete* plan). The required+excluded contradiction scan runs here (signal-elevated concerns only; `DECIDE_ONLY_CONCERNS` exempt). Build `coverage[]` from the must-haves + the concern `coverageLink`s + `featureOrder[].mustHaveId` mapping.
2. **Run the four gates (pure JS set checks)** over the frozen skeleton + reconciled concerns; collect blocking `openQuestions[]` with their gate tokens.
3. **Decidedness verdict:** `incomplete = openQuestions.some(q => q.blockingCompose)`. (Mechanical, not a judgement.)
4. **Assemble + validate + render (pure JS):** build the `plan.lock.json` object conforming to `schemas/plan.lock.schema.json` (schemaVersion 2). This is the mechanical skeleton→lock **mapping**: drop the skeleton fields the lock has no slot for (`app.slug`, `mustHaves[].deferred`, `successMetric.statement`, `featureOrder[].mustHaveId`), decompose `successMetric` into `{id,text}` steps, and map the skeleton's stack layers onto the schema's `stack` key enum (unmappable layers drop to `plan.md` prose). **Build-order tier (Layer 1, epic `autonomous-build-onv`):** every assembled `featureOrder[]` entry is stamped with an authoritative `tier ∈ {foundational, platform, feature, enforcement}` via `deriveFeatureTier(entry.formulas)` — the single source-of-truth mapping (`TIER_RULES`) from formula-name pattern to tier (case-insensitive, first-match-wins per formula; an entry with multiple formulas takes the **most-foundational** tier among them — ordering `foundational < platform < feature < enforcement`). `foundational` = app-skeleton / OTel-observability bootstrap (the scaffolding the whole tree depends on); `platform` = shared infra/services (tenancy, `oidc`/`openfga`/`authn`/`authz`, audit, `terraform`/`iac`, migrations, secrets, composer grammar); `enforcement` = `concern-enforcement` + `e2e`/`*-acceptance` gates; `feature` is the **default** (CRUD, gRPC, integrations, jobs, anything unmatched). Each entry also gets an optional `requires: []` (featureOrder names this feature builds after, for finer cross-feature ordering — empty/reserved for now). `/decompose` consumes `tier`/`requires` to wire the cross-epic ordering edges (deriving a fallback from the formula category for old locks without `tier`). **Phasing (epic 0ms):** `derivePhases` reads `phaseOf` (explicit `phase` int, else `deferred ⇒ 2`, else `1`) across the must-haves + features; if more than one distinct phase exists it emits a top-level `phases[]` (`{id,name,goal,status,provisional}` — phase 1 `active`/decided, later phases `planned`/`provisional`) and tags every `mustHaves[].phase` + `featureOrder[].phase`. A single-phase plan emits **neither** — the lock is byte-identical to the pre-phases shape (so the change is additive and `schemaVersion` stays 2). `renderPlanMd` surfaces the proposed split as a `## Phases` section for the human gate. Then render `plan.md` (human-readable) and `tenets.md` (T1–T10 inherited verbatim — inlined as `TENETS_INHERITED_MD`, SYNC with `templates/tenets.md` + `docs/TENETS.md` — plus one app tenet per §5 non-goal + the locked-stack tenet). Validate the assembled lock against the schema with `validateLock` (a strict **superset** of `vision-eval.js`'s L1 `validatePlanLock`: the same checks plus the `additionalProperties` / stack-key-enum constraints).
5. **Write (1 agent):** the lone Phase-4 agent writes the three already-built strings to `planLock` / `planMd` / `tenets` paths verbatim. Skip the agent entirely if `Context.dryRun` (return the would-be lock + verdict, write nothing).
6. **Return** the verdict + paths to the runtime (and, on the skill-shell path, back to the shell for the human-facing summary).

**Output:** `{ status: 'ok' | 'needs-input' | 'failed', incomplete: <bool>, lock: <obj>, openQuestions: [...], reportPaths: { planLock, planMd, tenets }, dryRun }`.

**Failure (T7):** the lock is built **in pure JS, not by an agent**, so a `validateLock` failure is a deterministic workflow bug — there is no agent to retry. Return `{ status: 'failed', lock, validationErrors }` with the errors loud and **write nothing**. (A write-agent that fails to write a valid lock is logged loud but does not corrupt the verdict.)

---

## Agent I/O schemas (per-phase structured output)

Every `agent()` call that must return data uses a JSON Schema so the runtime validates the shape (the convention `decompose.js` / `vision-eval.js` follow). The load-bearing ones:

- **`intake`** → `{ status: 'ok'|'needs-input'|'failed', context?: {...}, missing?: [<section>], failedReason?: <string> }`
- **`skeleton`** → `{ skeleton: <FrozenSkeleton>, signals: { <signalName>: <bool> }, blocks?: [{ token, note }] }` — the agent emits observable `signals`; the workflow computes `applicability` from them in pure JS (`deriveApplicability`), so the agent never hand-assigns a concern's tier.
- **`concern`** (per applicable concern) → the `ConcernResult` shape above: `{ concernId, status: 'addressed'|'excluded'|'failed', evidence?, reason?, applicability, coverageLink?, blockingQuestion? }`
- **`assemble`** (the write-agent) → `{ status: 'ok'|'failed', written: [<path>], failedReason?: <string> }` — it only reports which files it wrote; the lock/plan.md/tenets.md content is the workflow's (built + validated in pure JS), not the agent's, so it carries no `validationErrors` (validation already happened upstream).

> **Honesty note (mirrors `vision-eval`'s "honest" rule).** The `concern` agent is schema-constrained on its *output shape* but the workflow does **not** hand it the answer — it must derive `addressed`/`excluded` and the evidence itself. The `EVIDENCE_BAR` is applied by the agent at derivation time and re-checkable downstream by `vision-eval`'s L4 judge: `/vision` is the producer, `vision-eval` is the independent grader, and they share only the inlined bar — never a verdict.

---

## Sync rules

- **`spec ↔ js`** — edit `workflows/vision.spec.md` and `workflows/vision.js` in the same commit (house rule; T3). Spec-only edits with no JS counterpart are a workflow bug.
- **`CONCERN_IDS` + applicability table + `EVIDENCE_BAR` ↔ `docs/PLAN_CONCERNS.md`** — inlined as JS consts because the agents run in the app cwd and cannot read the doc. When the vocabulary, derivation table, or evidence bar changes, update `vision.js` in the same commit. The same change typically also touches `vision-eval.js` and `decompose.js`.
- **gate tokens ↔ `skills/vision/SKILL.md` gates ↔ `vision-eval.js` `GATE_TOKENS`** — the controlled `openQuestions[].context` vocabulary the workflow emits is the same set `vision-eval` matches. Keep a token stable even if a gate's prose changes.
- **lock shape ↔ `schemas/plan.lock.schema.json`** — Phase 4 assembles to schemaVersion 2 and validates against the schema. When the schema changes, update Phase 4's assembly to match.
- **skill shell ↔ workflow seam** — `skills/vision/SKILL.md` (the thin shell, rewritten by `autonomous-build-ih5.5`) owns Steps 1–5 + 7–8; this workflow owns Step 6 + gates 6.5/6.6/6.7/8.6. When the seam moves, both move together.

---

## Run-completion behavior

When the workflow finishes:
- Returns to the conversation (or the skill shell): `{ status, incomplete, reportPaths: { planLock, planMd, tenets }, openQuestions: [...], dryRun }`.
- The shell / orchestrator prints a one-line summary:
  - complete: `"Vision: plan.lock.json written (N concerns decided, M must-haves covered) → ready for /decompose."`
  - incomplete: `"Vision: BLOCKED — <K> open question(s): <gate tokens>. Resolve in vision.md and re-run /vision."` (a blocked lock has `incomplete: true`; `/decompose` pre-flight refuses it — the same gate the must-have/decidedness path uses.)

---

## Stopping conditions

- `vision.md` missing or load-bearing sections (§1/§3/§8) unfilled → Phase 1 `needs-input` (shell asks the human; headless run blocks via `missing-product-sections`). Never invent product content (T1).
- A concern cannot be decided from the vision → Phase 3 `blockingQuestion` → Phase 4 `concern-decidedness` block.
- A must-have maps to no feature → `forward-coverage` block. A feature with no source must-have → `reverse-trace` block.
- A must-have's feature has no installed formula → `no-matching-formula` block.
- A must-have contradicts a non-goal → `musthave-nongoal-contradiction` block.
- A stack deviation is needed but no consult was recorded → block (carried from the skeleton phase).
- The assembled lock fails schema validation → `failed` (loud, write nothing) — a workflow bug, not a product gap.

---

## Do not

- Do not invent product content (must-haves, users, features). The vision is the human's input; an underspecified vision blocks, it is not filled in (T1).
- Do not let a concern agent see another concern agent's output, or mutate the frozen skeleton — that breaks the independence + reproducibility the fan-out exists for.
- Do not accept a bare assertion as `addressed` evidence. The `EVIDENCE_BAR` is the same one `vision-eval` L4 grades against; a rubber-stamp here is caught downstream — derive real evidence or mark the concern `excluded`/blocking.
- Do not emit a `plan.lock.json` that fails `schemas/plan.lock.schema.json` validation.
- Do not deviate from the pinned `docs/DEFAULT_STACK.md` without a recorded `agentConsults[]` entry.
- Do not tell an agent to read `docs/PLAN_CONCERNS.md` or this spec by a bare relative path — inline everything (the agents run in the app cwd; see "Agent prompts must be self-contained").
- Do not edit `vision.md`. It is the human's read-only input; drift means a human edit + re-run, not an in-flight patch (T10).

---

## Relationship to other skills + workflows

- **Wraps** `skills/vision/SKILL.md` — the thin shell (rewritten by `autonomous-build-ih5.5`) runs the product conversation and invokes this workflow for the concern engine. The shell + workflow together are `/vision`.
- **Consumes** `vision.md` (the human's product brief) + `docs/DEFAULT_STACK.md`, `docs/PLAN_CONCERNS.md`, `docs/TENETS.md`, the formula library.
- **Produces** `plan.md` + `plan.lock.json` (schemaVersion 2) + `tenets.md`.
- **Feeds** `/decompose` — the BLESSED-able lock is its input; an `incomplete: true` lock is refused at decompose pre-flight (`schemas/plan.lock.schema.json` + `decompose.spec.md` Phase 1 step 4).
- **Graded by** `workflows/vision-eval.spec.md` — `vision-eval` runs this workflow headlessly over a fixture corpus and scores the lock (L1 contract, L2 oracle, L3 stability, L4 evidence vagueness, L5 propagation). The shared `EVIDENCE_BAR` + `GATE_TOKENS` are what let the grader check the producer without sharing a verdict.

---

## Authoring `vision.js` (sync checklist)

Hand-authored JS pattern — this spec is NOT regenerated on first invocation; `workflows/vision.js` is authored from it by `autonomous-build-ih5.2`–`ih5.4` and kept in lockstep thereafter.

1. **`ih5.2`** authors `vision.js` Phases 1–2 (intake/validate + skeleton) + the inlined `CONCERN_IDS` / applicability table / `EVIDENCE_BAR` consts + the node-bridge for pure-JS gate selftests.
2. **`ih5.3`** authors Phase 3 (concern fan-out, 1 agent per applicable concern over the frozen skeleton).
3. **`ih5.4`** authors Phase 4 (reconcile + the four gates + decidedness verdict + assemble lock v2 / tenets / plan.md).
4. **`ih5.5`** rewrites `skills/vision/SKILL.md` into the thin shell that invokes the workflow.
5. **`ih5.6`** installs the hardlink (`install.sh` / `install.ps1`) + an end-to-end smoke test + docs update.

When this spec changes after `vision.js` exists, edit both in the same commit (T3).
