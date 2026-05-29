# Retro: smbuild (2026-05-28)

**Window:** 2026-05-28 (single `/decompose` run)  |  **Mode:** decompose-time (pre-build, not a finished build)
**Tasks:** n/a — this is a pre-build decomposition retro, not a build retro
**Data sources:** `/decompose` workflow result + logs (ok); smbuild `plan.lock.json` + `plan.md` (ok); smbuild `.beads` post-run (ok); `decomposeReport.md` (ok); `integration-http.formula.toml` (ok); autonomous-build `skills/`, `install.ps1`, `.beads` (ok)
**Filed under:** epic `autonomous-build-cnv` → anchor `autonomous-build-1zq` (Workflow improvements)

## Headline

`/decompose` was run against a fresh smbuild app repo. The first run failed at pre-flight because `bd formula list` cannot run without an openable beads DB, yet pre-flight invokes it before `bd init` — so the workflow could not pass pre-flight in *any* fresh repo. After a local fix (list against a throwaway empty DB) and wiring the project formulas into `~/.beads/formulas/`, the full 8-phase pipeline ran: 18 of 21 features poured (130 beads), no oversized beads, no cycles, traceability clean. The verdict was **NEEDS-FIX**, driven by a single root cause — `/vision` emitted the variable name `auth_scheme` for all five `integration-http` features, but the formula requires `auth_strategy` (a closed enum). Three pours failed honestly; two poured with off-enum values because their pour agents improvised the rename. Two further silent holes surfaced: quality scoring scored **zero** beads (the gate passed vacuously) and cross-dep wiring reported applying 24 edges while only 13 actually landed.

## What worked

- **The throwaway-DB pre-flight fix** resolved the fresh-repo blocker cleanly; the rerun passed pre-flight and parse with no further intervention.
- **Plan parsing** extracted all 21 features and 28 cross-feature dependencies from `plan.lock.json` (schema v1) with zero errors.
- **18 of 21 formula pours succeeded**, and **atomize correctly found 0 oversized beads** — the formulas produce well-sized atomic work.
- **Dependency topology is sound**: no cycles, ready-set non-empty.
- **Fidelity verifier B (dag→plan) came back clean** — all 44 sampled non-epic beads traced to a named feature; zero scope-drift candidates.

## What didn't (filed as improvements)

All evidence-grounded and cross-checked before filing. Two candidates were *corrected* during the check (see notes) rather than dropped.

- **autonomous-build-eyj** (P1) — decompose pre-flight check 6 is unrunnable in any fresh app repo [workflow-improvement, from-app:smbuild]
  - Evidence: first run NEEDS-FIX at pre-flight; `bd formula list` errors "no beads database found" before `bd init`.
  - Verification: reproduced. **Fix already applied locally** to `decompose.js` + `decompose.spec.md` (uncommitted) — bead tracks committing it.
- **autonomous-build-bje** (P1, **blocker**) — /vision does not validate variable bindings against the chosen formula's declared vars
  - Evidence: all 5 `integration-http` features bind `auth_scheme`; formula requires `auth_strategy` (enum). `auth_scheme` appears nowhere in `skills/`/`templates/`/`schemas/`, so `/vision` invented it. `skills/vision/SKILL.md:28` never says to validate against `bd formula show`.
  - Verification: plan.lock.json + formula TOML (`auth_strategy required=true`) + 3 pour errors.
- **autonomous-build-49u** (P1) — decompose quality phase scored zero beads (silent no-op; gate passes vacuously)
  - Evidence: log "Quality scoring done: 0 epics scored, 0 beads below 95" despite 18 pours / ~111 children. Phase 5 epic-discovery returned no epics with open children, so `all-beads-≥95` passed on an empty set.
  - Verification: workflow logs + live `bd list` (21 epics, children present).
- **autonomous-build-zip** (P2) — decompose cross-dep wiring reports success but under-applies edges
  - Evidence: wiring agent reported `applied=24`; fidelity found 13 present, 9 missing between poured molecule epics. Likely pourRoot-vs-molecule-epic ID mismatch; no post-add verification.
  - Verification: wiring agent log vs `decomposeReport.md` coverage section.
- **autonomous-build-l6g** (P2) — decompose pour agents improvise unknown variables instead of failing
  - Evidence: 2 of 5 pour agents renamed `auth_scheme`→`auth_strategy` keeping off-enum values; poured "successfully" with invalid auth. Violates T1 (do not guess).
  - Verification: `bd show smbuild-mol-hnz`/`-efc` show off-enum `auth_strategy` values.
- **autonomous-build-fun** (P2) — decompose agents cannot read decompose.spec.md (relative path resolves to app cwd)
  - Evidence: prompts cite `workflows/decompose.spec.md`, but agents run in the app cwd; the wire-cross-deps agent reported the spec "does not exist anywhere in the workspace" and fell back to `--help`.
  - Verification: wire-cross-deps agent log.
- **autonomous-build-43c** (P2) — provide a cross-platform installer (`install.sh`); `install.ps1` is Windows-only
  - Evidence: `install.ps1` already links `formulas/`→`~/.beads/formulas/` and `workflows/`→`~/.claude/workflows/`, but it is PowerShell and never ran on this Linux host, so formulas were unresolvable. **Note: this corrects an earlier mis-framing** ("formulas not on a search path") — the search-path wiring exists; only the Linux installer is missing.
  - Verification: `install.ps1` lines 49/177-182; `~/.beads/formulas/` was empty.
- **autonomous-build-kmk** (P2) — integration-http `auth_strategy` enum has no HTTP Basic option
  - Evidence: Twilio uses HTTP Basic (SID:token); enum is api-key/oauth-client-credentials/hmac-signed/none, forcing a lossy `api-key` mapping.
  - Verification: `formulas/integration-http.formula.toml` `[vars.auth_strategy]`.
- **autonomous-build-qo4** (P3) — decompose returns `reportPath: null` though `decomposeReport.md` was written
  - Evidence: final result `reportPath=null`; the 10,677-byte report exists on disk.
  - Verification: task result JSON vs file on disk.

## Uncertain (human triage — not filed)

- **Bead-count inconsistency.** `decomposeReport.md` says 130 beads (19 epics + 111 tasks); the workflow return says `beadCount: 111`; live `bd list --status=open` shows 50 (21 epics + 29 non-epic). The three sources disagree and the cause is not pinned (possible explanations: molecule-root epics counted differently, atomize/close churn, or `children[]` double-counting). Not filed because no concrete fix target is verifiable yet — needs investigation.

## Already tracked (not re-filed)

- `skills/vision/SKILL.md` still references the retired `/compose` (lines 28, 68). This is covered by existing bead **autonomous-build-fnr** ("Sweep stale /compose,/quality-pass,/split command references → /decompose"). Idempotency: not duplicated.

## Decompose run metrics

| Metric | Value |
| --- | --- |
| Features in plan | 21 |
| Features poured OK | 18 (86%) |
| Pours failed | 3 (all `integration-http`, `auth_strategy` unset) |
| Beads created (report) | 130 (19 epics + 111 tasks) |
| Oversized beads after atomize | 0 |
| Dep cycles | 0 |
| Cross-feature edges declared / present | 28 / 13 |
| Quality beads scored | 0 (no-op — see autonomous-build-49u) |
| Fidelity bin | coverage-gap (verifier A incomplete, verifier B clean) |
| Cross-check fileability rate | 9 filed / 10 candidates (1 → uncertain) |
| Verdict | NEEDS-FIX |

## Data sources

- smbuild `.beads` DB: `/home/cstaulbee/.openclaw/workspace/smbuild/.beads`
- smbuild plan: `plan.lock.json` (schemaVersion 1), `plan.md`
- Decompose report: `decomposeReport.md`
- Formula: `autonomous-build/formulas/integration-http.formula.toml`
- autonomous-build: `skills/vision/SKILL.md`, `install.ps1`, `workflows/decompose.js`+`.spec.md`
- Failed sources: none (this was a manual decompose-time retro, not the auto `/retro` workflow — see note below)

---

*Note: This retro was assembled manually (the `/retro` dynamic workflow is not yet installed — only `workflows/retro.spec.md` exists, no `retro.js`). It follows the retro spec's bead schema, label conventions, cross-check discipline, and report structure. The deeper findings here (quality no-op, cross-dep under-apply, enum gap) are not auto-detectable from app beads + git log, which is what the automated `/retro` keys off.*
