# Phased builds — JIT per-phase decompose + inter-phase replan

**Status:** proposed (design of record); implementation tracked under epic `autonomous-build-0ms`.
**Date:** 2026-05-29.

## Problem

The planning agent already *wants* to phase work — in a real run it decided certain
features belonged in a later build. But the pipeline has no way to express or honor that:

1. **The deferral signal evaporates.** The `/vision` skeleton lets a must-have carry
   `deferred: true` (`workflows/vision.js:105`, `:953`), but the forward-coverage gate just
   *skips* it (`vision.js:573`) and the skeleton→lock mapping **strips the field entirely**
   (`vision.js:672`, `vision.spec.md:182`). A "this is really phase 2" must-have doesn't get
   deferred — it **vanishes**: no lock entry, no bead, no record it ever existed.
2. **No phase concept in the plan.** `plan.lock.json` (`schemas/plan.lock.schema.json`) has a
   flat `featureOrder[]`; order matters only for pour sequence and cross-deps.
3. **A dead branch downstream.** `/decompose`'s fidelity verifier C *looks* for a
   "deferred / out-of-v1" marker (`decompose.spec.md:235`, `decompose.js:795`) that `/vision`
   never emits, so that path is effectively dead.
4. **A flat ready queue.** `bd ready` returns every topologically-unblocked leaf;
   `/build-batch` and `/build-next` build whatever is ready. There is no "don't start the next
   slice yet."

The result: the only way the planning agent can say "later" today is to drop the feature on the
floor or bury it in a non-goal note.

## The shape: a phase loop, not a gated graph

The key realization is that phase isolation does **not** need a gate in the bead graph. If we
decompose **just-in-time** — one phase at a time — then while phase 1 is building, *phase 2's
beads do not exist yet*. There is nothing in `bd ready` to accidentally pick up. The "boundary"
is not a graph edge; it is the orchestration loop pausing to **replan and decompose the next
slice**. This keeps the loop dumb (design principle #3) and beads as the only state (#1).

```
/vision  → whole-project plan, phase boundaries identified   (human reviews the split)
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│  for each phase i = 1, 2, 3, … until phases exhausted:        │
│    /decompose --phase i   → beads for THIS phase only         │
│    /build-batch           → drain phase i                     │
│    /retro --phase i       → what did we learn                 │
│    /replan i+1            → revise the next phase from outcomes│  ← the new step
└─────────────────────────────────────────────────────────────┘
```

Single-phase apps are the default: a plan with one phase runs exactly like today (one
decompose, one build, one retro), so this change is **opt-in and backward-compatible**.

## Design decisions (settled)

- **Skeleton-first phase 1.** Phase 1 is the *walking skeleton* — the smallest feature set that
  makes the `successMetric` end-to-end flow actually run. A tracer bullet that proves the
  architecture and yields something runnable to review. (Alternative considered: risk-first.
  Rejected as the default; the skeleton derisks the architecture, which is the more common need.
  Risk-first remains expressible by hand-editing the phase split at the vision gate.)
- **`/replan` is a scoped re-run of `/vision`** (`/vision --replan-from N`): it loads the
  existing lock, freezes already-built phases, and re-derives phases `> N` with the prior
  phase's build outcomes + retro as added context. Reuses vision's gates/coverage/concern
  machinery rather than duplicating it.
- **Later phases are provisional sketches.** `/vision` fully specs phase 1 and leaves phases 2+
  as a named goal + a rough must-have assignment. Replan firms up the next phase when it's
  reached — no point fully speccing phase 3 up front when replan will rewrite it.
- **No hard cap on phase count.** `phases[]` is an ordered list; the loop runs until it is
  exhausted, and replan may extend, drop, or re-cut downstream phases.
- **Single-phase by default.** Phasing is proposed only when a threshold is crossed (below).

## The phase-boundary heuristic

There is no purely mechanical cut that is right for every app, so the rubric exists to make the
agent's proposal **legible and falsifiable**; the human approves or edits it at the vision gate.

**Trigger (when to propose a split at all).** Default to a single phase. Propose a multi-phase
split only when either:
- the must-have set exceeds a size/budget threshold (the plan is too big to be one reviewable
  build), or
- a subset of must-haves is not needed for the core end-to-end flow ("we could ship without
  these") — the cleavage the planning agent detected in the run that motivated this work.

**Cut (how to draw the boundaries).**
1. **Phase 1 = the walking skeleton** — the minimal features that make `successMetric.steps[]`
   (already in the lock) execute end-to-end, even thinly.
2. **Each later phase = one coherent layer** — remaining must-haves grouped by dependency
   layering + subsystem cohesion. Anything needing an off-stack addition or a brand-new formula
   is *isolated into its own phase* so a risky bet does not block the skeleton.

**Guardrails (mechanical, the agent must satisfy each).**
- Every phase is **independently shippable** — the gate stays green and the app is runnable at
  the phase's end, not mid-refactor.
- Every phase is **size-bounded** — a soft cap on bead count / budget so phase 1 cannot swallow
  the whole plan.
- **Cross-phase dependencies point backward only** — phase `N+1` may depend on `N`, never the
  reverse. (Forward deps would break JIT decomposition: the depended-on bead wouldn't exist
  yet.)

## Stage-by-stage changes

### `/vision`
- Emit a `phases[]` structure in `plan.lock.json` (schema below) and tag every `featureOrder[]`
  and `mustHaves[]` entry with its `phase` (default `1`).
- Run the trigger + cut heuristic; **retain** deferred must-haves as `phase: 2+` entries instead
  of dropping them (delete the strip at `vision.js:672`; stop discarding `deferred`). This fixes
  the vanishing-must-have bug.
- Present the proposed phase split at the human gate alongside the existing coverage/concerns
  tables; the human approves or edits.
- Phase 1 is fully decided (decompose-ready); phases 2+ are provisional (goal + rough must-have
  assignment).

### `/decompose` — re-entrancy + `--phase N`
- New `--phase N` argument; default `1`.
- **Relax the fresh-repo refusal.** Today decompose hard-refuses if the repo already has open
  beads (`decompose.spec.md:49`). It must become phase-aware: refuse only if *this phase* already
  has open beads; allow re-entry for the next phase on a repo that already holds prior phases'
  (closed) beads.
- **Bootstrap only at phase 1.** `bd init`, Jankurai scaffold (Phase 2), and baseline acceptance
  (Phase 8) are fresh-repo operations — they run only for phase 1. Later phases skip the
  bootstrap, pour the new slice under a **phase epic**, and ride the gate's existing high-water
  baseline re-stamp.
- **Scope the checks to the phase slice.** Fidelity / coverage (Phase 6) verify *this phase's*
  features and must-haves, not the whole plan. Verifier C treats a must-have assigned to a
  *future* phase as a legitimate deferral (covered-in-phase-N), not a gap — this lights up the
  currently-dead branch.

### `/replan` (new — implemented as `/vision --replan-from N`)
- Load the existing lock; freeze phases `< N` (built); re-derive phases `>= N` with the prior
  phase's build outcomes + `/retro` report as added input.
- Re-cut the downstream provisional phases (may add/drop/reorder/merge). The human reviews the
  revised split at the same gate `/vision` uses.

### `/orchestrate` — the phase loop
- Phase-aware stage detection: which phase are we in, is the current phase drained, is there a
  next phase.
- Drive the loop: `decompose --phase i → build-batch → retro --phase i → replan i+1`, repeating
  until `phases[]` is exhausted, with the same escalate/resume-poll behavior at build-time
  blocks. The phase crossing reuses the existing `--auto-bless`-style seam (auto-advance on a
  walk-away run; stop for human review by default).

### `/retro` — per-phase
- New `--phase N` scoping; the report becomes an explicit input to `/replan`.

## Schema changes (`plan.lock.json`)

All additive — **`schemaVersion` stays `2`** (the versioning rules in `docs/PLAN_LOCK.md` count
new optional fields as non-breaking). A lock with no `phases` and no `phase` tags is a
single-phase plan and behaves exactly as today.

- New optional top-level `phases[]`:
  ```jsonc
  "phases": [
    { "id": 1, "name": "Walking skeleton", "goal": "...", "status": "active",   "provisional": false },
    { "id": 2, "name": "Enhancements",     "goal": "...", "status": "planned",  "provisional": true  }
  ]
  ```
- New optional `featureOrder[].phase` (integer, default `1`) and `mustHaves[].phase` (integer,
  default `1`).
- `additionalProperties: false` on those objects means the schema file must be edited to admit
  the new keys, but the version need not bump. If a later change makes `phase` *required* or
  changes phase semantics, that is when `schemaVersion` goes to `3`.

## What this fixes for free

- **The vanishing must-have** (#1 above): a deferred must-have becomes a phase-tagged entry that
  survives into the lock and the per-phase DAG.
- **The dead verifier-C branch** (#3 above): a future-phase must-have is now exactly the
  "deliberately deferred" case verifier C was written to recognize.

## Open / deferred questions

- **Phase-size cap value.** The "size-bounded" guardrail needs a concrete default (bead count?
  budget? both?). Start with a soft warn, not a hard fail.
- **Re-cut safety.** If replan drops a must-have entirely (not just defers it), that should be a
  loud human decision, not a silent edit — likely a new openQuestion gate token.
- **Cross-phase deps in the lock.** `crossFeatureDependencies` may now span phases; the
  backward-only guardrail should be validated at the vision gate.

## Implementation plan

Tracked as a bead epic in this repo (meta mode → built with `/loop /build-next`, not
`/build-batch`). Rough order:

1. Schema + `docs/PLAN_LOCK.md` (foundation — blocks the rest).
2. `/vision` phase proposal + retain-deferred fix.
3. `/decompose` re-entrancy + `--phase N`.
4. `/replan` as scoped `/vision`.
5. `/orchestrate` phase loop.
6. `/retro --phase N`.
7. `docs/ARCHITECTURE.md` + `README.md` pipeline overview.
