#!/usr/bin/env bash
# post-build-gate.sh
#
# POSIX counterpart to post-build-gate.ps1. This is the gate that actually runs
# on the documented Linux/macOS install path, where no PowerShell (powershell OR
# pwsh) is present. The .ps1 stays for Windows; the two are kept behaviourally
# in sync. Pick the right one with the OS-dispatch convention documented in
# README.md and the build-batch / build-next / beads-builder gate-resolution
# snippets — never assume one interpreter exists everywhere.
#
# Gate checks (in execution order):
# 1. lint            — stack linter (biome / clippy+fmt / ruff); style + obvious errors
# 2. typecheck       — type checker (tsc / mypy); reject untyped or ill-typed code
# 3. test            — the project's test suite; MANDATORY when a stack is detected
#                      (no runnable suite / no tests collected == hard fail, never a silent pass)
# 4. e2e/integration — formula-scaffolded e2e/integration suites, run HERE (not just in CI)
# 5. SCA             — dependency-vuln scan (npm/pnpm/yarn audit, pip-audit, cargo audit);
#                      hard fail on high/critical. GATE_SCA=advisory warns only; GATE_SCA=off skips
# 6. coverage floor  — opt-in via GATE_COVERAGE_MIN=<pct>; off by default so it never
#                      retroactively breaks an app (the production-floor step turns it on)
# 7. pre-commit safety — secret / large-file / merge-marker scan before anything commits
# 8. Jankurai        — `jankurai audit` (advisory) + `jankurai witness` (hard fail if baseline exists)
#
# Stacks covered: Node/TS, Python, and Rust (the flagship core — fmt + clippy +
# cargo test + cargo audit). Each stack runs only when its manifest is present.
#
# Quality gate run by /build-next (and the beads-builder worker) before `bd close`.
# Detects the stack and runs the checks above in order. Exits 0 only if everything
# passes, nonzero with a summary on red.
#
# Conservative by design: if a check has no runner it prints "SKIP: <check> ..."
# and continues — EXCEPT tests (a detected stack with no suite is a hard fail) —
# but the /build-next skill should escalate if a critical check skips.
#
# Env knobs:
#   GATE_SCA            on (default) | advisory | off   — software-composition analysis
#   GATE_COVERAGE_MIN   integer percent (default 0=off) — minimum coverage floor

set -uo pipefail

failures=()
pm=""       # Node package manager, set when package.json present
runner=""   # Python runner prefix ("uv run "/"poetry run "/""), set in Python block

# normalize env knobs
GATE_SCA="${GATE_SCA:-on}"
GATE_COVERAGE_MIN="${GATE_COVERAGE_MIN:-0}"
case "$GATE_COVERAGE_MIN" in (''|*[!0-9]*) GATE_COVERAGE_MIN=0 ;; esac

# run_sca <name> <command> — software-composition analysis with severity gating.
# Honors GATE_SCA: off skips entirely, advisory warns without failing, on hard-fails.
run_sca() {
  local name="$1" cmd="$2"
  [ "$GATE_SCA" = "off" ] && { echo "SKIP: $name (GATE_SCA=off)"; return 0; }
  echo "=== $name ==="
  echo "  \$ $cmd"
  if bash -c "$cmd"; then
    echo "PASS: $name"
  else
    local code=$?
    if [ "$GATE_SCA" = "advisory" ]; then
      echo "ADVISORY: $name reported vulnerabilities (exit $code) — GATE_SCA=advisory, not failing"
    else
      echo "FAIL: $name reported vulnerabilities (exit $code)"
      failures+=("$name")
    fi
  fi
}

# run_step <name> <command-string>
# Runs the command in a subshell and records a failure on nonzero exit.
run_step() {
  local name="$1" cmd="$2"
  echo "=== $name ==="
  echo "  \$ $cmd"
  if bash -c "$cmd"; then
    echo "PASS: $name"
    return 0
  else
    local code=$?
    echo "FAIL: $name (exit $code)"
    failures+=("$name")
    return 1
  fi
}

# has_cmd <name> — true if an executable is on PATH.
has_cmd() { command -v "$1" >/dev/null 2>&1; }

# npm_script <name> — true if package.json declares scripts.<name>.
# node is guaranteed present when package.json exists (it's a Node project).
npm_script() {
  node -e "process.exit((require('./package.json').scripts||{})['$1']?0:1)" 2>/dev/null
}

# --- Node / TS / JS ---
if [ -f "package.json" ]; then
  if   [ -f "pnpm-lock.yaml" ]; then pm="pnpm"
  elif [ -f "yarn.lock" ];      then pm="yarn"
  else                               pm="npm"
  fi

  npm_script lint      && run_step "lint"      "$pm run lint"
  if npm_script typecheck; then
    run_step "typecheck" "$pm run typecheck"
  elif npm_script tsc; then
    run_step "tsc"       "$pm run tsc"
  fi
  # Tests are mandatory. A detected stack with no test suite is a HARD FAIL,
  # not a silent pass — "no tests" must never be indistinguishable from green
  # (it's the easiest escape hatch for an agent under retry pressure).
  if npm_script test; then
    run_step "test" "$pm run test"
  else
    echo "=== test ==="
    echo "FAIL: test — package.json declares no \"test\" script. A detected stack must ship a runnable test suite; absent tests are a hard fail, not a pass."
    failures+=("test-missing")
  fi
  # e2e / integration suites: formulas scaffold these but historically they ran
  # only in CI. Run them in the gate too when present (absence is fine).
  for s in "test:e2e" "e2e" "test:integration" "integration"; do
    npm_script "$s" && run_step "$s" "$pm run $s"
  done
  # SCA: known-vuln dependency scan. Only run with a committed lockfile — `npm
  # audit` (and friends) exit non-zero for "no lockfile" too, which would be a
  # false vuln report. yarn classic uses --level; npm/pnpm use --audit-level.
  lockfile=""
  case "$pm" in
    pnpm) [ -f "pnpm-lock.yaml" ]    && lockfile="pnpm-lock.yaml" ;;
    yarn) [ -f "yarn.lock" ]         && lockfile="yarn.lock" ;;
    npm)  [ -f "package-lock.json" ] && lockfile="package-lock.json" ;;
  esac
  if [ -n "$lockfile" ]; then
    if [ "$pm" = "yarn" ]; then
      run_sca "yarn-audit" "yarn audit --level high"
    else
      run_sca "$pm-audit" "$pm audit --audit-level=high"
    fi
  else
    echo "SKIP: $pm audit (no committed lockfile — SCA needs one to resolve the dep tree)"
  fi
fi

# --- Python ---
if [ -f "pyproject.toml" ] || [ -f "requirements.txt" ]; then
  if   [ -f "uv.lock" ];      then runner="uv run "
  elif has_cmd poetry;        then runner="poetry run "
  else                             runner=""
  fi

  if has_cmd ruff; then
    run_step "ruff" "${runner}ruff check ."
  fi
  if has_cmd mypy || [ -f "mypy.ini" ]; then
    run_step "mypy" "${runner}mypy ."
  fi
  # Tests are mandatory (see Node block). pytest exit 5 == "no tests collected":
  # an empty suite is treated as a hard fail, not a pass.
  echo "=== pytest ==="
  if has_cmd pytest; then
    echo "  \$ ${runner}pytest -q"
    if bash -c "${runner}pytest -q"; then
      echo "PASS: pytest"
    else
      code=$?
      if [ "$code" -eq 5 ]; then
        echo "FAIL: pytest — no tests collected. An empty suite is a hard fail, not a pass."
        failures+=("pytest-empty")
      else
        echo "FAIL: pytest (exit $code)"
        failures+=("pytest")
      fi
    fi
  else
    echo "FAIL: pytest not available — a detected Python stack must ship a runnable test suite; absent tests are a hard fail, not a pass."
    failures+=("pytest-missing")
  fi
  # SCA: known-vuln dependency scan (advisory-skip if pip-audit absent).
  if has_cmd pip-audit; then
    run_sca "pip-audit" "${runner}pip-audit"
  else
    echo "SKIP: pip-audit (not installed — SCA for Python deps unavailable)"
  fi
fi

# --- Rust / Cargo ---
# The flagship core stack. Without this branch the gate ran essentially nothing
# at the root of a Rust-workspace app.
if [ -f "Cargo.toml" ]; then
  if has_cmd cargo; then
    # fmt/clippy are rustup components — skip-with-note if absent (parity with
    # Node/Python lint), but a loud SKIP that build-next can escalate on.
    if cargo fmt --version >/dev/null 2>&1; then
      run_step "cargo fmt" "cargo fmt --all -- --check"
    else
      echo "SKIP: cargo fmt (rustfmt component not installed)"
    fi
    if cargo clippy --version >/dev/null 2>&1; then
      run_step "cargo clippy" "cargo clippy --all-targets --all-features -- -D warnings"
    else
      echo "SKIP: cargo clippy (clippy component not installed)"
    fi
    # cargo test is mandatory; note cargo exits 0 even with zero tests, so the
    # "non-empty suite" guarantee is best-effort for Rust (unit+integration run).
    run_step "cargo test"   "cargo test --all-features"
    # SCA: cargo audit (needs Cargo.lock; advisory-skip if cargo-audit absent).
    if ! cargo audit --version >/dev/null 2>&1; then
      echo "SKIP: cargo audit (cargo-audit not installed — SCA for Rust deps unavailable)"
    elif [ ! -f "Cargo.lock" ]; then
      echo "SKIP: cargo audit (no Cargo.lock — SCA needs a resolved lockfile)"
    else
      run_sca "cargo-audit" "cargo audit"
    fi
  else
    echo "=== cargo ==="
    echo "FAIL: Cargo.toml present but cargo not on PATH — a detected Rust stack must build, lint, and test."
    failures+=("cargo-missing")
  fi
fi

# --- Coverage floor (opt-in) ---
# Off by default (GATE_COVERAGE_MIN=0) so it never retroactively breaks an app.
# The production-floor step sets a real minimum. When set, run the stack's
# coverage tool and hard-fail below the floor.
if [ "$GATE_COVERAGE_MIN" -gt 0 ]; then
  echo "=== coverage floor (${GATE_COVERAGE_MIN}%) ==="
  ran_coverage=0
  if [ -f "package.json" ] && npm_script coverage; then
    # The project's coverage script is expected to enforce the threshold itself
    # (vitest/nyc config); the gate runs it and hard-fails if it does not pass.
    run_step "coverage(node)" "$pm run coverage"; ran_coverage=1
  fi
  if { [ -f "pyproject.toml" ] || [ -f "requirements.txt" ]; } && has_cmd pytest; then
    run_step "coverage(py)" "${runner}pytest -q --cov --cov-fail-under=$GATE_COVERAGE_MIN"; ran_coverage=1
  fi
  if [ -f "Cargo.toml" ] && has_cmd cargo-tarpaulin; then
    run_step "coverage(rust)" "cargo tarpaulin --fail-under $GATE_COVERAGE_MIN"; ran_coverage=1
  fi
  if [ "$ran_coverage" -eq 0 ]; then
    echo "FAIL: coverage floor set to ${GATE_COVERAGE_MIN}% but no coverage runner found (need a 'coverage' npm script, pytest-cov, or cargo-tarpaulin)."
    failures+=("coverage-no-runner")
  fi
fi

# --- Pre-commit safety: refuse common secret/receipt patterns ---
# .gitignore catches most, but an autonomous loop can create files .gitignore
# doesn't know about (a pasted .env, a copied id_rsa, a cred dump). The gate
# runs before commit, so failing here blocks the bead before the leak lands.
echo "=== pre-commit safety scan ==="
suspicious=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  # porcelain format: two status chars, space, then path (or "old -> new" for renames)
  path="${line:3}"
  case "$path" in *" -> "*) path="${path##* -> }" ;; esac
  case "$path" in
    .env|.env.*|*/.env|*/.env.*) suspicious+=("$path") ;;
    *.pem|*.key|*.p12|*.pfx)     suspicious+=("$path") ;;
    *id_rsa*)                    suspicious+=("$path") ;;
    *credentials*.json)          suspicious+=("$path") ;;
    target/jankurai/*|*/target/jankurai/*) suspicious+=("$path") ;;
  esac
done < <(git status --porcelain)
if [ "${#suspicious[@]}" -gt 0 ]; then
  echo "FAIL: pre-commit safety — suspicious files in tree:"
  for s in "${suspicious[@]}"; do echo "  - $s"; done
  failures+=("pre-commit-safety")
else
  echo "PASS: pre-commit safety"
fi

# --- Jankurai (quality standard) ---
# Audit is always advisory in the inner loop. Witness vs. baseline is hard-fail
# only after a baseline has been accepted at agent/baselines/main.repo-score.json.
if has_cmd jankurai; then
  mkdir -p "target/jankurai"

  # Inner-loop advisory scan over changed files. Surfaces issues but does not
  # fail the gate on its own — the witness step below is what enforces.
  audit_cmd="jankurai audit . --changed-fast --changed-from origin/main \
--json target/jankurai/audit-fast.json \
--md target/jankurai/audit-fast.md \
--timings-json target/jankurai/audit-timings.json"
  echo "=== jankurai audit (advisory) ==="
  echo "  \$ $audit_cmd"
  if bash -c "$audit_cmd"; then
    echo "PASS: jankurai audit (advisory)"
  else
    echo "ADVISORY: jankurai audit reported findings (exit $?) — see target/jankurai/audit-fast.md"
  fi

  # Witness ratchet: only enforce if a reviewed baseline exists.
  baseline="agent/baselines/main.repo-score.json"
  if [ -f "$baseline" ]; then
    witness_cmd="jankurai witness . --changed-from origin/main \
--baseline $baseline \
--out target/jankurai/merge-witness.json \
--md target/jankurai/merge-witness.md"
    run_step "jankurai witness" "$witness_cmd"
  else
    echo "SKIP: jankurai witness (no baseline at $baseline — ratchet disabled until baseline accepted)"
  fi
else
  echo "SKIP: jankurai (not installed — see docs for install)"
fi

if [ "${#failures[@]}" -gt 0 ]; then
  echo ""
  echo "GATE: FAILED (${#failures[@]} failure(s): ${failures[*]})"
  exit 1
fi

echo ""
echo "GATE: PASSED"
exit 0
