# post-build-gate.ps1
#
# Windows gate. The POSIX install path (Linux/macOS) runs post-build-gate.sh
# instead — there is no powershell/pwsh there. Keep the two behaviourally in
# sync. Invokes pwsh (cross-platform PowerShell Core), not the Windows-only
# "powershell", so this also works on a host where only pwsh is present.
#
# Gate checks (in execution order):
# 1. lint            — stack linter (biome / clippy+fmt / ruff); style + obvious errors
# 2. typecheck       — type checker (tsc / mypy); reject untyped or ill-typed code
# 3. test            — the project's test suite; MANDATORY when a stack is detected
#                      (no runnable suite / no tests collected == hard fail, never a silent pass)
# 4. e2e/integration — formula-scaffolded e2e/integration suites, run HERE (not just in CI)
# 5. SCA             — dependency-vuln scan (npm/pnpm/yarn audit, pip-audit, cargo audit);
#                      hard fail on high/critical. GATE_SCA=advisory warns only; GATE_SCA=off skips
# 6. coverage floor  — opt-in via GATE_COVERAGE_MIN=<pct>; off by default
# 7. pre-commit safety — secret / large-file / merge-marker scan before anything commits
# 8. Jankurai        — `jankurai audit` (advisory) + `jankurai witness` (hard fail if baseline exists)
#
# Stacks covered: Node/TS, Python, and Rust (the flagship core — fmt + clippy +
# cargo test + cargo audit). Each stack runs only when its manifest is present.
#
# Quality gate run by /build-next before `bd close`. Detects the stack and
# runs the checks above in order. Exits 0 only if everything passes.
#
# Conservative by design: a missing runner prints "SKIP: <check> ..." and
# continues — EXCEPT tests (a detected stack with no suite is a hard fail) —
# but the /build-next skill should escalate if a critical check skips.
#
# Env knobs:
#   GATE_SCA            on (default) | advisory | off   — software-composition analysis
#   GATE_COVERAGE_MIN   integer percent (default 0=off) — minimum coverage floor

$ErrorActionPreference = 'Stop'

function Run-Step {
    param([string]$name, [string]$cmd)
    Write-Host "=== $name ==="
    Write-Host "  $ $cmd"
    $proc = Start-Process -FilePath "pwsh" -ArgumentList "-NoProfile", "-Command", $cmd -NoNewWindow -PassThru -Wait
    if ($proc.ExitCode -ne 0) {
        Write-Host "FAIL: $name (exit $($proc.ExitCode))"
        return $false
    }
    Write-Host "PASS: $name"
    return $true
}

# Run-Sca — software-composition analysis with severity gating. Honors GATE_SCA:
# off skips, advisory warns without failing, on hard-fails. Mutates $script:failures.
function Run-Sca {
    param([string]$name, [string]$cmd)
    if ($env:GATE_SCA -eq "off") { Write-Host "SKIP: $name (GATE_SCA=off)"; return }
    Write-Host "=== $name ==="
    Write-Host "  $ $cmd"
    $proc = Start-Process -FilePath "pwsh" -ArgumentList "-NoProfile", "-Command", $cmd -NoNewWindow -PassThru -Wait
    if ($proc.ExitCode -eq 0) {
        Write-Host "PASS: $name"
    } elseif ($env:GATE_SCA -eq "advisory") {
        Write-Host "ADVISORY: $name reported vulnerabilities (exit $($proc.ExitCode)) — GATE_SCA=advisory, not failing"
    } else {
        Write-Host "FAIL: $name reported vulnerabilities (exit $($proc.ExitCode))"
        $script:failures += $name
    }
}

# normalize env knobs
if (-not $env:GATE_SCA) { $env:GATE_SCA = "on" }
$covMin = 0
if ($env:GATE_COVERAGE_MIN -match '^\d+$') { $covMin = [int]$env:GATE_COVERAGE_MIN }

$failures = @()

# --- Node / TS / JS ---
if (Test-Path "package.json") {
    $pkg = Get-Content package.json -Raw | ConvertFrom-Json
    $scripts = $pkg.scripts
    $pm = if (Test-Path "pnpm-lock.yaml") { "pnpm" } elseif (Test-Path "yarn.lock") { "yarn" } else { "npm" }

    if ($scripts.lint)      { if (-not (Run-Step "lint"      "$pm run lint"))      { $failures += "lint" } }
    if ($scripts.typecheck) { if (-not (Run-Step "typecheck" "$pm run typecheck")) { $failures += "typecheck" } }
    elseif ($scripts.tsc)   { if (-not (Run-Step "tsc"       "$pm run tsc"))       { $failures += "tsc" } }
    # Tests are mandatory. A detected stack with no test suite is a HARD FAIL,
    # not a silent pass — "no tests" must never be indistinguishable from green.
    if ($scripts.test) {
        if (-not (Run-Step "test" "$pm run test")) { $failures += "test" }
    } else {
        Write-Host "=== test ==="
        Write-Host "FAIL: test — package.json declares no `"test`" script. A detected stack must ship a runnable test suite; absent tests are a hard fail, not a pass."
        $failures += "test-missing"
    }
    # e2e / integration suites: run in the gate when present (absence is fine).
    foreach ($s in @("test:e2e", "e2e", "test:integration", "integration")) {
        if ($scripts.$s) { if (-not (Run-Step $s "$pm run $s")) { $failures += $s } }
    }
    # SCA: only with a committed lockfile (audit exits non-zero for "no lockfile"
    # too, which would be a false vuln report). yarn classic uses --level.
    $lockfile = switch ($pm) {
        "pnpm" { if (Test-Path "pnpm-lock.yaml")    { "pnpm-lock.yaml" } }
        "yarn" { if (Test-Path "yarn.lock")         { "yarn.lock" } }
        "npm"  { if (Test-Path "package-lock.json") { "package-lock.json" } }
    }
    if ($lockfile) {
        if ($pm -eq "yarn") { Run-Sca "yarn-audit" "yarn audit --level high" }
        else                { Run-Sca "$pm-audit"  "$pm audit --audit-level=high" }
    } else {
        Write-Host "SKIP: $pm audit (no committed lockfile — SCA needs one to resolve the dep tree)"
    }
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
    # Tests are mandatory (see Node block). pytest exit 5 == "no tests collected":
    # an empty suite is treated as a hard fail, not a pass.
    Write-Host "=== pytest ==="
    if (Get-Command pytest -ErrorAction SilentlyContinue) {
        $pytestCmd = "$runner pytest -q"
        Write-Host "  $ $pytestCmd"
        $pyProc = Start-Process -FilePath "pwsh" -ArgumentList "-NoProfile", "-Command", $pytestCmd -NoNewWindow -PassThru -Wait
        if ($pyProc.ExitCode -eq 0) {
            Write-Host "PASS: pytest"
        } elseif ($pyProc.ExitCode -eq 5) {
            Write-Host "FAIL: pytest — no tests collected. An empty suite is a hard fail, not a pass."
            $failures += "pytest-empty"
        } else {
            Write-Host "FAIL: pytest (exit $($pyProc.ExitCode))"
            $failures += "pytest"
        }
    } else {
        Write-Host "FAIL: pytest not available — a detected Python stack must ship a runnable test suite; absent tests are a hard fail, not a pass."
        $failures += "pytest-missing"
    }
    # SCA: known-vuln dependency scan (advisory-skip if pip-audit absent).
    if (Get-Command pip-audit -ErrorAction SilentlyContinue) {
        Run-Sca "pip-audit" "$runner pip-audit"
    } else {
        Write-Host "SKIP: pip-audit (not installed — SCA for Python deps unavailable)"
    }
}

# --- Rust / Cargo ---
# The flagship core stack. Without this branch the gate ran essentially nothing
# at the root of a Rust-workspace app.
if (Test-Path "Cargo.toml") {
    if (Get-Command cargo -ErrorAction SilentlyContinue) {
        # fmt/clippy are rustup components — skip-with-note if absent (parity
        # with Node/Python lint), but a loud SKIP that build-next can escalate on.
        & cargo fmt --version *> $null
        if ($LASTEXITCODE -eq 0) {
            if (-not (Run-Step "cargo fmt" "cargo fmt --all -- --check")) { $failures += "cargo fmt" }
        } else { Write-Host "SKIP: cargo fmt (rustfmt component not installed)" }
        & cargo clippy --version *> $null
        if ($LASTEXITCODE -eq 0) {
            if (-not (Run-Step "cargo clippy" "cargo clippy --all-targets --all-features -- -D warnings")) { $failures += "cargo clippy" }
        } else { Write-Host "SKIP: cargo clippy (clippy component not installed)" }
        # cargo test is mandatory; cargo exits 0 even with zero tests, so the
        # "non-empty suite" guarantee is best-effort for Rust.
        if (-not (Run-Step "cargo test" "cargo test --all-features")) { $failures += "cargo test" }
        # SCA: cargo audit (needs Cargo.lock; advisory-skip if cargo-audit absent).
        & cargo audit --version *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "SKIP: cargo audit (cargo-audit not installed — SCA for Rust deps unavailable)"
        } elseif (-not (Test-Path "Cargo.lock")) {
            Write-Host "SKIP: cargo audit (no Cargo.lock — SCA needs a resolved lockfile)"
        } else {
            Run-Sca "cargo-audit" "cargo audit"
        }
    } else {
        Write-Host "=== cargo ==="
        Write-Host "FAIL: Cargo.toml present but cargo not on PATH — a detected Rust stack must build, lint, and test."
        $failures += "cargo-missing"
    }
}

# --- Coverage floor (opt-in) ---
# Off by default (GATE_COVERAGE_MIN=0). The production-floor step sets a real
# minimum. When set, run the stack's coverage tool and hard-fail below the floor.
if ($covMin -gt 0) {
    Write-Host "=== coverage floor ($covMin%) ==="
    $ranCoverage = $false
    if ((Test-Path "package.json")) {
        $covScripts = (Get-Content package.json -Raw | ConvertFrom-Json).scripts
        if ($covScripts.coverage) {
            $cpm = if (Test-Path "pnpm-lock.yaml") { "pnpm" } elseif (Test-Path "yarn.lock") { "yarn" } else { "npm" }
            if (-not (Run-Step "coverage(node)" "$cpm run coverage")) { $failures += "coverage(node)" }
            $ranCoverage = $true
        }
    }
    if (((Test-Path "pyproject.toml") -or (Test-Path "requirements.txt")) -and (Get-Command pytest -ErrorAction SilentlyContinue)) {
        $crunner = if (Test-Path "uv.lock") { "uv run" } elseif (Get-Command poetry -ErrorAction SilentlyContinue) { "poetry run" } else { "" }
        if (-not (Run-Step "coverage(py)" "$crunner pytest -q --cov --cov-fail-under=$covMin")) { $failures += "coverage(py)" }
        $ranCoverage = $true
    }
    if ((Test-Path "Cargo.toml") -and (Get-Command cargo-tarpaulin -ErrorAction SilentlyContinue)) {
        if (-not (Run-Step "coverage(rust)" "cargo tarpaulin --fail-under $covMin")) { $failures += "coverage(rust)" }
        $ranCoverage = $true
    }
    if (-not $ranCoverage) {
        Write-Host "FAIL: coverage floor set to $covMin% but no coverage runner found (need a 'coverage' npm script, pytest-cov, or cargo-tarpaulin)."
        $failures += "coverage-no-runner"
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
    $auditProc = Start-Process -FilePath "pwsh" -ArgumentList "-NoProfile", "-Command", $auditCmd -NoNewWindow -PassThru -Wait
    if ($auditProc.ExitCode -ne 0) {
        Write-Host "ADVISORY: jankurai audit reported findings (exit $($auditProc.ExitCode)) — see target/jankurai/audit-fast.md"
    } else {
        Write-Host "PASS: jankurai audit (advisory)"
    }

    # Witness ratchet: enforce if a baseline exists. /decompose populates this at
    # scaffold time (lbq.14) so the ratchet is LIVE during the unattended build —
    # a missing baseline now means a pre-lbq.14 app or a skipped decompose.
    $baseline = "agent/baselines/main.repo-score.json"
    if (Test-Path $baseline) {
        $witnessCmd = "jankurai witness . --changed-from origin/main " +
                      "--baseline $baseline " +
                      "--out target/jankurai/merge-witness.json " +
                      "--md  target/jankurai/merge-witness.md"
        if (-not (Run-Step "jankurai witness" $witnessCmd)) { $failures += "jankurai-witness" }
    } else {
        Write-Host "SKIP: jankurai witness (no baseline at $baseline — pre-lbq.14 app or decompose skipped; ratchet not live)"
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
