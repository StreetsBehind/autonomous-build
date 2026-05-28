# autonomous-build

Workflow infrastructure for going from a `vision.md` file to a shipped app, with the human as autopilot supervisor rather than pilot. Uses [beads (`bd`)](https://github.com/gastownhall/beads) for task tracking, Claude Code skills for the per-stage workflows, and `/loop` to drive autonomous execution.

## The pipeline

```
vision.md   ──/vision──▶   plan.md
plan.md     ──/compose──▶  beads DAG (epics + tasks + deps)
                                  │
                                  ▼
              ┌──── /loop /build-next ────┐
              │  bd ready → claim → build │   ◀── /flag bd-<id> <reason>
              │  → gate → commit          │       (in-flight workflow capture)
              │  → bd close (or block)    │
              └─┬───────────────────┬─────┘
                │ ready=0,          │ ready=0,
                │ blocked>0         │ blocked=0
                ▼                   ▼
            /escalate            /retro
            (PushNotification)   (workflow performance report +
                                  files improvements into
                                  autonomous-build's own beads)
```

## Repo layout

| Path | What it is |
| --- | --- |
| `formulas/` | beads workflow templates — the reusable intellectual property |
| `skills/` | Claude Code skills that drive each stage (`vision`, `compose`, `build-next`, `escalate`, `flag`, `retro`) |
| `templates/vision.md` | The form you fill out per app |
| `hooks/post-build-gate.ps1` | Quality gate (typecheck/lint/test + Jankurai audit/witness) run before every `bd close` |
| `retros/` | Markdown retros produced by `/retro` after each app finishes |
| `.beads/` | This repo's *own* beads DB — tracks workflow improvements (retro-filed) |
| `docs/` | Architecture, install, escalation rules |

## Getting started

See `docs/INSTALL.md`. Short version: clone, symlink `skills/` into `~/.claude/skills/`, copy `formulas/` into `~/.beads/formulas/`, install [Jankurai](https://github.com/neverhuman/jankurai) (`cargo install --path crates/jankurai --locked` from a checkout, or the release installer), then in any new app repo run `bd init && bd setup claude --project` and invoke `/vision`.

## Quality standard

Every app this workflow builds is held to the **[Jankurai](https://github.com/neverhuman/jankurai)** standard — an anti-vibe coding spec + local audit CLI that turns "did the agent do the right thing?" into auditable receipts. The pipeline wires it in at three points:

| Stage | Jankurai step | Mode |
| --- | --- | --- |
| `/compose` (per-app init) | `jankurai adopt` → `jankurai init --level agents --yes` → first advisory `jankurai audit` | Scaffolds `AGENTS.md`, ownership map, proof lanes; establishes a starting score |
| `/build-next` (per-task) | `jankurai kickoff --intent "<acceptance>"` before coding | Bounds the change — names read-first files, ownership boundaries, forbidden paths, proof lane |
| `hooks/post-build-gate.ps1` (per-task close) | `jankurai audit --changed-fast` (advisory) + `jankurai witness` against baseline if present (hard fail on regression) | Inner-loop scan; merge witness ratchets only after a baseline has been accepted |

Adoption is staged: start at **observe** + **agents** (read-only inventory and AGENTS.md), then accept a baseline at `agent/baselines/main.repo-score.json` in a dedicated commit once the first few tasks close cleanly, then enable **ratchet** mode in CI.

Receipts land under `target/jankurai/` (gitignored) per task. Baselines under `agent/baselines/` (tracked, trusted).

## Conventions

- App repos are siblings: `~/Documents/Github/<app-name>/`, not nested here.
- Each `/build-next` works in its own `bd worktree` so the main checkout stays clean and parallelism is possible later.
- Decisions that require human judgment (schema changes on existing data, auth model, paid APIs, repeated failures) escalate via `bd update --status=blocked` and `PushNotification` — they are not guessed. See `docs/ESCALATION_RULES.md`.
- Jankurai kickoff refusal ("intent too broad to bound") is treated as a real signal: the task blocks, it doesn't get worked around.
