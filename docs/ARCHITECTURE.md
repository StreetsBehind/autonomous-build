# Architecture

## Design principles

1. **Beads is the state.** No parallel `tasks.yaml`, no markdown TODO drift. If it isn't in beads, it doesn't exist. The skills are thin glue over `bd` commands.
2. **Formulas are the intellectual property.** Each formula encodes a reusable work pattern (CRUD feature, auth flow, UI page). Building a new app is mostly picking and parameterizing formulas.
3. **The loop is dumb on purpose.** `/build-next` does: pick → claim → build → gate → close. All the intelligence about *what to build* lives in the formulas and the plan. All the intelligence about *when to stop and ask* lives in escalation rules.
4. **Escalation over guessing.** Anything that requires judgment the loop cannot self-verify becomes a `bd update --status=blocked` with a reason. The escalate skill summarizes blockers and pushes a notification.
5. **Worktree-per-task.** Each task builds in `bd worktree create task-<id>`, then commits and removes the worktree. Same beads DB, isolated checkout. Enables future parallelism with no redesign.

## Stage-by-stage

### `/vision` — vision.md → plan.md + plan.lock.json + tenets.md

Implemented as a **hybrid** (epic `autonomous-build-ih5`): a thin skill shell (`skills/vision/SKILL.md`) holds the human-present product conversation, and a **dynamic workflow** (`workflows/vision.spec.md` + `workflows/vision.js`) is the deterministic planning engine. The shell reads `vision.md`, quotes back must-haves/non-goals/constraints/success-metric for correction, helps fill missing product sections, runs the off-stack agent consult, then invokes the workflow and presents the gate (COMPLETE → coverage/concerns tables; NEEDS-INPUT → blocking questions + edit-vision-and-rerun). The shell carries no planning logic; the workflow owns it.

Inputs: `templates/vision.md` filled out by the user.
Outputs: a paired `plan.md` (human narrative) and `plan.lock.json` (schemaVersion 2 machine-readable mirror), plus `tenets.md` (T1–T10 inherited + app-specific), containing:
- Tech stack decision with one-line reasoning per choice (resolved from `docs/DEFAULT_STACK.md`, never negotiated with the user)
- Data model (entities, fields, relationships)
- Feature list ranked by dependency
- Formula picks (which `formulas/*.formula.toml` to pour, with variable bindings)
- `coverage[]` (every must-have → the feature(s) that deliver it + how) and `concerns[]` (each cross-cutting concern from `docs/PLAN_CONCERNS.md` decided: addressed-with-evidence or excluded-with-reason), the latter produced by the workflow's concern fan-out — one agent per applicable concern over a frozen skeleton
- Escalation budget (e.g. "block on >$5/day API spend")

The workflow runs four gates (forward-coverage, reverse-trace, decidedness, must-have↔non-goal) plus a required+excluded contradiction scan; any blocking question flips `incomplete: true`. The lock is built and validated against [`schemas/plan.lock.schema.json`](../schemas/plan.lock.schema.json) in pure JS before being written; field reference is in [`docs/PLAN_LOCK.md`](PLAN_LOCK.md). The lock is the source of truth `/decompose` consumes — `plan.md` exists for human review and as a fallback for repos that pre-date the lock; an `incomplete: true` lock is refused at `/decompose` pre-flight.

This stage runs *with the user in the loop* (the shell holds the conversation; the workflow is headless). The plan is a contract — the loop won't second-guess it later. For a large plan it may also propose a **phase split**, retaining deferred must-haves as `phase: 2+` entries (rather than dropping them) and presenting the proposed phases at the gate for the human to approve or edit (see *Phased builds* below).

### `/decompose` — plan.lock.json → blessed beads DAG

Implemented as a **dynamic workflow** (`workflows/decompose.spec.md` + `workflows/decompose.js`). Subsumes the three former skills `/compose`, `/quality-pass`, and `/split` — their behaviors are now Phases 3 (pour), 5 (score), and 4 (atomize) of one workflow.

Reads `plan.lock.json` (falling back to `plan.md` regex parse with a deprecation warning if the lock is absent), initializes beads in the app repo, runs `bd setup claude --project` + Jankurai scaffolding, then:
- **Pour (per-feature fan-out):** `bd cook <formula> --var k=v ... --persist` (or `bd mol pour`) to spawn each formula's issue subtree; `bd dep add` for cross-formula dependencies declared in the plan. Independent agents parallelize the pour (the old `/compose` skill was sequential).
- **Atomize:** oversized beads are split along a named seam (the old `/split`).
- **Score:** each bead gets a quality score (the old `/quality-pass`).
- **Adversarial fidelity cross-check:** two independent agents must agree the DAG covers the source plan before it's blessed.

Output: a populated beads DB with epics, tasks, and a working dep graph, plus a `decomposeReport.md` and a mechanical **`BLESSED` | `NEEDS-FIX`** verdict. The human reviews and authorizes the blessed DAG before any build stage runs. `bd ready` should then return the first true leaf tasks.

When the plan is phased, `/decompose --phase N` is **re-entrant**: it bootstraps (`bd init`, Jankurai scaffold, baseline acceptance) only at phase 1, pours just the current phase's slice under a phase epic just-in-time, and scopes its fidelity/coverage checks to that slice — a must-have assigned to a *future* phase is a legitimate *covered-in-phase-N* deferral, not a coverage gap (see *Phased builds* below).

### `/build-batch` — parallel build (the concurrent sibling of `/build-next`)

Implemented as a **dynamic workflow** (`workflows/build-batch.spec.md` + `workflows/build-batch.js`), converted from a former single-context skill. One orchestrator script holds in-memory pipeline state, dispatches `beads-builder` workers into their own `bd worktree`s in the background, polls each worker's completion marker file (a cheap `stat()` rather than an LLM round-trip), and merges results to `main` **one at a time** behind the `hooks/post-build-gate.{sh,ps1}` post-merge gate. Configurable `--workers`, `--max-merges`, and `--budget`.

It **refuses to run in meta mode** in its Phase 0 pre-flight agent (parallel workers would race on this repo's shared checkout). Use `/loop /build-next` for meta work. Keeping pipeline state in script variables (instead of conversation) makes the run cheap to poll and resumable in-session across a context compaction.

### `/build-next` — one tick of the loop

```
bd ready --json --limit 1
↓
bd update <id> --claim                      # atomic, fails if already claimed
↓
bd worktree create task-<id>
↓
implement against issue.acceptance          # the formula provides this
↓
hooks/post-build-gate.{sh,ps1}              # lint + typecheck + test + e2e + SCA + coverage (Node/Py/Rust)
↓
green?  → git commit, bd close <id>, worktree remove
red x1? → retry once with failure context
red x2? → bd update <id> --status=blocked --notes "<failure>"
escalation trigger? → block instead of guess (see ESCALATION_RULES.md)
```

The skill schedules the next wake via `ScheduleWakeup`:
- backlog non-empty → 60–180s
- backlog empty, blockers present → exit, call `/escalate`
- backlog empty, no blockers → exit, all done

### `/escalate` — blocked queue → PushNotification

Reads `bd blocked --json`, groups by reason category, and sends a single `PushNotification` with the summary. User responds, unblocks issues (`bd reopen` + edits), restarts the loop.

### `/flag` — in-flight workflow capture

When the user notices the loop did something the workflow itself should have prevented (vision picked wrong stack, gate too lax, formula's acceptance was vague), they invoke `/flag bd-<id> <reason>`. The skill labels the issue `workflow-issue` + a category sub-label and appends a `FLAG:` note. `/retro` reads these labels.

### `/retro` — workflow performance review

Implemented as a **dynamic workflow** (`workflows/retro.spec.md` + `workflows/retro.js`) rather than a turn-by-turn skill. The workflow fans out an independent agent per data source, then runs an adversarial cross-check (two agents must agree) on every proposed improvement bead before it's filed. Runs automatically at the loop's DONE exit (both ready and blocked are empty), and manually any time. Pulls from:
- App's beads DB: closure metrics, retry counts, flagged issues, blocked issues
- App git log: reverts of loop commits, post-close edits within 24h, suspiciously-fast closures (<30s)
- `autonomous-build`'s git log during the build window: mid-build edits to skills/workflows/formulas/gate (each one is evidence the workflow needed adjustment)
- `bd audit` interactions.jsonl: per-task tool-call activity
- Jankurai receipts under `target/jankurai/` and prior retros under `retros/`

Outputs:
1. A markdown report at `retros/retro-<app>-<date>.md`, including a "Uncertain (human triage)" section for proposed improvements whose evidence or fix didn't survive cross-check
2. Concrete improvement issues filed into autonomous-build's own beads DB under a per-retro epic, with `workflow-improvement`, `from-app:<name>`, and `retro-date:<date>` labels; acceptance criteria the loop can later self-verify (e.g. "edit `skills/vision/SKILL.md` to add SQLite bias for simple-v1 apps; verify by grep"). Idempotent — re-running the same retro will not duplicate previously-filed beads.

### Phased builds — vision identifies the boundaries, the loop runs per-phase

The stages above describe a single build pass, which is the **default**: a plan with one phase runs exactly as written (one `/decompose`, one build, one `/retro`). For a plan too big to review as one build — or one where a subset of must-haves isn't needed for the core end-to-end flow — `/vision` proposes a **phase split** (epic `autonomous-build-0ms`): phase 1 is the *walking skeleton* (the smallest feature set that makes the `successMetric` flow run end-to-end), and each later phase is one coherent layer. The human approves or edits the split at the vision gate. Phasing is additive and opt-in: a single-phase lock is byte-identical to the pre-phases shape.

When a plan has multiple phases, the stages compose into a loop driven by `/orchestrate`:

```
/vision  → whole-project plan + phase boundaries   (human reviews the split)
   │
   ▼
for each phase i = 1, 2, 3, … until phases exhausted:
   /decompose --phase i   → beads for THIS phase only (just-in-time)
   /build-batch           → drain phase i
   /retro --phase i       → what did we learn
   /replan i+1            → revise the next phase from the outcomes
```

The boundary is **not** a graph edge. Phases are isolated by **just-in-time decomposition** — while phase 1 builds, phase 2's beads do not exist yet, so there is nothing in `bd ready` to pick up early. This keeps beads the only state (principle #1) and the loop dumb (principle #3): no phase gate is encoded in the DAG. `/replan` is a scoped re-run of `/vision` (`/vision --replan-from N`) that freezes the already-built phases and re-derives the downstream provisional ones, feeding the prior phase's build outcomes + `/retro` report back in as added context; it may add, drop, reorder, or merge later phases. Cross-phase dependencies point backward only (phase `N+1` may depend on `N`, never the reverse — a forward dep would reference a bead that doesn't exist yet). Design of record: [`PHASED_BUILD_PROPOSAL.md`](PHASED_BUILD_PROPOSAL.md).

## The meta-loop

`autonomous-build/` is itself a `bd init`'d repo. Workflow improvement tasks filed by `/retro` are real beads issues here. You can work them by hand or — for ones whose acceptance is self-verifiable — run `/loop /build-next` *on this repo* and let the loop improve the loop. The same machinery applies; the only difference is the work product is a SKILL.md / `<name>.spec.md` / formula.toml diff instead of app code.

This is where the workflow compounds: the more apps you build, the more retros run, the more improvement issues get filed, and the better the next app's first draft is. The infrastructure improves itself.

## Why beads specifically

- **Dependency-aware ready queue** (`bd ready` excludes blocked, in-progress, deferred, hooked) — no custom scheduler needed.
- **Atomic claim** (`bd update --claim`) — multi-agent safe out of the box.
- **Formula/molecule system** — first-class workflow templates with variable substitution and DAG composition.
- **`bd worktree create`** — auto-redirects the beads DB so all worktrees share state.
- **JSON output everywhere** — skills can parse without scraping.

## Why a dedicated workflow repo

- Formulas evolve as you build more apps. Versioning them in their own repo means improvements compound rather than getting stranded in one app.
- Skills can be symlinked into `~/.claude/skills/` (global) while the source of truth lives here.
- `git log` on this repo is the history of how your build workflow itself has matured.
