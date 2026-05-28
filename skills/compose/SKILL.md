---
name: compose
description: Take a plan.md and materialize it into a beads issue DAG (epics, tasks, dependencies) using bd formula pours. Use when the user says "compose", "build the task graph", "pour the formulas", or invokes /compose after /vision has produced plan.md.
---

# compose

Convert `plan.md` into a live beads DAG inside the current app repo. After this skill runs, `bd ready` returns the first true leaf tasks and `/loop /build-next` can take over.

## Pre-flight checks (run these before doing anything)

1. **`plan.md` exists in CWD.** If not, stop and ask the user to run `/vision`.
2. **Plan source resolved.** Prefer `plan.lock.json`; fall back to `plan.md` regex parse with a deprecation warning. See "Plan source" below.
3. **Plan is not flagged incomplete.** If `plan.lock.json` has `incomplete: true`, refuse and surface its `openQuestions` list. If only `plan.md` is present and has an "Open questions for human" section with content, refuse and surface that — do not paper over.
4. **Beads is not yet initialized in this repo.** If `bd info` succeeds, ask the user whether to reset (`rm -rf .beads/`) or proceed and merge. Default: stop and ask.
5. **Every formula referenced in the plan exists in `bd formula list`.** If any are missing, stop and ask.
6. **Jankurai is installed.** `jankurai version` must succeed. If not, stop and surface the install command (`cargo install --path crates/jankurai --locked` from a checkout, or the release installer at github.com/neverhuman/jankurai/releases). Jankurai is the [quality standard for every app this workflow builds](../../README.md#quality-standard) — not optional.

## Plan source: `plan.lock.json` first, `plan.md` fallback

`/vision` emits both `plan.md` (human narrative) and `plan.lock.json` (machine-readable mirror; schema at [`schemas/plan.lock.schema.json`](../../schemas/plan.lock.schema.json), reference in [`docs/PLAN_LOCK.md`](../../docs/PLAN_LOCK.md)). Resolve the source in this order, before Step 1:

```powershell
if (Test-Path plan.lock.json) {
    $lock = Get-Content plan.lock.json -Raw | ConvertFrom-Json
    # Validate against schemas/plan.lock.schema.json (e.g. via `jankurai` if it has a JSON Schema validator,
    # or `python -m jsonschema -i plan.lock.json autonomous-build/schemas/plan.lock.schema.json`,
    # or a small inline check on required top-level fields + schemaVersion == 1).
    if ($lock.schemaVersion -ne 1) {
        throw "plan.lock.json schemaVersion=$($lock.schemaVersion) — this compose only understands 1"
    }
    if ($lock.incomplete) {
        Write-Host "plan.lock.json incomplete — open questions blocking /compose:"
        $lock.openQuestions | Where-Object blockingCompose | ForEach-Object { Write-Host "  - $($_.question)" }
        exit 1
    }
    $planSource = 'lock'
} else {
    Write-Host "[deprecation] plan.lock.json missing — falling back to plan.md regex parse; rerun /vision to generate the lock"
    $planSource = 'md'
}
```

When `$planSource -eq 'lock'`:
- Step 4 iterates `$lock.featureOrder` directly. `$feature.name`, `$feature.formulas`, `$feature.vars` are already structured — no regex.
- Step 5 (coverage check) compares `$pouredFeatures` keys against `$lock.featureOrder.name` rather than re-parsing markdown.
- Step 6 reads cross-feature deps from `$lock.crossFeatureDependencies` instead of the markdown section.
- `plan.md` is only read for human-narrative output (printed in summaries, never parsed).

When `$planSource -eq 'md'`: behave exactly as the prior version of this skill did — regex-parse `plan.md` §"Feature order" and §"Cross-feature dependencies". This is the legacy path; the deprecation warning at pre-flight should prod the user to rerun `/vision`.

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

4. **For each feature in the resolved plan source:**

   When `$planSource -eq 'lock'`, iterate `$lock.featureOrder` directly — `name`, `formulas`, `vars` are pre-structured. When `$planSource -eq 'md'`, fall back to the regex parse described in Step 5 below (legacy path).

   Maintain `$pouredFeatures = @{}` across the loop; Step 5 reads it for the coverage check.

   a. Pour the formula directly (no separate cook+persist step — `bd mol pour` accepts a formula name):
      ```powershell
      $pourOutput = bd mol pour <formula-name> --var key=value ... 2>&1
      # Parse "Root issue: <id>" from $pourOutput to get the molecule's root.
      $pourRoot = ($pourOutput | Select-String -Pattern 'Root issue: (\S+)').Matches[0].Groups[1].Value
      if (-not $pouredFeatures.ContainsKey($featureName)) { $pouredFeatures[$featureName] = @() }
      $pouredFeatures[$featureName] += $pourRoot
      ```
      (Use `--dry-run` first to preview if the formula is unfamiliar; print the planned issues to the user, then proceed without confirmation.)
   b. Reparent the molecule's root epic under the app-level epic. `bd mol pour` has no `--parent` flag (verified 2026-05-28); reparent after the fact:
      ```powershell
      bd dep add $pourRoot <app-epic-id> --type parent-child
      ```
   c. Capture the spawned child issue IDs from `bd show $pourRoot --json` (`dependents[].id`) for the downstream steps below.

   d. **Write step-derived metadata onto the spawned beads.** bd cook silently drops unknown step fields from formulas (verified 2026-05-28 against bd 0.55.3), so the spawned beads have no `testPlanFile`/`testPlanCases`/`testPlanCoverage` and no `filesTouched` until compose writes them. Both are load-bearing downstream: /quality-pass and /build-next read the testPlan fields; /build-batch reads `filesTouched` for conflict-aware dispatch (see autonomous-build-1zq.2 and skills/build-batch/SKILL.md "Dispatch-Bead").

      ```powershell
      # Parse the formula TOML and find every step that declares testPlan and/or files.
      $formulaPath = "$env:USERPROFILE\.beads\formulas\<formula-name>.formula.toml"
      $cooked     = bd cook <formula-name> --mode=runtime --var key=value ... | ConvertFrom-Json
      $rawToml    = Get-Content $formulaPath -Raw
      # Walk the formula's steps; build a map of substituted step.title → {
      #   testPlan: { file, cases, coverage }  (from [steps.testPlan] sub-table, optional)
      #   files:    [ "<glob>", ... ]          (from inline `files = [...]` on the step, optional)
      # }
      # Apply the same variable substitution to testPlan.file, testPlan.coverage, AND every
      # entry in the files array.
      # (See formulas/README.md for the testPlan block + `files` field schema.)

      # For each spawned child issue under $pourRoot, look up its source step by title and
      # write whatever metadata was declared. Either, both, or neither may be present.
      $children = (bd show $pourRoot --json | ConvertFrom-Json)[0].dependents
      foreach ($child in $children) {
          $stepMeta = $titleToStepMeta[$child.title]
          if (-not $stepMeta) { continue }
          $payload = @{}
          if ($stepMeta.testPlan) {
              $payload.testPlanFile     = $stepMeta.testPlan.file
              $payload.testPlanCases    = $stepMeta.testPlan.cases
              $payload.testPlanCoverage = $stepMeta.testPlan.coverage
          }
          if ($stepMeta.files) {
              $payload.filesTouched     = $stepMeta.files   # string array
          }
          if ($payload.Count -eq 0) { continue }
          $metaFile = "$env:TEMP\bd-meta-$($child.id).json"
          $payload | ConvertTo-Json -Depth 5 | Set-Content -Path $metaFile -Encoding utf8
          bd update $child.id --metadata "@$metaFile"
          Remove-Item $metaFile
      }
      ```

      Use the `@<file>` pattern — coverage strings contain semicolons that would break inline JSON quoting. The TOML parser used by PowerShell is whatever is convenient (a small parser in this skill, or shell out to `python -c "import tomllib; ..."` if Python is available in the build env).

      If a step declares neither `[steps.testPlan]` nor `files`, skip it — that's a valid signal that the step doesn't produce code with tests AND has no specific file ownership (e.g., a coordination/decision bead). The orchestrator will still dispatch the bead; it will print a `[WARN] no filesTouched` line and fall back to the post-merge gate for conflict detection.

      If a step declares `files` but no `testPlan`, that's also fine — chore steps (lint config, README) write files but don't ship tests, and the filesTouched declaration still earns them conflict-aware dispatch.

5. **Coverage check: every plan feature produced an epic.** During Step 4, build a map `$pouredFeatures[<feature-name>] = @($pourRoot, ...)`. After the loop, compare against the source-of-truth feature list:

   ```powershell
   if ($planSource -eq 'lock') {
       # Authoritative path — names come straight from the structured lock.
       $planFeatures = $lock.featureOrder | ForEach-Object { $_.name }
   } else {
       # Legacy regex path — used only when plan.lock.json is absent.
       # Feature lines in plan.md look like:
       #   "1. Habits CRUD — formulas: `[crud-feature]`, vars: `{entity=Habit}`"
       # The feature name is the text before the em-dash (—).
       $planLines = Get-Content plan.md
       $inFeatureSection = $false
       $planFeatures = @()
       foreach ($line in $planLines) {
           if ($line -match '^##\s+Feature order')        { $inFeatureSection = $true;  continue }
           if ($inFeatureSection -and $line -match '^##\s'){ break }
           if ($inFeatureSection -and $line -match '^\s*\d+\.\s+(.+?)\s+—') {
               $planFeatures += $Matches[1].Trim()
           }
       }
   }

   $missing = $planFeatures | Where-Object { -not $pouredFeatures.ContainsKey($_) }
   if ($missing.Count -gt 0) {
       Write-Host "PLAN COVERAGE GAP — these plan features produced no epic:"
       $missing | ForEach-Object { Write-Host "  - $_" }
   }
   ```

   Do NOT auto-correct, do NOT block — print the gap to the compose summary so the user can fix the plan or re-pour the missing formula(s). On the `lock` path this should never fire (structured input means no parse drops); on the `md` fallback it's the cheap insurance against a typo silently dropping a feature.

6. **Add cross-feature dependencies.** Source-of-truth depends on the resolved plan source:

   ```powershell
   if ($planSource -eq 'lock') {
       foreach ($dep in $lock.crossFeatureDependencies) {
           # Resolve feature names → pour-root bead IDs via $pouredFeatures.
           # If $dep.blocked / $dep.blocker is already a bead ID, pass through.
           $blockedId = if ($pouredFeatures.ContainsKey($dep.blocked)) { $pouredFeatures[$dep.blocked][0] } else { $dep.blocked }
           $blockerId = if ($pouredFeatures.ContainsKey($dep.blocker)) { $pouredFeatures[$dep.blocker][0] } else { $dep.blocker }
           bd dep add $blockedId $blockerId
       }
   } else {
       # Legacy: parse plan.md §"Cross-feature dependencies" and call bd dep add for each line.
   }
   ```

7. **Validate the DAG.**
   ```powershell
   bd dep cycles            # must report none
   bd ready --json          # must return at least one issue
   bd graph --json          # visual sanity check
   ```

8. **Sizing audit (post-pour).** Walk every spawned bead and flag outliers that are likely to exhaust the `/build-next` builder's context window (~70-85K tokens after fixed overhead). This is an advisory pass — surface, don't block:

   ```powershell
   $beads = bd list --status=open --json | ConvertFrom-Json | Where-Object { $_.issue_type -ne 'epic' }
   $oversized = @()
   foreach ($b in $beads) {
       $desc = $b.description
       # Acceptance criteria count: lines starting with "- " or "* " in the Acceptance block
       $acs = ($desc -split "`n" | Where-Object { $_ -match '^\s*[-*]\s' }).Count
       # File paths in description: rough heuristic — tokens containing / and a file extension
       $files = ([regex]::Matches($desc, '\b[\w/.-]+\.(ts|tsx|js|jsx|py|sql|md|toml|yaml|json|rs|go|java|kt|swift|rb|php|html|css)\b')).Count
       # Cross-layer signal: description mentions more than one of {UI/component, API/endpoint, DB/migration, test}
       $layers = 0
       if ($desc -match '(?i)\b(ui|component|page|screen|frontend)\b')      { $layers++ }
       if ($desc -match '(?i)\b(endpoint|api|route|handler|rpc)\b')          { $layers++ }
       if ($desc -match '(?i)\b(migration|schema|db|database|table|column)\b'){ $layers++ }
       if ($desc -match '(?i)\b(test|spec|integration test|unit test)\b')    { $layers++ }
       $flags = @()
       if ($acs   -gt 6) { $flags += "ACs=$acs (>6)" }
       if ($files -gt 5) { $flags += "files=$files (>5)" }
       if ($layers -gt 2){ $flags += "cross-layer=$layers" }
       if ($flags.Count -gt 0) {
           $oversized += "  - $($b.id): $($b.title)  [$($flags -join '; ')]"
       }
   }
   if ($oversized.Count -gt 0) {
       Write-Host "OVERSIZED BEADS (advisory — may exhaust builder context):"
       $oversized | ForEach-Object { Write-Host $_ }
   }
   ```

   Do NOT auto-split, do NOT block. Print to the compose summary so the user can review before invoking `/loop /build-next`. Genuine formula bugs surface this way; one-off outliers can stay.

9. **Commit the beads state and Jankurai scaffold.**
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
- Any items surfaced by Step 5 (coverage gaps) or Step 8 (oversized beads)
- **Recommend running `/quality-pass <app-epic-id>`** before `/loop /build-next` — it scores each bead against the buildability rubric and surfaces risks (sizing, missing test plans, scope drift) the structural validation in Step 7 can't see.
- The command to start the autonomous loop: `/loop /build-next`

## Stopping conditions

- `bd dep cycles` reports a cycle → stop, print the cycle, ask the user how to break it.
- `bd ready` returns zero issues immediately after pour → the DAG is malformed (everything blocked); stop and report.
- A formula pour fails (variable validation, missing required vars) → fix the var bindings in plan.md, ask the user to confirm, then re-pour.

## Do not

- Do not start implementing tasks here. The next skill (`/build-next`) is what executes work.
- Do not edit `plan.md` to make a formula fit. If a formula doesn't fit, write a new one in `autonomous-build/formulas/` (with user confirmation).
- Do not create issues outside of formula pours. If you find yourself reaching for `bd create` directly, the formula library is missing a pattern — call it out.
