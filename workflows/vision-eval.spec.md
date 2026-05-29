---
name: vision-eval
description: Scale harness that grades /vision output against a hand-authored oracle corpus. Runs each fixture's vision.md through /vision K times, then scores the resulting plan.lock.json with three mechanical (pure-JS, no-LLM) layers — L1 contract validation, L2 expectation assertions vs the per-fixture manifest, L3 K-run stability — and emits a per-fixture result table. Turns "are our plans deterministic / in line with expectations?" from a vibe into numbers.
---

# vision-eval

The plan-determinism measurement stage, implemented as a **dynamic workflow** (see https://code.claude.com/docs/en/workflows). It grades the `/vision` stage against the oracle corpus in `tests/vision-eval/` (epic `autonomous-build-4vj`; corpus + manifests are `4vj.1`, already landed). This spec covers `4vj.2` — the **L1–L3 mechanical layers**. L4 (evidence-quality judge fan-out, `4vj.3`), the scorecard + baseline ratchet (`4vj.4`), and L5 (downstream propagation, `4vj.5`) are separate, later beads and are **out of scope here** — but the phase structure leaves room for them.

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
| `--selftest` | false | Run the pure-JS checker unit tests against embedded synthetic locks (NO agents, free) and stop. Used for CI of the harness logic itself. |

### Cost model (read before wiring to CI)

The mechanical layers L1–L3 are cheap (pure JS). The **cost is the inputs**: each run is a full `/vision` planning pass (a heavy agent), so a full corpus run is `fixtures × k` heavy agents (10 × 5 = 50 by default). "L1–L3 every commit" therefore means *the grading is cheap*, not *the run is free*. Practical tiering:

- **Per-commit CI:** `--k 1` over the full corpus (L1 + L2 + verdict; no stability) — 10 agents.
- **Nightly / pre-release:** `--k 5` (adds L3 stability) — 50 agents.

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

Assemble a **per-fixture result table** and `log()` it: fixture, parsed/K, L1 pass/K, L2 pass/K, L2 per-concern + per-gate offenders, coverage-stability %, verdict-stability, entity/feature ranges, and a header line stating corpus scope (`--only`, `--k`) so a restricted run is never read as full coverage. The scorecard artifact + baseline ratchet is `4vj.4`; this phase only emits the table.

## Sync rules

- **`spec ↔ js`** — edit both in the same commit (house rule).
- **`CONCERN_IDS` ↔ `docs/PLAN_CONCERNS.md`** — the ten concern ids are inlined as a JS const (mirroring `vision.js`). When the vocabulary changes, update both.
- **L1 structural checks ↔ `schemas/plan.lock.schema.json`** — the workflow sandbox cannot read files, so L1 hand-codes the schema's hard constraints rather than loading the schema. When the plan.lock schema changes, update `validatePlanLock` in the same commit. (Same documented-sync discipline the repo uses elsewhere instead of runtime SSOT loading.)
- **`GATE_TOKENS` ↔ `skills/vision/SKILL.md` gates** — the controlled context vocabulary the run agent tags blocks with, and the patterns L2 matches. When a gate's wording changes, keep the token stable.

## Verification

- **Pure-JS checkers** are exported and node-importable (the script guards all `agent()` calls behind `typeof agent === 'function'` and uses no top-level `return`). `--selftest` (and `node tests/vision-eval/selftest.mjs`) runs them against embedded synthetic locks and asserts: a schema-invalid lock fails L1; a lock whose concern decisions contradict a manifest fails L2; **a deliberately wrong manifest fails L2** (the acceptance check); identical locks score 100% stability and a divergent one scores <100%.
- **Live smoke:** `--only 01-multitenant-saas-web --k 1` runs one real `/vision` pass end-to-end and emits a one-row table (the expensive path; opt-in).
