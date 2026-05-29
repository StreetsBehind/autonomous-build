---
name: vision
description: Convert a filled-out vision.md into a concrete plan.md (tech stack, data model, feature order, formula picks). Use when the user says "run vision", "vision-to-plan", or invokes /vision on a fresh app repo that has vision.md present.
---

# vision

Turn a `vision.md` into a `plan.md` the rest of the pipeline can consume.

## Inputs

- `vision.md` in the current working directory (filled out from `autonomous-build/templates/vision.md`).
- [`docs/DEFAULT_STACK.md`](../../docs/DEFAULT_STACK.md) — the pinned Jankurai stack the plan resolves against. **Read this first.**
- [`docs/PLAN_CONCERNS.md`](../../docs/PLAN_CONCERNS.md) — the pinned cross-cutting concern vocabulary (`data-model`, `authn`, `authz`, `secrets`, `data-lifecycle`, `error-handling`, `observability`, `external-integrations`, `perf-envelope`, `abuse-surface`), each with its `addressed`-means bar and the rule that derives its applicability from the vision. Read alongside `DEFAULT_STACK.md`; the concern step (8.5) binds to it.
- The user is present for this stage — it's the last human-in-the-loop checkpoint before the autonomous build begins. **The checkpoint is for product, not tech.**

## Process

1. **Read `vision.md` end to end.** Do not skim. Then:
   - **Assign a stable ID to each §3 must-have** — `M1`, `M2`, … in document order. These IDs are load-bearing: they become `mustHaves[]` in the lock and the left column of the coverage map, and the forward-coverage gate (step 6.5) checks every one is delivered. One ID per discrete must-have; if a §3 bullet bundles two independent capabilities, split it into two IDs.
   - **Decompose the §8 success metric into observable steps** — `S1`, `S2`, … one per observable action/assertion in the metric (e.g. "I can sign up, create a habit, log it 3 days, see a streak of 3" → S1 sign up, S2 create habit, S3 log 3 days, S4 streak shows 3). These become `successMetric.steps[]`.
   - **Quote back** to the user the *non-goals*, *constraints*, *success metric*, **and the IDed must-haves** (`M1: …`, `M2: …`) so they can correct you — including catching a must-have you mis-split or missed — before you commit to choices.

2. **Resolve the stack from [`docs/DEFAULT_STACK.md`](../../docs/DEFAULT_STACK.md), silently.** Do **not** ask the user any technical questions — not language, framework, database, auth, hosting, tests, or lint. The stack is pinned at the repo level; per-app stack negotiation is forbidden. If `vision.md` §7 ("Tech preferences") expresses a preference, ignore it unless it materially conflicts with the pinned stack — in which case treat the conflict as a *product/scope* issue (see step 8), not a tech question.

3. **Fill the architecture rows from the default stack.** Every row in the `plan.md` Stack table comes from `docs/DEFAULT_STACK.md`. Copy the choices verbatim; the "Why" cell cites the default stack file in one line.

4. **Sketch the data model.** Entities, key fields, relationships. Just enough to drive the first migration. Assume Postgres.

5. **Order the features.** List from must-haves §3 in dependency order. Each feature is one to a few formulas (see `~/.beads/formulas/`). As you place each feature, note which must-have ID(s) (`M1`, `M2`, …) it delivers — you will turn this into the coverage map in step 6.5.

6. **Pick formulas — and bind variables against the formula contract, not from memory.** For each feature, identify which formula(s) from `bd formula list` will be poured. Then, for **each** chosen formula, run `bd formula show <name>` and read its declared `[vars.*]` blocks. Bind **only** the declared variable names — never invent a variable (e.g. do not write `auth_scheme` when the formula declares `auth_strategy`) — and for any variable whose description enumerates a closed set of allowed values, use **only** an enum-valid value verbatim. If the feature's real need has no matching enum value (e.g. the API uses HTTP Basic but the enum lacks a `basic` slot), that is a **formula gap**: note it under "Open questions for human" and escalate before `/decompose` runs — do not bind an off-enum value or remap to a near-miss (T1: do not guess). If no formula fits at all, note "needs new formula" — escalate to the user before `/decompose` runs (this is a *workflow* gap, not a tech preference).

6.5. **Build the coverage map.** Turn the must-have→feature notes from step 5 into the `coverage[]` map: one entry per `mustHaveId`, listing the `features` (by `featureOrder[].name`) that deliver it and **`how`**. `how` must state *how* the feature delivers the must-have — concrete, falsifiable evidence, not a restatement of the link. "M2 covered by the Streaks feature" is a bare link and is rejected; "the Streaks feature computes a consecutive-day count from logged completions and renders it per habit" is evidence. This mirrors `/decompose`'s anti-vagueness invariant: a verifier must be able to check the claim against the feature. Every `M`-ID from step 1 gets a coverage entry. (The assertion that no must-have is left uncovered is step 6.6.)

6.6. **Forward-coverage assertion (the gate).** This is what turns the coverage map from documentation into enforcement. Assert that **every** `mustHaves[].id` from step 1 appears in `coverage[]` with **≥1** `features` entry. For each must-have that is missing from `coverage[]` (or present with an empty `features` array), append an `openQuestions[]` entry:

   ```jsonc
   {
     "question": "Must-have <Mn> (\"<text>\") maps to no feature — which feature delivers it, or should it move to nice-to-haves (§4)?",
     "blockingCompose": true,
     "context": "Forward-coverage gate: every §3 must-have must map to >=1 feature, else it would be silently dropped during the build."
   }
   ```

   Any `blockingCompose: true` entry forces `incomplete: true` in the lock (per the schema/`incomplete` rule). No new downstream code is needed: `/decompose` Phase 1 already refuses when `incomplete == true` and prints the blocking `openQuestions` list (`decompose.spec.md` step 4), so a dropped must-have now stops the build with a named reason instead of vanishing. Do **not** paper over an uncovered must-have by inventing a feature to cover it — surface it as the blocking question and let the human decide (add a feature, or demote the must-have). Report PASS/uncovered in the closing summary (see "Closing summary").

7. **Off-stack technical decisions → agent consult, not human.** If a must-have feature needs something outside the pinned stack (e.g. a queue, a websocket gateway, a vector DB, a third-party API integration shape), do **not** add it to "Open questions for human." Instead, spawn a parallel 3-agent consult in a single message:
   - `Agent(subagent_type=Plan, description="Architect: minimal off-stack addition", prompt="Given the Jankurai stack in docs/DEFAULT_STACK.md and feature <X>, propose the minimal addition or an alternative shape that stays on-stack. Argue for your recommendation.")`
   - `Agent(subagent_type=general-purpose, description="Reviewer: risks of going off-stack", prompt="For feature <X> on the Jankurai stack, list the load-bearing risks of any off-stack addition and what we lose by staying on-stack. Be specific.")`
   - `Agent(subagent_type=general-purpose, description="Counter-arguer: stay on-stack", prompt="Argue that feature <X> can be served entirely from the Jankurai stack with no additions. Show how.")`
   
   Synthesize the three into one decision and record it in `plan.md` under a top-level section:
   
   ```markdown
   ## Decided by agent consult
   - **Question**: <what we asked>
   - **Decision**: <one line>
   - **Rationale**: <2–4 lines, citing whichever agent's argument carried>
   - **Reversal cost**: <what changes if we change our minds in 3 months>
   ```
   
   The human reviews `plan.md` after — they can reverse the decision at the gate, but they are **not** paged for it during planning.

8. **Set the escalation budget.** Copy from vision.md §9, fill defaults for anything left blank.

8.5. **Derive and decide the cross-cutting concerns.** Read [`docs/PLAN_CONCERNS.md`](../../docs/PLAN_CONCERNS.md) (the same way you read `DEFAULT_STACK.md`). For each of the ten concerns in its vocabulary:

   - **Derive applicability** from the human's product input per that doc's derivation rules — never invent it. Drive it from vision.md §3 (a must-have implying user accounts/per-user data → `authn`, and `authz` if >1 principal or cross-user data), §6 (a privacy/budget/infra constraint → `secrets` + `data-lifecycle`), and §8 (a success metric naming scale/latency/throughput → `perf-envelope`). `external-integrations` is always decided (even "none"); `data-model` and `error-handling` are always required. A concern resolves to `required`, `optional`, or `excluded-by-default`; **applicable** = `required` or `optional`.
   - **Decide a status** for every concern (applicable or not — `excluded-by-default` concerns are recorded as `excluded` with the standard reason so the decision is explicit and auditable). `addressed` requires *falsifiable evidence* meeting that concern's "addressed means…" bar: a `featureOrder[].name`, a formula, a tenet (by number), the quality gate, or a `DEFAULT_STACK.md` pin. A bare assertion ("we handle auth", "security is covered") is rejected, mirroring the coverage `how` rule and `/decompose`'s anti-vagueness invariant. `excluded` requires a one-line `reason`.
   - When addressing a concern needs an off-stack decision (e.g. `external-integrations` pulling in a queue or third-party API), that goes through the step 7 agent consult; the concern's evidence then cites the consult/decision.

   Write `concerns[]` into `plan.lock.json` (one entry per concern: `{concernId, status, evidence}` when addressed, `{concernId, status, reason}` when excluded). Add a `## Concerns` table to `plan.md` (see structure below). (The decidedness + required-excluded contradiction *gate* is step 8.6.)

9. **Derive the tenets.** Tenets are the principles the loop falls back on for build-time judgment calls — what to do when the bead spec, formula, gate, and lock don't decide for it. Produce `tenets.md` in the app repo from [`autonomous-build/templates/tenets.md`](../../templates/tenets.md):

   - The "Inherited workflow tenets" section is copied verbatim from the template — it summarizes T1–T10 from [`autonomous-build/docs/TENETS.md`](../../docs/TENETS.md). Do not paraphrase; the bullets are deliberately load-bearing.
   - The "App-specific tenets" section is generated:
     - **From vision.md §5 (non-goals)**: one `A_n` tenet per non-goal, restated as a "do not X" rule. Empty §5 → omit the subsection.
     - **From vision.md §6 (constraints)**: one tenet per binding constraint (privacy, budget, infra, deadline). Skip cosmetic constraints.
     - **From plan.lock §stack**: one fixed tenet — "Stack is locked at /vision time; mid-build swaps require re-running /vision." Always include.
     - **From plan.lock §agentConsults**: one tenet per consult decision so the same question is not re-litigated mid-build. The decision becomes the rule; the rationale becomes the why; the reversalCost is carried forward.
     - **From plan.lock §openQuestions where `blockingCompose: false`**: the chosen default becomes a tenet, with the question recorded in the why so a future builder knows it was deliberately deferred. Omit the subsection if there are no non-blocking open questions.
   - The "Escalation budget" section mirrors `plan.lock.escalationBudget`. This duplication is intentional — the builder reads tenets first.
   - Number A-tenets sequentially across all subsections (A1, A2, A3, ...). The numbering is local to the app; T-numbers stay reserved for the workflow tenets.

   Tenets are derived, not negotiated with the user. If a tenet would conflict with a workflow tenet (T1–T10), do not write the app tenet — surface the conflict in the `/vision` summary so the human can resolve it (usually by rephrasing the vision non-goal).

## Outputs: `plan.md` + `plan.lock.json` + `tenets.md`

`/vision` writes three paired files in the app repo CWD:

- **`plan.md`** — the human-readable contract (structure below). Quoted to the user, edited if they want, and kept in git as the narrative.
- **`plan.lock.json`** — the machine-readable mirror that `/decompose` consumes (schema v2). Same content in structured form, validated against [`autonomous-build/schemas/plan.lock.schema.json`](../../schemas/plan.lock.schema.json) before writing. In addition to the stack/data-model/feature fields, write the v2 coverage fields: `mustHaves[]` ({id, text} from step 1), `successMetric.steps[]` ({id, text} from step 1), `coverage[]` ({mustHaveId, features, how} from step 6.5), and `concerns[]` (one decided entry per concern from step 8.5). See [`docs/PLAN_LOCK.md`](../../docs/PLAN_LOCK.md) for the field reference.
- **`tenets.md`** — the build-time judgment-call reference, derived from [`autonomous-build/templates/tenets.md`](../../templates/tenets.md) per step 9. Read by `/build-next` when an agent faces a question the bead spec / formula / gate don't answer.

Write all three. Before writing the lock, cross-check each `featureOrder[].vars` entry against its formula's declared vars (from `bd formula show`): every bound key must be a declared variable name, and every value of an enum-typed variable must be enum-valid. A key that isn't declared, or an off-enum value, is a hard stop — fix the binding (step 6) or escalate the formula gap; do not write a lock that pours will reject or that improvises a rename. If schema validation fails on the lock, stop — do not write a partial lock or a tenets file derived from a partial lock. If `plan.md` §"Open questions for human" has any items the user must answer before composing, write the lock anyway with `incomplete: true` and `openQuestions[].blockingCompose: true` for those items, and still write `tenets.md` (the blocking questions become tenets that say "do not proceed until the human answers"); `/compose` will refuse cleanly with the structured reason.

### Closing summary

After writing the three files, print a closing summary to the user. It must include:

- the **coverage table** — every must-have (`M1`, `M2`, …) with the feature(s) that deliver it — so the human sees, at the gate, exactly which feature carries each must-have. State **PASS** (every must-have covered) explicitly; if the forward-coverage assertion (step 6.6) found an uncovered must-have, list the offending must-haves and note that `incomplete: true` was written and `/decompose` will refuse until the vision or coverage is fixed.
- the **concerns table** — every concern with its applicability, status, and evidence/reason (step 8.5). State **PASS** (every applicable concern decided, no required+excluded contradictions) explicitly; if the decidedness gate (step 8.6) found an undecided applicable concern or a required+excluded contradiction, list the offending concerns and note that `incomplete: true` was written and `/decompose` will refuse.

### `plan.md` structure

Use this exact structure so `/compose`'s fallback parser (for repos that pre-date plan.lock.json) still works:

```markdown
# Plan: <app name>

## Stack
| Layer | Choice | Why |
| --- | --- | --- |
| Language | ... | ... |
| Backend framework | ... | ... |
| Frontend framework | ... | ... |
| Database | ... | ... |
| ORM/driver | ... | ... |
| Auth | ... | ... |
| Hosting | ... | ... |
| Tests | ... | ... |
| Lint/format | ... | ... |

## Data model
- **Entity**: fields, relationships, notes
- ...

## Feature order
1. <feature> — formulas: `[app-skeleton]`, vars: `{name=...}`
2. <feature> — formulas: `[crud-feature]`, vars: `{entity=Habit, fields=[name,description]}`
3. ...

## Coverage
> Every must-have (§3) maps to the feature(s) that deliver it and HOW. Mirrors `coverage[]` in the lock. Every M-ID appears exactly once; an uncovered must-have blocks /decompose (see step 6.6).

| Must-have | Delivered by | How |
| --- | --- | --- |
| M1: <text> | <feature name> | <how the feature delivers it — evidence, not a restatement> |
| M2: <text> | <feature name(s)> | ... |

### Success metric steps
> §8 decomposed into observable steps. Mirrors `successMetric.steps[]`.

- **S1**: <observable>
- **S2**: <observable>

## Concerns
> Every cross-cutting concern (docs/PLAN_CONCERNS.md) decided: addressed (with falsifiable evidence) or excluded (with reason). Mirrors `concerns[]` in the lock. One row per concern; silence is not an option (see step 8.5).

| Concern | Applicability | Status | Evidence / Reason |
| --- | --- | --- | --- |
| data-model | required | addressed | <entities in Data model> |
| authn | required | addressed | <feature/formula citing who + mechanism> |
| ... | ... | ... | ... |
| abuse-surface | excluded-by-default | excluded | <no public unauthenticated surface> |

## Cross-feature dependencies
- Feature 3 depends on feature 1's auth tasks (use `bd dep add`)

## Decided by agent consult
> One block per off-stack decision. Empty section is fine; omit the section entirely if there were no consults.
- **Question**: ...
- **Decision**: ...
- **Rationale**: ...
- **Reversal cost**: ...

## Escalation budget
- Max session cost: $...
- Max failures per task: ...
- Additional block triggers: ...

## Open questions for human
> Product/scope only. Tech ambiguity does NOT belong here — see "Decided by agent consult" above.
> If this section is non-empty, /compose will NOT run. Resolve here first.
- ...
```

## Stopping conditions

Only **product/scope** ambiguities stop the plan. Tech ambiguity is never a stopping condition — it routes to step 7 (agent consult) or to `docs/DEFAULT_STACK.md`.

- vision.md has internal contradictions in *product/scope* (e.g. a must-have that the non-goals exclude, a success metric the must-haves cannot satisfy) → list them under "Open questions", ask the user, do not write a plan.
- A must-have feature has no matching formula → list under "Open questions" as a workflow gap, recommend either picking a closer formula with adjustments or writing a new one in `autonomous-build/formulas/`. (This is a workflow question for the human, not a tech preference.)
- vision.md is missing entire product sections (problem, users, must-haves, non-goals, success metric) → ask the user to fill them in before continuing. Missing tech preferences (§7) are *fine* — that section is now ignored.

## Do not

- Do not run `bd init` or create any issues — that is `/compose`'s job.
- Do not start implementing — even a `package.json` is too early.
- **Do not ask the user any technical question.** Stack, framework, database, auth, hosting, tests, lint — all come from `docs/DEFAULT_STACK.md`. Off-stack needs go through the 3-agent consult, not the human.
- Do not put tech choices in `plan.md` §"Open questions for human" — that section is product/scope only.
- Do not invent a stack row that isn't in `docs/DEFAULT_STACK.md` without going through the agent consult and recording the decision under "Decided by agent consult".
- **Do not ask the user about tenets.** Tenets are *derived* from vision.md non-goals/constraints + plan.lock agentConsults + deferred openQuestions. If you can't derive a tenet, the source section is empty — omit the subsection. Do not invent tenets that aren't grounded in the vision or lock.
- Do not paraphrase the inherited workflow tenets (T1–T10). Copy them verbatim from `templates/tenets.md`; their phrasing is load-bearing for downstream skills that grep for tenet IDs.
