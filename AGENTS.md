# Agent instructions — autonomous-build

This is the **workflow repository**, not an app. Beads issues here track *improvements to the workflow itself* (skills, dynamic workflows, formulas, gate logic, escalation rules), not app code.

## What lives in this repo's beads

- **`Workflow improvements` epic** (`bd-1zq` or look up via `bd query "type=epic AND title='Workflow improvements'"`) — anchor for all retro-filed improvement tasks.
- **Per-retro sub-epics** — each `/retro` run creates one, with the suggested changes as children.
- **Labels you'll see:** `workflow-improvement`, `from-app:<name>`, `triage`, `needs-app-confirm` (see "Confirm-the-fix" below).

## How issues get created here

1. **Automatically** by `/retro` against an app repo. The retro analyzes the app's beads + git log, finds patterns (reverts, post-close edits, flagged issues, vague acceptance), and files concrete change-this-file-to-do-that tasks here.
2. **Manually** when you notice something you want to fix but don't have time to fix now: `bd create "..." --type=task -p 2 --labels workflow-improvement` (`bd create` uses `--labels <comma-separated>`, not `--add-label`). From inside a sibling app you're hand-working, use `/flag --upstream "<observation>"` instead — it files a `triage`-labelled bead straight here (see `docs/META_PATH_RESOLUTION.md`).

## Confirm-the-fix: the from-app bead lifecycle (`needs-app-confirm`)

A `from-app:<X>` bead originated from a defect surfaced in sibling app X. Landing a fix in *this* repo is only half the loop — the fix must be re-validated against app X before the bead is truly done. So a from-app bead carrying a **repro** (reproduction steps + an Expected outcome, e.g. `retros/repro-smbuild-decompose-run2-2026-05-28.md`) closes in two stages:

1. **Fix lands here** → the bead moves to **`needs-app-confirm`** (label, **open, not closed**): "fixed in the meta repo, not yet proven against the app."
2. **Re-validate** → `/confirm-upstream <bead>` (`skills/confirm-upstream/SKILL.md`) resolves app X, re-runs the recorded repro, and **closes only on green** (Actual now matches Expected), recording `confirmed-fixed vs <X>@<sha>` — the provable loop-closed moment. On red/blocked it leaves the bead `needs-app-confirm` with the failing output.

Do **not** close a from-app bead that has a runnable repro without that green confirmation (bead `autonomous-build-m73`). A from-app bead with no recorded repro is a human-confirm — `/confirm-upstream` will hold it at `needs-app-confirm` rather than close blind. (Auto-routing the build-next close-step into `/confirm-upstream` is a deferred follow-up; for now invoke it explicitly.)

## How to work on these issues

These ARE candidates for the same `/loop /build-next` machinery applied to apps — workflow improvements have acceptance criteria like "edit skills/vision/SKILL.md to add bias toward SQLite for simple v1 apps" that the loop can self-verify (the diff exists, the language is present). For improvements that need judgment (rewriting whole formulas, redesigning a skill), do them in a regular session and close the issue manually.

**Meta mode — use `/build-next`, not `/build-batch`.** Working this repo's own beads is *meta mode* (the cwd contains `skills/build-next/SKILL.md`). `/build-batch` is now a dynamic workflow, and its Phase 0 pre-flight agent refuses to run in meta mode — parallel workers would race on this repo's single shared checkout (there are no per-task worktrees in meta mode). So drive meta work with `/loop /build-next` (serial), which detects meta mode and skips the worktree + Jankurai kickoff steps. The refusal now lives in the workflow's Phase 0 agent rather than in skill prose.

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

## Quality standard for the apps this workflow builds

The pipeline applies the **[Jankurai](https://github.com/neverhuman/jankurai)** standard to every app it builds (not to this workflow repo itself — Jankurai governs the *outputs*, not the meta-infrastructure). When you change `skills/`, `workflows/`, `formulas/`, or `hooks/`, keep these invariants intact:

- `/decompose` scaffolds Jankurai in every new app (`jankurai adopt` + `jankurai init --level agents --yes`) — do not silently remove this; it produces the `AGENTS.md` that downstream `/build-next` / `/build-batch` ticks read. (`/decompose` is the dynamic workflow that subsumed the old `/compose` skill.)
- `/build-next` runs `jankurai kickoff --intent "<acceptance>"` before coding — this is the bounded-plan step. Kickoff refusal is a real signal, not a nuisance.
- `hooks/post-build-gate.{sh,ps1}` (POSIX + Windows ports, kept in sync) runs `jankurai audit --changed-fast --baseline <blessed>` (advisory) and then enforces a **regression-only ratchet parsed from the audit receipt** (`target/jankurai/audit-fast.json` → `decision.ratchet`): it blocks the commit iff `score_delta < -TOLERANCE` (TOLERANCE=2), there is a **new hard finding**, or there is a **new cap** — and *never* on the absolute 85 floor. It reads only those three fields, never `decision.passed`/`ratchet.passed` (floor-contaminated → would reintroduce the deadlock). A missing/unparseable/schema-skewed receipt is a **loud SKIP, not a block**. `jankurai witness` is no longer called for enforcement — it bakes the absolute 85 floor into its decision and would deadlock any sub-85 app. Do not gut this without a replacement audit step, and keep the two ports behaviourally identical.
- Receipts under `target/jankurai/` are gitignored; baselines under `agent/baselines/` are tracked and accepted in dedicated commits. `/decompose` captures the scaffold audit, but **baseline acceptance rides the human BLESSED gate** (auto-accepted with a loud "trusted-by-policy, not by human" note on the `--auto-bless` walk-away path) — not the unconditional Phase-2 stamp lbq.14 did. The gate then re-stamps the baseline **upward only** (high-water mark) on green commits so the trusted floor stays monotonic. App-mode callers (`/build-next`, `/build-batch`) export `GATE_REQUIRE_BASELINE=1`, so a missing baseline in app mode is a loud FAIL (a `/decompose` bug); meta mode leaves it unset and the ratchet quietly skips — correct, since Jankurai governs the outputs, not this repo. **Supersedes lbq.14** (which auto-stamped a sub-85 scaffold score and hard-failed on `jankurai witness`, proven to bake in the 85 floor and deadlock the next real app build); see `docs/JANKURAI_GATING_PROPOSAL.md` and the `autonomous-build-igu` epic.

Workflow-improvement tasks that touch the Jankurai integration should be labelled `quality-standard` so retros can find them.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
