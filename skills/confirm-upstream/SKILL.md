---
name: confirm-upstream
description: Close the loop on a from-app:<X> workflow-improvement bead by re-running its originating repro against app X and only closing on green. Use when a from-app bead's fix has landed in autonomous-build and you want to prove it actually resolved the originating defect, when the user says "confirm upstream", "confirm the fix", "re-validate against the app", or invokes /confirm-upstream <bead>.
---

# confirm-upstream

The **reverse leg** of `/flag --upstream` and `/retro`. Those file `from-app:<X>` beads into autonomous-build from a defect noticed in a sibling app X. This skill proves the fix actually closed that defect: it re-runs the bead's originating **repro** against app X and **only closes the bead on green**. Until confirmed, the bead carries `needs-app-confirm` and stays open — a fix that compiles in the meta repo but was never re-validated against the app that surfaced it has not closed the loop (bead `autonomous-build-m73`). This formalizes what `retros/repro-smbuild-decompose-run2-2026-05-28.md` did by hand as the **provable loop-closed moment**.

## Mode

Runs **in the autonomous-build (meta) repo** — the bead being confirmed is one of *this* repo's own beads. App X is a sibling repo. Detect meta mode the same way the other skills do: `Test-Path skills/build-next/SKILL.md` must be true here; if it isn't, you're in the wrong cwd — stop.

## Inputs

- A bead ID (this repo's own), e.g. `/confirm-upstream autonomous-build-3fr.1`. The bead must carry a `from-app:<X>` label and a recorded **repro** (numbered reproduction steps + an Expected outcome) in its description/notes or a linked repro report under `retros/`.
- Optional `--app-path <path>` to point at app X explicitly (skips the sibling probe).

## Process

### 1. Read the bead and extract the contract

```bash
bd show <id> --json
```

- Confirm a `from-app:<X>` label exists; capture `X`. **No `from-app` label → not a confirm-upstream target.** Stop with "not a from-app bead — nothing to confirm against."
- Extract the **repro**: the numbered Reproduction steps + the **Expected** outcome, from the description/notes, or from a repro report the bead references under `retros/`. If no mechanically-runnable repro is recorded → do **not** close blind: label `needs-app-confirm` (step 5, red path) with a note asking for the repro command, and stop. A from-app bead with no repro cannot be machine-confirmed; that is a human-confirm, not a silent close.

### 2. Resolve app X's path (meta → app — the reverse of META_PATH_RESOLUTION)

`docs/META_PATH_RESOLUTION.md` resolves *this* repo from an app; here you need the opposite. Try in order, first that **validates** wins:

1. **Explicit override** — `--app-path <path>`.
2. **Sibling probe** — `<parent-of-meta>/X`, plus the obvious case variants of `X` (the literal `from-app:` value, lowercased, the repo's actual dir name). The meta repo's parent is `dirname` of this repo root.

**Validation** — a candidate is app X iff **both** hold (guards against a same-named unrelated dir and against pointing at the meta repo itself):
- `<cand>/.git` exists (it's a real repo), **and**
- `<cand>/skills/build-next/SKILL.md` does **NOT** exist (it is an app, not this meta repo).

If none validate → **fail loudly** naming the fix: label `needs-app-confirm`, note `"cannot resolve app <X>; pass --app-path <path>"`, and stop. Never guess a path or close as if confirmed.

### 3. Re-run the repro against app X (safely)

`cd` into app X. Capture its current commit (`git -C <appX> rev-parse --short HEAD`) for the audit trail.

- **Inspective repros** (read state, run a build/test, inspect output) — run directly; they don't mutate the app.
- **Destructive repros** (e.g. `rm -rf .beads && /decompose`, or anything that rewrites the app's tracked state) — do **not** run them against the app's live checkout. Run in a throwaway `git worktree`/clone of app X, or, if the repro can't be sandboxed, treat it as a human-confirm: label `needs-app-confirm` with the repro + a note that it is destructive, and stop. Re-validating a fix must not damage the app that surfaced it (T5 reversibility).
- Slash-command repros (`/decompose`, `/vision`, `/build-batch`) cannot be dispatched from inside this skill — they are user-driven. If the repro hinges on one, label `needs-app-confirm` with the exact command for the human to run, and stop. (Same constraint the `/decompose` and `/build-batch` smoke-test beads hit.)

### 4. Compare Actual vs Expected

Judge the repro's **Actual** result against the bead's recorded **Expected**:

- **Green** — Actual now matches Expected; the defect is gone.
- **Red** — the defect still reproduces (Actual still ≠ Expected).

Be honest and specific: quote the observed Actual. A partial/ambiguous result is **not** green — treat it as red (needs-app-confirm) rather than over-claiming a fix.

### 5. Close on green / hold on red

- **Green:**
  ```bash
  bd update <id> --remove-label needs-app-confirm   # if present
  bd close <id> --reason "confirmed-fixed vs <X>@<sha>: <repro one-liner> now yields <Expected>"
  ```
  The close reason records app X's commit SHA + the repro result — the auditable loop-closed moment.

- **Red:** do **not** close.
  ```bash
  bd update <id> --add-label needs-app-confirm --append-notes "confirm vs <X>@<sha> FAILED on <date>: <Actual observed>. Repro: <command>."
  ```
  Leave the bead open. The fix did not close the loop — it needs more work (reopen for build) or a human (`/escalate`).

### 6. Report

Print a one-line outcome: `CONFIRMED: <id> vs <X>@<sha>` or `NOT-CONFIRMED: <id> vs <X>@<sha> — <why>; left needs-app-confirm`.

## The `needs-app-confirm` convention

A `from-app:<X>` bead whose fix has landed in autonomous-build but has **not** yet been re-validated against app X sits with the label `needs-app-confirm`, **open, not closed**. It is the explicit "fixed here, not yet proven there" state. `/confirm-upstream` is what drains it. (Set it manually after landing a from-app fix, or let confirm-upstream set it on a red/blocked confirmation.) See `AGENTS.md` for where it sits in the from-app bead lifecycle.

## Stopping conditions (do not guess, do not close blind)

- Not in the meta repo (`skills/build-next/SKILL.md` absent in cwd) → stop.
- The bead has no `from-app:` label → stop ("nothing to confirm against").
- No mechanically-runnable repro recorded → `needs-app-confirm`, request the repro, stop.
- App X can't be resolved/validated → `needs-app-confirm`, name the `--app-path` fix, stop.
- The repro is destructive and can't be sandboxed, or hinges on a user-driven slash command → `needs-app-confirm` with the exact command for the human, stop.
- The repro result is ambiguous/partial → treat as red (`needs-app-confirm`), never green.

## Do not

- Do not close a from-app bead without a green repro against its originating app — that is the exact failure this skill exists to prevent.
- Do not modify app X's tracked state to make a repro pass; run destructive repros in a worktree/clone, never the live checkout.
- Do not guess app X's path or fabricate a repro the bead didn't record.
- Do not over-claim: a partial or ambiguous Actual is red, not green.
