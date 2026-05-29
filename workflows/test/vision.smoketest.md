# `/vision` smoke test (bead autonomous-build-ih5.6)

Records the end-to-end smoke for the hybrid `/vision` (thin skill shell + `workflows/vision.js` engine).

## 1. Install hardlink — PASS

Both installers glob `workflows/*.js`, so `vision.js` is picked up automatically — **no explicit add needed**:

- `install.sh`: `js=("$WORKFLOWS_SRC"/*.js)` → `link workflow "$name" ...` for each.
- `install.ps1`: `Get-ChildItem $workflowsSrc -File -Filter '*.js'` → `Link-HardLink 'workflow' ...` for each.

Verified `workflows/vision.js` is in the glob set alongside `build-batch.js`, `decompose.js`, `retro.js`, `vision-eval.js`. After `./install.sh` (or `./install.ps1`) the runtime resolves `Workflow(name:"vision")` user-globally from any app repo.

## 2. Engine Verify path — PASS (`node tests/vision/selftest.mjs`, 61/61)

The spec (`workflows/vision.spec.md`) designates the pure-JS `--selftest` as the agent-free Verify mechanism: it "exercises the whole Verify path (complete → COMPLETE+valid; required+excluded → NEEDS-INPUT+incomplete:true) without spending an agent." All 61 checks pass. The AC-load-bearing ones:

- **Complete plan → COMPLETE + schema-valid v2 lock** — `Phase4 VERIFY: a fully-decided plan validates as a COMPLETE v2 lock`.
- **`concerns[]` complete** — `Phase4 reconcile folds in excluded-by-default concerns -> all 10 decided`.
- **`coverage[]` built for every must-have** — `Phase4 builds coverage for every must-have (forward-coverage clean)`.
- **plan.md + tenets.md rendered (T1–T10 inherited)** — `Phase4 renders non-empty plan.md + tenets.md (tenets inherit T1..T10)`.
- **Incomplete plan → NEEDS-INPUT + `incomplete:true`** — `Phase4 VERIFY: a required+excluded concern returns NEEDS-INPUT (incomplete:true) and a valid lock`.
- **Gate tokens fire correctly** — `required-excluded-contradiction`, `concern-decidedness`, `forward-coverage`, `musthave-nongoal` all asserted; decide-only concerns (`external-integrations`) correctly NOT flagged as contradictions; no false-fire when no must-have requires a non-goal.
- **Schema strictness** — `validateLock rejects a disallowed additionalProperty` and `rejects a stack key outside the enum`.

This proves the deterministic engine produces a schema-valid `plan.lock.json` v2 (with `coverage[]` + `concerns[]`) + `plan.md` + `tenets.md` on a complete plan, and a NEEDS-INPUT (`incomplete:true`) verdict on an incomplete one — the AC's smoke assertions, deterministically.

## 3. Live agent-driven run — graded by vision-eval

The live path — real `intake`/`skeleton`/`concern` agents over a filled `vision.md` in an app repo — is exercised and scored by the **`vision-eval`** harness (epic `autonomous-build-4vj`), which runs `vision.js` headlessly over a fixture corpus across K runs and grades L1 contract / L2 oracle / L3 stability / L4 evidence-vagueness / L5 propagation. That harness is the standing grader of the agent path; `/vision` is the producer and `vision-eval` the independent grader, sharing only the inlined `EVIDENCE_BAR` + `GATE_TOKENS`. A one-off live run is also available any time via `Workflow(name:"vision", args:"--vision <path> --no-file")` for inspection without writing.

## Verdict

Install ✅ · engine Verify path ✅ (61/61) · docs updated (README.md, docs/ARCHITECTURE.md) ✅. The hybrid `/vision` is wired and the gate behavior is verified.
