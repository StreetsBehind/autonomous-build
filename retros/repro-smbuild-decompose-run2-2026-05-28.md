# Repro report: smbuild /decompose — run 2 (2026-05-28)

**Filed under:** epic `autonomous-build-3fr` → anchor `autonomous-build-1zq` (Workflow improvements)
**Prior context:** run-1 fixes (`autonomous-build-cnv`) + a manual patch of the 5 integration auth bindings in `plan.lock.json`.
**Run result:** `NEEDS-FIX` — 14/21 features poured (50 beads), quality scored 47 beads across 14 epics, fidelity `coverage-gap`.

## Why this run matters

Run 1 looked *almost* fine (18/21 poured) because two workflow bugs hid the truth: pour agents silently improvised bad variables, and the quality phase scored nothing. With those fixed (`autonomous-build-l6g`, `-49u`) and the auth bindings patched, run 2 is the **first truthful decomposition** — and it surfaces a deeper, previously-masked plan defect.

### Fixes confirmed working (the enabling conditions for this report)
- All 5 integration pours now succeed (Stripe, Twilio=`basic`, Postmark, Zitadel, OpenFGA).
- Quality phase scored 47 beads across 14 epics (run 1: 0).
- `reportPath` propagated (`autonomous-build-qo4`).
- Pour agents now **fail honestly** on bad vars instead of improvising (`autonomous-build-l6g`) — this is what exposed finding R1.

---

## R1 — `/vision` picks generic formulas, not stack-native variants (root cause) · `autonomous-build-3fr.1` · P1

**The stack is Rust.** `docs/DEFAULT_STACK.md`: *"Core / services: **Rust** — all product truth, authorization, direct Postgres writes."* Contracts are gRPC/tonic/ConnectRPC.

**But `/vision` bound the generic formulas to Rust backend features:**

| Feature | Plan picked | Result | Stack-native formula that exists |
|---|---|---|---|
| Repo skeleton (Cargo workspace) | `app-skeleton` | ❌ pour fail: `package_manager=cargo` off-enum (npm/pnpm/uv/poetry/auto) | `app-skeleton-rust-cargo` |
| Closed grammar v1 | `app-skeleton` | ❌ `package_manager=n/a` | `composer-grammar-version` |
| OpenTelemetry bootstrap | `app-skeleton` | ❌ `package_manager=cargo` | `otel-bootstrap-rust` |
| Terraform baseline | `app-skeleton` | ❌ `package_manager=terraform` | `terraform-aws-baseline` |
| Tenant boot chokepoint | `background-job` | ❌ `trigger_type=internal` off-enum (schedule/queue) | `tenant-boot-rust` |
| Audit chain | `background-job` | ❌ `trigger_type=cron` | `audit-chain-rust` |
| Universal migration | `migration` | ❌ missing required `down_outline` | `migration` (+ supply the var) |
| ConnectRPC/gRPC contracts | `app-skeleton` | ⚠ poured but skeleton-shaped, not a proto/tonic repo | `grpc-tonic-service` |
| Customer/Property/Job/Inventory/Invoice CRUD | `crud-feature` | ⚠ poured but **REST-shaped — contradicts the locked gRPC stack** | `crud-feature-rust` |
| Zitadel OIDC | `integration-http` | ⚠ generic HTTP client; plan itself annotated `[needs-formula: oidc-client-rust]` | `oidc-client-rust` |
| OpenFGA | `integration-http` | ⚠ generic HTTP client; plan annotated `[needs-formula: openfga-model]` | `openfga-model` |

**Reproduction**
1. With `docs/DEFAULT_STACK.md` pinned to Rust, run `/vision` on smbuild's `vision.md`.
2. Inspect `plan.lock.json` `featureOrder[].formulas` → generic formulas (`app-skeleton`, `crud-feature`, `background-job`) chosen for Rust features.
3. `rm -rf .beads && /decompose` → 7 features fail to pour with off-enum `package_manager`/`trigger_type` (see Pours section of `decomposeReport.md`); CRUD beads carry REST-vs-gRPC quality penalties (`smbuild-mol-3ww` et al.).

**Expected:** for a Rust-locked stack, `/vision` selects the `-rust`/native variants (they declare Rust-appropriate vars and emit gRPC, not REST). **Actual:** defaulted to generic JS/Python/REST formulas.

**Note:** distinct from `autonomous-build-bje` — that validates a variable *name* against a chosen formula. Here the wrong *formula* was chosen to begin with. (The `bje` validation would not catch this: `package_manager` is a real var of `app-skeleton`; it's the formula choice that's wrong, not the var name.)

---

## R2 — formulas reference `docs/ESCALATION_RULES.md` that doesn't exist in app repos · `autonomous-build-3fr.2` · P2

**Reproduction:** pour any `migration` bead or secret-store (`wire credentials`) bead into a fresh app repo. The bead cites `docs/ESCALATION_RULES.md`, which doesn't exist in a freshly-initialized app (it lives, if anywhere, in autonomous-build). Quality penalized: `smbuild-mol-val`, `-j9k`, `-b5e`, `-atv` (migrations) and `-7se`, `-uew`, `-djf`, `-451` (secret wiring).

**Expected:** a formula shouldn't point app beads at a meta-repo file absent from the app — drop the pointer, inline the rule, or have repo init create the file. **Actual:** dead pointer in every migration/secret bead.

---

## R3 — cross-dep wiring applied 0/28 edges, including poured-to-poured edges · `autonomous-build-3fr.3` · P2

**Reproduction:** `decomposeReport.md` reports *"Cross-feature deps applied: 0"*; verifier found only intra-molecule edges. Some missing edges touch the 7 unpoured features (expected). **But several are between two features that both poured** and were still not wired — e.g. `Customer CRUD` (`smbuild-mol-cci`) ← `ConnectRPC/gRPC contracts v1` (`smbuild-mol-jlk`); `Property` ← `Customer`; `Job` ← `Customer`/`Property`.

This suggests Phase-3 cross-dep wiring still under-applies (feature-name → molecule-epic-id resolution failing, or wiring aborting when any one endpoint is unresolvable). `autonomous-build-zip` (verify edges landed) is closed, so this is either an incomplete fix or a separate resolution bug. **Flagged for maintainer confirmation** — I did not want to over-claim a regression.

**Expected:** edges between two poured features get applied and counted.

---

## Bottom line for the plan question

This is no longer "tweak a few vars." The plan has a **systemic formula-selection defect** — generic formulas for a Rust/gRPC stack — that cascades into 7 hard pour failures and REST/gRPC contradictions in the beads that did pour. The right fix is at the `/vision` formula-selection layer (R1); R2/R3 are separable workflow issues the truthful run also surfaced. Solutions left to the maintainer per request.

## Data sources
- `decomposeReport.md` (smbuild, run 2)
- `smbuild/plan.lock.json` `featureOrder`, `docs/DEFAULT_STACK.md`
- `bd formula list` (confirmed all `-rust`/native variants exist)
- Workflow result for run `wf_52e32bc0-deb` (verdict, beadCount, failedPhases)
