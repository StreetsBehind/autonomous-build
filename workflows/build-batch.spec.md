---
name: build-batch
description: Run N concurrent build-next-style workers in parallel — dispatch beads-builder subagents into their own worktrees, poll the marker file each emits on completion, then serialize merges to main behind a post-merge gate. Use when the user says "build batch", "fan out the build", "parallel build", or invokes /build-batch. Refuses to run in meta mode (autonomous-build self-edits) — use /loop /build-next there.
---

# build-batch

The parallel sibling of `/build-next`, implemented as a **dynamic workflow** (see https://code.claude.com/docs/en/workflows). One orchestrator script holds in-memory pipeline state, dispatches `beads-builder` workers in the background, and merges their results to `main` one at a time behind a post-merge quality gate.

This workflow replaces `skills/build-batch/` — the prior single-context skill held the same pipeline state in conversation, paid for it in tokens on every poll, and could not survive a context compaction mid-batch. The dynamic-workflow form keeps pipeline state in script variables, polls cheaply (stat() on a marker file rather than `TaskOutput` reads), and is resumable in-session.

## How this spec runs

This file is a **workflow spec**, not a skill. The canonical script lives at `workflows/build-batch.js` in this repo (**hand-authored**, not first-run-generated) and is hardlinked to `~/.claude/workflows/build-batch.js` by `install.ps1`. The hand-authored pattern is deliberate: `/build-batch` is the load-bearing parallel-orchestration stage, and a reviewed JS script with named helpers (`Dispatch-Bead`, `Test-FilesTouched-Intersect`, `Process-WorkerCompletion`, `Merge-And-Close`, `Find-BuildCompleteMarker`) is more trustworthy than "whatever the model emitted that one time we saved it." Edits to behavior happen here AND in the JS — both files are source-of-truth, kept in sync (T3: atomic bead, atomic commit).

**Why a workflow instead of a single-context skill:** pipeline state lives in script variables instead of bloating Claude's context; the poll loop runs as JS (a stat() per worker per tick) instead of as a conversation turn (an LLM round-trip per tick); the run is resumable in-session if the orchestrator hits a transient failure; parallel worker dispatch and serialized merging are mechanical, not a judgment call buried in chat.

---

## Inputs

The workflow accepts these arguments (parsed from the `/build-batch` invocation; all optional):

| Arg | Default | Meaning |
| --- | --- | --- |
| `--workers N` | `2` | Max concurrent worker dispatches. Cap at 4 unless the user explicitly raises it — beyond that, merge throughput dominates and you're not actually getting more done. |
| `--max-merges M` | unbounded | Stop dispatching new work after M successful merges. Useful for "do a chunk and come back." |
| `--budget $X` | unbounded | Cumulative session cost cap (USD). Checked before each new wave's dispatch, never mid-worker. Cost is an **estimate**: the runtime `budget` global's output-token spend converted via `USD_PER_1M_OUTPUT_TOKENS` when available, else `workersDispatched × USD_PER_WORKER_ESTIMATE`. Both constants live at the top of `build-batch.js` and should be tuned to current pricing. |

If the user invokes `/build-batch` with no flags, use defaults.

The workflow expects to run **in the app repo's root**, not in `autonomous-build`. There is no `--self` analog — see Phase 0.

---

## Single-run contract

This workflow must:

1. Run to completion (all ready work merged or blocked, or `--max-merges` reached) before returning. Do not exit mid-batch unless explicitly told to abort.
2. Never merge an un-gated bead branch into `main`. Both the worker's in-worktree gate AND the orchestrator's post-merge gate must pass.
3. Serialize the merge step — at most one `git merge` against `main` in flight at any moment.
4. Leave every claimed bead in a coherent state on exit: `closed` (merged), `blocked` (worker filed notes), or `in_progress` (recovery needed — log explicitly).
5. Print a structured summary at the end the human (or `/retro`) can read.

---

## Phase 0 — Meta-mode guard (sequential, 1 agent, first check always)

Refuse to run in the workflow repo. Parallel writers cannot share a single checkout, and meta mode (`/build-next`'s Step 5 skips the worktree) operates on `main` directly — fanning out from `main` would race.

**Agent:** `meta-guard`
**Tools:** `Bash`
**Steps:**
1. `Test-Path skills/build-next/SKILL.md` (relative to cwd). The marker is build-next's own source file — present by definition in the workflow repo, absent in any app the loop builds. (Don't use `Test-Path AGENTS.md` for this — Jankurai writes an `AGENTS.md` into every app, and this repo also has one, so that check misfires both ways.)
2. If present, fail loud with the exact message:
   ```
   MODE: meta — refusing to fan out. Parallel writes to autonomous-build's own files would race on a shared checkout.
   Use: /loop /build-next
   ```
   and exit with non-zero status. This is not a soft warning — refuse.

**Output:** `MetaGuardResult = { isMeta: <bool>, message?: <string> }`

**Failure:** if `isMeta == true`, the workflow halts here. No further phases run. (T9: meta vs app discipline — `/build-batch` is explicitly app-only.)

---

## Phase 1 — Pre-flight (sequential, 1 agent)

Verify the run is viable. Produces a `Context` object the rest of the workflow consumes.

**Agent:** `preflight`
**Tools:** `Bash`, `Read`
**Steps:**
1. **bd is healthy.** `bd ready --json` must return successfully. If it errors with a lock issue, run `bd doctor --fix` once; if still failing, fail loud with the underlying error.
2. **At least one ready non-epic bead exists.** Filter out epics client-side (bd has no `--type` filter on `ready`):
   ```
   $ready = bd ready --json | ConvertFrom-Json | Where-Object { $_.issue_type -ne 'epic' }
   ```
   If `$ready` is empty:
   - Check `bd blocked --json`. If any → invoke `/escalate` and exit cleanly.
   - Else → print "DONE: no ready or blocked work" and exit cleanly.
3. **`main` is clean.** `git status --porcelain` on main must be empty. Workers branch worktrees from main; uncommitted state on main propagates into worktrees and confuses the post-merge gate. Fail loud if dirty.
4. **Resolve flags.** Parse `--workers`, `--max-merges`, `--budget` from the invocation; apply defaults. Sanity-check `workers >= 1` and warn (but proceed) if `workers > 4`.

**Output:** `Context = { workers, maxMerges, budget, readyCount, batchStart: <timestamp> }`

**Failure:** any pre-flight failure stops the workflow with a clear message — do not proceed to dispatch on bad context (T1, T7).

---

## Phase 2 — Dispatch + poll loop (orchestrated, fan-out workers up to `workers`)

The heart of the workflow. One orchestrator script holds in-memory pipeline state and dispatches `beads-builder` subagents in the background. The loop iterates every 10 s until the exit condition fires.

> **v1 implementation note.** The dynamic-workflow runtime exposes `agent()` and `parallel(thunks)` but not background tasks or sleep primitives, so `workflows/build-batch.js` v1 implements this phase as **wave-dispatch** rather than continuous polling: pick up to `workers` candidates with pairwise filesTouched disjointness, `parallel()` them, await the whole wave, then run serialized merges of the wave's `ready-to-merge` results, then refresh `bd ready` and repeat. Every load-bearing guarantee in this section is preserved — up to N concurrent builders, at most one merger in flight, filesTouched conflict filtering, post-merge gate, blocking on errors. The only difference vs the continuous-poll wording below is "the next wave can't start until the slowest builder in the current wave finishes," which the smoke test (sibling B3 bead) confirms is acceptable. The pseudo-code below is written in continuous-poll form because that's the eventual target; v1's wave-dispatch is a strict subset of those semantics. If the runtime later gains background-task primitives, the JS upgrade is local to Phase 2 — Phase 0, 1, and 3 are unchanged.

### In-memory pipeline state

The orchestrator holds this as script variables (do not persist to a build epic — the run is bounded by a single workflow invocation, and recovery from a crash mid-batch is a deliberate non-goal for v1):

```
activePipelines = {}      # beadId → { taskId, worktreePath, branch, dispatchTime, filesTouched }
mergeQueue      = []      # FIFO of beadIds whose workers emitted BUILD_COMPLETE ready-to-merge
mergeInFlight   = null    # { beadId, startTime } | null — only one merge at a time
mergedSet       = []      # beadIds successfully merged + closed
blockedSet      = []      # beadIds the worker filed as blocked
failedSet       = []      # beadIds that failed unexpectedly (left in_progress)
```

`freeSlots = workers - len(activePipelines)` is the only number that decides whether to dispatch more work.

### Phase 2.0 — Announce

```
[BATCH START] workers=$workers max-merges=$maxMerges
[BATCH START] ready beads (non-epic): $readyCount
```

### Phase 2.1 — Poll loop body

Iterate every 10 s until the exit condition fires:

**Step A — Fill free slots.**
Build the set of file paths currently in flight (active pipelines + queued merges + in-flight merge). `filesTouched` lives in bd metadata; `/decompose` (formerly `/compose`) writes it from the formula's per-step `files` array (see `formulas/README.md` and `workflows/decompose.spec.md` Phase 3). Globs are unioned.

```
inFlightFiles = []
for p in activePipelines.values():    inFlightFiles += p.filesTouched
for qId in mergeQueue:                inFlightFiles += (bd show qId --json).metadata.filesTouched
if mergeInFlight:                     inFlightFiles += (bd show mergeInFlight.beadId --json).metadata.filesTouched

freeSlots = workers - len(activePipelines)
if freeSlots > 0:
  candidates = bd ready --json
    .filter(issue_type != 'epic')
    .filter(id not in activePipelines and id not in mergeQueue and id != mergeInFlight?.beadId)
    .filter(id not in mergedSet and id not in blockedSet)
    .filter(not Test-FilesTouched-Intersect(metadata.filesTouched, inFlightFiles))
    .take(freeSlots)

  for bead in candidates:
    dispatched = Dispatch-Bead(bead)
    if dispatched: activePipelines[bead.id] = dispatched
```

**Step B — Poll active pipelines.**
Prefer the marker FILE the worker drops on completion over reading `TaskOutput`. `Test-Path <worktree>/.bd-build-complete.json` is a single stat() per worker — cheap. `TaskOutput` is a billed read of the worker's full stdout buffer; doing that every 10 s × N workers × ~30 min wall is a meaningful Opus token spend on idle agents.

Workers write `<worktree>/.bd-build-complete.json` (same payload as the legacy `<!-- BUILD_COMPLETE:{...} -->` stdout marker) the instant they finish. The orchestrator falls back to scraping stdout only if the file is somehow absent on an exited task.

```
for id, pipeline in activePipelines.items():
  markerFile = pipeline.worktreePath / ".bd-build-complete.json"
  marker = null

  if Test-Path(markerFile):
    try: marker = Get-Content(markerFile) | ConvertFrom-Json
    catch: marker = null

  if not marker:
    # Fallback: scrape stdout. Only if the task has actually exited or we're
    # past the stage timeout — checking TaskOutput on a still-running worker is
    # the exact cost we're trying to avoid.
    taskState = TaskGet(pipeline.taskId)
    if taskState.status in ('completed', 'failed', 'stopped'):
      output = TaskOutput(pipeline.taskId, block=false, timeout=5000)
      marker = Find-BuildCompleteMarker(output)

  if marker:
    Process-WorkerCompletion(id, marker)
  elif (now - pipeline.dispatchTime) > stageTimeout:
    TaskStop(pipeline.taskId)
    bd update id --status=blocked --notes "worker timeout after $stageTimeout min"
    blockedSet += id
    activePipelines.remove(id)
```

**Step C — Process merge queue (serialized).**

```
if mergeInFlight is null and len(mergeQueue) > 0:
  nextBeadId = mergeQueue.shift()
  Merge-And-Close(nextBeadId)    # blocking call — see "Serialized merge step" below
```

**Step D — Exit conditions.**

```
if len(activePipelines) == 0 and len(mergeQueue) == 0 and mergeInFlight is null:
  # Refresh ready set — workers may have unblocked dependent beads
  remaining = bd ready --json
    .filter(issue_type != 'epic' and id not in mergedSet and id not in blockedSet)
    .length
  if remaining == 0: break
  # else: loop continues, slots will fill on next iteration

if maxMerges and len(mergedSet) >= maxMerges:
  print "[BATCH] hit --max-merges=$maxMerges, draining active pipelines and exiting"
  # Stop dispatching new work, but let in-flight workers + merge complete
  # (set drainOnly = true; do not break — the natural exit fires when queues drain)
```

Then `sleep 10 s` and continue.

### Phase 2.2 — Dispatch-Bead helper

```
Dispatch-Bead(bead):
  # Escalation pre-check from the orchestrator's side (cheap rules only).
  # Anything that requires reading the file tree is the worker's job.
  if 'needs-decision' in bead.labels or 'touches-auth' in bead.labels:
    bd update bead.id --status=blocked --notes "label-based escalation: $bead.labels"
    blockedSet += bead.id
    return null

  # filesTouched defense in depth. The candidate filter in Phase 2.1 Step A already
  # excluded any bead whose filesTouched intersected the in-flight set, so reaching
  # here means the intersection was empty as of that snapshot. Re-check anyway —
  # something may have entered the merge queue between the filter pass and here.
  # If a new conflict appeared, do NOT claim; let the next loop iteration retry.
  if Test-FilesTouched-Intersect(bead.metadata.filesTouched, inFlightFiles):
    print "[SKIP] $bead.id deferred — filesTouched would conflict with in-flight pipelines"
    return null

  # Beads with no filesTouched declared fall back to the old behavior: the post-merge
  # gate is the sole conflict catcher. Warn — this almost always indicates a missing
  # `files = [...]` declaration on the formula step that produced this bead.
  if not bead.metadata.filesTouched or len(bead.metadata.filesTouched) == 0:
    print "[WARN] $bead.id has no filesTouched — relying on post-merge gate; consider adding `files` to the formula step"

  # Claim atomically. If another agent (somehow) raced us, skip.
  claimOutput = bd update bead.id --claim
  if exitCode != 0: return null

  # Create the worktree. bd handles branch creation (bead/<id>).
  worktreePath = (bd worktree create "task-$bead.id" --json | ConvertFrom-Json).path
  if not worktreePath:
    bd update bead.id --status=blocked --notes "worktree create failed"
    blockedSet += bead.id
    return null

  # Dispatch the worker. description="Build $id" wires up future telemetry hooks.
  taskId = Agent(
    subagent_type="beads-builder",
    run_in_background=true,
    description="Build $bead.id",
    prompt="beadId: $bead.id\nworktree: $worktreePath"
  )

  print "[DISPATCH] $bead.id → worktree $worktreePath, task $taskId"
  return {
    taskId:       taskId,
    worktreePath: worktreePath,
    branch:       "bead/$bead.id",
    dispatchTime: now,
    filesTouched: bead.metadata.filesTouched   # carried so the next iteration's filter can union it
  }
```

### Phase 2.3 — Test-FilesTouched-Intersect helper

Used by both the candidate filter (Phase 2.1 Step A) and Dispatch-Bead's defense-in-depth re-check. Compares two arrays of path globs and returns `true` iff any pair intersects.

```
Test-FilesTouched-Intersect(candidateFiles, inFlightFiles):
  if not candidateFiles or len(candidateFiles) == 0: return false
  if not inFlightFiles  or len(inFlightFiles)  == 0: return false
  for c in candidateFiles:
    for f in inFlightFiles:
      # Two globs intersect if any concrete path matches both. For dispatch purposes,
      # a string-equality OR mutual-glob-match check is sufficient — false positives
      # (over-defer) are cheap; false negatives (race + merge conflict) are expensive.
      if c == f: return true
      if c -like f or f -like c: return true   # PowerShell -like glob match
  return false
```

### Phase 2.4 — Process-WorkerCompletion helper

```
Process-WorkerCompletion(beadId, marker):
  pipeline = activePipelines[beadId]
  activePipelines.remove(beadId)

  switch marker.status:
    "ready-to-merge":
      print "[WORKER] $beadId completed → merge queue (sha $marker.commitSha)"
      mergeQueue.append(beadId)
    "blocked":
      print "[WORKER] $beadId blocked: $marker.notes"
      blockedSet += beadId
      # Worker already called `bd update --status=blocked`. Just clean up the worktree.
      bd worktree remove "task-$beadId" --force
    "failed":
      print "[WORKER] $beadId failed: $marker.notes"
      failedSet += beadId
      # Leave bead in_progress for human inspection. Do NOT remove the worktree —
      # the human needs to see the worktree state to diagnose.
      print "  Worktree left at $pipeline.worktreePath for inspection."
```

### Phase 2.5 — Serialized merge step (Merge-And-Close)

This is the orchestrator's exclusive responsibility — workers never touch `main` or run `git merge`.

```
Merge-And-Close(beadId):
  mergeInFlight = { beadId: beadId, startTime: now }
  branch = "bead/$beadId"

  push-location (git rev-parse --show-toplevel)
  try:
    git checkout main
    # Pull only if a remote is configured. The prior skill suppressed errors with
    # `2>&1 | Out-Null` but still proceeded to merge against (potentially stale)
    # local main — silently hiding pull failures from a real remote. Gate explicitly.
    remotes = git remote
    if len(remotes) > 0:
      git pull --ff-only origin main
      if exitCode != 0:
        bd update beadId --status=blocked --notes "git pull --ff-only origin main failed before merge — local main is behind remote and cannot fast-forward"
        blockedSet += beadId
        mergeInFlight = null
        return

    mergeOutput = git merge --no-ff $branch -m "Merge $beadId"
    if exitCode != 0:
      # Conflict. Abort the merge, block the bead.
      git merge --abort
      bd update beadId --status=blocked --notes "merge conflict against main" --append-notes "$mergeOutput"
      blockedSet += beadId
      mergeInFlight = null
      return

    # Post-merge gate on main. THIS is the defense-in-depth check.
    print "[GATE] post-merge gate on main (bead $beadId)"
    # Resolve cross-platform: post-build-gate.sh on Linux/macOS, .ps1 (via pwsh) on Windows.
    gateOutput = runGate("hooks/post-build-gate")   # picks .sh or .ps1 by OS
    if exitCode != 0:
      # Gate failed. Undo the merge, block the bead.
      git reset --hard HEAD~1
      bd update beadId --status=blocked --notes "post-merge gate failed on main" --append-notes "$gateOutput"
      blockedSet += beadId
      mergeInFlight = null
      return

    # Success. Close the bead, remove the worktree.
    bd close beadId --session $env:CLAUDE_SESSION_ID
    bd worktree remove "task-$beadId" --force
    mergedSet += beadId
    print "[MERGE] $beadId → main (post-gate PASS)"
  finally:
    pop-location
    mergeInFlight = null
```

### Phase 2.6 — Find-BuildCompleteMarker helper

Fallback stdout-scraper used only when the marker file is absent on an exited task.

```
Find-BuildCompleteMarker(output):
  # Match the LAST occurrence — workers should emit exactly one, but if a
  # malformed run emits multiple, the last one is authoritative.
  regex = '<!-- BUILD_COMPLETE:({.*?}) -->'
  matches = regex.findall(output)
  if len(matches) == 0: return null
  json = matches[-1].group(1)
  return ConvertFrom-Json(json)
```

---

## Phase 3 — Summary + post-actions (sequential, 1 agent)

After the poll loop exits.

**Agent:** `summary`
**Tools:** `Bash`
**Steps:**

1. Print the structured summary:
   ```
   [BATCH COMPLETE]
     Merged:   $len(mergedSet) beads → $mergedSet
     Blocked:  $len(blockedSet) beads → $blockedSet
     Failed:   $len(failedSet) beads → $failedSet
     Duration: $(now - batchStart)
   ```

2. Conditional post-actions:
   - If `len(blockedSet) > 0` → invoke `/escalate` (it builds the push notification from `bd blocked`).
   - If `len(failedSet) > 0` → print the worktree paths for the human to inspect; do NOT auto-escalate (these need eyes, not a notification).
   - If `len(blockedSet) == 0` and `len(failedSet) == 0` and `bd ready` is now empty → invoke `/retro` (matches /build-next's DONE path).

**Output:** `BatchSummary = { merged: [...], blocked: [...], failed: [...], durationSec, postActions: [...] }`

**Failure:** if `/escalate` or `/retro` invocation fails, log the failure but do not retry — the summary itself is the system of record (T7: loud and recoverable).

---

## Run-completion behavior

When the workflow finishes:
- Returns to the conversation: `{ merged: [...], blocked: [...], failed: [...], durationSec, postActions: [...] }`
- The orchestrator turn prints a one-line summary: `"Batch: merged <N>, blocked <M>, failed <F> in <duration>"` plus any post-action results.

---

## Stage timeout

Default `stageTimeout = 30 minutes` per worker. If a worker hasn't emitted BUILD_COMPLETE in 30 min, `TaskStop` it, mark the bead blocked with `"worker timeout"`, and continue. A worker that hangs without output is almost always wedged on a tool prompt or an interactive command.

This is a per-worker timeout, not a batch-wide one. The batch's only wall-time bound is whatever `--max-merges` and `--budget` impose.

---

## Stopping conditions (do not guess)

- **Meta mode detected** (Phase 0): refuse outright. Tell user to use `/loop /build-next`.
- **Worktree create fails** (disk full, bd misconfigured) → block the bead, do not retry.
- **bd lock contention three times in a row** → exit the batch; recommend the user `bd doctor --fix` and re-run.
- **More than 50% of attempted beads end up in `failedSet`** (not blocked — failed) → abort the batch. Something systemic is wrong; better to stop than burn budget.
- **Cumulative session cost exceeds `--budget`** → finish the in-flight merge, then exit. Do NOT dispatch new work mid-budget-exceed.
- **Phase 1 pre-flight fails** (bd unhealthy, main dirty) → stop with the underlying error preserved (T7).

---

## Do not

- Do not run `/build-batch` in meta mode. Period. (T9.)
- Do not skip the post-merge gate "because the worker gate already passed." That's the whole point — defense-in-depth catches the cases where two workers' merges interact. (T2.)
- Do not run concurrent merges. The merge queue exists for exactly this reason.
- Do not amend or rebase a worker's commit. If a commit is wrong, the bead is blocked. (T3.)
- Do not `bd close` a bead before the post-merge gate passes. The bead's "done" state IS "merged to main and main is green."
- Do not auto-remove the worktree of a `failed` bead — the human needs that state to debug.
- Do not invoke `/build-batch` recursively. One orchestrator at a time.
- Do not promise dependency-aware scheduling beyond what `bd ready` + the `filesTouched` conflict filter (Phase 2.1 Step A) give you. When two ready siblings declare overlapping `filesTouched`, the filter defers the second until the first completes; if a bead has no `filesTouched` declared, the orchestrator warns and falls back to the post-merge gate as the sole conflict catcher.
- Do not persist pipeline state to bd or disk between iterations. The run is bounded by a single workflow invocation; recovery from a crash mid-batch is a deliberate non-goal for v1. (If recovery becomes a requirement, it's a separate bead.)
- Do not poll `TaskOutput` on workers that haven't exited. The marker-file path is the cheap default; stdout scraping is the fallback only.

---

## Save-as-workflow + sync checklist

Hand-authored JS pattern — this spec is NOT regenerated on first invocation. The canonical script lives at `workflows/build-batch.js` in this repo.

**Initial install (after the sibling B2 bead lands `workflows/build-batch.js`):**
1. `./install.ps1` — hardlinks `workflows/build-batch.js` to `~/.claude/workflows/build-batch.js`.
2. `/build-batch` is now invokable from any app repo (this workflow is project-agnostic — it operates on cwd).
3. The smoke test (sibling B3-equivalent — TBD) validates end-to-end.

**Spec changes:** edit this file AND `workflows/build-batch.js` in the same commit (T3). Spec-only edits are a workflow bug; JS-only changes that diverge from the spec are also a workflow bug. The two stay in lockstep.

---

## Relationship to other skills + workflows

- **Replaces** `skills/build-batch/` — the prior single-context skill. The skill directory is deleted by the umbrella epic's docs-and-cleanup bead (`autonomous-build-mvh.3` family) once docs are updated.
- **Consumes** the BLESSED bead DAG from `/decompose` (`workflows/decompose.spec.md`). A NEEDS-FIX DAG should not be dispatched — Phase 1's pre-flight will not refuse on quality scores in v1, but the human gate between `/decompose` and `/build-batch` is the intended check. (A future bead may wire quality-score thresholding into Phase 1.)
- **Dispatches** the `beads-builder` subagent (defined elsewhere in the skill registry). Workers are responsible for their own in-worktree quality gate, claim, implement, commit, and BUILD_COMPLETE marker emission — see `skills/build-next/SKILL.md` for the single-worker contract that `beads-builder` implements per-worktree.
- **Triggers** `/escalate` on `blockedSet` and `/retro` on a clean drain. Both are workflow-level sibling commands.
- **Refuses** to run in `autonomous-build` (Phase 0 meta-mode guard). Use `/loop /build-next` there.

---

## Removed (semantics intentionally dropped from the skill form)

Nothing — every section, helper, and behavior from `skills/build-batch/SKILL.md` is preserved in this spec. The ToolSearch loading note (`ToolSearch query="select:Agent,TaskOutput,TaskStop"`) is implicit at the JS layer rather than a conversation step (the runtime loads tools as the orchestrator calls them); no semantic is dropped. If future edits intentionally drop a behavior, add a bullet here with the rationale and the bead ID that authorized the drop.
