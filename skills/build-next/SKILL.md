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

**App mode** (default): the repo is an app scaffolded by `/decompose`. Jankurai is initialized (or about to be), and the full Step 5–8 sequence runs. This is what 99% of /build-next ticks do.

**Meta mode**: the repo is `autonomous-build` itself, and the work is editing skills, formulas, hooks, or docs. Detect this at the top of the tick:

```powershell
$metaMode = Test-Path "skills/build-next/SKILL.md"
```

The marker is this skill's own source file. It is present by definition in the workflow repo and absent in any app the loop builds. (Don't use `Test-Path AGENTS.md` for this — Jankurai writes an `AGENTS.md` into every app, and this repo also has one, so that check misfires both ways.)

In meta mode:
- **Skip Step 5 (worktree)** unless the change is genuinely risky (cross-skill rewrite, schema change). Skill/formula edits are small enough that working on `main` is fine.
- **Skip Step 6 (Jankurai kickoff)** entirely — skills/formulas aren't Jankurai-tracked source code, and there's no app-level `AGENTS.md` intent to bound against.
- **Step 8 quality gate** runs unchanged — the gate is self-detecting (no package.json → no Node checks; no baseline → no witness; jankurai audit runs but is advisory).
- **Step 11 worktree cleanup** is also skipped when Step 5 was skipped.
- Print `MODE: meta` at the start of the tick so the loop driver and any human observer know which path the skill took.

If unsure whether the work is "risky enough" to warrant a worktree in meta mode: default to no worktree. The diff is git-tracked; revert is one command.

## Phases

One tick is a linear pipeline of gates; each phase can exit the tick early (stale, blocked, DONE) without reaching the next. The detailed `## Process` steps below map onto these phases:

1. **meta** — detect meta vs app mode (`$metaMode`); meta mode skips the worktree, Jankurai kickoff, and worktree-cleanup phases.
2. **pick + claim** — `bd ready` → first non-epic leaf → **claim** it (`bd update --claim`); if nothing ready, branch to blocked-escalation or DONE.
3. **freshness** — verify the bead's load-bearing claims against current code; close-as-stale if the AC is already met before doing any work.
4. **epic + escalation** — read the issue (and its parent **epic** context); escalation pre-check against `docs/ESCALATION_RULES.md`; block rather than guess.
5. **tenets** — Jankurai kickoff (app mode) and the **tenets** check bound the change to declared intent before code is written.
6. **implement** — make the edit in the worktree (app) or on `main` (meta).
7. **gate** — run the post-build quality **gate** (lint + typecheck + test + Jankurai); a red gate blocks the close.
8. **close** — commit, **close** the bead, clean up the worktree, and schedule the next tick.

## Process

### Step 1: pick

```powershell
$next = bd ready --json | ConvertFrom-Json | Where-Object { $_.issue_type -ne 'epic' } | Select-Object -First 1
```

`bd ready` includes epics, but epics are containers with no implementable work. Filter them out client-side (bd has no `--type` filter on `ready`).

If `$next` is empty:
- Check `bd list --status=blocked --json`. If any → invoke `/escalate` and exit. (Use the **status field**, not `bd blocked` — `bd blocked` lists only *dependency*-blocked beads and misses the `--status=blocked` ones the loop itself sets on every escalation, so a drain-to-blocked would read as zero and skip the page; autonomous-build-gh4.)
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

Before writing any code, check the issue against the escalation rules. **Resolve the rules file the way Step 8 resolves the gate** — the rules live in the workflow repo and are *not* copied into app repos, so a bare `docs/ESCALATION_RULES.md` resolves to the app cwd where it does not exist. Try the app repo root first, then the sibling `autonomous-build` checkout:

```bash
rules="$(git rev-parse --show-toplevel)/docs/ESCALATION_RULES.md"
[ -f "$rules" ] || rules="$(cd "$(git rev-parse --show-toplevel)/.." && pwd)/autonomous-build/docs/ESCALATION_RULES.md"
```

Then check the issue against the rules in `$rules`:
- Does this introduce a paid third-party API? → block
- Cumulative session cost over budget? → block
- Does this require a **new** auth/authz model, secrets, or migration decision? → block — **unless** that decision was front-loaded in `plan.lock.json` `concerns[]` (authn/authz/secrets/data-lifecycle `addressed` with evidence). If the relevant concern is `addressed`, the decision already exists: **implement the decided model and proceed, do not block.** Only block when the concern is absent/`excluded`, or the bead needs a decision *beyond* what the plan decided. A bare `touches-auth` label is not a block when the auth concern is decided (lbq.3).

If a genuine escalation fires → `bd update $id --status=blocked --notes "<rule>"` and exit (loop will detect and call `/escalate`).

### Step 5: worktree

**App mode:**
```powershell
bd worktree create "task-$id"
```

`cd` into the worktree. All subsequent file edits happen here.

**Meta mode:** skip — work directly on `main`. (See "Modes" above for when to override and use a worktree anyway.)

### Step 6: Jankurai kickoff (bounded plan)

**Meta mode:** skip this entire step. There's no `AGENTS.md` to bound the intent against, and the skills/formulas being edited aren't Jankurai-tracked. Proceed to Step 7.

**App mode:** The repo has `AGENTS.md` from `/decompose`. Read it. Then turn the issue's `acceptance` into a bounded plan:

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

### Step 6.5: Tenets check

Read the tenets as a context input alongside the bead spec and the kickoff plan. Tenets are the principles the loop falls back on for build-time judgment calls — they exist for exactly the "should I do X or Y" moments Step 7 implementation hits. Loading them now means the builder can consult them at the moment of decision instead of improvising and discovering the conflict at gate time (or worse, post-merge).

**App mode:** the per-app `tenets.md` is the primary source. `/vision` derives it from the app's vision.md and inherits T1–T10 verbatim from the workflow tenets:

```powershell
$tenets = Get-Content "tenets.md" -Raw -ErrorAction SilentlyContinue
if (-not $tenets) {
    # Pre-/vision-tenets app, or tenet was never derived. Fall back to workflow tenets.
    $tenets = Get-Content "<autonomous-build path>/docs/TENETS.md" -Raw
}
```

**Meta mode:** the workflow tenets in `docs/TENETS.md` ARE this repo's tenets — load them directly:

```powershell
$tenets = Get-Content "docs/TENETS.md" -Raw
```

Source-of-truth ordering applies: if a question is answered by the bead spec, plan.lock, formula, or gate, those win — the tenets only kick in when none of them decide. If a tenet directly forbids the implementation approach the bead's design calls for, that is a Stopping condition (see below) — block, do not improvise around it.

### Step 7: implement

Implement against `acceptance`, the kickoff plan, and the tenets loaded in Step 6.5. Stay inside the kickoff's ownership boundaries; do not edit forbidden paths. Write tests first if the formula's design notes recommend it. Keep the change scoped to this single issue — if you find yourself touching things outside the kickoff's bounded set, that's an escalation (block with "scope creep: <what>").

Optional: launch the editor session under `jankurai guard run -- claude` for realtime write enforcement (failed writes get reverted, agent sees a compile-error header). Useful when the change is risky; overhead otherwise.

### Step 8: quality gate

Run the gate that matches the host OS. There is **no PowerShell on the documented Linux/macOS path** — use the `.sh`; reserve the `.ps1` (invoked via `pwsh`) for Windows. Resolve the `hooks/` dir from the app repo root first, then from the sibling `autonomous-build` checkout:

In **app mode**, export `GATE_REQUIRE_BASELINE=1` before running the gate. App repos are blessed by `/decompose` before the loop starts, so a missing baseline at gate time is a `/decompose` bug, not a benign fresh-repo condition — the signal flips the gate's no-baseline branch from quiet SKIP to LOUD FAIL (igu.3), blocking the bead instead of silently shipping ungated commits. In **meta mode**, do NOT set it: this workflow repo is never Jankurai-governed, so no baseline is correct and the gate's quiet SKIP is what we want.

```bash
# Linux / macOS
gate="$(git rev-parse --show-toplevel)/hooks/post-build-gate.sh"
[ -f "$gate" ] || gate="$(cd "$(git rev-parse --show-toplevel)/.." && pwd)/autonomous-build/hooks/post-build-gate.sh"
# App mode only — meta mode leaves GATE_REQUIRE_BASELINE unset (quiet SKIP).
if [ "$metaMode" != "1" ]; then export GATE_REQUIRE_BASELINE=1; fi
"$gate"
```

```powershell
# Windows
$gate = Join-Path (git rev-parse --show-toplevel) "hooks/post-build-gate.ps1"
if (-not (Test-Path $gate)) { $gate = Join-Path (Resolve-Path "../autonomous-build/hooks/post-build-gate.ps1") "" }
# App mode only — meta mode leaves GATE_REQUIRE_BASELINE unset (quiet SKIP).
if (-not $metaMode) { $env:GATE_REQUIRE_BASELINE = "1" }
pwsh -NoProfile -File $gate
```

Exits 0 on green, nonzero with summary on red. The gate's Jankurai pass is: `jankurai audit --changed-fast` (advisory — prints findings, does not fail the gate by itself) plus a **regression-only ratchet** parsed from the audit receipt's `decision.ratchet` (igu.1, supersedes the old `jankurai witness` exit-code gate) — it hard-fails only on `score_delta < -TOLERANCE`, new hard findings, or new caps, and only when `agent/baselines/main.repo-score.json` exists. On a **green** commit in app mode (baseline present), the gate may also **re-stamp the baseline upward** (high-water mark, igu.2) — a one-way advance that creates its own `chore: ratchet jankurai baseline upward (...)` commit. The serial build-next path leaves the re-stamp on; only build-batch's parallel workers disable it (`GATE_RESTAMP=off`).

On red — the retry budget is **not** a hardcoded "once" (that biases surviving output toward easy beads and strands hard, load-bearing ones, lbq.19). Compute the gate-attempt budget for this bead:

```
budget = plan.lock.escalationBudget.maxFailuresPerTask   # default 2 if no lock
# Load-bearing bonus: stranding a bead that blocks others wastes the whole
# downstream subtree, so it earns more attempts before a permanent block.
if bead has dependents (other beads blocked-by it) OR priority is P0/P1: budget += 2
```

- Each failure: read the failure (including `target/jankurai/audit-fast.md` and `target/jankurai/merge-witness.md` if present), adjust, re-run — up to `budget` total attempts.
- On the final failure (attempts == budget): `bd update $id --status=blocked --notes "<failure summary>" --append-notes "<full failure output>"`, leave the worktree for the human to inspect, exit.

Each re-run must be a *different* approach informed by the failure, not the same diff resubmitted — a budget spent re-running an unchanged build is wasted.

### Step 9: commit

Stage **explicitly**, never with a blanket `add --all`. The gate's pre-commit safety scan already ran in Step 8 — any file that appeared between then and now (a scratch file, an .env an agent created to test something, a forgotten kickoff receipt) is unscreened. Blanket-staging puts those in the commit. Derive the path list from the kickoff's ownership boundary, which already enumerates what the bead is allowed to touch:

**App mode:**
```powershell
$kickoff = Get-Content "target/jankurai/kickoff-$id.json" -Raw | ConvertFrom-Json
# The kickoff's ownership list is the bounded set of paths this bead may write.
# Intersect against `git status --porcelain` so we stage only files that (a) are
# inside ownership AND (b) actually changed. Glob expansion handled by `git add`.
$dirty = git status --porcelain | ForEach-Object { ($_ -split '\s+', 2)[1] }
foreach ($path in $kickoff.ownership) {
    # Each ownership entry may be a literal path or a glob — pass to git add as-is
    # and let git match. Anything outside ownership stays unstaged and won't be committed.
    git add -- $path
}
git commit -m "<issue.title> (bd: $id)"
```

**Meta mode:** no kickoff exists. Enumerate the files this tick touched (from your own edit history this session) and pass them to `git add` explicitly. Do not use the blanket `--all` flag. If you genuinely need a broad stage (e.g. a refactor that touched dozens of files), list them with `git status --porcelain` first, sanity-check the list yourself, then `git add` each path explicitly.

Use a HEREDOC for multi-line commit bodies. Do not include co-author lines unless the user has previously enabled them. Do **not** stage `target/jankurai/` — it should be in `.gitignore`, and even if it isn't, the kickoff's ownership list won't include it so the explicit-staging approach already excludes it.

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
- `$remaining == 0` and blocked present → **resume-poll, do not exit** (see below). On the *first* drain-to-blocked (or whenever the blocked set has changed since the last notification), invoke `/escalate`. Then emit `"BLOCKED-POLL: <count> — re-checking bd ready every ~20–30min"` so the loop keeps waking on a long interval and resumes the instant the human unblocks something.
- `$remaining == 0` and no blocked → invoke `/retro` (the build is done; generate the workflow performance report and file improvements), then "DONE" — loop should exit

Note: if this tick exited at Step 3.5 with "STALE: $id", the loop should wake immediately — there's still real work in the queue and the freshness check is cheap.

### Resume-poll on full block (don't strand the unattended window)

The whole point of the loop is that the human can hand off a vision and walk away for two days. If the loop *exits* the moment everything is blocked, then a human who unblocks a bead an hour later comes back to a pipeline that has done nothing since — the rest of the window is wasted. So a drain-to-blocked is a **pause, not a stop**:

1. **Notify once per distinct block state.** Invoke `/escalate` on the first drain-to-blocked. Record the set of blocked bead IDs. On a later poll, only re-invoke `/escalate` if that set has *changed* (a new bead blocked, or the reasons changed) — never re-notify the identical set every poll, or the human gets spammed.
2. **Keep waking on a long interval.** Emit `BLOCKED-POLL` and let `/loop` schedule the next wake ~20–30 min out (long enough not to burn cost spinning, short enough to resume promptly). Each wake re-runs `bd ready` (Step 1). The moment it returns a non-epic bead — because the human ran `bd update <id> --status=open`, or a time-based block cleared — the tick proceeds normally and the loop is back to fast 60–180s cadence.
3. **Backstop so it can't poll forever.** Stop polling and emit `"DONE: blocked, max wait reached"` when any of: the cumulative session budget is exhausted, a max wall-clock window has elapsed (default ~48h — the unattended window), or the blocked set has been identical across many consecutive polls *and* the window is closing. A backstop exit still leaves one final `/escalate` so the last state is visible.

The DONE-path `/retro` invocation is automatic. The user can also run `/retro` mid-build for a partial review — the skill handles either case.

## Stopping conditions (escalate, do not guess)

- Any rule in `docs/ESCALATION_RULES.md` fires.
- Quality gate fails the bead's full retry budget (`plan.lock.escalationBudget.maxFailuresPerTask`, raised for load-bearing beads — see Step 8) on the same issue.
- A required tool isn't installed (don't auto-install — that's a human decision).
- Tests pass but acceptance can't be self-verified (e.g. "the UI looks right" — block with a screenshot request).
- A task's scope expands during implementation (block with "scope creep: <what>").
- A tenet (per-app `tenets.md` or workflow `docs/TENETS.md`) directly forbids the implementation approach the bead's design calls for — block with `"tenet conflict: <tenet ID> vs <what the bead asked for>"`.

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
- Do not improvise around a tenet to make the bead's design work. A tenet conflict is an escalation, not an implementation puzzle — block with `"tenet conflict: <tenet ID> vs <what the bead asked for>"` and let the human resolve (usually by rephrasing the bead, retiring the tenet, or splitting the bead so it no longer crosses the tenet).
