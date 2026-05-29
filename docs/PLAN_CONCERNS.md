# Plan Concerns (Jankurai)

The pinned vocabulary of cross-cutting concerns every plan must **decide**. This is the `DEFAULT_STACK.md` of coverage: where `DEFAULT_STACK.md` pins *what tech* every app uses, this file pins *what concerns* every plan must address — or consciously exclude.

`/vision` reads this file, derives whether each concern applies to the app, records a decision per concern in `plan.lock.json` `concerns[]`, and refuses to ship a complete plan with any applicable concern left undecided. `/decompose` later verifies that each `addressed` decision traces to a real bead.

> Workflow-level and **pinned**. Edits here ripple into every future app's plan, exactly like `docs/DEFAULT_STACK.md` and `docs/TENETS.md`. See "When this file changes."

---

## The decided-state rule

The mechanism that makes coverage deterministic is not "every plan has every section." It is:

> **Every concern in the vocabulary below resolves to exactly one decided state — `addressed` or `excluded` — and never to silence.**

- `plan.lock.json` `concerns[]` carries **one entry per concern in this vocabulary** — applicable concerns decided by the plan, excluded-by-default concerns carrying the standard exclusion reason. A concern is never simply *absent*; "did we consider X?" is always answerable from the lock.
- **`addressed`** requires *falsifiable evidence* (see "Evidence"). A bare assertion ("we handle security") is not evidence and fails.
- **`excluded`** requires a one-line reason ("CLI tool, no network surface").
- **`required` + `excluded` is a contradiction.** It means the plan excluded something the product needs (or the derivation misread the product). `/vision` does not resolve it — it surfaces a blocking `openQuestion` for the human (the same `incomplete: true` → `/decompose`-refusal path the must-have gate uses). The human either corrects the vision or confirms the exclusion.

Silence is the only failure mode this file exists to prevent. An unaddressed concern is a silent failure — see **T7 (failure visibility: loud over silent)** in `docs/TENETS.md`.

---

## The concern vocabulary

Ten concerns. The `concernId` strings are canonical and stable — `plan.lock.json` and the vision workflow bind to them verbatim.

| `concernId` | What it covers | **`addressed` requires** (falsifiable) |
| --- | --- | --- |
| `data-model` | The entities/fields/relationships the truth layer needs | Every must-have entity appears in the plan's Data model with fields + relationships — not "we'll have a database." |
| `authn` | Authentication — who the caller is | Names *who* authenticates (which §2 role) **and** the mechanism, cited to a feature/formula (e.g. "OIDC login for the Operator role via `oidc-client-rust`") — not "users log in." |
| `authz` | Authorization — what the caller may do | The authorization boundary: who may read/write whose data, cited to a feature or enforcement point (e.g. "OpenFGA model: a user reads only their own habits; tenants isolated") — not "permissions enforced." |
| `secrets` | How credentials/secrets are stored and injected | Where each secret lives + that it is not in the repo, enumerated (e.g. "DB URL + OIDC client secret via env from the host secret store; `.env` gitignored") — not "we use env vars." |
| `data-lifecycle` | Retention, deletion, migration, backfill of stored data | Retention/deletion stance for user data **and** whether migrations are destructive (e.g. "habits soft-deleted; user hard-delete cascades; migrations additive in v1"). Ties to **T5 reversibility** + **T8 idempotency**. |
| `error-handling` | Failure-mode stance for the app's own operations | Names the failure modes that need *design* (partial failure, ret[ries], dependency-down) **and** cites **T7** for the rest — not silence. Cheap to address, but must be named. |
| `observability` | Logging/metrics/tracing so failures are diagnosable | A feature/formula that emits them (e.g. "`otel-bootstrap-rust` emits traces+metrics") **or** `excluded` with reason. |
| `external-integrations` | Third-party services/APIs the app depends on | Each integration named with its shape (auth, data flow, failure mode) **or** "none." A silent integration is a hidden dependency + a secrets/abuse surface. |
| `perf-envelope` | The scale/latency target the design must hold | A concrete envelope **if** the success metric implies one (e.g. "p99 < 200ms on the streak endpoint at 100 concurrent users") **or** `excluded` ("v1 single-user, no perf target") — not a vibe. |
| `abuse-surface` | Rate-limiting, input validation/bounds, abuse vectors | For each public surface: an input-validation + rate-limit stance. By default this is the **pinned abuse-surface posture** (DEFAULT_STACK §"Pinned abuse-surface posture": per-tenant `tower-governor` token-bucket + WAFv2 rate-based rule + body-size/`validator` bounds, realized by `concern-enforcement-abuse-surface`) — an auth'd/public app cites that DEFAULT_STACK pin + formula as evidence and is `addressed`, not blocked. `excluded` only when there is no public/unauthenticated network surface. |

---

## Applicability — and how it is derived

Applicability is **derived from `vision.md`, never invented.** This keeps the concern set grounded in the human's product input, consistent with "the `/vision` checkpoint is for product." Each concern resolves to `required`, `optional`, or `excluded-by-default`.

| `concernId` | Default | Resolves to **required** when… |
| --- | --- | --- |
| `data-model` | required | always (excluded only for a genuinely stateless app — rare). |
| `authn` | excluded-by-default | any §3 must-have implies user accounts / per-user data, or §2 lists multiple human roles. |
| `authz` | excluded-by-default | `authn` is required **and** there is >1 principal or any cross-user/cross-tenant data. |
| `secrets` | excluded-by-default | `authn` or `external-integrations` is required, **or** §6 has a privacy constraint. (Usually required once there's a DB + auth. A §6 *budget* line is a cost ceiling, not a secret-management signal — a paid-API budget surfaces as `external-integrations`, which already elevates `secrets`.) |
| `data-lifecycle` | optional | §6 has a privacy constraint, **or** the data model holds PII / user-owned entities. |
| `error-handling` | required | always (depth scales with `external-integrations` + destructive ops). |
| `observability` | optional | §8 success metric implies running-in-production / multi-user operation. |
| `external-integrations` | required *to decide* | always decided (even "none") — a silent integration is a hidden dependency. |
| `perf-envelope` | excluded-by-default | §8 success metric names a scale, latency, or throughput target. |
| `abuse-surface` | excluded-by-default | the app exposes a public or unauthenticated network surface. |

**Applicable** = resolves to `required` or `optional`. `excluded-by-default` concerns are auto-recorded as `status: excluded` with the standard reason unless the vision elevates them — they still appear in `concerns[]` so the decision is explicit and auditable.

---

## What is NOT a concern here

Deliberately excluded from the vocabulary, with the reason — so they are not re-litigated:

- **testing** — pinned by `DEFAULT_STACK.md` (`cargo test` / `vitest` / `pytest`) and scored *per bead* in `/decompose` Phase 5 (`testPlanCases`). A plan-level testing concern would double-count.
- **hosting / infra** — `DEFAULT_STACK.md`: "Hosting — per-app, chosen at deploy time, not vision time." Hosting therefore ships as a **pinned default exclusion** ("deferred to deploy time per DEFAULT_STACK"). *Off-stack infra additions* (a queue, a vector DB, a websocket gateway) are not "hosting" — they surface under `external-integrations` and route through the agent consult.
- **language / framework / lint / format** — pinned by `DEFAULT_STACK.md`; not coverage decisions.
- **accessibility, i18n / l10n** — real, but app-specific. Forcing every plan to write "excluded: i18n" trains rubber-stamping. They are deferred to future **per-archetype profiles** (a web-frontend profile would add them); they are not core vocabulary.

---

## Evidence — what counts

`addressed` evidence must point at something a verifier can check exists. Valid evidence is one of:

1. a `featureOrder[]` entry (by name) that delivers the concern,
2. a formula that encodes it (e.g. `oidc-client-rust`, `otel-bootstrap-rust`),
3. a tenet, by number (e.g. "T7: no swallowed exceptions"),
4. the quality gate (`hooks/post-build-gate.{sh,ps1}`),
5. a `DEFAULT_STACK.md` pin.

A bare assertion ("handled", "we take security seriously", "standard practices") is **not** evidence — it is unfalsifiable and fails, mirroring `/decompose`'s anti-vagueness invariant (`decompose.spec.md` §Phase 5: record the exact phrase, never a bare claim). Evidence that cites a feature is verified downstream: `/decompose` asserts ≥1 bead implements that feature (bead `autonomous-build-bfo.9`). Evidence that cites a tenet/gate/stack-pin is accepted as-is (those are always present — a weaker but honest check).

---

## Worked example

A multi-tenant habit tracker with an OIDC login and a "p99 < 200ms streak endpoint at 100 users" success metric, no public unauthenticated surface:

```jsonc
"concerns": [
  { "concernId": "data-model",            "status": "addressed", "evidence": "Habit, User, Streak entities in Data model; Streak belongs_to User" },
  { "concernId": "authn",                  "status": "addressed", "evidence": "feature 'Account login' (Operator role) via oidc-client-rust" },
  { "concernId": "authz",                  "status": "addressed", "evidence": "feature 'Tenant isolation' (openfga-model): a user reads only their own habits" },
  { "concernId": "secrets",                "status": "addressed", "evidence": "DB URL + OIDC client secret via env from host secret store; .env gitignored" },
  { "concernId": "data-lifecycle",         "status": "addressed", "evidence": "habits soft-deleted; user hard-delete cascades; migrations additive in v1 (T5)" },
  { "concernId": "error-handling",         "status": "addressed", "evidence": "streak recompute is idempotent (T8); external calls surface, no silent fallback (T7)" },
  { "concernId": "observability",          "status": "addressed", "evidence": "feature 'Telemetry' via otel-bootstrap-rust" },
  { "concernId": "external-integrations",  "status": "addressed", "evidence": "OIDC IdP (Zitadel) only; no other third-party deps" },
  { "concernId": "perf-envelope",          "status": "addressed", "evidence": "p99 < 200ms on the streak endpoint at 100 concurrent users (from §8)" },
  { "concernId": "abuse-surface",          "status": "excluded",  "reason": "all endpoints behind authn; no public/unauthenticated surface in v1" }
]
```

A single-user offline CLI, by contrast, would `exclude` `authn`/`authz`/`secrets`/`observability`/`perf-envelope`/`abuse-surface` with reasons, and `address` only `data-model`, `data-lifecycle`, and `error-handling`.

---

## Relationship to agentConsults, tenets, and the gate

- **agentConsults** — when addressing `external-integrations` (or an off-stack infra need) triggers an off-stack decision, that decision is recorded in `plan.lock.json` `agentConsults[]` (the existing 3-agent consult). The concern's evidence then cites the consult. Concerns ensure the *question gets asked*; agentConsults record *how it was answered*.
- **tenets** — `error-handling`, `data-lifecycle`, and idempotency lean on T5/T7/T8. A concern may legitimately be `addressed` by citing a tenet the build is already bound to.
- **the gate** — some concerns (lint-enforced input handling, no swallowed exceptions) are partly enforced by `hooks/post-build-gate.{sh,ps1}`. Citing the gate is valid evidence; it does not remove the obligation to *decide* the concern.

---

## When this file changes

Pinned, like `docs/DEFAULT_STACK.md` and `docs/TENETS.md`. Edits ripple into every future app's plan.

- File a `bd create --type=task --labels workflow-improvement` describing the vocabulary change and the app or build that motivated it.
- Adding or removing a concern, or changing a derivation rule, is a deliberate commit — not a drive-by edit during a build.
- The downstream vision workflow inlines this vocabulary as a JS const (its agents run in the app cwd and cannot read this file). When this file changes, that const changes **in the same commit** — the same source-of-truth sync rule as `decompose.spec.md` ↔ `decompose.js`.
