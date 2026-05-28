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
5. **Jankurai is installed.** `jankurai version` must succeed. If not, stop and surface the install command (`cargo install --path crates/jankurai --locked` from a checkout, or the release installer at github.com/neverhuman/jankurai/releases). Jankurai is the [quality standard for every app this workflow builds](../../README.md#quality-standard) — not optional.

## Process

1. **Initialize beads.**
   ```powershell
   bd init
   bd setup claude --project
   bd hooks install
   ```

2. **Initialize Jankurai (quality standard).**
   ```powershell
   # Read-only inventory + adoption plan
   mkdir -Force target/jankurai | Out-Null
   jankurai adopt . `
     --profile auto --mode observe `
     --out target/jankurai/adoption-plan.json `
     --md  target/jankurai/adoption-plan.md

   # Scaffold AGENTS.md + agent guidance (level 'agents' = minimal tracked footprint)
   jankurai init . --level agents --yes

   # First advisory audit — establishes the starting score the loop will improve on
   jankurai audit . --mode advisory `
     --json target/jankurai/repo-score.json `
     --md   target/jankurai/repo-score.md
   ```
   - `target/jankurai/` should be gitignored (jankurai's init handles this; verify).
   - `AGENTS.md` is created at repo root — this is what every `/build-next` tick reads before coding.
   - Do **not** enable ratchet mode yet. Baseline gets accepted later in a dedicated commit (`agent/baselines/main.repo-score.json`) after the first few real tasks have closed cleanly.

3. **Create one top-level epic for the app itself.**
   ```powershell
   bd create "<app name>" --type=epic --priority=1 --description "See plan.md"
   ```
   Capture the returned epic ID.

4. **For each feature in `plan.md` §"Feature order":**
   a. Pour the formula directly (no separate cook+persist step — `bd mol pour` accepts a formula name):
      ```powershell
      $pourOutput = bd mol pour <formula-name> --var key=value ... 2>&1
      # Parse "Root issue: <id>" from $pourOutput to get the molecule's root.
      $pourRoot = ($pourOutput | Select-String -Pattern 'Root issue: (\S+)').Matches[0].Groups[1].Value
      ```
      (Use `--dry-run` first to preview if the formula is unfamiliar; print the planned issues to the user, then proceed without confirmation.)
   b. Reparent the molecule's root epic under the app-level epic. `bd mol pour` has no `--parent` flag (verified 2026-05-28); reparent after the fact:
      ```powershell
      bd dep add $pourRoot <app-epic-id> --type parent-child
      ```
   c. Capture the spawned child issue IDs from `bd show $pourRoot --json` (`dependents[].id`) for the downstream steps below.

   d. **Write test-plan metadata onto the spawned beads.** bd cook silently drops `[steps.testPlan]` blocks from formulas (verified 2026-05-28 against bd 0.55.3), so the spawned beads have no `testPlanFile`/`testPlanCases`/`testPlanCoverage` until compose writes them. /quality-pass and /build-next both depend on this metadata being present:

      ```powershell
      # Parse the formula TOML and find every step that declares a testPlan.
      $formulaPath = "$env:USERPROFILE\.beads\formulas\<formula-name>.formula.toml"
      $cooked     = bd cook <formula-name> --mode=runtime --var key=value ... | ConvertFrom-Json
      $rawToml    = Get-Content $formulaPath -Raw
      # Match each step with [steps.testPlan] by walking the formula's steps; build a map
      # of substituted step.title → testPlan fields (file/cases/coverage) with the same
      # variable substitution applied to file & coverage.
      # (See formulas/README.md for the testPlan block schema.)

      # For each spawned child issue under $pourRoot, look up its source step by title and
      # write the metadata if a testPlan exists:
      $children = (bd show $pourRoot --json | ConvertFrom-Json)[0].dependents
      foreach ($child in $children) {
          $tp = $titleToTestPlan[$child.title]
          if (-not $tp) { continue }
          $metaFile = "$env:TEMP\bd-meta-$($child.id).json"
          @{ testPlanFile = $tp.file; testPlanCases = $tp.cases; testPlanCoverage = $tp.coverage } |
              ConvertTo-Json | Set-Content -Path $metaFile -Encoding utf8
          bd update $child.id --metadata "@$metaFile"
          Remove-Item $metaFile
      }
      ```

      Use the `@<file>` pattern — coverage strings contain semicolons that would break inline JSON quoting. The TOML parser used by PowerShell is whatever is convenient (a small parser in this skill, or shell out to `python -c "import tomllib; ..."` if Python is available in the build env). If a step has no `[steps.testPlan]`, skip it — that's a valid signal that the step doesn't produce code with tests (e.g., a `chore: write README`).

5. **Add cross-feature dependencies** from `plan.md` §"Cross-feature dependencies":
   ```powershell
   bd dep add <blocked-id> <blocker-id>
   ```

6. **Validate the DAG.**
   ```powershell
   bd dep cycles            # must report none
   bd ready --json          # must return at least one issue
   bd graph --json          # visual sanity check
   ```

7. **Commit the beads state and Jankurai scaffold.**
   ```powershell
   git add .beads/ AGENTS.md agent/ .gitignore
   git commit -m "Compose: initial task DAG + Jankurai scaffold"
   ```
   (`target/jankurai/` should be in `.gitignore`; do not commit receipts.)

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
