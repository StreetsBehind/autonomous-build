# autonomous-build

Workflow infrastructure for going from a `vision.md` file to a shipped app, with the human as autopilot supervisor rather than pilot. Uses [beads (`bd`)](https://github.com/gastownhall/beads) for task tracking, Claude Code skills for the per-stage workflows, and `/loop` to drive autonomous execution.

## The pipeline

```
vision.md   ──/vision──▶   plan.md
plan.md     ──/compose──▶  beads DAG (epics + tasks + deps)
                                  │
                                  ▼
              ┌──── /loop /build-next ────┐
              │  bd ready → claim → build │
              │  → preflight → commit     │
              │  → bd close (or block)    │
              └────── exits when ready=0 ─┘
                                  │
                                  ▼
                             /escalate
                             (PushNotification with blocker summary)
```

## Repo layout

| Path | What it is |
| --- | --- |
| `formulas/` | beads workflow templates — the reusable intellectual property |
| `skills/` | Claude Code skills that drive each stage |
| `templates/vision.md` | The form you fill out per app |
| `hooks/post-build-gate.ps1` | Quality gate (typecheck/lint/test) run before every `bd close` |
| `docs/` | Architecture, install, escalation rules |

## Getting started

See `docs/INSTALL.md`. Short version: clone, symlink `skills/` into `~/.claude/skills/`, copy `formulas/` into `~/.beads/formulas/`, then in any new app repo run `bd init && bd setup claude --project` and invoke `/vision`.

## Conventions

- App repos are siblings: `~/Documents/Github/<app-name>/`, not nested here.
- Each `/build-next` works in its own `bd worktree` so the main checkout stays clean and parallelism is possible later.
- Decisions that require human judgment (schema changes on existing data, auth model, paid APIs, repeated failures) escalate via `bd update --status=blocked` and `PushNotification` — they are not guessed. See `docs/ESCALATION_RULES.md`.
