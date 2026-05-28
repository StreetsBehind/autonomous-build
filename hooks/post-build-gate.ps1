# post-build-gate.ps1
#
# Quality gate run by /build-next before `bd close`. Detects the stack and
# runs lint + typecheck + test. Exits 0 only if everything passes.
#
# Designed to be conservative: if the gate cannot find a runner for a check,
# it prints "SKIP: <check> (no runner detected)" and continues — but the
# /build-next skill should escalate if a critical check skips.

$ErrorActionPreference = 'Stop'

function Run-Step {
    param([string]$name, [string]$cmd)
    Write-Host "=== $name ==="
    Write-Host "  $ $cmd"
    $proc = Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-Command", $cmd -NoNewWindow -PassThru -Wait
    if ($proc.ExitCode -ne 0) {
        Write-Host "FAIL: $name (exit $($proc.ExitCode))"
        return $false
    }
    Write-Host "PASS: $name"
    return $true
}

$failures = @()

# --- Node / TS / JS ---
if (Test-Path "package.json") {
    $pkg = Get-Content package.json -Raw | ConvertFrom-Json
    $scripts = $pkg.scripts
    $pm = if (Test-Path "pnpm-lock.yaml") { "pnpm" } elseif (Test-Path "yarn.lock") { "yarn" } else { "npm" }

    if ($scripts.lint)      { if (-not (Run-Step "lint"      "$pm run lint"))      { $failures += "lint" } }
    if ($scripts.typecheck) { if (-not (Run-Step "typecheck" "$pm run typecheck")) { $failures += "typecheck" } }
    elseif ($scripts.tsc)   { if (-not (Run-Step "tsc"       "$pm run tsc"))       { $failures += "tsc" } }
    if ($scripts.test)      { if (-not (Run-Step "test"      "$pm run test"))      { $failures += "test" } }
}

# --- Python ---
if ((Test-Path "pyproject.toml") -or (Test-Path "requirements.txt")) {
    $runner = if (Test-Path "uv.lock") { "uv run" } elseif (Get-Command poetry -ErrorAction SilentlyContinue) { "poetry run" } else { "" }

    if (Get-Command ruff -ErrorAction SilentlyContinue) {
        if (-not (Run-Step "ruff" "$runner ruff check .")) { $failures += "ruff" }
    }
    if ((Get-Command mypy -ErrorAction SilentlyContinue) -or (Test-Path "mypy.ini")) {
        if (-not (Run-Step "mypy" "$runner mypy .")) { $failures += "mypy" }
    }
    if (Get-Command pytest -ErrorAction SilentlyContinue) {
        if (-not (Run-Step "pytest" "$runner pytest -q")) { $failures += "pytest" }
    }
}

# --- Jankurai (quality standard) ---
# Audit is always advisory in the inner loop. Witness vs. baseline is hard-fail
# only after a baseline has been accepted at agent/baselines/main.repo-score.json.
if (Get-Command jankurai -ErrorAction SilentlyContinue) {
    New-Item -ItemType Directory -Force -Path "target/jankurai" | Out-Null

    # Inner-loop advisory scan over changed files. Surfaces issues but does not
    # fail the gate on its own — the witness step below is what enforces.
    $auditCmd = "jankurai audit . --changed-fast --changed-from origin/main " +
                "--json target/jankurai/audit-fast.json " +
                "--md   target/jankurai/audit-fast.md " +
                "--timings-json target/jankurai/audit-timings.json"
    Write-Host "=== jankurai audit (advisory) ==="
    Write-Host "  $ $auditCmd"
    $auditProc = Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-Command", $auditCmd -NoNewWindow -PassThru -Wait
    if ($auditProc.ExitCode -ne 0) {
        Write-Host "ADVISORY: jankurai audit reported findings (exit $($auditProc.ExitCode)) — see target/jankurai/audit-fast.md"
    } else {
        Write-Host "PASS: jankurai audit (advisory)"
    }

    # Witness ratchet: only enforce if a reviewed baseline exists.
    $baseline = "agent/baselines/main.repo-score.json"
    if (Test-Path $baseline) {
        $witnessCmd = "jankurai witness . --changed-from origin/main " +
                      "--baseline $baseline " +
                      "--out target/jankurai/merge-witness.json " +
                      "--md  target/jankurai/merge-witness.md"
        if (-not (Run-Step "jankurai witness" $witnessCmd)) { $failures += "jankurai-witness" }
    } else {
        Write-Host "SKIP: jankurai witness (no baseline at $baseline — ratchet disabled until baseline accepted)"
    }
} else {
    Write-Host "SKIP: jankurai (not installed — see docs for install)"
}

if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "GATE: FAILED ($($failures.Count) failure(s): $($failures -join ', '))"
    exit 1
}

Write-Host ""
Write-Host "GATE: PASSED"
exit 0
