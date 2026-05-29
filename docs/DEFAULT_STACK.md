# Default Stack (Jankurai)

The pipeline's canonical tech stack. `/vision` defaults every app to this stack without asking the user. `/decompose`, `/build-next`, and the formulas all assume it.

> Jankurai itself is stack-agnostic (per `github.com/neverhuman/jankurai`). This file pins the specific stack profile this workflow uses — it is *not* prescribed by Jankurai's CLI, it is the choice this repo has made for every app it builds.

## The stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Core / services | **Rust** | All product truth, authorization, direct Postgres writes, backend glue. |
| Product surface | **TypeScript + React + Vite** | User-facing UI and any product-surface JS. |
| Database | **PostgreSQL** | The truth layer. SQLite is *not* a v1 fallback. |
| Cross-language contracts | **Generated** | TS types generated from Rust (e.g. `ts-rs` or OpenAPI). Hand-maintained duplicate types are a smell. |
| AI / data service | **Python — exception only** | Allowed only when the AI/data ecosystem requires it (e.g. a model serving sidecar). Never for repo tooling, product truth, services, authorization, direct PostgreSQL writes, or general backend glue. |
| Tests | Rust: `cargo test`. TS: `vitest`. Python (when present): `pytest`. | |
| Lint / format | Rust: `cargo fmt` + `clippy`. TS: `biome`. Python: `ruff`. | |
| Hosting | Per-app — chosen at deploy time, not vision time. | Default: whatever the app needs; Postgres-compatible host. |

## Stack-native formulas (formula selection)

The formula library carries **two kinds** of formula for several capabilities: a *generic* formula (JS/Python/REST-shaped — `app-skeleton`, `crud-feature`, `background-job`, `integration-http`) and a *stack-native variant* tuned to this pinned stack (Cargo workspace, tonic/gRPC, sqlx, Vite/React). The generic formulas exist for stacks that have no native variant; **on this pinned stack they are a fallback, not the default.**

**Selection rule (`/vision` step 6):** for each feature, identify the capability, then pour the **stack-native variant if one covers that capability**. Fall back to a generic formula only when no native variant exists for the capability (currently only `migration`, which is shared — supply a Rust/sqlx-appropriate `up_outline`/`down_outline`).

| Capability | Generic (fallback) | Stack-native — **prefer this** |
| --- | --- | --- |
| Repo / workspace skeleton (Rust core) | `app-skeleton` | `app-skeleton-rust-cargo` |
| Frontend skeleton (product surface) | `app-skeleton` | `app-skeleton-vite-react` |
| CRUD entity vertical slice | `crud-feature` | `crud-feature-rust` |
| Non-CRUD gRPC service | — | `grpc-tonic-service` |
| Closed grammar / composer version | — | `composer-grammar-version` |
| Observability bootstrap | `app-skeleton` (misuse) | `otel-bootstrap-rust` |
| Audit chain | `background-job` | `audit-chain-rust` |
| Tenant-boot chokepoint | `background-job` | `tenant-boot-rust` |
| OIDC auth client | `integration-http` | `oidc-client-rust` |
| ReBAC authz model | `integration-http` | `openfga-model` |
| IaC / cloud baseline | `app-skeleton` (terraform) | `terraform-aws-baseline` |
| Schema migration | — | `migration` (shared; supply `down_outline`) |

**The off-enum tell (how to catch a wrong pick before `/decompose`):** the generic formulas declare JS/Python-flavored enum vars — `app-skeleton.package_manager ∈ {npm,pnpm,uv,poetry,auto}`, `background-job.trigger_type ∈ {schedule,queue}`, `app-skeleton.language/framework`. If binding a feature to a generic formula forces an **off-enum** value (`package_manager=cargo`, `trigger_type=internal|cron`, `language=rust`), that is proof the generic formula is the wrong choice for this stack — a stack-native variant almost certainly exists; pick it instead. Do **not** remap to a near-miss enum value or invent one (T1: do not guess). This is exactly the run-2 smbuild defect (`autonomous-build-3fr.1`): 7 Rust features were bound to generic formulas and failed to pour off-enum.

When a new stack-native formula lands (or the stack changes), add its row here so `/vision` selects it — same deliberate-edit rule as the stack table below.

## Production floor (mandatory, not opt-in)

Production-readiness is **not** something a product must-have has to "happen to" pull in. `/decompose` Phase 3.5 injects a mandatory floor based on what the app declares, and gates it (a floor capability with no enforcement formula is NEEDS-FIX):

| App declares… | Mandatory floor capabilities |
| --- | --- |
| **Data** (non-empty data model) | `observability` (otel traces/metrics), `audit-log`, `iac-deploy` — the app must be observable, auditable, and **actually deployed**: `iac-deploy` is an *unattended* deploy-to-dev (CI OIDC creds, auto-created state backend, `terraform apply -auto-approve` for dev only) plus a post-deploy health/smoke check; prod apply stays human-gated (lbq.9) |
| **Auth** (auth in stack, an addressed authn/authz concern, or a must-have implying accounts) | additionally `authz` (access-control enforcement) and `abuse-surface` (input-validation / rate-limit on exposed surfaces) |
| Neither (stateless no-auth tool) | empty floor |

The floor is realized by enforcement formulas, the same way `concerns[]` and `nfrs[]` are (no `bd create`; a missing formula surfaces `recommendedFormula` and forces NEEDS-FIX). A capability already delivered by a product feature or an addressed concern is not poured twice. This is what stops a real data-backed app from shipping as skeleton+CRUD with no observability, audit, authz, or deploy path.

### Floor enforcement formulas

Each floor capability resolves to a pinned enforcement formula. `/decompose` Phase 3.5 selects it by **purpose** (it runs `bd formula list` and matches the formula whose purpose enforces that class — there is no hardcoded name table), so the names below are the canonical realizations, not a lookup the code depends on:

| Floor capability | Enforcement formula |
| --- | --- |
| `observability` | `otel-bootstrap-rust` |
| `audit-log` | `audit-chain-rust` |
| `iac-deploy` | `terraform-aws-baseline` |
| `authz` | `openfga-model` |
| `abuse-surface` | `concern-enforcement-abuse-surface` |
| success-metric end-to-end definition-of-done | `e2e-acceptance` |

Two further concern-enforcement formulas back conditional concerns when an app triggers them: `concern-enforcement-data-lifecycle` (retention / deletion / hard-delete cascade — the `data-lifecycle` concern) and `concern-enforcement-perf` (load / latency-envelope assertion — the `perf-envelope` concern).

### Pinned abuse-surface posture

`abuse-surface` is a mandatory auth-floor item, so — like the other floor items — its default posture is **pinned here, not re-litigated per app**. A per-app rate-limit decision is the exception (an unusual threat model), not the default. The posture below is encoded by `concern-enforcement-abuse-surface` and is a valid `addressed` evidence citation (a `DEFAULT_STACK.md` pin — see `docs/PLAN_CONCERNS.md` §Evidence), so an auth'd app's `abuse-surface` concern resolves `addressed` at vision time instead of blocking at the decidedness gate:

- **Edge:** an AWS WAFv2 web ACL with a **rate-based rule** in front of the ALB (default 2,000 requests / 5-min per source IP — AWS's minimum rate-rule window), shipped as a `terraform-aws-edge-security` module the IaC baseline wires in (this is the WAF layer `terraform-aws-baseline` defers as Phase 2+).
- **In-app:** a **per-tenant token-bucket** limiter via [`tower-governor`](https://docs.rs/tower-governor) as an Axum layer on every public route (default **10 req/s sustained, burst 20**, keyed on the authenticated tenant; falls back to source IP for unauthenticated routes).
- **Input bounds:** a request body-size cap (`tower-http` `RequestBodyLimitLayer`, default 1 MiB) plus `validator`-derive bounds on request DTOs (reject malformed/oversized input with 400).

All three are **overridable per app** (a §6 constraint or a vision-time decision can tighten or relax them); in the absence of an app-specific decision they are the default.

## Why this is pinned, not chosen per-app

The human checkpoint in `/vision` is for **product** (problem, users, must-haves, non-goals, success metric), not **tech**. Re-litigating the stack per app burns the human's time on a decision that almost never changes the product outcome — and inconsistent stacks across apps make the formulas, retros, and shared skills more expensive to maintain.

## How `/vision` uses this file

- For every required `plan.md` Stack row, fill in from this table. Do not ask the user.
- If a feature in `vision.md` §3 needs something outside this stack (e.g. a real-time websocket service, a queue, a vector DB), do **not** escalate to the user. Spawn a 3-agent consult (architect / reviewer / counter-arguer), synthesize, and write the decision into `plan.md` under "Decided by agent consult" with the rationale. See `skills/vision/SKILL.md` for the consult protocol.
- The only stack-related thing that escalates to the human is a direct contradiction in `vision.md` itself (e.g. "must run on a TI-84 calculator" + a must-have feature that requires a Postgres backend). That's a product-scope problem disguised as a tech one.

## Off-stack escalation (agent consult, not human)

When a must-have feature can't be served by the pinned stack:

1. Spawn 3 `Agent` calls in parallel in a single message:
   - **Architect**: "Given Jankurai stack + this feature, propose the minimal addition (or alternative shape using only the pinned stack)."
   - **Reviewer**: "Given the same constraints, identify the load-bearing risks of adding anything off-stack and what we'd lose by staying on-stack."
   - **Counter-arguer**: "Argue against any addition; show how to satisfy the must-have with what's already in the stack."
2. Synthesize their outputs into one decision in `plan.md`:
   ```
   ## Decided by agent consult
   - **Question**: <what we asked>
   - **Decision**: <one line>
   - **Rationale**: <2–4 lines, citing whichever agent's argument carried>
   - **Reversal cost**: <what changes if we change our minds in 3 months>
   ```
3. Do not ask the human. The human reviews `plan.md` after — they can still reverse the decision at that gate, but they should not be paged for it during planning.

## When this file changes

Edits to this stack are workflow improvements — file a `bd create --type=task --add-label workflow-improvement` and discuss before flipping a row. A row change here ripples into every future app, so it deserves a deliberate commit, not a drive-by edit during a build.
