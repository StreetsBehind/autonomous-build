# Proposal: Tier the Jankurai gate (ratchet on commit, score floor on push)

**Status:** Decisions locked (2 review rounds, 7 agents) — implementation-ready MVP spec below; supersedes lbq.14
**Date:** 2026-05-28
**Author:** workflow investigation (Sally + Claude)
**Related:** `retros/critique-pipeline-intent-2026-05-28.md` (independently flagged this gap), `docs/PLAN_CONCERNS.md`

---

## Problem in one line

We hold every app to the Jankurai standard, but **none of our Jankurai integration points can block during the unattended build window** — the audit is advisory-only and the regression ratchet ships disabled. We have no enforced minimum-quality criterion for commit or push.

## What Jankurai is (capabilities + intents)

Jankurai (CLI `1.5.1`, standard `0.9.0`, schema `1.9.0`) is an "anti-vibe-coding" standard plus a local audit CLI that turns "did the agent do the right thing?" into auditable receipts. Its ~40 commands fall into four intents:

| Intent | Representative commands | Purpose |
|---|---|---|
| **Bound the work** (planning) | `kickoff`, `context-pack`, `adopt`, `init`, `proof`/`prove`, `repair-plan` | Name read-first files, ownership boundaries, forbidden paths, and the proof lane a change must satisfy — *before* coding |
| **Score the work** (audit) | `audit`, `diff-audit`, `score`, `conformance`, `rules`, `explain`, `history` | Weighted-dimension score (0–100), conformance level (HL1/2/3), hard findings + caps |
| **Gate the work** (enforcement) | `witness`, `govern`, `ci install`, `hooks install`, `guard`, `certify` | Regression ratchet vs baseline, absolute score floor, git hooks, CI scaffolds, live FUSE/watcher guard |
| **Fix the work** | `repair`, `optimize`, `agent`, `migrate`, `security`, `ux`, `exceptions`, `postmortem` | Agent-fix queue, targeted repair lanes |

### How Jankurai advises gating itself

The tool ships its own opinion — we do not have to invent thresholds.

`jankurai govern` emits the recommended policy:

```
minimum score:    85
fail on:          critical, high
advisory on:      medium, low
exception timebox: 90 days
```

`jankurai ci install` exposes a **staged adoption ladder** with `--min-score` defaulting to **85**:

```
--mode observe | advisory | ratchet     --min-score 85
```

And there is a purpose-built pre-push command we do not currently use:

> **`jankurai diff-audit`** — "Fast pre-PR / pre-push audit scoped to the diff vs a base ref. Composes `proof` (lane routing) + `audit` (changed-fast scoring) and fails on hard findings or new caps."

The scoring model is weighted dimensions (ownership/navigation, contract & boundary integrity, proof lanes, security posture, code shape, data truth, observability, context economy), each scored 0–100 with a weight, rolled into a single score; plus hard findings, caps, and a conformance decision (`pass` / `block`). The receipt also carries a `ratchet` block (baseline_score, allowed_drop, score_delta, new_caps, new_hard_findings) — this is the regression mechanism.

## Where we use it today, and the gap

Three integration points, **none enforcing during the autonomous window**:

1. **`hooks/post-build-gate.{sh,ps1}` runs `audit --changed-fast` advisory-only.** It prints findings and always passes. We never pass `--fail-under` or `--fail-on`, although both flags exist.
2. **`witness` (the regression ratchet) only fires if `agent/baselines/main.repo-score.json` exists** — and it ships effectively empty (`score: 0`, zeroed fingerprints). The single hard-fail path is disabled exactly when no human is watching.
3. **We never call `diff-audit`** — the command literally built for "pre-push, fail on hard findings + sub-floor score."

Evidence: an on-disk receipt in this repo scored **44/100, status `fail`, 2 hard findings, conformance `block`** — and the gate let it through, because advisory.

The `retros/critique-pipeline-intent-2026-05-28.md` retro reached the same conclusion independently: *"Jankurai — the marquee enterprise enforcer — is advisory by default … zero blocking power during exactly the unattended window."*

## Decision (calibrated with the human)

The human's original calibration was: **per-commit posture = ratchet** (no absolute floor on commit), **absolute 85 floor enforced at pre-push/PR**. A four-agent review (below) showed the *mechanism* chosen to implement that calibration is largely unworkable against `jankurai 1.5.1`. The **intent** survives; the **design has been revised** (see "Revised design"). The original plan is preserved struck-through below for the record.

## ~~Original implementation plan (SUPERSEDED — see review)~~

> ⚠️ **This plan does not work as written.** Retained for traceability. Jump to **Revised design**.

- ~~**1. Populate a real baseline at `/decompose`** and auto-accept it as `agent/baselines/main.repo-score.json`.~~
- ~~**2. Per-commit gate = ratchet:** make the existing `witness` step live; add `--fail-on critical,high` backstop.~~
- ~~**3. Pre-push floor = `jankurai diff-audit --base-ref origin/main --fail-under 85`** in a new git pre-push hook.~~
- ~~**4. Doctrine + invariants:** update AGENTS.md / README.~~

---

## Review verdict (2026-05-28, four agents)

Four reviewers (Jankurai-doctrine fidelity, pipeline-integration correctness, deadlock/failure-modes, design-altitude) read the draft and exercised the real CLI. Consensus: **the gap diagnosis is correct and well-evidenced; the keystone instinct (real baseline + live enforcement) is right; but the specific command bindings are wrong on nearly every count, and the pre-push tier is dead code.** Verdict: **rethink the mechanism, ship the MVP keystone only.**

### Confirmed-fatal defects (empirically verified against `jankurai 1.5.1`)

1. **`witness` is NOT a pure delta-ratchet — it embeds the absolute 85 floor.** A reviewer accepted the current tree as baseline, then ran `witness` against the *identical* tree (`score_delta: 0`, `changed_paths: 0`) → it still returned `decision: block`, driven by carried `"…scored N below the standard floor of 85"` findings. ⇒ Making `witness` live on a sub-85 baseline **blocks every commit of every app until it is nearly complete** — a guaranteed unattended deadlock, not an edge case. The original "ratchet, no floor on commit" keystone is **false against this CLI**.
2. **`diff-audit --fail-under 85` is unrunnable.** `diff-audit` has no `--fail-under` flag → `exit 2` (arg-parse failure, the command never runs). `diff-audit` enforces **no score floor at all**; it fails *only* on hard findings or new caps. The score floor lives on `audit`/`score --fail-under` and `ci install --min-score`.
3. **`hooks install` / `guard install` write a *pre-commit* hook, not pre-push** (+ `prepare-commit-msg`). And the managed pre-commit hook is itself **advisory** (`audit --mode advisory`, never `exit 1` on a fail decision). The draft's "Jankurai scaffolds the pre-push hook for us" is false; a pre-push hook must be hand-authored.
4. **The pre-push floor is altitude-inverted dead code.** The pipeline never pushes during the unattended window, so the hook never fires when it matters; worse, `diff-audit --base-ref origin/main` against a never-pushed repo prints `"no changes vs main — nothing to audit"` and **exits 0** — the floor silently evaporates (fails *open*).
5. **The `--fail-on critical,high` backstop wedges the first commit and meta mode.** It fires on *any* critical/high (not just new), so on a repo that legitimately starts with hard findings (this repo's own receipt: 44/100, 2 hard) it blocks the first commit before any baseline exists, and would block autonomous-build's *own* meta-mode loop (which has no baseline by design).

### Other confirmed corrections
- **Score floor knob** = `audit … --fail-under 85 --fail-on critical,high` (standard mode already exits 1 on a fail decision; the current gate is advisory partly because the wrapper swallows the exit code and/or uses `--mode advisory`). `--mode`, not just the flags, is the real advisory switch.
- **Receipt field-name trap:** the *audit* receipt's `decision.ratchet` uses `new_caps` / `new_hard_findings`; the *witness* receipt uses `caps_added` / `new_findings` with top-level `current_score`/`baseline_score`/`score_delta` and `conformance_decision: ratchet_fail`. Code that parses one by the other's names silently misses everything.
- **`allowed_drop: 0` + scope variance** → a 1-point noise wobble across differing `--changed-fast` scopes can block a good commit. Wants a small tolerance and a *resolvable, pinned* base ref (merge-base / baseline sha), never the possibly-absent `origin/main`.
- **Pre-push hook belongs in `/decompose`, not `build-batch`** — build-batch refuses meta mode and is only one of two drivers (the serial `/loop /build-next` path never calls it) and is per-wave re-entrant. Decompose Phase 2 already owns one-time git-hook scaffolding (`bd hooks install`).
- **Distribution/`.gitignore` gaps:** `install.{sh,ps1}` do not link `hooks/` at all (the gate is resolved at runtime), so there is *no existing path to ship a git hook* — decompose must author it inline. New tracked files under `agent/` need `.gitignore` care (today `target/` isn't even ignored in this repo).
- **jankurai crash vs absence:** the gate degrades gracefully on `has_cmd` *absence*, but a jankurai *crash / schema-version skew* under the new hard-fail paths would block a commit indistinguishably from a real quality fail. Block only on a *valid receipt judged block*, SKIP-with-warning otherwise.
- **Auto-accepting a low baseline violates the README's "tracked, **trusted**" baseline contract** and the staged-adoption story ("accept a baseline once the first few tasks close cleanly"). It should ride the **existing human BLESSED gate** in decompose, not be auto-stamped.
- Minor: the standard has **11** scoring dimensions, not the 8 listed; the capabilities table omitted three.

---

## Revised design (post-review)

**Ship the keystone only. Cut the pre-push tier and the flat-85 floor for v1.** Re-evaluate a floor after the ratchet has run on a real app.

### MVP (high value, lowest surface)
1. **Make Jankurai blocking via a true regression-only ratchet — parsed from the receipt, not `witness`'s exit code.** In both gate ports, after the advisory `audit --changed-fast` run, read the audit receipt's `decision.ratchet` block and hard-fail the commit iff `score_delta < -allowed_drop` **OR** `new_hard_findings > 0` **OR** `new_caps > 0`. This expresses "never make it worse / never add a critical-high" *without* importing the absolute 85 floor that wedges `witness`. (Upstream alternative: request a `witness --mode ratchet` flag.)
2. **Capture the initial audit at decompose and surface it at the existing human BLESSED gate** — the human blesses (or rejects) the starting baseline in the same action that already gates the DAG. No auto-accept; baseline stays a trusted artifact. Write `agent/audit-policy.toml` from `jankurai govern` (tracked) and pass it via `--policy` so it's *enforced*, not just present.
3. **`--fail-on critical,high` only for *new* findings**, folded into the ratchet (step 1), gated on baseline presence so it never fires pre-baseline or in meta mode (fail-open when no baseline — there's nothing to regress against yet).
4. **Guards:** distinguish jankurai-crash from jankurai-judged-block (receipt validity, not just exit code); pin the comparison to a resolvable local base ref; give `allowed_drop` a small tolerance (2–3) to absorb scope noise.
5. **Doctrine:** update `AGENTS.md` invariants + `README.md` quality table to state the ratchet rule and preserve the meta-mode exemption (`AGENTS.md` "Jankurai governs the outputs, not the meta-infrastructure").

### Deferred (revisit with evidence)
- **Absolute ≥85 floor.** If wanted later, (a) bind it to `audit --fail-under` (never `diff-audit`), and (b) place it where work actually integrates in the unattended window — **build-batch's merge-to-main step** (the option originally declined) — *not* a pre-push hook that never fires. Better still, derive the floor from the app's declared conformance level (HL2/HL3) instead of a flat 85.

### Files touched (MVP)
`hooks/post-build-gate.{sh,ps1}` (ratchet logic, kept in sync), `workflows/decompose.{js,spec.md}` (capture-baseline-at-bless + write policy + `.gitignore` for tracked `agent/`), `AGENTS.md`, `README.md`. Meta-mode → small bead DAG.

---

## 🔴 Urgent latent bug found during review round 2

The current on-disk spec (`decompose.spec.md:75`, `decompose.js:166` — the "lbq.14" change) **auto-stamps the sub-85 scaffold score as the witness baseline and commits it**, and `hooks/post-build-gate.{sh,ps1}` runs `jankurai witness --baseline …` via `run_step`, **hard-failing on its exit code**. Round 2 empirically proved `witness` bakes the absolute 85 floor into its decision (it blocked an *identical, zero-delta* tree). Therefore **the next real app build through this pipeline will deadlock**: every commit fails witness because a freshly-scaffolded app starts ~44, far below 85, with `ready>0` and no human-clearable cause. It is latent only because this meta-repo is never Jankurai-governed, so no baseline file exists *here*. lbq.14 fixed the "advisory-only" gap with the wrong primitive and converted a toothless gate into a wedged one. **The MVP below supersedes lbq.14 and is the fix; it should be treated as a bug fix, not an enhancement.**

---

## Decisions (made on the owner's behalf — 2026-05-28, after review round 2)

Round 2 (3 agents: mechanism-verification, decision-resolution, deadlock-recheck) verified the revised mechanism against `jankurai 1.5.1` and converged. Decisions:

- **D1 — Floor placement: ratchet-only in v1. No absolute floor anywhere.** A flat ≥85 floor is incoherent against a ~44 scaffold; a floor at build-batch's merge-to-main would leave the serial `/loop /build-next` path (a first-class driver, and the only meta-mode one) entirely ungated. The gate hook is the one contract both drivers share, so the ratchet lives there. The HL-level-derived floor is deferred until the ratchet has run on a real app.
- **D2 — Baseline trust: ride the human BLESSED gate for attended runs; auto-accept-with-loud-note for the walk-away path.** Move baseline acceptance to *after* the BLESSED verdict (not the unconditional Phase-2 capture lbq.14 does today). For `/orchestrate --auto-bless` (where no human reads the report), auto-accept the scaffold score as baseline **and** record a conspicuous "trusted-by-policy, not by human" note in the commit + report — because a never-accepted baseline means a ratchet that never fires, reopening the gap in exactly the unattended window. Plumb the `autoChain`/`--auto-bless` signal into decompose's baseline step.
- **D3 — Upstream ask: parse the audit receipt ourselves now; file `witness --mode ratchet` upstream as a non-blocking cleanup.** We don't control Jankurai's release cadence, the receipt is already on disk after the advisory audit, and parsing is low self-contained surface. If the upstream flag lands, we delete the parser.

## Final MVP spec (implementation-ready)

**Mechanism (verified):** in both gate ports, after the advisory `jankurai audit . --changed-fast --baseline <blessed-baseline.json> --json target/jankurai/audit-fast.json` run, **parse `audit-fast.json` → `decision.ratchet`** and:

```
r = receipt.decision.ratchet
BLOCK the commit iff
      r.score_delta < -TOLERANCE        # TOLERANCE = 2 (applied in our compare; allowed_drop is pinned at 0 by the CLI)
   OR len(r.new_hard_findings) > 0
   OR len(r.new_caps)         > 0
```

Hard rules learned in review (each is load-bearing):

1. **Parse the three fields, never `decision.passed` / `ratchet.passed`** — those booleans are floor-contaminated and reintroduce the witness deadlock. (Verified: a clean zero-delta sub-85 tree has `passed=false` but `score_delta=0, new_hard_findings=[], new_caps=[]`.)
2. **A `--baseline` must be passed** — without it the ratchet self-references (`baseline_score == score`, deltas always 0) and the gate is an inert no-op.
3. **Parse the `audit` receipt (`audit-fast.json`), not the `witness` receipt.** Field names differ (`new_caps`/`new_hard_findings` vs witness's `caps_added`/`new_findings`); parsing the wrong one silently passes everything. Stop calling `jankurai witness` for enforcement.
4. **`--changed-fast` audit always exits 0** regardless of pass/fail — so the decision *must* come from the parsed receipt, never the exit code.
5. **Crash-vs-block:** BLOCK only when the receipt exists, parses as JSON, and contains `decision.ratchet` with the numeric fields. Otherwise `SKIP: ratchet (receipt invalid — treated as crash, not block)` + loud warning. Assert `schema_version` and treat a skew as a SKIP, not a block.
6. **Baseline presence + mode (F6):** app-mode callers (build-next, build-batch — they already compute meta-vs-app) pass `GATE_REQUIRE_BASELINE=1`. Then "no baseline in app mode" is a **loud FAIL** (decompose bug); meta mode (signal unset) keeps the quiet SKIP and the ratchet never fires there — correct, Jankurai governs outputs not this repo.
7. **Advancing baseline / high-water mark (F2, F4):** a baseline frozen at decompose-time goes stale — after the app climbs to 80, a regression 80→70 still reads as +26 vs the frozen 44 and the ratchet dies. So on a **green** commit where the new whole-repo score exceeds `baseline_score`, the gate **re-stamps the baseline upward (one-way; never lowers it).** This keeps the trusted floor monotonic (human blessed the *starting* line; the machine only ratchets it up) and bounds cumulative drift to TOLERANCE against the high-water mark rather than `TOLERANCE × commits`. Gate-owned, app-mode only.
8. **Base ref:** pin `--changed-from` to a resolvable *local* ref (merge-base with pre-build HEAD, or the baseline commit sha) — **never `origin/main`**, which is absent in a never-pushed repo and makes the comparison fail open.
9. **`--policy` does not smuggle the floor back (F7):** writing `agent/audit-policy.toml` from `jankurai govern` is fine for tracking/documentation, but the gate's BLOCK decision reads only the three ratchet fields and ignores the floor verdict, so the 85 `minimum_score` in that policy never blocks in v1.

**Files touched (MVP):** `hooks/post-build-gate.{sh,ps1}` (replace the witness-exit-code block with the receipt-parse ratchet; keep both ports in sync), `workflows/decompose.{js,spec.md}` (move baseline acceptance after BLESSED + autoChain-aware auto-accept-with-note; `.gitignore` care for tracked `agent/`), `skills/build-next/SKILL.md` + `workflows/build-batch.js` (pass `GATE_REQUIRE_BASELINE=1` in app mode), `AGENTS.md` + `README.md` (doctrine: ratchet rule, supersede lbq.14, preserve meta-mode exemption).

**Deferred (revisit with evidence):** absolute / HL-derived floor; if ever wanted, bind it to `audit --fail-under` (never `diff-audit`) at the build-batch merge step, not a pre-push hook. Upstream `witness --mode ratchet` request.

## Suggested bead DAG

1. **(bug, blocks all app builds)** Replace witness-exit-code enforcement with the receipt-parse ratchet in both gate ports; supersede lbq.14. Rules 1–5, 8, 9.
2. Decompose baseline acceptance: move after BLESSED, autoChain-aware auto-accept-with-note (D2); high-water-mark re-stamp on green (rule 7). Depends on #1.
3. App-mode `GATE_REQUIRE_BASELINE=1` wiring + loud-fail-vs-skip (rule 6). Depends on #1.
4. Doctrine: AGENTS.md / README.md updates; file the upstream `witness --mode ratchet` request (D3).
