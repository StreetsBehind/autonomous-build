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

# --- Pre-commit safety: refuse common secret/receipt patterns ---
# .gitignore catches most, but an autonomous loop can create files .gitignore
# doesn't know about (a pasted .env, a copied id_rsa, a cred dump). The gate
# runs before commit, so failing here blocks the bead before the leak lands.
Write-Host "=== pre-commit safety scan ==="
$suspicious = git status --porcelain | ForEach-Object {
    # porcelain format: two status chars, space, then path (or "old -> new" for renames)
    $path = ($_ -replace '^.{2}\s+', '')
    if ($path -match ' -> ') { $path = ($path -split ' -> ')[-1] }
    $path
} | Where-Object {
    $_ -match '(^|/)\.env(\.|$)' -or
    $_ -match '\.(pem|key|p12|pfx)$' -or
    $_ -match 'id_rsa' -or
    $_ -match 'credentials.*\.json$' -or
    $_ -match '(^|/)target/jankurai/'
}
if ($suspicious) {
    Write-Host "FAIL: pre-commit safety — suspicious files in tree:"
    $suspicious | ForEach-Object { Write-Host "  - $_" }
    $failures += "pre-commit-safety"
} else {
    Write-Host "PASS: pre-commit safety"
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
