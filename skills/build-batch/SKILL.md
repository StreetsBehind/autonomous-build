---
name: build-batch
description: Run N concurrent build-next-style workers in parallel — dispatch beads-builder subagents in their own worktrees, poll for completion, then serialize merges to main behind a post-merge gate. Use when the user says "build batch", "fan out the build", "parallel build", or invokes /build-batch. Refuses to run in meta mode (autonomous-build self-edits) — use /loop /build-next there.
---

# build-batch

The parallel sibling of `/build-next`. One orchestrator agent (you) holds in-memory pipeline state, dispatches `beads-builder` workers in the background, and merges their results to `main` one at a time behind a post-merge quality gate.

## Tool loading

Before entering the poll loop, load the deferred harness tools you'll need:

```
ToolSearch query="select:Agent,TaskOutput,TaskStop"
```

(`Agent` is always available, but `TaskOutput` and `TaskStop` are deferred — calling them without loading their schemas first will fail with InputValidationError.)

## Single-run contract

This skill must:

1. Run to completion (all ready work merged or blocked, or `--max-merges` reached) before returning. Do not exit mid-batch unless explicitly told to abort.
2. Never merge an un-gated bead branch into `main`. Both the worker's in-worktree gate AND the orchestrator's post-merge gate must pass.
3. Serialize the merge step — at most one `git merge` against `main` in flight at any moment.
4. Leave every claimed bead in a coherent state on exit: `closed` (merged), `blocked` (worker filed notes), or `in_progress` (recovery needed — log explicitly).
5. Print a structured summary at the end the human (or `/retro`) can read.

## Meta-mode guard (first check, always)

```powershell
if (Test-Path "skills/build-next/SKILL.md") {
  Write-Host "MODE: meta — refusing to fan out. Parallel writes to autonomous-build's own files would race on a shared checkout."
  Write-Host "Use: /loop /build-next"
  exit 1
}
```

The marker is build-next's own source file. It is present by definition in the workflow repo and absent in any app the loop builds. (Don't use `Test-Path AGENTS.md` for this — Jankurai writes an `AGENTS.md` into every app, and this repo also has one, so that check misfires both ways.)

The whole point of /build-batch is N worktrees doing N isolated builds. In meta mode there are no worktrees (build-next Step 5 skips), so parallel workers would race on the main checkout. This is not a soft warning — refuse and tell the user to use /loop.

## Inputs

Flags parsed from the user's invocation:

| Flag | Default | Description |
|---|---|---|
| `--workers N` | `2` | Max concurrent worker dispatches. Cap at 4 unless the user explicitly raises it — beyond that, merge throughput dominates and you're not actually getting more done. |
| `--max-merges M` | unbounded | Stop dispatching new work after M successful merges. Useful for "do a chunk and come back." |
| `--budget $X` | unbounded | Cumulative session cost cap (USD). Check before each new dispatch, not mid-worker. |

If the user invokes `/build-batch` with no flags, use defaults.

## Pre-flight checks

Before starting the loop:

1. **bd is healthy.** `bd ready --json` must return successfully. If it errors with a lock issue, run `bd doctor --fix` once; if still failing, exit with a clear error.
2. **At least one ready non-epic bead exists.** Filter out epics client-side (bd has no `--type` filter on `ready`):
   ```powershell
   $ready = bd ready --json | ConvertFrom-Json | Where-Object { $_.issue_type -ne 'epic' }
   if (-not $ready) {
     bd blocked --json | ... # if any blocked, invoke /escalate
     # else "DONE: no ready or blocked work" and exit
   }
   ```
3. **`main` is clean.** `git status --porcelain` on main must be empty. Workers branch worktrees from main; uncommitted state on main propagates into worktrees and confuses the post-merge gate.

## In-memory state

The orchestrator holds this in its head (do not persist to a build epic — the run is bounded by a single skill invocation, and recovery from a crash mid-batch is a deliberate non-goal for v1):

```
$activePipelines = @{}     # beadId → { taskId, worktreePath, branch, dispatchTime }
$mergeQueue      = @()     # FIFO of beadIds whose workers emitted BUILD_COMPLETE ready-to-merge
$mergeInFlight   = $null   # { beadId, startTime } | $null — only one merge at a time
$mergedSet       = @()     # beadIds successfully merged + closed
$blockedSet      = @()     # beadIds the worker filed as blocked
$failedSet       = @()     # beadIds that failed unexpectedly (left in_progress)
```

`freeSlots = $workers - $activePipelines.Count` is the only number that decides whether to dispatch more work.

## Process

### Phase 0: announce

```
[BATCH START] workers=$workers max-merges=$maxMerges
[BATCH START] ready beads (non-epic): $($ready.Count)
```

### Phase 1: poll loop

Run this loop until the exit condition fires:

```
while ($true) {

  # ── 1. Fill free slots ──
  $freeSlots = $workers - $activePipelines.Count
  if ($freeSlots -gt 0) {
    $candidates = bd ready --json | ConvertFrom-Json |
      Where-Object {
        $_.issue_type -ne 'epic' -and
        -not $activePipelines.ContainsKey($_.id) -and
        $_.id -notin $mergeQueue -and
        $_.id -ne $mergeInFlight.beadId -and
        $_.id -notin $mergedSet -and
        $_.id -notin $blockedSet
      } |
      Select-Object -First $freeSlots

    foreach ($bead in $candidates) {
      $dispatched = Dispatch-Bead $bead
      if ($dispatched) { $activePipelines[$bead.id] = $dispatched }
    }
  }

  # ── 2. Poll active pipelines ──
  # Batch all TaskOutput calls into a single response — they're independent.
  foreach ($id in $activePipelines.Keys) {
    $pipeline = $activePipelines[$id]
    $output = TaskOutput -taskId $pipeline.taskId -block $false -timeout 5000
    $marker = Find-BuildCompleteMarker $output
    if ($marker) {
      Process-WorkerCompletion $id $marker
    } elseif ((Get-Date) - $pipeline.dispatchTime -gt $stageTimeout) {
      TaskStop -taskId $pipeline.taskId
      bd update $id --status=blocked --notes "worker timeout after $($stageTimeout.TotalMinutes) min"
      $blockedSet += $id
      $activePipelines.Remove($id)
    }
  }

  # ── 3. Process merge queue (serialized) ──
  if ($null -eq $mergeInFlight -and $mergeQueue.Count -gt 0) {
    $nextBeadId = $mergeQueue[0]
    $mergeQueue = $mergeQueue[1..($mergeQueue.Count - 1)]
    Merge-And-Close $nextBeadId    # blocking call — see "Serialized merge step" below
  }

  # ── 4. Exit conditions ──
  if ($activePipelines.Count -eq 0 -and
      $mergeQueue.Count -eq 0 -and
      $null -eq $mergeInFlight) {

    # Refresh ready set — workers may have unblocked dependent beads
    $remaining = (bd ready --json | ConvertFrom-Json |
      Where-Object { $_.issue_type -ne 'epic' -and $_.id -notin $mergedSet -and $_.id -notin $blockedSet }).Count

    if ($remaining -eq 0) { break }
    # else: loop continues, slots will fill on next iteration
  }

  if ($maxMerges -and $mergedSet.Count -ge $maxMerges) {
    Write-Host "[BATCH] hit --max-merges=$maxMerges, draining active pipelines and exiting"
    # Stop dispatching new work, but let in-flight workers + merge complete
    # (set a flag, do not break — the natural exit will fire when queues drain)
  }

  Start-Sleep -Seconds 10
}
```

### Dispatch-Bead

```
Dispatch-Bead($bead):
  # Escalation pre-check from the orchestrator's side (cheap rules only).
  # Anything that requires reading the file tree is the worker's job.
  if ($bead.labels -contains 'needs-decision' -or
      $bead.labels -contains 'touches-auth') {
    bd update $bead.id --status=blocked --notes "label-based escalation: $($bead.labels)"
    $blockedSet += $bead.id
    return $null
  }

  # Claim atomically. If another agent (somehow) raced us, skip.
  $claimOutput = bd update $bead.id --claim 2>&1
  if ($LASTEXITCODE -ne 0) { return $null }

  # Create the worktree. bd handles branch creation (bead/<id>).
  $worktreePath = bd worktree create "task-$($bead.id)" --json | ConvertFrom-Json | Select -ExpandProperty path
  if (-not $worktreePath) {
    bd update $bead.id --status=blocked --notes "worktree create failed"
    $blockedSet += $bead.id
    return $null
  }

  # Dispatch the worker. description="Build $id" wires up future telemetry hooks.
  $taskId = Agent -subagent_type "beads-builder" `
                  -run_in_background $true `
                  -description "Build $($bead.id)" `
                  -prompt "beadId: $($bead.id)`nworktree: $worktreePath"

  Write-Host "[DISPATCH] $($bead.id) → worktree $worktreePath, task $taskId"
  return @{ taskId = $taskId; worktreePath = $worktreePath; branch = "bead/$($bead.id)"; dispatchTime = (Get-Date) }
```

### Process-WorkerCompletion

```
Process-WorkerCompletion($beadId, $marker):
  $pipeline = $activePipelines[$beadId]
  $activePipelines.Remove($beadId)

  switch ($marker.status) {
    "ready-to-merge" {
      Write-Host "[WORKER] $beadId completed → merge queue (sha $($marker.commitSha))"
      $mergeQueue += $beadId
    }
    "blocked" {
      Write-Host "[WORKER] $beadId blocked: $($marker.notes)"
      $blockedSet += $beadId
      # Worker already called `bd update --status=blocked`. Just clean up the worktree.
      bd worktree remove "task-$beadId" --force 2>&1 | Out-Null
    }
    "failed" {
      Write-Host "[WORKER] $beadId failed: $($marker.notes)"
      $failedSet += $beadId
      # Leave bead in_progress for human inspection. Do NOT remove the worktree —
      # the human needs to see the worktree state to diagnose.
      Write-Host "  Worktree left at $($pipeline.worktreePath) for inspection."
    }
  }
```

### Serialized merge step

This is the orchestrator's exclusive responsibility — workers never touch `main` or run `git merge`.

```
Merge-And-Close($beadId):
  $mergeInFlight = @{ beadId = $beadId; startTime = (Get-Date) }
  $pipeline = @{ branch = "bead/$beadId" }   # reconstruct if not still in scope

  # Switch to main and merge.
  Push-Location (git rev-parse --show-toplevel)
  try {
    git checkout main
    git pull --ff-only origin main 2>&1 | Out-Null   # if a remote is configured; ignore if not
    $mergeOutput = git merge --no-ff $pipeline.branch -m "Merge $beadId" 2>&1
    if ($LASTEXITCODE -ne 0) {
      # Conflict. Abort the merge, block the bead.
      git merge --abort
      bd update $beadId --status=blocked --notes "merge conflict against main" --append-notes "$mergeOutput"
      $blockedSet += $beadId
      $mergeInFlight = $null
      return
    }

    # Post-merge gate on main. THIS is the defense-in-depth check.
    Write-Host "[GATE] post-merge gate on main (bead $beadId)"
    $gateOutput = & "hooks/post-build-gate.ps1" 2>&1
    if ($LASTEXITCODE -ne 0) {
      # Gate failed. Undo the merge, block the bead.
      git reset --hard HEAD~1
      bd update $beadId --status=blocked --notes "post-merge gate failed on main" --append-notes "$gateOutput"
      $blockedSet += $beadId
      $mergeInFlight = $null
      return
    }

    # Success. Close the bead, remove the worktree.
    bd close $beadId --session $env:CLAUDE_SESSION_ID
    bd worktree remove "task-$beadId" --force 2>&1 | Out-Null
    $mergedSet += $beadId
    Write-Host "[MERGE] $beadId → main (post-gate PASS)"

  } finally {
    Pop-Location
    $mergeInFlight = $null
  }
```

### Find-BuildCompleteMarker

```
Find-BuildCompleteMarker($output):
  # Match the LAST occurrence — workers should emit exactly one, but if a
  # malformed run emits multiple, the last one is authoritative.
  $regex = '<!-- BUILD_COMPLETE:({.*?}) -->'
  $matches = [regex]::Matches($output, $regex)
  if ($matches.Count -eq 0) { return $null }
  $json = $matches[$matches.Count - 1].Groups[1].Value
  return $json | ConvertFrom-Json
```

## Phase 2: summary

After the poll loop exits:

```
[BATCH COMPLETE]
  Merged:   $($mergedSet.Count) beads → $($mergedSet -join ', ')
  Blocked:  $($blockedSet.Count) beads → $($blockedSet -join ', ')
  Failed:   $($failedSet.Count) beads → $($failedSet -join ', ')
  Duration: $((Get-Date) - $batchStart)
```

Then:

- If `$blockedSet.Count -gt 0` → invoke `/escalate` (it builds the push notification from `bd blocked`).
- If `$failedSet.Count -gt 0` → print the worktree paths for the human to inspect, do NOT auto-escalate (these need eyes, not a notification).
- If all clean and `bd ready` is now empty → consider invoking `/retro` (matches /build-next's DONE path).

## Stage timeout

Default `$stageTimeout = 30 minutes` per worker. If a worker hasn't emitted BUILD_COMPLETE in 30 min, `TaskStop` it, mark the bead blocked with `"worker timeout"`, and continue. A worker that hangs without output is almost always wedged on a tool prompt or an interactive command.

## Stopping conditions (do not guess)

- Worktree create fails (disk full, bd misconfigured) → block the bead, do not retry.
- bd lock contention three times in a row → exit the batch; recommend the user `bd doctor --fix` and re-run.
- More than 50% of attempted beads end up in `$failedSet` (not blocked — failed) → abort the batch. Something systemic is wrong; better to stop than burn budget.
- Cumulative session cost exceeds `--budget` → finish the in-flight merge, then exit. Do NOT dispatch new work mid-budget-exceed.

## Do not

- Do not run /build-batch in meta mode. Period.
- Do not skip the post-merge gate "because the worker gate already passed." That's the whole point — defense-in-depth catches the cases where two workers' merges interact.
- Do not run concurrent merges. The merge queue exists for exactly this reason.
- Do not amend or rebase a worker's commit. If a commit is wrong, the bead is blocked.
- Do not `bd close` a bead before the post-merge gate passes. The bead's "done" state IS "merged to main and main is green."
- Do not auto-remove the worktree of a `failed` bead — the human needs that state to debug.
- Do not invoke `/build-batch` recursively. One orchestrator at a time.
- Do not promise dependency-aware scheduling beyond what `bd ready` gives you. If two ready siblings would conflict on a shared file (no `testPlanFile` plan yet), the post-merge gate is what catches the conflict.
