# vision-eval corpus (the oracle)

This directory is the **oracle** the vision-eval harness grades against (epic `autonomous-build-4vj`). Each fixture is a `vision.md` input paired with an `expect.json` manifest stating what a correct `/vision` run must produce. A sloppy oracle makes the whole eval meaningless, so the manifests are deliberately falsifiable: every assertion traces to a rule in [`docs/PLAN_CONCERNS.md`](../../docs/PLAN_CONCERNS.md) or a gate in [`skills/vision/SKILL.md`](../../skills/vision/SKILL.md).

This bead (`autonomous-build-4vj.1`) ships the **corpus + manifests** only. The harness that runs `/vision` against each fixture and grades the output is `autonomous-build-4vj.2`+ (L1–L3 mechanical checks, L4 evidence-quality judge, L5 downstream propagation).

## Layout

```
tests/vision-eval/
  expect.schema.json          # JSON Schema for every expect.json (the manifest contract)
  README.md                   # this file
  fixtures/
    NN-<slug>/
      vision.md               # the input handed to /vision
      expect.json             # the oracle: what a correct run must produce
```

## The manifest (`expect.json`)

Each manifest is validated by `expect.schema.json`. Fields:

| Field | Meaning |
| --- | --- |
| `fixture` / `axis` / `archetypeProfile` | identity + which coverage axis + the deferred profile it maps to (below) |
| `expectIncomplete` | whether a correct run must BLOCK (`incomplete: true` → `/decompose` refuses). `true` for adversarial fixtures. |
| `concernApplicability` | derived applicability per `concernId` (all ten), per the `docs/PLAN_CONCERNS.md` "Applicability" table |
| `mustHaves[]` | the `M`-IDs a run should assign, and whether each must map to ≥1 feature in `coverage[]` |
| `blocking[]` | the gate(s) that must fire when `expectIncomplete` is true (empty otherwise) |
| `notes` | the rationale, so a reviewer can audit the oracle itself |

### Applicability tiers — and the invariant the oracle enforces

`concernApplicability` uses the three tiers from `PLAN_CONCERNS.md` plus one for the empty case:

- **`required`** — the concern is required (always-required concerns, or an excluded/optional-by-default concern the vision elevated).
- **`optional`** — only ever `data-lifecycle` and `observability` (the two optional-by-default concerns) when their elevating condition is *not* met.
- **`excluded`** — an excluded-by-default concern (`authn`, `authz`, `secrets`, `perf-envelope`, `abuse-surface`) the vision did not elevate.
- **`underivable`** — only fixture 10: no product input, so nothing to derive from.

> **Invariant the manifests obey** (and the harness can mechanically check): the five excluded-by-default concerns resolve only to `required` or `excluded`, never `optional`; the three always-decided concerns (`data-model`, `error-handling`, `external-integrations`) are always `required`; `optional` appears only for `data-lifecycle`/`observability`. Applicability is the *derived tier*, distinct from the decided `status` in `concerns[]` (a concern can be applicability `optional` but `status: excluded` by decision).

## The axes (and per-archetype-profile mapping)

The corpus spans the coverage-relevant axes so the eval exercises every branch of the concern-derivation and gate logic. `PLAN_CONCERNS.md` defers a class of app-specific concerns (accessibility, i18n, …) to future **per-archetype profiles**; each fixture records the `archetypeProfile` it would belong to, so when those profiles land the corpus already has representatives.

| # | Fixture | Axis | Archetype profile | Blocks? | Load-bearing signal |
| --- | --- | --- | --- | --- | --- |
| 01 | `multitenant-saas-web` | greenfield multi-tenant web | `web-frontend` | no | `authz` required (tenant isolation); `abuse-surface` required (signup) |
| 02 | `single-user-offline-cli` | single-user offline CLI | `cli` | no | nearly everything excluded; `external-integrations` still *decided* ("none") |
| 03 | `data-pipeline` | batch ETL, no end-user accounts | `data-pipeline` | no | `authn`/`authz` excluded but `secrets`+`data-lifecycle`+`observability` required |
| 04 | `public-unauth-api` | public unauthenticated API | `public-api` | no | `abuse-surface` required is the whole point; `secrets` excluded (no creds) |
| 05 | `privacy-constraint` | §6 privacy / data-residency constraint | `web-frontend` | no | `data-lifecycle` required via privacy + PII; residency → an `nfrs[]` entry |
| 06 | `scale-latency-target` | §8 scale/latency target | `public-api` | no | `perf-envelope` required (concrete p99/throughput) → gated NFR |
| 07 | `external-integrations` | several third-party integrations | `web-frontend` | no | `external-integrations` required (3 named) + deep `error-handling` |
| 08 | `adversarial-musthave-excluded-by-nongoal` | must-have contradicted by a non-goal | `web-frontend` | **yes** | `musthave-nongoal-contradiction` + success-metric oracle |
| 09 | `adversarial-musthave-no-formula` | must-have no formula can pour | `web-frontend` | **yes** | `no-matching-formula` workflow gap (don't force-fit crud-feature) |
| 10 | `adversarial-empty-product-sections` | unfilled product sections | none | **yes** | `missing-product-sections`; applicability `underivable` (don't hallucinate) |

### Why these axes

- **Concern derivation coverage.** Across 01–07 every concern is `required` in at least one fixture and `excluded`/`optional` in at least one other, so a harness can detect a derivation rule that is stuck-on or stuck-off. In particular the deliberate contrasts: `authz` required (01) vs excluded (06); `secrets` required (03) vs excluded (04); `perf-envelope` required (06) vs excluded everywhere else; `abuse-surface` required (04) vs excluded (02).
- **Gate coverage.** The three adversarial fixtures each trip a *different* class of `/vision` block: a product/scope contradiction (08), a workflow/formula gap (09), and missing input (10). A run that blesses any of them is wrong in a way the oracle pins precisely.
- **The negative cases are the point.** 08–10 guard the failure modes that are invisible in a "looks fine" run: silently dropping a contradicted must-have, force-fitting an ill-matched formula (the `3fr.1` failure), and hallucinating a product from an empty vision.

## Adding a fixture

1. Create `fixtures/NN-<slug>/vision.md` (a realistic, filled `vision.md` — or a deliberately broken one for an adversarial axis).
2. Author `fixtures/NN-<slug>/expect.json` and validate it against `expect.schema.json`.
3. Ground every assertion in `notes` against a `PLAN_CONCERNS.md` rule or a `skills/vision/SKILL.md` gate — an unfalsifiable manifest is as bad as an unfalsifiable plan.
4. Add a row to the axes table above and note any new `archetypeProfile`.
