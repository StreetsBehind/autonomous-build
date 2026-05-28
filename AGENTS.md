# Agent instructions — autonomous-build

This is the **workflow repository**, not an app. Beads issues here track *improvements to the workflow itself* (skills, formulas, gate logic, escalation rules), not app code.

## What lives in this repo's beads

- **`Workflow improvements` epic** (`bd-1zq` or look up via `bd query "type=epic AND title='Workflow improvements'"`) — anchor for all retro-filed improvement tasks.
- **Per-retro sub-epics** — each `/retro` run creates one, with the suggested changes as children.
- **Labels you'll see:** `workflow-improvement`, `from-app:<name>`.

## How issues get created here

1. **Automatically** by `/retro` against an app repo. The retro analyzes the app's beads + git log, finds patterns (reverts, post-close edits, flagged issues, vague acceptance), and files concrete change-this-file-to-do-that tasks here.
2. **Manually** when you notice something you want to fix but don't have time to fix now: `bd create "..." --type=task -p 2 --add-label workflow-improvement`.

## How to work on these issues

These ARE candidates for the same `/loop /build-next` machinery applied to apps — workflow improvements have acceptance criteria like "edit skills/vision/SKILL.md to add bias toward SQLite for simple v1 apps" that the loop can self-verify (the diff exists, the language is present). For improvements that need judgment (rewriting whole formulas, redesigning a skill), do them in a regular session and close the issue manually.

## Quick reference

```bash
bd ready                          # next workflow improvement to tackle
bd show <id>                      # details + acceptance
bd update <id> --claim            # start work
bd close <id>                     # done
bd list --label workflow-improvement --all   # full backlog
```

## When NOT to file issues here

- Bugs in an app the loop built → file in the app's beads, not here. Here is for *workflow* bugs.
- One-off thoughts → use [[memory]] (`~/.claude/projects/.../memory/`) instead. Beads is for actionable work.

## Git

There is no remote configured for this repo by default. If you set one up later, beads' git hooks will auto-sync the `.beads/` JSONL exports on commit/push.
