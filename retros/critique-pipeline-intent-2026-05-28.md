# Critique: pipeline vs its core promise (2026-05-28)

**Method:** multi-agent workflow `critique-pipeline-intent` — 6 adversarial lenses (e2e-flow, autonomy-resilience, production-bar, gate-rigor, decompose-coverage, consistency-install), each finding verified by an independent refutation pass, then synthesized.
**Scale:** 48 agents · 41 candidate gaps · **35 survived verification · 6 refuted.**
**Promise under test:** *a user hands off a filled-out vision, walks away, and comes back 2 days later (fully unattended) to a fully built, enterprise-grade, production-ready application.*

---

## 1. Verdict

**It cannot deliver the promise today, and the single biggest reason is structural: the pipeline was never designed to run unattended end-to-end.** It is explicitly architected as *human-supervised, stage-by-stage* execution — `README.md:3` calls the human an "autopilot supervisor," and the docs bake a deliberate human-review gate between `/decompose` and `/build-batch` (`README.md:16-18`, `decompose.spec.md:361`). Even if you wave a human past that gate, the build itself stops and pages a human on the first auth/secrets/migration decision (`ESCALATION_RULES.md:9-12`) with no auto-resume, the quality gate is PowerShell-only and is never installed where it runs (so on the documented Linux/macOS path it silently no-ops), and the default build floor is a functional toy with no observability/audit/authz/deploy. The promise breaks at the *flow* layer, the *resilience* layer, the *output-grade* layer, and the *does-it-even-run* layer simultaneously.

## 2. The promise, scored

| Claim | Rating | Justification |
|---|---|---|
| **Unattended for 2 days, no human in the loop** | **Not met** | Mandatory human gate between `/decompose` and `/build-batch` by design (`decompose.spec.md:361,386`); no end-to-end orchestrator; build escalates to a human on auth/secrets/migration and cannot self-resume. |
| **Fully built** | **Partial** | The parallel build does auto-chain to `/retro` and builds all *unblocked* beads, but an early foundational blocker (auth) strands its subtree, and dropped must-haves/NFRs are never built at all. |
| **Enterprise-grade** | **Not met** | No observability/audit/authz/tenancy by default; NFRs evaporate to prose tenets; gate has no coverage floor, no SCA, no e2e, and treats "no tests" as a pass. |
| **Production-ready** | **Not met** | Nothing is ever deployed (terraform is `plan`-only, bootstrap+secrets+apply all need a human); no monitoring/SLO/backup verification; the success metric is never an executable test. |

## 3. Critical & high gaps (prioritized)

### A. The flow assumes a present human at every seam — the promise's core contradiction

- **No automated path from BLESSED DAG to running build, by design.** `decompose.spec.md:361,386` and `build-batch.spec.md:461` explicitly forbid auto-chaining; `README.md:16-18` draws the human-review gate as a pipeline node. A user who walks away returns to a pipeline *halted with zero app code written*. **Fix:** add an opt-in `--auto-bless` / orchestrator mode that, on a BLESSED verdict above a confidence threshold, chains into `/build-batch` automatically; keep the human gate as the default, not the only path.
- **No end-to-end orchestrator.** Nothing drives `vision → decompose → build-batch → retro`; `/loop` only iterates `/build-next` *within* the build stage (`README.md:20`, `ARCHITECTURE.md:43`). The human is the orchestrator at every seam except the build→retro tail. **Fix:** a top-level `build-app` driver that takes a filled `vision.md` and sequences all four stages with explicit checkpoints it can clear autonomously.

### B. Unattended resilience: the first hard decision ends autonomy and nothing resumes

- **Auth/secrets/migration are hard-stop escalations** (`ESCALATION_RULES.md:9-12`), and these *are* the defining features of an enterprise app. `auth-email-password.formula.toml` labels all six steps `touches-auth`; `build-batch.spec.md:213-214` blocks any `touches-auth`/`needs-decision` bead unconditionally. A login-bearing app *will* block mid-run and page an absent human. **Fix:** capture auth-model and secrets decisions as structured, pre-approved choices at `/vision` time (human-present), recorded in `plan.lock`, so the labeled beads can clear unattended.
- **No auto-resume after a block.** `/escalate` sends a `PushNotification` and the loop exits; the only restart is a human typing `/loop /build-next` (`escalate/SKILL.md:38,52`, `ESCALATION_RULES.md:40-41`). After a drain-to-blocked, *nothing is running* for the rest of the 2 days. **Fix:** a polling driver that re-checks `bd ready` on an interval and resumes when a human unblocks (or a budget/timeout fires).
- **`--budget` is parsed but never enforced** — appears only at `build-batch.js:28,34`, never read in the 519-line wave loop. The one financial safety stop for an unattended run does not exist. **Fix:** wire cumulative-cost accounting into the dispatch loop as the spec already documents (`build-batch.spec.md:425`).
- **A hung worker stalls the whole batch forever.** `build-batch.js:362` `await parallel(buildTasks)` has no timeout; the spec's 30-min `stageTimeout`/`TaskStop` (`build-batch.spec.md:411-415`) was never implemented. A worker wedged on an interactive prompt never returns, so `parallel()` never resolves — silent infinite stall, no notification. **Fix:** wrap each worker thunk in the spec's per-worker timeout.
- **Crash mid-batch is unrecoverable** — declared a non-goal (`build-batch.spec.md:101,440`); all state is in-memory. Over a 2-day window an OOM/restart is likely, and it strands `in_progress` beads invisible to `bd ready`. **Fix:** checkpoint `merged/blocked/failed` sets to disk and add a stale-claim reaper on re-run.

### C. The output is a toy by default, not enterprise-grade

- **Production formulas are opt-in per-feature, never injected.** The only always-poured baseline is `app-skeleton` (init/deps/lint/test/ci/readme). Auth, authz (`openfga-model`), observability (`otel-bootstrap`), audit (`audit-chain`), tenancy, and IaC enter *only* if a vision §3 must-have happens to map to them — and `templates/vision.md` tells users to list product features, not cross-cutting infra. The template's own example ("sign up, create a habit, see a streak") yields skeleton + crud + maybe auth and nothing else. **Fix:** a mandatory production-floor formula set injected by default for any app declaring auth/data, with the decompose fidelity check made aware of it.
- **Nothing is ever deployed.** `terraform-aws-baseline` writes HCL and at best runs `terraform plan`; state-bucket bootstrap (line 109), secrets (line 581), and `terraform apply` (human-gated CI environment) all require a human. No smoke test, health check, SLO, alerting, or backup verification anywhere. "Production-ready" implies *running somewhere*; the user gets a git repo that passes tests. **Fix:** an unattended deploy-to-dev path (CI-issued credentials, auto-created state backend) plus a post-deploy health/smoke bead.

### D. The quality gate passes shoddy and untested work

- **The gate is PowerShell-only and never installed where it runs** — and this is the most damning *does-it-run* defect. `post-build-gate.ps1` uses `Start-Process -FilePath "powershell"` (Windows name); on the documented Linux/macOS install path there is no `pwsh`, and neither installer links the hook into a runtime location (`install.sh:101-132` ships only skills/formulas/workflows `*.js`). `build-batch.js:348,418` invokes `hooks/post-build-gate.ps1` (or "its symlink" — which nothing creates). Worst case it exits 0 on parse garbage and reports PASS. **Net: on a Linux host the single gate between "agent wrote code" and `bd close` silently no-ops.** **Fix:** ship a POSIX gate (`.sh`), invoke via `pwsh` not `powershell`, and have an installer/scaffold place the gate into each app repo.
- **`beads-builder` agent is dispatched but never installed** (`build-batch.js:360`); no installer touches `agents/`. Workers fall back to a generic agent missing the escalation pre-check, "don't edit acceptance to pass," and test-extension rules — silently degrading safety. **Fix:** install/scaffold the agent definition; inline its safeguards into the worker prompt.
- **Test step treats "no tests" as a pass** (`post-build-gate.ps1:43,56` guard on `$scripts.test`/`Get-Command pytest`). Absence is indistinguishable from green — a mechanical escape hatch. **Fix:** require a discovered, non-empty test suite per bead or hard-fail.
- **No coverage threshold, no e2e/integration in the gate, no SCA scan.** Gate is unit-level only; e2e suites the formulas scaffold run only in CI; no `npm audit`/`cargo audit`; the "secret scan" is filename-pattern matching. For the flagship Rust-workspace stack the gate has *no Rust branch at all*, so it runs essentially nothing at repo root. **Fix:** coverage floor, run the integration/e2e suites in the gate, add SCA, add a Cargo branch.
- **Jankurai — the marquee enterprise enforcer — is advisory by default** (`post-build-gate.ps1:101-104`); the hard-fail witness ratchet is disabled until a human accepts a baseline that ships as `{}`. It has zero blocking power during exactly the unattended window. **Fix:** populate a real baseline during decompose and make the ratchet live.

### E. Planning silently loses scope

- **No vision↔plan coverage check.** The adversarial Phase-6 cross-check verifies plan↔DAG only (`decompose.js:574-602`); nothing re-reads `vision.md`. A must-have dropped during `/vision` distillation is invisible — BLESSED means "DAG matches plan," not "plan matches vision." A 12-must-have vision can build as a faithful 9-feature app with a green report. **Fix:** emit a must-have→featureOrder traceability matrix and assert 1:1-or-deliberate-defer.
- **NFRs evaporate to prose tenets** — `plan.lock.schema.json` (`additionalProperties:false`) has no field for security/perf/compliance/privacy; `/vision` routes §6 constraints to advisory `tenets.md` text. "User data stays in my region" becomes a sentence a builder may consult, never a bead with an AC and a test, never scored, never gated. **Fix:** model NFRs as first-class plan-lock entries that pour enforcement beads.
- **The §8 success metric — the user's one definition of "done" — is never an executable test.** No schema field, no bead; the cross-feature journey is never verified as a path. **Fix:** pour an e2e acceptance bead from §8.

## 4. Medium / low & themes

- **Notification asymmetry:** `failed` beads (the *most* unexpected) send no notification, only orphaned worktrees + a log nobody reads (`build-batch.js:393-398`); `blocked` notifies. The severe case is the silent one.
- **Gate-fails-twice → permanent block** (`ESCALATION_RULES.md:15`): one retry is a thin budget for hard/load-bearing beads; biases surviving output toward easy beads.
- **Merge conflicts permanently block with no rebase/retry** (`build-batch.js:414-421`); shared config/barrel/lockfiles accumulate over the run, so conflict-blocks rise exactly when the human is furthest away.
- **`/retro` has a spec but no `retro.js`/skill**, yet `build-next` auto-invokes it — the terminal stage resolves to nothing (blast radius is the self-improvement loop, not the deliverable).
- **Doc/code drift:** `build-batch.js` agent prompts still reference the undistributed `build-batch.spec.md` (the bug already fixed in `decompose.js`); `build-next/SKILL.md` still cites the removed `/compose` stage.
- **Theme:** lint/typecheck strictness, test rigor, and quality enforcement are all *delegated to project config and agent goodwill* under retry pressure — the system trusts the builder not to weaken the very rules it's racing to satisfy.

## 5. What's actually solid

The refutation pass confirms the design holds up in several real ways:

- **The parallel build is resilient at the wave level.** A single blocked bead does *not* end the run — it's parked, its subtree excluded, and every other ready bead keeps building (`build-batch.js:242,269-274`), with a >50% failure-rate abort as a systemic backstop. The "first escalation kills everything" framing was correctly downgraded.
- **Escalate-over-guess is a defensible correctness stance.** Pausing on an irreversible auth/secrets/migration decision is *better* than guessing wrong and compounding it across the build — the tension with "unattended" is real, but the choice is principled, not careless.
- **Stack decisions are genuinely front-loaded.** `DEFAULT_STACK.md` + `/vision` resolve test framework, ORM, DB, lint silently — so the "formula didn't pin the test framework → page mid-run" fear is designed away.
- **Where a formula exists, it tests behavior against real dependencies** (testcontainers OTel/OpenFGA, tamper-detection audit tests, auth flow assertions) — cross-cutting correctness is *not* wholly unverified.
- **Formula scope is transparent, not deceptive.** "Phase 1 single-region" is SMBuild's product roadmap, not a hidden capability ceiling; rotation stubs ship with honest runbooks. No masquerading-as-complete.
- **Coverage granularity is sound for the common path.** Feature-name matching works because ACs are *formula-derived* and atomization can't drop them — the false-positive fear only bites on vision→formula misfit, behind the human gate.
- **`/decompose` and `/vision` human gates are correctly placed** (pre-walkaway), and the just-shipped `decompose.js` self-containment fix shows the maintainers learn from observed failures.

## 6. Top 5 highest-leverage changes

1. **Make the gate actually run everywhere:** ship a POSIX gate, invoke `pwsh` not `powershell`, and install/scaffold both the gate and the `beads-builder` agent into each app repo — today the single verification step silently no-ops on Linux/macOS.
2. **Front-load the escalating decisions:** capture auth-model + secrets choices at human-present `/vision` time into `plan.lock` so `touches-auth`/`touches-secrets` beads clear unattended, and add a polling driver that auto-resumes after blocks (with `--budget` finally enforced).
3. **Inject a mandatory production floor** (auth + authz + observability + audit + unattended deploy-to-dev + post-deploy smoke) for any data/auth app, instead of leaving it to a product-feature must-have happening to map to it.
4. **Add a vision↔plan traceability assertion** and make NFRs + the §8 success metric first-class plan-lock entries that pour gated beads — so dropped must-haves and the user's own definition of "done" can't evaporate.
5. **Build the end-to-end orchestrator with auto-bless + per-worker timeouts + crash checkpointing** so `vision → decompose → build-batch → retro` runs as one durable sequence that survives stage boundaries, hung workers, and process restarts across the 2-day window.
