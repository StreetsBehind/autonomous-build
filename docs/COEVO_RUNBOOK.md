# Co-evolution runbook — smbuild ⇄ autonomous-build

The procedure each **tick** of `coevo_smbuild.sh` executes. The driver script is the
orchestrator; this runbook is the brain it loads every tick. A tick is one headless
`claude --print` invocation: assess state, advance **one lane** until the next gate /
lane-switch / drain, append a journal entry, and emit exactly one `COEVO_STATUS=` line.

The goal: drive **smbuild** through its full lifecycle while feeding every workflow
defect it surfaces back into **autonomous-build** — building those fixes between app
phases — until smbuild is fully built or a genuine human gate is hit.

## RUN MODE — 2026-05-30: BUILD-NOW (operator-authorized)

This run **builds the existing NEEDS-FIX DAG** rather than gating on BLESSED. The operator
explicitly authorized fanning out builders over the 75 ready beads now, for the express
purpose of dogfooding the **build** stage and catching failures through the feedback loop.
Standing directives for every tick this run:

- Treat the `decomposeReport.md` **NEEDS-FIX** verdict as **non-blocking for `/build-batch`**
  as long as ready non-epic beads exist. Do **not** re-`/decompose` and do **not** gate the
  build on BLESSED this run.
- The two NEEDS-FIX root causes are both safe to build over: **M9** (tamper-evident audit
  chain) traceability is **already fixed upstream** (autonomous-build `8a77909`) and its
  audit-chain beads are present + buildable in the DAG; the missing
  **`concern-enforcement-error-handling`** formula only affects an enforcement epic with no
  ready feature children, so it cannot make any of the 75 ready beads wrong.
- **Capture** residual planning-gap defects (the error-handling formula, the M9 re-trace) with
  `/flag --upstream`, but **DEFER** their meta-lane fixes until the app lane is quiesced after
  a drain. Building comes first; planning-completeness fixes are the post-drain feedback loop.

## The two lanes and the one invariant

- **App lane** — smbuild at `/home/cstaulbee/.openclaw/workspace/smbuild` (app mode).
  Stages: `/decompose` → `/build-batch` → `/retro`.
- **Meta lane** — autonomous-build at `/home/cstaulbee/.openclaw/workspace/autonomous-build`
  (meta mode). Action: vet/promote captured signal → `/loop /build-next` → reinstall.

**INVARIANT (load-bearing): never run a meta-lane edit while smbuild has `build-batch`
workers in flight.** Parallel builders read autonomous-build's *live* skills/formulas/gate;
mutating them mid-build changes behavior under running workers and corrupts the run. A tick
is in *exactly one* lane. Before entering the meta lane, confirm the app lane is quiesced:
no active worktrees building, `bd` shows nothing `in_progress`. If unsure, stay in the app
lane or `sleep-poll` — never overlap.

## Stage detection (run every tick, cheap checks first)

Work the app lane to a natural boundary, *then* consider the meta lane. Decide the tick's
action from repo state — this is what makes the loop resumable after a crash/usage-limit:

| Observed state (check in this order) | Tick action |
|---|---|
| smbuild has **build-batch workers in flight** (worktrees + `in_progress` beads) | App lane: let the current `/build-batch` finish its drain; report its outcome. Never enter meta lane. |
| **(BUILD-NOW run, 2026-05-30)** smbuild verdict NEEDS-FIX **but operator authorized build-now** (see RUN MODE banner) + ready non-epic beads exist + app quiesced | App lane: `/build-batch` one drain of the ready beads. `/flag --upstream` any residual planning-gap cause, but **DEFER** its meta fix until after the drain — do **not** re-`/decompose`, do **not** gate on BLESSED. This row outranks the two NEEDS-FIX rows below it for this run. |
| smbuild `decomposeReport.md` verdict is **NEEDS-FIX** with a **new** root cause not yet captured | **Capture** each cause (`/flag --upstream`), then switch to **meta lane**. |
| smbuild verdict NEEDS-FIX but all root causes were **already fixed** in autonomous-build this run | App lane: re-run `/decompose` (the fixes should now let the blocked features pour). |
| smbuild **BLESSED** + ready non-epic beads exist + app quiesced | App lane: `/build-batch` one drain. |
| autonomous-build has ready `triage`/`workflow-improvement` beads **AND** smbuild quiesced | **Meta lane**: promote + `/loop /build-next` the ones needed to unblock smbuild first. |
| smbuild ready=0, blocked>0 (genuine human gate) | `/escalate` → PushNotification → `sleep-poll`. |
| smbuild ready=0, blocked=0, **all beads closed** | App lane: `/retro` smbuild, then (if chosen) `/retro --self`, then `stop-done`. |
| nothing actionable, no gate cleared | `sleep-poll`. |

Cheap checks: `cd smbuild && bd stats / bd ready --json / bd blocked --json`; verdict via
`grep -m1 'Verdict:' decomposeReport.md`; in-flight via `bd list --status in_progress` +
`ls -d ../*smbuild*wt* 2>/dev/null`; meta backlog via
`cd autonomous-build && bd ready --json` filtered to `triage`/`workflow-improvement`.

## Autonomy policy (decisions locked for this run)

**Auto-fix the safe class, escalate the rest — but route EVERY fix through the meta-lane
gate.** "Auto-fix" never means a blind edit. It means: the tick promotes the defect to a
workflow-improvement bead with a crisp self-verifiable acceptance, then `/build-next` builds
it under the normal post-build gate (lint+typecheck+test+Jankurai). The gate stays in the
loop even for autonomous fixes.

**Safe class — fix autonomously this run** (mechanically well-specified by the decompose
report or an obvious one-liner):
- An enum that simply lacks a valid value the locked stack needs, where the formula's
  downstream already handles that value correctly (verify the downstream before widening —
  if widening the enum alone won't produce a valid skeleton, it is NOT safe; see below).
- A missing required formula variable the plan can supply unambiguously (e.g. `down_outline`
  derivable from the migration's `up`).
- A broken pointer / path / typo (e.g. `docs/ESCALATION_RULES.md` reference).

**Escalate class — `/escalate` + PushNotification, then `sleep-poll`** (judgment / product /
architecture — do NOT guess, T1):
- A defect whose fix is a **new formula variant or real codegen**, not just config (e.g. "the
  stack is Rust/gRPC/tonic but there is no Rust app-skeleton formula" — adding `cargo` to an
  enum does not make a non-existent Rust skeleton appear). File the improvement bead but do
  not self-bless the design; escalate for the human to confirm scope.
- A **contract contradiction** requiring a design call (e.g. REST handlers vs a gRPC-locked
  stack — which side is authoritative?).
- Anything touching **secrets, auth, or a schema migration's data semantics** that the plan
  did not fully specify.
- A **vision/product gap** — never invent product.

When unsure which class a defect is in: treat it as escalate. A wasted notification is
cheaper than a wrong autonomous edit to the workflow that builds every app.

## Per-defect handling (the meta lane in detail)

1. **Capture** — `/flag --upstream "<one-line observation>"` from inside smbuild, with the
   right `category`. This files a raw `triage` bead into autonomous-build. Cheap; do it for
   every defect, safe or escalate-class, so nothing is lost.
2. **Vet + promote** (manual — `/retro --inbox` is filed but NOT yet implemented; bead
   `autonomous-build-35x`): adversarially cross-check the triage bead — is it real, is the
   fix verifiable? If yes and it's safe-class, promote to a `workflow-improvement` bead with
   a concrete acceptance (grep / file-exists / gate-pass) and a `targetFile`. Drop the
   `triage` label. If escalate-class, leave it as triage and `/escalate`.
3. **Build** — `cd autonomous-build` and `/loop /build-next` on the promoted bead(s). The
   post-build gate enforces quality. Meta mode skips the worktree (edits `main` directly) —
   this is why the app lane MUST be quiesced first.

   **Meta-quiescence pre-check (the user runs parallel sessions on this checkout):** before
   any meta edit, confirm the meta repo is safe to touch:
   - `git -C autonomous-build status --porcelain` — if a file you intend to edit is **already
     dirty** (uncommitted changes you did not make this tick), another session is editing it.
     Do **not** edit or commit over it: skip the meta lane this tick and `sleep-poll`.
   - Do not pick up a bead that is `in_progress` or assigned to a human (e.g.
     `autonomous-build-35x`, @Sally) — only your own promoted beads.
   - Take a lock: create `autonomous-build/.coevo-meta.lock` (with your tick timestamp) before
     editing, remove it after commit+reinstall. If it already exists and is fresh (<1h), assume
     another meta tick/session is mid-flight and `sleep-poll`.
4. **Reinstall** — run the installer so the runtime picks up edited skills/workflows/formulas
   (`bash autonomous-build/install.sh` or the documented install path). `*.js` workflows are
   hardlinked/symlinked; skills are junctioned.
5. **Return to app lane** — next tick re-runs `/decompose` on smbuild; the previously-blocked
   features should now pour. Verify the verdict improved; if a cause persists, the fix was
   wrong → re-capture, do not loop blindly.

## Commit rules

- **Stage explicit paths and commit them explicitly: `git commit -- <path1> <path2>`. NEVER
  `git add -A` / `git add .`** — the user runs parallel Claude instances on the same checkout;
  a broad add would capture another session's in-flight work. Committing explicit paths leaves
  a parallel session's other dirty files untouched.
- If your target file is already dirty from another session (see meta-quiescence pre-check),
  do not commit over it — defer to the next tick.
- Meta-lane commits reference the bead (`(bd: autonomous-build-<id>)`) and end with the
  Co-Authored-By trailer.
- App-lane (smbuild) commits are owned by `/build-batch`'s per-bead merge — do not hand-commit
  smbuild outside that path.
- Do not commit `target/`, journals, or `.orchestrator-logs/`.

## Journal

Append one entry per tick to `.orchestrator-logs/coevo-smbuild/journal.md`:
```
## tick <N> — <UTC timestamp> — lane=<app|meta> phase=<...>
- state: smbuild ready=<r> blocked=<b> closed=<c>/<total>; verdict=<...>
- action: <what this tick did>
- result: <outcome>
- captured/built: <bead ids>
- STATUS: <the COEVO_STATUS line emitted>
```
The journal + `bd` state is the only continuity between ticks (each tick is a fresh context).
Read it first every tick.

## STATUS contract (the line bash parses)

End the tick's final message with EXACTLY one line, nothing after it:
```
COEVO_STATUS=<phase>|<result>|<next>
```
- `<phase>`: e.g. `app-decompose`, `app-build`, `meta-fix`, `app-retro`, `assess`.
- `<result>`: short human-readable outcome (no `|` characters).
- `<next>` ∈:
  - `continue` — more progress is immediately available; driver loops at once.
  - `sleep-poll` — at a gate or nothing actionable; driver sleeps, then re-ticks (resume-poll).
  - `stop-done` — smbuild fully built (ready=0 ∧ blocked=0 ∧ all closed) and retro done.
  - `stop-blocked` — a hard human gate that polling cannot clear; driver notifies and exits.

## Notifications

- Genuine gate / escalate-class defect / blocked drain → invoke `/escalate` (it sends one
  consolidated `PushNotification`). One notification per *distinct* block state, not per bead.
- The driver additionally emits an `openclaw system event` + Discord check-in each tick; do
  not duplicate that from inside the tick.

## Hard guardrails — do NOT

- Do **not** enter the meta lane while smbuild `build-batch` workers are in flight.
- Do **not** make a blind workflow edit; every fix goes through a bead + the `/build-next` gate.
- Do **not** auto-resolve a product, contract, or secrets/migration decision — escalate.
- Do **not** disable, weaken, or skip the post-build gate or Jankurai to make a bead pass.
- Do **not** `git add -A`; stage explicit paths only.
- Do **not** delete worktrees or branches the loop did not create.
- The gRPC/REST contract contradiction is **RESOLVED** (verified 2026-05-30: the re-decomposed
  DAG is gRPC/tonic-native; the only HTTP beads are legitimate external clients — OpenFGA,
  Postmark, Stripe, Twilio — plus the grpc-web browser transport and the e2e/loadtest crates).
  No build-blocking contract contradiction remains, so this guardrail no longer fires. If a NEW
  contract contradiction surfaces during build, escalate it (do not silently build over it).
