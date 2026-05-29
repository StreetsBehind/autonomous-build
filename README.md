# autonomous-build

Workflow infrastructure for going from a `vision.md` file to a shipped app, with the human as autopilot supervisor rather than pilot. Uses [beads (`bd`)](https://github.com/steveyegge/beads) for task tracking, a mix of Claude Code skills and dynamic workflows for the per-stage steps, and `/loop` to drive autonomous execution.

## The pipeline

```
vision.md   ──/vision──▶   plan.md + plan.lock.json + tenets.md
plan.md + plan.lock.json  ──/decompose──▶  blessed beads DAG (epics + tasks + deps)
   (dynamic workflow: fans out formula pours, atomizes oversized beads,
    scores each bead, adversarially cross-checks the DAG against the plan,
    emits a BLESSED | NEEDS-FIX verdict + decomposeReport.md.
    Subsumes the old /compose + /quality-pass + /split skills.)
   tenets.md ─ read by /build-next for build-time judgment calls
                                  │
                          human review
                   (authorize the blessed DAG before build)
                                  │
                                  ▼
        ┌──── /build-batch  (or /loop /build-next) ────┐
        │  bd ready → claim → build                    │   ◀── /flag bd-<id> <reason>
        │  → gate → commit → bd close (or block)       │       (in-flight workflow capture)
        │  /build-batch: N workers in worktrees,       │
        │   serialized merges behind the post-merge    │
        │   gate (dynamic workflow, refuses meta mode)  │
        └─┬───────────────────────────────────┬────────┘
          │ ready=0,                           │ ready=0,
          │ blocked>0                          │ blocked=0
          ▼                                    ▼
      /escalate                             /retro
      (PushNotification)                    (workflow performance report +
                                             files improvements into
                                             autonomous-build's own beads)
```

## Repo layout

| Path | What it is |
| --- | --- |
| `formulas/` | beads workflow templates — the reusable intellectual property |
| `skills/` | Turn-by-turn Claude Code skills (`vision`, `build-next`, `escalate`, `flag`) |
| `workflows/` | Dynamic-workflow specs (`<name>.spec.md`) and their canonical scripts (`<name>.js`). `decompose`, `build-batch`, and `retro` live here. `decompose.js` and `build-batch.js` are hand-authored (load-bearing); `retro.js` is first-run-generated then saved. |
| `templates/vision.md` | The form you fill out per app |
| `templates/tenets.md` | Template `/vision` populates per-app — inherits the workflow tenets and derives app-specific ones from vision + plan.lock |
| `docs/TENETS.md` | The workflow-level tenets — principles the loop falls back on for build-time judgment calls |
| `hooks/post-build-gate.{sh,ps1}` | Quality gate (typecheck/lint/test + Jankurai audit/witness) run before every `bd close`. `.sh` on Linux/macOS, `.ps1` (via `pwsh`) on Windows — kept in sync |
| `retros/` | Markdown retros produced by `/retro` after each app finishes |
| `.beads/` | This repo's *own* beads DB — tracks workflow improvements (retro-filed) |
| `docs/` | Architecture, install, escalation rules |

## Getting started

1. Clone this repo.
2. From the repo root, run the installer for your platform:
   - **Windows:** `./install.ps1` — creates a directory junction for each `skills/` subdir in `~/.claude/skills/`, a same-volume NTFS hard link for each `formulas/` file in `~/.beads/formulas/`, and a hard link for each `workflows/*.js` script in `~/.claude/workflows/`.
   - **Linux / macOS:** `./install.sh` — the same wiring via symlinks (which need no admin off Windows). Flags mirror the PowerShell version: `--dry-run` to plan without changing anything, `--force` to overwrite mismatched links / real files / dirs.

   Either installer makes the skills, formulas, and dynamic workflows resolvable user-globally so the runtime finds them from any app repo. Both also clean up stale skill links whose source no longer exists in this repo (e.g. skills that have graduated to workflows). Idempotent — safe to re-run after `git pull` to pick up new skills, formulas, or workflows.
3. Install [Jankurai](https://github.com/neverhuman/jankurai) (`cargo install --path crates/jankurai --locked` from a checkout, or the release installer).
4. In any new app repo: `bd init && bd setup claude --project`, then invoke `/vision`.

See `docs/INSTALL.md` for the long-form notes, including why the Windows installer uses junctions+hardlinks instead of symbolic links (no admin / Developer Mode requirement) while `install.sh` uses plain symlinks.

## Quality standard

Every app this workflow builds is held to the **[Jankurai](https://github.com/neverhuman/jankurai)** standard — an anti-vibe coding spec + local audit CLI that turns "did the agent do the right thing?" into auditable receipts. The pipeline wires it in at three points:

| Stage | Jankurai step | Mode |
| --- | --- | --- |
| `/decompose` (per-app init) | `jankurai adopt` → `jankurai init --level agents --yes` → first advisory `jankurai audit` | Scaffolds `AGENTS.md`, ownership map, proof lanes; establishes a starting score |
| `/build-next` (per-task) | `jankurai kickoff --intent "<acceptance>"` before coding | Bounds the change — names read-first files, ownership boundaries, forbidden paths, proof lane |
| `hooks/post-build-gate.{sh,ps1}` (per-task close) | `jankurai audit --changed-fast` (advisory) + `jankurai witness` against baseline if present (hard fail on regression) | Inner-loop scan; merge witness ratchets only after a baseline has been accepted |

Adoption is staged: start at **observe** + **agents** (read-only inventory and AGENTS.md), then accept a baseline at `agent/baselines/main.repo-score.json` in a dedicated commit once the first few tasks close cleanly, then enable **ratchet** mode in CI.

Receipts land under `target/jankurai/` (gitignored) per task. Baselines under `agent/baselines/` (tracked, trusted).

## Conventions

- App repos are siblings: `~/Documents/Github/<app-name>/`, not nested here.
- Each `/build-next` works in its own `bd worktree` so the main checkout stays clean and parallelism is possible later.
- Decisions that require human judgment (schema changes on existing data, auth model, paid APIs, repeated failures) escalate via `bd update --status=blocked` and `PushNotification` — they are not guessed. See `docs/ESCALATION_RULES.md`.
- Jankurai kickoff refusal ("intent too broad to bound") is treated as a real signal: the task blocks, it doesn't get worked around.
