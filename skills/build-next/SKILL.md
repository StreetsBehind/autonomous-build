---
name: build-next
description: Execute one tick of the autonomous build loop — pick the next ready beads issue, claim it, implement it in a worktree, run the quality gate, commit, and close (or block). Use when the user says "build next", "next task", "advance the loop", or when invoked by /loop /build-next. Designed to be run repeatedly without human input until ready=0.
---

# build-next

Execute exactly one beads task. Designed to be invoked over and over by `/loop /build-next` until `bd ready` is empty.

## Single-tick contract

This skill must:
1. Always exit cleanly (success or escalation), never leave a half-built state.
2. Always leave the beads DB in a consistent state — either `closed`, `blocked`, or `in_progress` with a valid worktree.
3. Always print a one-line outcome the loop driver can use to decide pacing.

## Process

### Step 1: pick

```powershell
bd ready --json --limit 1
```

If empty:
- Check `bd blocked --json`. If any → invoke `/escalate` and exit.
- If both empty → print "DONE: no ready or blocked work" and exit.

Capture the returned issue ID as `$id`.

### Step 2: claim

```powershell
bd update $id --claim
```

If this fails (already claimed by another agent), exit and let the loop pick again on the next tick.

### Step 3: read the issue

```powershell
bd show $id --json
```

Pay attention to:
- `acceptance` — the contract. If empty or vague, block immediately: `bd update $id --status=blocked --notes "acceptance criteria too vague to self-verify"`.
- `design` — implementation hints from the formula.
- `dependencies` — should all be closed (beads enforces this, but sanity check).
- `labels` — may include hints like `needs-decision`, `touches-auth`. If any match an escalation trigger, block.

### Step 4: escalation pre-check

Before writing any code, check the issue against `docs/ESCALATION_RULES.md`:
- Does this touch existing-data schema migrations? → block
- Does this introduce a paid third-party API? → block
- Does this make an auth/authz model decision? → block
- Are secrets involved? → block
- Cumulative session cost over budget? → block

If any → `bd update $id --status=blocked --notes "<rule>"` and exit (loop will detect and call `/escalate`).

### Step 5: worktree

```powershell
bd worktree create "task-$id"
```

`cd` into the worktree. All subsequent file edits happen here.

### Step 6: implement

Implement against `acceptance`. Write tests first if the formula's design notes recommend it. Keep the change scoped to this single issue — if you find yourself touching things outside the issue's scope, that's a sign of an escalation (block with "scope creep detected: <what>").

### Step 7: quality gate

```powershell
..\autonomous-build\hooks\post-build-gate.ps1
```

(Or symlink it in.) Exits 0 on green, nonzero with summary on red.

On red:
- First failure: read the failure, adjust, re-run. Once.
- Second failure: `bd update $id --status=blocked --notes "<failure summary>" --append-notes "<full failure output>"`, leave the worktree for the human to inspect, exit.

### Step 8: commit

```powershell
git add -A
git commit -m "<issue.title> (bd: $id)"
```

Use a HEREDOC for multi-line bodies. Do not include co-author lines unless the user has previously enabled them.

### Step 9: close

```powershell
bd close $id --session $env:CLAUDE_SESSION_ID
```

### Step 10: clean up worktree

```powershell
# from main checkout
bd worktree remove "task-$id"
```

(If `--merge` is needed first, do that — depends on the user's branching strategy in plan.md.)

### Step 11: schedule next tick

Output the next-action hint for `/loop`:
- `bd ready --json --limit 1` non-empty → "READY: <count> remaining" — loop should wake in 60–180s
- empty + blocked present → invoke `/escalate`, then "BLOCKED: <count>" — loop should exit
- both empty → invoke `/retro` (the build is done; generate the workflow performance report and file improvements), then "DONE" — loop should exit

The DONE-path `/retro` invocation is automatic. The user can also run `/retro` mid-build for a partial review — the skill handles either case.

## Stopping conditions (escalate, do not guess)

- Any rule in `docs/ESCALATION_RULES.md` fires.
- Quality gate fails twice on the same issue.
- A required tool isn't installed (don't auto-install — that's a human decision).
- Tests pass but acceptance can't be self-verified (e.g. "the UI looks right" — block with a screenshot request).
- A task's scope expands during implementation (block with "scope creep: <what>").

## Do not

- Do not skip the quality gate "just this once".
- Do not edit `acceptance` to make a failing build pass.
- Do not close an issue whose tests are skipped, mocked over, or commented out.
- Do not work on multiple issues in one tick. The loop will pick them up in order.
- Do not commit to the main branch from inside the worktree — the worktree has its own branch.
