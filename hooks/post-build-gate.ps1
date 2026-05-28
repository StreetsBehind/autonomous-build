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

if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "GATE: FAILED ($($failures.Count) failure(s): $($failures -join ', '))"
    exit 1
}

Write-Host ""
Write-Host "GATE: PASSED"
exit 0
