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

## Modes

**App mode** (default): the repo is an app scaffolded by `/compose`. `AGENTS.md` exists at repo root, Jankurai is initialized (or about to be), and the full Step 5–8 sequence runs. This is what 99% of /build-next ticks do.

**Meta mode**: the repo is `autonomous-build` itself, and the work is editing skills, formulas, hooks, or docs. Detect this at the top of the tick:

```powershell
$metaMode = -not (Test-Path "AGENTS.md")
```

In meta mode:
- **Skip Step 5 (worktree)** unless the change is genuinely risky (cross-skill rewrite, schema change). Skill/formula edits are small enough that working on `main` is fine.
- **Skip Step 6 (Jankurai kickoff)** entirely — there's no `AGENTS.md` to bound against, and skills/formulas aren't Jankurai-tracked source code.
- **Step 8 quality gate** runs unchanged — the gate is self-detecting (no package.json → no Node checks; no baseline → no witness; jankurai audit runs but is advisory).
- **Step 11 worktree cleanup** is also skipped when Step 5 was skipped.
- Print `MODE: meta` at the start of the tick so the loop driver and any human observer know which path the skill took.

If unsure whether the work is "risky enough" to warrant a worktree in meta mode: default to no worktree. The diff is git-tracked; revert is one command.

## Process

### Step 1: pick

```powershell
$next = bd ready --json | ConvertFrom-Json | Where-Object { $_.issue_type -ne 'epic' } | Select-Object -First 1
```

`bd ready` includes epics, but epics are containers with no implementable work. Filter them out client-side (bd has no `--type` filter on `ready`).

If `$next` is empty:
- Check `bd blocked --json`. If any → invoke `/escalate` and exit.
- If both empty → print "DONE: no ready or blocked work" and exit.

Capture the returned issue ID as `$id = $next.id`.

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

### Step 3.5: freshness check

A bead is a snapshot of the codebase at the time it was filed. Other work — sibling beads, manual edits, a partial /retro that landed — may have already satisfied the AC. Skip this step and you'll dispatch a builder to do nothing, waste a worktree, and add a confusing empty commit.

Before doing any other gating, verify the bead's **load-bearing claims** against current code. A load-bearing claim is anything the bead asserts about the *current* state that the implementation plan depends on:

- "File X does not exist" / "X is missing" → `Test-Path X` or `Glob X`
- "X is not wired into Y" / "Z is orphan" → grep for the wiring, confirm it's still absent
- "X currently has N lines / N imports / N callers" → spot-check the count is still ≈ correct
- "Current behavior is X" → quick read or grep to confirm

Three outcomes:

| Outcome | Detection | Action |
|---|---|---|
| **Fresh** | every claim still matches current code | proceed to Step 4 |
| **Drifted** | supporting details moved (file renamed, count off, neighboring code refactored) BUT the underlying gap is still real | proceed to Step 4, **add a "Freshness note" line** to the design field via `bd update $id --design "<original design>\n\nFreshness note (<date>): <what moved>"` so the builder doesn't trust stale details |
| **Stale** | the bead's AC is already met by code that landed after the bead was filed | close immediately: `bd close $id --reason "stale: AC already met by <file/commit ref>"`. Exit with "STALE: $id" so the loop picks the next bead. Do NOT proceed to Step 4. |

Keep this fast — 2–4 Grep/Glob calls is the right budget. This is a sanity check, not a code review. If a claim is too vague to mechanically verify (e.g. "the system is too slow"), skip the freshness check for that claim and proceed; the escalation pre-check (Step 4) will catch genuinely unverifiable beads.

The stale path is especially important when /retro has filed beads in batches — sibling beads in the same batch often silently satisfy each other.

### Step 4: escalation pre-check

Before writing any code, check the issue against `docs/ESCALATION_RULES.md`:
- Does this touch existing-data schema migrations? → block
- Does this introduce a paid third-party API? → block
- Does this make an auth/authz model decision? → block
- Are secrets involved? → block
- Cumulative session cost over budget? → block

If any → `bd update $id --status=blocked --notes "<rule>"` and exit (loop will detect and call `/escalate`).

### Step 5: worktree

**App mode:**
```powershell
bd worktree create "task-$id"
```

`cd` into the worktree. All subsequent file edits happen here.

**Meta mode:** skip — work directly on `main`. (See "Modes" above for when to override and use a worktree anyway.)

### Step 6: Jankurai kickoff (bounded plan)

**Meta mode:** skip this entire step. There's no `AGENTS.md` to bound the intent against, and the skills/formulas being edited aren't Jankurai-tracked. Proceed to Step 7.

**App mode:** The repo has `AGENTS.md` from `/compose`. Read it. Then turn the issue's `acceptance` into a bounded plan:

```powershell
mkdir -Force target/jankurai | Out-Null
jankurai kickoff . `
  --intent "<issue title + key acceptance lines, one paragraph>" `
  --out target/jankurai/kickoff-$id.json `
  --md  target/jankurai/kickoff-$id.md
```

The kickoff receipt tells you:
- **Read-first files** before editing.
- **Ownership boundaries** and **forbidden paths** for this change.
- **Proof lane** the change needs to satisfy.
- **Clarifying questions** — if any are blocking, treat them as you would a `needs-decision` label: `bd update --status=blocked` with the question.

If kickoff fails or refuses to bound the intent (intent too broad), block the issue: `bd update $id --status=blocked --notes "jankurai kickoff: intent too broad to bound — needs scope clarification"`.

### Step 7: implement

Implement against `acceptance` and the kickoff plan. Stay inside the kickoff's ownership boundaries; do not edit forbidden paths. Write tests first if the formula's design notes recommend it. Keep the change scoped to this single issue — if you find yourself touching things outside the kickoff's bounded set, that's an escalation (block with "scope creep: <what>").

Optional: launch the editor session under `jankurai guard run -- claude` for realtime write enforcement (failed writes get reverted, agent sees a compile-error header). Useful when the change is risky; overhead otherwise.

### Step 8: quality gate

```powershell
..\autonomous-build\hooks\post-build-gate.ps1
```

(Or symlink it in.) Exits 0 on green, nonzero with summary on red. The gate now includes a Jankurai pass: `jankurai audit --changed-fast` (advisory — prints findings, does not fail the gate by itself) and `jankurai witness` against `agent/baselines/main.repo-score.json` if that baseline exists (hard fail on regression).

On red:
- First failure: read the failure (including `target/jankurai/audit-fast.md` and `target/jankurai/merge-witness.md` if present), adjust, re-run. Once.
- Second failure: `bd update $id --status=blocked --notes "<failure summary>" --append-notes "<full failure output>"`, leave the worktree for the human to inspect, exit.

### Step 9: commit

```powershell
git add -A
git commit -m "<issue.title> (bd: $id)"
```

Use a HEREDOC for multi-line bodies. Do not include co-author lines unless the user has previously enabled them. Do **not** stage `target/jankurai/` — it should be in `.gitignore`.

### Step 10: close

```powershell
bd close $id --session $env:CLAUDE_SESSION_ID
```

### Step 11: clean up worktree

**Meta mode:** skip (no worktree was created in Step 5).

**App mode:**
```powershell
# from main checkout
bd worktree remove "task-$id"
```

(If `--merge` is needed first, do that — depends on the user's branching strategy in plan.md.)

### Step 12: schedule next tick

Output the next-action hint for `/loop`. Use the same non-epic filter as Step 1 when counting remaining work:

```powershell
$remaining = (bd ready --json | ConvertFrom-Json | Where-Object { $_.issue_type -ne 'epic' }).Count
```

- `$remaining > 0` → "READY: $remaining remaining" — loop should wake in 60–180s
- `$remaining == 0` and blocked present → invoke `/escalate`, then "BLOCKED: <count>" — loop should exit
- `$remaining == 0` and no blocked → invoke `/retro` (the build is done; generate the workflow performance report and file improvements), then "DONE" — loop should exit

Note: if this tick exited at Step 3.5 with "STALE: $id", the loop should wake immediately — there's still real work in the queue and the freshness check is cheap.

The DONE-path `/retro` invocation is automatic. The user can also run `/retro` mid-build for a partial review — the skill handles either case.

## Stopping conditions (escalate, do not guess)

- Any rule in `docs/ESCALATION_RULES.md` fires.
- Quality gate fails twice on the same issue.
- A required tool isn't installed (don't auto-install — that's a human decision).
- Tests pass but acceptance can't be self-verified (e.g. "the UI looks right" — block with a screenshot request).
- A task's scope expands during implementation (block with "scope creep: <what>").

## Do not

- Do not skip the quality gate "just this once".
- Do not skip the Step 3.5 freshness check on the assumption that "the bead was just filed". /retro batches and sibling beads regularly satisfy each other invisibly.
- Do not edit `acceptance` to make a failing build pass.
- Do not close an issue whose tests are skipped, mocked over, or commented out.
- Do not work on multiple issues in one tick. The loop will pick them up in order.
- Do not commit to the main branch from inside the worktree — the worktree has its own branch.
- Do not skip the `jankurai kickoff` step **in app mode**. If kickoff cannot bound the intent, that is a real signal — block the issue, do not work around it. (Meta mode skips kickoff by design — see "Modes" above.)
- Do not edit files outside the kickoff's ownership boundaries to make the gate pass.
- Do not commit `target/jankurai/` receipts to git — they are local generated outputs. Baselines (`agent/baselines/`) ARE committed, in dedicated commits.
