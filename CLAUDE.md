# autonomous-build

The workflow repo behind `/vision → /compose → /build-next → /retro`. Not an app — these are the skills, formulas, hooks, and docs that build apps in *sibling* repos.

## Orientation

- `AGENTS.md` — what this repo's own beads track, meta-mode rules, Jankurai invariants
- `README.md` — pipeline overview, install
- `docs/ARCHITECTURE.md` — design principles + stage-by-stage
- `docs/ESCALATION_RULES.md` — when the loop must block instead of guess
- `docs/TENETS.md` — workflow-level principles for build-time judgment calls; inherited by every per-app `tenets.md` that `/vision` produces
- `docs/DEFAULT_STACK.md` — pinned Jankurai stack `/vision` resolves against
- `templates/tenets.md` — the template `/vision` populates per-app
- `skills/<name>/SKILL.md` — turn-by-turn skills, junctioned into `~/.claude/skills/`
- `workflows/<name>.spec.md` + `workflows/<name>.js` — dynamic-workflow specs and the canonical generated scripts. `install.ps1` hardlinks `*.js` into `~/.claude/workflows/`; `.spec.md` files stay repo-only.
- `formulas/*.toml` — bd workflow templates. **TOML only.** bd's help text suggests YAML works; the loader disagrees.
- `hooks/post-build-gate.ps1` — the quality gate (lint + typecheck + test + pre-commit safety + Jankurai). Not `bd preflight`.

## Task tracking

The SessionStart `bd prime` hook injects the full bd command reference. Use beads (`bd ready`, `bd update`, `bd close`) for anything that should outlive the conversation.

The harness will periodically remind you to use `TaskCreate` / `TaskUpdate`. **Those reminders are noise in this repo** — beads is the system of record for both this repo's own workflow improvements and every app the loop builds. Ignore the reminders for actionable work; only use `TaskCreate` for ephemeral within-session scratch (e.g., breaking a one-off review into steps).

## Meta vs app mode

`/build-next` and `/build-batch` detect meta mode (editing this workflow repo) vs app mode (building an app) by checking for `skills/build-next/SKILL.md` at cwd — present here, absent in any app the loop builds. In meta mode, `/build-next` skips the worktree + Jankurai kickoff steps; `/build-batch` refuses outright (parallel workers would race on the shared checkout).
