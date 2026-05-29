---
name: orchestrate
description: End-to-end build-app driver — sequence the full pipeline (/vision → /decompose → /build-batch → /escalate|/retro) from a filled vision.md, clearing the seams it can clear autonomously and stopping only at genuine human gates. Use when the user says "build this app", "run the whole pipeline", "/orchestrate", or hands off a vision.md and walks away. The walk-away entry point; refuses meta mode.
---

# orchestrate

The top-level driver that turns a filled-out `vision.md` into a built app with no human at the seams — except the seams that genuinely need one. Nothing else sequences the four stages; without this, the human is the orchestrator at every boundary except build→retro. This skill IS that missing orchestrator (bead `autonomous-build-lbq.2`).

It does not re-implement any stage. It **invokes the existing slash commands** (`/vision`, `/decompose`, `/build-batch`, `/escalate`, `/retro`), reads their structured returns, and decides what to do next. Each stage still owns its own gates, escalations, and quality bars.

## Invocation

```
/orchestrate [--auto-bless] [--workers N] [--budget $X]
```

- `--auto-bless` — clear the decompose→build seam autonomously on a **high-confidence** BLESSED (this is the walk-away switch; see Stage 2). It ALSO clears the **phase crossing** in a phased build (auto-advance to the next phase after replan; see "The phase loop"). Without it, the orchestrator stops at the human-review gate after `/decompose` and at each phase crossing, exactly as today.
- `--workers`, `--budget` — passed through to `/build-batch`.

## Meta-mode refusal (first check, always)

```powershell
if (Test-Path "skills/build-next/SKILL.md") { <refuse> }
```

If the marker exists, this is the `autonomous-build` workflow repo itself. **Refuse**: "MODE: meta — /orchestrate builds *apps*, not this workflow repo. Use /loop /build-next for meta work." Exit. (Same marker `/build-batch` uses; T9.)

## Stage detection

The orchestrator is resumable: it figures out where the pipeline is from the repo state, so a re-invocation after a pause/crash picks up where it left off rather than restarting.

| State | Next stage |
|---|---|
| `vision.md` present and filled; no `plan.lock.json` | **Stage 1 — /vision** |
| `plan.lock.json` present; bd has no open non-epic beads | **Stage 2 — /decompose** |
| bd has ready non-epic beads | **Stage 3 — /build-batch** |
| ready=0, blocked>0 | **Stage 4a — /escalate + resume-poll** |
| ready=0, blocked=0, beads were built | **Stage 4b — /retro**, then DONE |
| no `vision.md` at all | STOP: "no vision.md — nothing to build. Fill the vision template first." |

Detect with cheap checks: `Test-Path vision.md / plan.lock.json`, `bd ready --json` (filter epics), `bd list --status=blocked --json` (the human-needed set — not `bd blocked`, which lists only dependency-blocked beads and misses the `--status=blocked` ones the loop sets; autonomous-build-gh4).

**Phase awareness (epic 0ms — first thing after `plan.lock.json` exists).** Read `plan.lock.json` `phases[]`. If it is absent or has ≤1 entry, this is a **single-phase** plan: the table above applies verbatim (one decompose → one build → one retro → DONE). If `phases[]` has **>1 entry**, the build runs the **phase loop** below, and stage detection becomes phase-scoped:

| State (multi-phase) | Next stage |
|---|---|
| no `Phase i` epic exists for the lowest unbuilt `phases[].id` `i` | **/decompose --phase i** |
| `Phase i` epic exists with ready/in-progress non-epic beads | **/build-batch** (resume phase i) |
| `Phase i` epic drained (children closed), not yet retro'd | **/retro --phase i**, then the **phase crossing** |
| `Phase i` drained + retro'd AND a `phases[]` entry with id > i exists | **/replan --replan-from i+1** → crossing (auto-advance with `--auto-bless`, else STOP for review) |
| every `phases[]` entry built + drained | **final /retro**, then DONE |

The "lowest unbuilt phase" is resumable from bd state alone: the `Phase i` epics that exist + whether their children are closed tell the orchestrator exactly where a paused/crashed run left off.

## Stage 1 — /vision

Invoke `/vision`. Read its result:

- **Vision incomplete** (blocking `openQuestions`, `incomplete: true`, or `/vision` asks the human something it cannot decide) → **STOP** and surface the questions. A vision gap is a product decision; the orchestrator does not invent product. This is a real human gate.
- **plan.md + plan.lock.json + tenets.md produced** → proceed to Stage 2.

## Stage 2 — /decompose (the seam that needs the --auto-bless decision)

Invoke `/decompose` — **with `--auto-bless` iff the orchestrator was invoked with `--auto-bless`**. Read its structured return `{ verdict, confidence, autoChain, suggestedBuildBatch, reportPath }`:

- **`verdict == 'NEEDS-FIX'`** → **STOP**. The DAG is not buildable. Surface `reportPath` and the top fixes; do not loop /decompose blindly (a re-pour won't fix a bad plan). This is a human gate.
- **`verdict == 'BLESSED'` and `autoChain == true`** (high-confidence BLESSED + `--auto-bless`) → proceed to Stage 3 automatically. This is the seam the orchestrator clears for a walk-away run.
- **`verdict == 'BLESSED'` and `autoChain == false`** (either no `--auto-bless`, or `confidence == 'review-recommended'`) → **STOP at the human-review gate**: print "Decompose BLESSED (confidence=<…>) — review `<reportPath>`, then re-run `/orchestrate --auto-bless` (or `<suggestedBuildBatch>`) to build." The human gate stays the default; a `review-recommended` BLESSED never auto-chains even with `--auto-bless` (advisory warnings deserve a glance).

Do not auto-chain a NEEDS-FIX or a review-recommended verdict under any flag — that gate is what stops a bad plan from burning N workers' worth of tokens.

## Stage 3 — /build-batch

Invoke `/build-batch --workers <N or suggested> --budget <X if set>`. It fans out workers, merges behind the post-merge gate, and returns `{ merged, blocked, failed, postAction, drained }`. Then branch on its outcome (Stage 4).

## Stage 4 — drain handling

- **4a — `blocked`/`failed` present (postAction == 'escalate')**: `/escalate` has notified (or build-batch returned the marker). Enter **resume-poll** — the same behavior `/build-next` uses (see `skills/build-next/SKILL.md` "Resume-poll on full block"): schedule a long-interval wake (~20–30 min), re-check `bd ready`, and resume Stage 3 the moment the human reopens a bead. Notify once per distinct block state. Backstop on budget exhaustion / max wall-clock (~48h). **Do not exit** — that strands the unattended window (bead `autonomous-build-lbq.4`).
- **4b — clean drain (`drained == true`, postAction == 'retro-suggested')**: **single-phase** → invoke `/retro`, print the final summary, exit **DONE** (the app is built). **Phased build (multi-entry `phases[]`)** → this was a *phase* draining: invoke `/retro --phase i` and go to the **phase crossing** (replan + advance-or-stop; see "The phase loop"). DONE only fires after the *last* phase drains.

## The phase loop (phased builds — epic autonomous-build-0ms)

When `plan.lock.json` carries a multi-entry `phases[]`, the app is built **one phase at a time** — JIT per-phase decomposition: phase `i+1`'s beads do not exist until phase `i` is built and the next phase is replanned. The orchestrator reuses Stages 2–4 verbatim as the **per-phase body**, adding the `--phase` argument and one new step (replan) at the boundary:

```
/vision  → whole-project plan with phases[] identified   (Stage 1; human reviews the split)
for i = 1, 2, … until phases[] is exhausted:
    /decompose --phase i     → beads for phase i ONLY, under a "Phase i" epic   (Stage 2 gate)
    /build-batch             → drain phase i                                    (Stage 3 + 4a)
    /retro --phase i         → phase i learnings (report feeds the replan)      (Stage 4b, scoped)
    ── phase crossing ──     → if a phase i+1 exists: /replan --replan-from i+1, then advance
```

**Per-phase body.** Steps 1–3 are exactly Stages 2, 3, and 4 with two changes: `/decompose` is invoked **`--phase i`** (pours only that slice; its BLESSED/NEEDS-FIX gate and the `--auto-bless` auto-chain are unchanged), and the clean-drain retro is **`/retro --phase i`** (its report is the explicit input to the next replan). A build-time block inside a phase is handled by the **unchanged Stage 4a escalate + resume-poll** — a block pauses *this phase*, it does not abandon the run.

**The phase crossing (reuses the `--auto-bless` seam).** After phase `i` drains and `/retro --phase i` finishes, check `phases[]` for an entry with id > `i`:
- **No next phase** → the app is built: run a final whole-build `/retro` (or treat the last per-phase retro as terminal) and exit **DONE**.
- **A next phase exists** → invoke **`/replan --replan-from i+1`** (`/vision --replan-from i+1`): it freezes the built phases `< i+1` and re-derives the rest from the retro + what shipped. A must-have **dropped** (not deferred) in the re-cut returns as a blocking `replan-dropped-musthave` openQuestion — a real human gate (the lock comes back `incomplete: true`). Then cross the boundary the same way Stage 2 clears decompose→build:
  - **with `--auto-bless`** (walk-away) → auto-advance: loop back to `/decompose --phase i+1`.
  - **without it** (default) → **STOP** at the phase-review gate: "Phase `i` built + retro'd; phase `i+1` replanned — review `plan.md` §Phases, then re-run `/orchestrate --auto-bless` to continue." Re-invocation resumes at phase `i+1` via stage detection.

A single-phase plan never enters this loop — it is the linear Stage 1→4 flow, so this change is fully backward-compatible.

## Budget & cost

Thread `--budget` to `/build-batch` (which enforces it as a pre-dispatch cost stop). The orchestrator additionally treats a budget-exhaustion backstop in Stage 4a as a terminal exit (one final `/escalate`, then stop) — it must not poll forever.

## The autonomy contract (which seams it clears, which it doesn't)

Clears autonomously: vision→decompose (when the vision is complete), decompose→build (only on high-confidence BLESSED + `--auto-bless`), build→retro (clean drain), block→resume (when the human reopens a bead), and **phase→phase** (after retro + replan, only with `--auto-bless`).

Stops for a human: an incomplete vision (product gap), a NEEDS-FIX decompose (bad plan), a review-recommended BLESSED without enough confidence to skip review, a genuine build-time escalation (it notifies and resume-polls rather than busy-failing), the **phase crossing without `--auto-bless`** (review the replanned next phase), and a **replan that drops a must-have** (a `replan-dropped-musthave` gate, always human).

This is the line the critique drew: the human gate must remain *available by default* but must not be the *only* path, or a walk-away run returns to a pipeline that did nothing.

## Do not

- Do not run in meta mode (the workflow repo). Refuse in the first check.
- Do not re-implement any stage — invoke the slash command and read its return.
- Do not auto-chain a NEEDS-FIX or review-recommended `/decompose` into a build, even with `--auto-bless`.
- Do not exit on drain-to-blocked — resume-poll instead (lbq.4).
- Do not invent product to get past an incomplete vision — that's the one gate that is always human.
- Do not decompose a later phase before the current one is built + replanned — phase isolation is the JIT loop, not a graph gate (epic 0ms). One `--phase i` at a time.
- Do not auto-advance a phase crossing without `--auto-bless`, and never auto-advance past a `replan-dropped-musthave` gate.
