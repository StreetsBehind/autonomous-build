---
name: vision-eval
description: Scale harness that grades /vision output against a hand-authored oracle corpus. Runs each fixture's vision.md through /vision K times, then scores the resulting plan.lock.json with three mechanical (pure-JS, no-LLM) layers — L1 contract validation, L2 expectation assertions vs the per-fixture manifest, L3 K-run stability — and emits a per-fixture result table. Turns "are our plans deterministic / in line with expectations?" from a vibe into numbers.
---

# vision-eval

The plan-determinism measurement stage, implemented as a **dynamic workflow** (see https://code.claude.com/docs/en/workflows). It grades the `/vision` stage against the oracle corpus in `tests/vision-eval/` (epic `autonomous-build-4vj`; corpus + manifests are `4vj.1`, already landed). This spec covers `4vj.2` (the **L1–L3 mechanical layers** + result table), `4vj.4` (the **scorecard + blessed-baseline regression ratchet**), `4vj.3` (the **L4 evidence-quality judge fan-out** — the opt-in LLM layer that populates `vaguenessRate`), and `4vj.5` (the **L5 downstream-propagation check** — the opt-in, most-expensive layer that runs BLESSED locks through `/decompose --dry-run` and re-checks the `bfo.9` forward-coverage invariant). L4 wired into the `vaguenessRate` slot the scorecard already reserved — no schema bump.

## How this spec runs

This file is a **workflow spec**, not a skill. The canonical script lives at `workflows/vision-eval.js` in this repo (hand-authored from this spec, the same convention `decompose.js` / `build-batch.js` / `retro.js` follow) and is linked into `~/.claude/workflows/` by the installers so the runtime finds it user-globally. Keep the spec and the script **in sync in the same commit** — when this spec changes meaningfully, edit `workflows/vision-eval.js` to match; do not rely on first-run regeneration.

**Why a workflow, not a skill:** the corpus is run fixture × K times in parallel, each run's plan.lock is graded independently, and the mechanical layers (L1–L3) are deterministic pure JS that must run identically on every invocation. A skill spawning agents ad hoc gives none of the determinism, isolation, or reproducibility this eval exists to measure. (This mirrors the same argument `decompose`/`retro` made when they converted from skills.)

## What this eval grades — and what makes it honest

The eval grades the **contract** (`plan.lock.json`: `concerns[]`, `coverage[]`, `mustHaves[]`, `incomplete`, `openQuestions[]`), never the prose. That is exactly what the `bfo` coverage gate made machine-checkable. Two design rules keep it from grading itself:

1. **The run agent is NOT schema-constrained.** L1 asks "does `/vision` *produce* a schema-valid lock?" If the run agent were forced through a StructuredOutput schema, L1 would pass vacuously. So each run agent returns **free JSON**, and the harness validates it in pure JS. This is deliberate; do not add a `schema:` to the run agent.
2. **The oracle is independent of the thing under test.** The manifests (`expect.json`) were hand-authored in `4vj.1`, each assertion grounded in a `docs/PLAN_CONCERNS.md` rule or a `skills/vision/SKILL.md` gate. The harness only *reads* them; it never derives expectations from the run output.

## Inputs

| Arg | Default | Meaning |
| --- | --- | --- |
| `--fixtures-dir <path>` | `tests/vision-eval/fixtures` | Corpus root (one `NN-<slug>/` dir per fixture, each with `vision.md` + `expect.json`). |
| `--k <int>` | `5` | Runs per fixture. The stability metric (L3) needs `k>=2`; `k=1` gives L1+L2 only. |
| `--only <slug[,slug...]>` | all | Restrict to named fixtures (e.g. a cheap `--only 01-multitenant-saas-web --k 1` smoke). |
| `--baseline <path>` | `agent/baselines/vision-eval.json` | The blessed-baseline file the ratchet diffs against and (with `--update-baseline`) rewrites. |
| `--update-baseline` | false | Bless the fresh scorecard AS the baseline: write it to `--baseline` with `blessed:true` and **do not gate**. The deliberate baseline-bump path; commit the result in a dedicated commit. |
| `--judge` | false | Run **L4** (`4vj.3`): the adversarial evidence-quality judge panel → populates `vaguenessRate`. Off by default — it adds `addressed-concerns × panelSize` heavy agents on top of the run cost, so it is the **periodic** layer, not per-commit. With it off, `vaguenessRate` stays `null` (a quiet ratchet skip). |
| `--judge-panel <int>` | `3` | Judges per evidence item (the "2–3 agents, majority" panel). Majority vote; an even split breaks toward *vague* (an unclear pass is not a pass). |
| `--judge-sample <int>` | `0` (all) | Cap the number of (deduped) evidence items judged — the small-sample lever for the periodic L4 run. `0` judges every deduped item; identical evidence strings across K runs are deduped first regardless. |
| `--propagate` | false | Run **L5** (`4vj.5`): take a small sample of BLESSED locks through `/decompose --dry-run` and re-check the `bfo.9` forward-coverage invariant → a leakage report. The most expensive, least frequent layer; **report-only** (never gates CI). Off by default. |
| `--propagate-sample <int>` | `1` | How many BLESSED locks to propagate (the "small sample, 1–3" of the bead). One `/decompose --dry-run` agent per sampled lock. |
| `--no-gate` | false | Compute + report the ratchet delta but never fail the run (report-only). |
| `--tol-pass <float>` | `0.15` | Max allowed drop (fraction) in L1/L2 pass-rate below baseline before it's a regression. |
| `--tol-stability <float>` | `10` | Max allowed drop (pct points) in coverage-/verdict-stability below baseline before it's a regression. |
| `--selftest` | false | Run the pure-JS checker unit tests (L1/L2/L3 + ratchet) against embedded synthetic data (NO agents, free) and stop. Used for CI of the harness logic itself. |

### Cost model (read before wiring to CI)

The mechanical layers L1–L3 are cheap (pure JS). The **cost is the inputs**: each run is a full `/vision` planning pass (a heavy agent), so a full corpus run is `fixtures × k` heavy agents (10 × 5 = 50 by default). "L1–L3 every commit" therefore means *the grading is cheap*, not *the run is free*. Practical tiering:

- **Per-commit CI:** `--k 1` over the full corpus (L1 + L2 + verdict; no stability) — 10 agents.
- **Nightly / pre-release:** `--k 5` (adds L3 stability) — 50 agents.
- **Periodic (L4 vagueness):** add `--judge` — an extra `deduped-addressed-evidence × --judge-panel` agents (≈ 9 concerns × fixtures × 3, minus dedupe). Use `--judge-sample N` to bound it. This is the LLM layer; run it on a cadence, not every commit.
- **Rare (L5 propagation):** add `--propagate` — one heavy `/decompose --dry-run` agent per `--propagate-sample` lock (default 1). The most expensive tier; report-only. Run it occasionally on a small sample, never per-commit.

Do not silently cap the corpus. If a run is restricted (`--only`, low `--k`), the result table states it so a green table is never mistaken for full coverage.

## Phases

### Phase 1 — Enumerate (sequential, 1 agent)

One agent lists the fixture slugs under `--fixtures-dir` (each dir containing both `vision.md` and `expect.json`). Returns `{ fixtures: [slug, ...] }`. The concern vocabulary is **not** fetched here — it is inlined in the script as `CONCERN_IDS` (the same PLAN_CONCERNS ↔ code sync rule `vision.js` follows; see "Sync rules").

### Phase 2 — Run + grade (pipeline, per fixture)

`pipeline(fixtures, readManifest, runAndGrade)` — each fixture flows through both stages independently (no barrier), so a fixture grades the moment its K runs finish.

**Stage A — `readManifest` (1 agent/fixture):** reads `<fixtures-dir>/<slug>/expect.json` and returns it as `{ manifest }`. This agent *is* schema-constrained (the manifest is the trusted oracle, not the thing under test — constraining it reduces transcription error).

**Stage B — `runAndGrade` (K agents/fixture + pure-JS grading):**

1. **K run agents in parallel.** Each executes `/vision` **headlessly** against `<fixtures-dir>/<slug>/vision.md` and returns the resulting `plan.lock.json` as **raw JSON** (no schema; see "honest" rule above). The headless contract the run agent obeys:
   - Read `skills/vision/SKILL.md` (the full procedure), `docs/DEFAULT_STACK.md`, `docs/PLAN_CONCERNS.md`, and the formula library; treat the fixture's `vision.md` as the app vision.
   - Run the procedure with **no human turns**: apply documented defaults; do the step-7 off-stack consult reasoning **inline** (do not spawn sub-agents); **never invent product content** to fill a gap.
   - Where a `/vision` gate or stopping condition fires (`skills/vision/SKILL.md` steps 6.6/6.7/8.6 and the "Stopping conditions" section), set `incomplete: true` and add `openQuestions[]` entries with `blockingCompose: true`, tagging each entry's `context` with the controlled gate token (see `GATE_TOKENS`) so the harness can map a block to its gate.
   - Write **no files**; output **only** the `plan.lock.json` object as raw JSON.
   - The run index `k` is an independence seed — produce an independent best plan each run.
2. **Grade in pure JS** (no agents, deterministic):
   - **L1 — contract validation** (`validatePlanLock`): JSON parses; `schemaVersion === 2`; all schema-required top-level keys present with correct types; `concerns[]` entries well-formed (`status ∈ {addressed, excluded}`, `addressed ⇒ evidence`, `excluded ⇒ reason`); `coverage[]`/`mustHaves[]`/`openQuestions[]` entries well-formed; `incomplete === (∃ openQuestion.blockingCompose)`. Two semantic checks apply **only to non-blocking runs** (`incomplete === false`): every `CONCERN_IDS` concern is decided, and every `mustHaves[].id` appears in `coverage[]` with ≥1 feature. (A correct *blocking* run is allowed an undecided concern or uncovered must-have — that is *why* it blocked; penalizing it there would invert the gate.)
   - **L2 — expectation assertions** (`gradeAgainstManifest`): per run vs the fixture manifest — (a) **verdict**: `incomplete === expect.expectIncomplete`; (b) **concerns**: per concern, `required ⇒ status addressed`, `excluded ⇒ status excluded`, `optional ⇒ decided either way`, `underivable ⇒ skipped` (fixture 10); (c) **must-haves**: `mustMapToFeature:true ⇒ covered by ≥1 feature`, `mustMapToFeature:false ⇒ NOT covered (no papering-over) and the run blocks`; empty `expect.mustHaves ⇒ the run invented none`; (d) **blocking** (when `expectIncomplete`): `incomplete:true` with ≥1 blocking openQuestion, and each expected `gate` has a matching blocking openQuestion by `GATE_TOKENS` pattern (per-gate hit/miss reported).
   - **L3 — stability** (`computeStability`, needs `k>=2`): **coverage-stability** = % of the ten concerns whose decided `status` is identical across all K runs; **verdict-stability** = do all K runs agree on `incomplete` (must be 100%); **content variance** = data-model entity count range and feature count range across runs — **measured, reported, never gated**.

### Phase 3 — Report (sequential, in-script)

Assemble a **per-fixture result table** and `log()` it: fixture, parsed/K, L1 pass/K, L2 pass/K, L2 per-concern + per-gate offenders, coverage-stability %, verdict-stability, entity/feature ranges, and a header line stating corpus scope (`--only`, `--k`) so a restricted run is never read as full coverage.

### Phase 3.5 — L4 evidence-quality judge (`4vj.3`, opt-in via `--judge`)

The one thing L1–L3 cannot mechanically check: is an `addressed` concern's evidence **falsifiable** (cites a feature/formula/tenet/gate/stack-pin) or rubber-stamped vagueness? This is the direct measure of the failure mode the whole coverage design fears, so it is an **LLM** layer — but built so the machinery around the LLM is pure-JS and unit-testable.

Runs only when `--judge` is passed (it is the **periodic** layer per the cost model, not per-commit). Steps:

1. **Collect (pure JS, in Stage B):** when `--judge` is on, each fixture's Stage B also runs `collectAddressedEvidence(parsedRuns)` → every `{slug, concernId, evidence}` where `status === 'addressed'`. Excluded concerns carry a `reason`, not evidence, and are not judged.
2. **Dedupe (pure JS):** `dedupeEvidence` collapses identical `slug::concernId::evidence` tuples (carrying a `count`) so the panel never re-judges the same string across K runs. `--judge-sample N` then caps the deduped set deterministically (stable key-sort, take first N — no `Math.random`, which the runtime forbids).
3. **Panel fan-out (agents):** for each evidence item, spawn `--judge-panel` judges (default 3). Each judge sees **only** that one concern's evidence and the **"Evidence — what counts" bar embedded inline** (the `EVIDENCE_BAR` const — the judge runs headless and cannot read `docs/PLAN_CONCERNS.md`). Each returns `{ falsifiable: bool, reason }`.
4. **Majority + tally (pure JS):** `judgePanelMajority` reduces each panel to `vague` unless a **strict majority** call it falsifiable (tie → vague). `tallyVagueness` rolls the items into `vaguenessRate` = fraction judged vague, plus a `perConcern` breakdown for the offender log.
5. **Feed the scorecard:** the resulting `vaguenessRate` is passed to `buildScorecard(rows, scope, vaguenessRate)`, replacing the reserved `null`. With `--judge` off it stays `null` and the ratchet's `vaguenessRate` check is a quiet skip.

`vaguenessRate` is an **"above" metric**: the ratchet (Phase 4) flags it as a regression when `current > baseline + tol.vague` (default `0.1`) — vagueness getting *worse* is the regression. The collection/dedupe/majority/tally functions and the `vaguenessRate` plumbing are exercised by `--selftest` with an **injected synthetic judge** (no agents), including the acceptance check that a deliberately vague string (`"we handle auth"`) is flagged.

### Phase 3.6 — L5 downstream propagation (`4vj.5`, opt-in via `--propagate`)

The end-to-end question L1–L4 cannot answer from the lock alone: when a BLESSED plan flows downstream, does `/decompose`'s `bfo.9` forward-coverage gate actually catch a **lying concern** — an `addressed` concern that cites a feature no bead implements — *at the plan gate*, before it can leak to the build gate? This is the most expensive, least frequent tier (it spends a full `/decompose` derivation per sampled lock), so it is opt-in and **report-only**.

Steps:

1. **Stash BLESSED locks (pure JS, in Stage B):** when `--propagate` is on, each fixture's Stage B keeps the first run whose lock is L1-valid **and** complete (`incomplete === false`) as `row.blessedLock` — only a genuinely blessable plan is worth propagating.
2. **Sample:** take the first `--propagate-sample` (default 1) BLESSED locks across fixtures. If none blessed, log it and skip (nothing to propagate — not a failure).
3. **Decompose dry-run (agent, 1 per sampled lock):** an agent executes the `/decompose` Phases 2–3 procedure **headlessly in `--dry-run`** over the inlined lock — deriving the bead DAG (one bead per `featureOrder[]` slice, each carrying a `feature:<name>` mapping) **without creating beads or writing files**. It returns `{ beads: [{title, feature, formula}], decomposeOk, error }`.
4. **Independent re-check (pure JS):** `checkPropagation(lock, beads)` re-asserts the `bfo.9` invariant *independently of the agent's own `decomposeOk`*: every addressed concern whose evidence cites a `featureOrder[]` name (via `citedFeature`) must map to ≥1 bead carrying that `feature:<name>` (`beadFeatures`); every must-have must map (through `coverage[].features`) to ≥1 bead. Evidence citing only a tenet/gate/stack-pin is **exempt** (cites no feature → nothing to trace, matching `bfo.9`). It returns the specific `concernLeaks` / `mustHaveLeaks` and a `leakageRate`.
5. **Report (log):** per sampled plan — bead count, concern-leaks, must-have-leaks, leakage rate, and the agent's `decomposeOk`. Each leak names the lying concern and the feature with no bead. **Report-only:** L5 never throws and never gates CI.

The collection/`citedFeature`/`beadFeatures`/`checkPropagation` machinery is pure JS, exercised by `--selftest` with a synthetic DAG — including the `4vj.5` acceptance check that **a deliberately lying concern (a feature cited with no implementing bead) is caught** and reported as a leak.

> **Scope note (loud, per T7).** The bead's acceptance also lists a `→ build-batch` leg ("and one → build-batch … nothing that should have blocked at the plan gate leaks to the build gate"). That leg is **deliberately deferred**, for two concrete reasons: (a) the corpus fixtures are vision-only (`vision.md` + `expect.json`) — there is no buildable app repo for `/build-batch` to operate on without first materializing a real poured repo per fixture; and (b) a live `/build-batch` run costs far more than even this "rare" tier budgets. The **load-bearing assertion is fully covered without it**: "a lying concern is caught at decompose, not at build" is proven by the decompose-side check plus the structural fact that a leak caught at the plan gate never reaches the build gate. Wiring a real `/decompose` (non-dry-run) + `/build-batch` over a materialized sample repo is a future extension; it is not required for the propagation invariant L5 measures.

### Phase 4 — Scorecard + baseline ratchet (`4vj.4`)

Rolls the rows into a **scorecard** and diffs it against the blessed baseline. Mirrors the jankurai regression-only ratchet in `hooks/post-build-gate.sh` (regression-only; missing/unblessed baseline = quiet SKIP; deliberate-commit-only bump).

1. **Read baseline** (1 agent): reads `--baseline` (`agent/baselines/vision-eval.json`); returns `{found, baseline}` or `{found:false}`. (Agents, not the sandbox, touch the filesystem.)
2. **Build scorecard** (`buildScorecard`, pure JS): per-fixture `{l1PassRate, l2PassRate, coverageStabilityPct, verdictStable}` + an `aggregate` of `l1PassRate`, `l2PassRate`, `meanCoverageStabilityPct`, `verdictStabilityPct`, and `vaguenessRate` (`null` until L4/`4vj.3`).
3. **Compare** (`compareToBaseline`, pure JS): regression-only. "Below" metrics (the four pass-rate/stability ones) regress when `current < baseline − tol`; the lone "above" metric `vaguenessRate` regresses when `current > baseline + tol`. Returns `status: 'pass' | 'block' | 'skip'`. **`skip`** when the baseline is missing or `blessed !== true`.
4. **Write** (1 agent): `--update-baseline` writes the fresh scorecard to `--baseline` with `blessed:true` (the deliberate bump — review + commit separately); otherwise writes a non-blessed copy to `target/vision-eval/scorecard.latest.json` (untracked, for inspection + the CI ratchet runner).
5. **Gate:** a `block` **throws**, failing the workflow run (the "exit non-zero" CI hook) — *unless* `--no-gate` or `--update-baseline`. A `skip` never gates.

**Baseline file + bless discipline.** `agent/baselines/vision-eval.json` ships as a **seed with `blessed:false`** (ratchet is report-only until blessed — like a missing jankurai baseline). To bless: run the full corpus at a representative `--k` with `--update-baseline`, review the emitted numbers, and commit the rewritten file in a **dedicated commit**. The numbers are inherently noisy (`/vision` is an LLM), so the ratchet is tolerance-banded, not exact-match.

**CI exit codes without agents.** `node tests/vision-eval/ratchet.mjs <scorecard.json> [--baseline <path>]` reuses the same `compareToBaseline` and exits `0=PASS / 1=BLOCK / 2=SKIP` (jankurai convention). CI flow: run the workflow to produce `target/vision-eval/scorecard.latest.json`, then run the ratchet for the process exit code (the workflow's own throw is the in-band gate; this is the out-of-band one).

## Sync rules

- **`spec ↔ js`** — edit both in the same commit (house rule).
- **`CONCERN_IDS` ↔ `docs/PLAN_CONCERNS.md`** — the ten concern ids are inlined as a JS const (mirroring `vision.js`). When the vocabulary changes, update both.
- **L1 structural checks ↔ `schemas/plan.lock.schema.json`** — the workflow sandbox cannot read files, so L1 hand-codes the schema's hard constraints rather than loading the schema. When the plan.lock schema changes, update `validatePlanLock` in the same commit. (Same documented-sync discipline the repo uses elsewhere instead of runtime SSOT loading.)
- **`GATE_TOKENS` ↔ `skills/vision/SKILL.md` gates** — the controlled context vocabulary the run agent tags blocks with, and the patterns L2 matches. When a gate's wording changes, keep the token stable.
- **`EVIDENCE_BAR` ↔ `docs/PLAN_CONCERNS.md` §"Evidence — what counts"** — the L4 judge runs headless and cannot read the doc, so the falsifiability bar (the five valid anchors + the bare-assertion-fails rule) is inlined as a JS const. When that section of `PLAN_CONCERNS.md` changes, update `EVIDENCE_BAR` in the same commit.
- **L5 `checkPropagation` ↔ `bfo.9` in `workflows/decompose.js` (Phase 6 verifier A)** — L5 is an *independent* re-implementation of the same forward-coverage invariant `/decompose` enforces (feature-cited addressed concern → ≥1 bead; tenet/gate/stack-pin exempt). That independence is the point (an oracle, not a mirror), but the *rule* must stay equivalent: when `bfo.9`'s notion of what counts as covered changes, update `checkPropagation` to match.
- **scorecard shape ↔ `agent/baselines/vision-eval.json`** — `buildScorecard` and the seed/baseline file share the `{schemaVersion, blessed, aggregate{...}, fixtures{...}}` shape; `tests/vision-eval/ratchet.mjs` reads it. Change the three together.

## Verification

- **Pure-JS checkers** are node-reachable: the script guards all `agent()` calls behind `typeof agent === 'function'`, uses no top-level `return`, and (in the node branch) publishes the checkers on `globalThis.__visionEval` — the workflow runtime forbids `export` other than `meta`, so a bridge replaces named exports. `--selftest` (and `node tests/vision-eval/selftest.mjs`, 34 checks) asserts: a schema-invalid lock fails L1; **a deliberately wrong manifest fails L2** (the `4vj.2` acceptance check); the adversarial branches (papering-over, fabricated must-haves, gate-token match) behave; identical locks score 100% stability and a divergent one <100%; the scorecard aggregates correctly; the ratchet SKIPs an unblessed baseline, PASSes an unchanged corpus, and **BLOCKs an injected regression** (the `4vj.4` acceptance check); for **L4** (`4vj.3`): `collectAddressedEvidence` skips excluded concerns, `dedupeEvidence` collapses repeats, the panel majority + even-split-→-vague rule holds, **a deliberately vague `"we handle auth"` string is flagged by the panel** (the `4vj.3` acceptance check, via an injected synthetic judge), `tallyVagueness` computes the rate, and the ratchet gates `vaguenessRate`; and for **L5** (`4vj.5`): `citedFeature` resolves/exempts evidence, `beadFeatures` parses both shapes, a complete DAG has no leaks, and **a deliberately lying concern — a feature cited with no implementing bead — is caught and reported** (the `4vj.5` acceptance check, via a synthetic DAG).
- **CI ratchet runner:** `node tests/vision-eval/ratchet.mjs <scorecard.json> [--baseline <path>]` exits `0/1/2` for PASS/BLOCK/SKIP.
- **Live smoke:** `--only 01-multitenant-saas-web --k 1` runs one real `/vision` pass end-to-end and emits a one-row table (the expensive path; opt-in). `4vj.2`'s smoke (`--only 01,08,10 --k 1`) confirmed L1 3/3 valid and L2 discriminating (01+10 matched the oracle, 08 flagged a real `authz` divergence).
- **L4 live smoke:** `--only 01-multitenant-saas-web --k 1 --judge --judge-panel 3` runs the real panel over one fixture's addressed evidence and emits a `vaguenessRate` + a vague-by-concern breakdown — the live counterpart to the injected-judge selftest (the well-formed fixture-01 evidence should score a low rate; the panel's flagging behavior on a bare assertion is what the selftest pins deterministically).
- **L5 live smoke:** `--only 01-multitenant-saas-web --k 1 --propagate` runs one BLESSED fixture-01 lock through a real `/decompose --dry-run` and emits the leakage report — the live counterpart to the synthetic-DAG selftest (fixture-01 is well-formed, so it should report zero leaks; the lying-concern detection is what the selftest pins deterministically).
