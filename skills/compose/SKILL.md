---
name: compose
description: Take a plan.md and materialize it into a beads issue DAG (epics, tasks, dependencies) using bd formula pours. Use when the user says "compose", "build the task graph", "pour the formulas", or invokes /compose after /vision has produced plan.md.
---

# compose

Convert `plan.md` into a live beads DAG inside the current app repo. After this skill runs, `bd ready` returns the first true leaf tasks and `/loop /build-next` can take over.

## Pre-flight checks (run these before doing anything)

1. **`plan.md` exists in CWD.** If not, stop and ask the user to run `/vision`.
2. **`plan.md` has no "Open questions for human" section content.** If it does, stop and surface them — do not paper over.
3. **Beads is not yet initialized in this repo.** If `bd info` succeeds, ask the user whether to reset (`rm -rf .beads/`) or proceed and merge. Default: stop and ask.
4. **Every formula referenced in plan.md exists in `bd formula list`.** If any are missing, stop and ask.

## Process

1. **Initialize beads.**
   ```powershell
   bd init
   bd setup claude --project
   bd hooks install
   ```

2. **Create one top-level epic for the app itself.**
   ```powershell
   bd create "<app name>" --type=epic --priority=1 --description "See plan.md"
   ```
   Capture the returned epic ID.

3. **For each feature in `plan.md` §"Feature order":**
   a. Pour the formula(s) with their variable bindings:
      ```powershell
      bd cook <formula-name> --mode=runtime --var key=value ... --persist --prefix "feat-"
      bd mol pour <proto-id> --parent <epic-id>
      ```
      (Use `--dry-run` first to preview if the formula is unfamiliar; print the planned issues to the user, then proceed without confirmation.)
   b. Capture the spawned issue IDs.

4. **Add cross-feature dependencies** from `plan.md` §"Cross-feature dependencies":
   ```powershell
   bd dep add <blocked-id> <blocker-id>
   ```

5. **Validate the DAG.**
   ```powershell
   bd dep cycles            # must report none
   bd ready --json          # must return at least one issue
   bd graph --json          # visual sanity check
   ```

6. **Commit the beads state.**
   ```powershell
   git add .beads/
   git commit -m "Compose: initial task DAG from plan.md"
   ```

## Output: a one-paragraph summary to the user

After successful pour, print:

- Total issues created
- Number of epics / tasks
- IDs of the first 3 ready tasks (`bd ready --limit 3`)
- The command to start the autonomous loop: `/loop /build-next`

## Stopping conditions

- `bd dep cycles` reports a cycle → stop, print the cycle, ask the user how to break it.
- `bd ready` returns zero issues immediately after pour → the DAG is malformed (everything blocked); stop and report.
- A formula pour fails (variable validation, missing required vars) → fix the var bindings in plan.md, ask the user to confirm, then re-pour.

## Do not

- Do not start implementing tasks here. The next skill (`/build-next`) is what executes work.
- Do not edit `plan.md` to make a formula fit. If a formula doesn't fit, write a new one in `autonomous-build/formulas/` (with user confirmation).
- Do not create issues outside of formula pours. If you find yourself reaching for `bd create` directly, the formula library is missing a pattern — call it out.
