# Architecture

## Design principles

1. **Beads is the state.** No parallel `tasks.yaml`, no markdown TODO drift. If it isn't in beads, it doesn't exist. The skills are thin glue over `bd` commands.
2. **Formulas are the intellectual property.** Each formula encodes a reusable work pattern (CRUD feature, auth flow, UI page). Building a new app is mostly picking and parameterizing formulas.
3. **The loop is dumb on purpose.** `/build-next` does: pick → claim → build → gate → close. All the intelligence about *what to build* lives in the formulas and the plan. All the intelligence about *when to stop and ask* lives in escalation rules.
4. **Escalation over guessing.** Anything that requires judgment the loop cannot self-verify becomes a `bd update --status=blocked` with a reason. The escalate skill summarizes blockers and pushes a notification.
5. **Worktree-per-task.** Each task builds in `bd worktree create task-<id>`, then commits and removes the worktree. Same beads DB, isolated checkout. Enables future parallelism with no redesign.

## Stage-by-stage

### `/vision` — vision.md → plan.md

Inputs: `templates/vision.md` filled out by the user.
Outputs: `plan.md` containing:
- Tech stack decision with one-line reasoning per choice
- Data model (entities, fields, relationships)
- Feature list ranked by dependency
- Formula picks (which `formulas/*.formula.yaml` to pour, with variable bindings)
- Escalation budget (e.g. "block on >$5/day API spend")

This stage runs *with the user in the loop*. The plan is a contract — the loop won't second-guess it later.

### `/compose` — plan.md → beads DAG

Initializes beads in the app repo, runs `bd setup claude --project`, then for each formula pick:
- `bd cook <formula> --var k=v ... --persist` (or `bd mol pour`) to spawn the issue subtree
- `bd dep add` for cross-formula dependencies declared in the plan

Output: a populated beads DB with epics, tasks, and a working dep graph. `bd ready` should return the first true leaf tasks.

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
hooks/post-build-gate.ps1                   # typecheck + lint + test
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

## Why beads specifically

- **Dependency-aware ready queue** (`bd ready` excludes blocked, in-progress, deferred, hooked) — no custom scheduler needed.
- **Atomic claim** (`bd update --claim`) — multi-agent safe out of the box.
- **Formula/molecule system** — first-class workflow templates with variable substitution and DAG composition.
- **`bd worktree create`** — auto-redirects the beads DB so all worktrees share state.
- **`bd preflight`** — built-in PR-readiness checklist usable as a quality gate.
- **JSON output everywhere** — skills can parse without scraping.

## Why a dedicated workflow repo

- Formulas evolve as you build more apps. Versioning them in their own repo means improvements compound rather than getting stranded in one app.
- Skills can be symlinked into `~/.claude/skills/` (global) while the source of truth lives here.
- `git log` on this repo is the history of how your build workflow itself has matured.
