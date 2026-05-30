# Decompose: unified quality-rework loop + epic-ordering enforcement

**Status:** design — implementing (reframes `autonomous-build-l6z`).
**Motivation:** the 2026-05-30 smbuild build-now run. `/decompose` produced a
topologically-invalid DAG (feature beads `ready` before the app-skeleton epic), so
build-batch built a leaf feature first and the post-merge Jankurai ratchet correctly
rejected it (the first Rust compile flips repo-wide ops/CI caps that belong to the
skeleton). Root cause is two related gaps in the bead-creation process.

## The two gaps

1. **Topology under-specified.** Decompose wires only the cross-feature deps `/vision`
   explicitly declares (`plan.lock.featureOrder[].crossDeps`) plus intra-pour formula
   deps. It pours an always-present app-skeleton + production floor and *knows* which
   pours those are, but never makes feature pours depend on the foundational pours. So
   foundational and feature beads land in `bd ready` together and can build out of order.
   *(Verified: epics link to task beads by parent-child, NOT dependency edges, and bd
   computes readiness per-bead from that bead's own edges — so the ordering must be
   materialized as **bead-level** edges to actually gate.)*

2. **Quality scores but never reworks.** Flow is `pour → atomize → score → verdict`.
   - Atomize (the only phase that splits) runs *before* scoring and uses a *narrower*
     "sizing" rubric, so monoliths the full quality rubric flags (`<95`) are never split.
   - Phase 5 computes scores + `remediations` + `wouldReach95` but is **read-only**; the
     verdict just checks `allBeadsAt95` and bails to NEEDS-FIX. Nobody applies the fixes.
   - Dependency-graph correctness is *already* a `-10` quality penalty (decompose.js:648)
     but it's inert: it lowers the score and triggers no fix and no topology assertion.

## The fix — one closed rework-to-bar loop

Two layers, matching where the responsibility belongs.

### Layer 1 — `/vision` owns the epic order (source of truth)
Each `featureOrder[]` entry gains a **`tier`** and optional **`requires: [featureKey…]`**:
- `tier ∈ { foundational, platform, feature, enforcement }`.
- Foundational = app-skeleton-* + the mandatory production-floor formulas (observability,
  audit, IaC, auth) — vision already knows these (the `lbq.8` floor).
- `requires` captures any finer cross-feature ordering vision can determine.
This is authoritative; decompose consumes it. **Fallback:** when an entry has no `tier`
(e.g. a lock from old vision), decompose *derives* it from the pour formula's category, so
existing locks still order correctly. Derivation is also what makes the rule general — not
a hardcoded "skeleton-first".

### Layer 2 — `/decompose` reworks to the bar, epic by epic
Replace `Atomize(4) + Quality(5)` with a single **Quality-rework** phase:

```
wire cross-epic ordering edges (from tiers/requires; bead-level: entry beads of a
   dependent epic → terminal beads of each required epic)
for pass in 1..MAX_REWORK (3):
   score every open non-epic bead — FULL rubric, incl. the topology criterion
   if all scores ≥ 95 AND topology valid: break
   rework the sub-95 / mis-wired beads (parallel):
      • oversized/monolith  → split along a clean seam (the existing atomize-agent logic)
      • dep-graph mismatch / missing required edge → wire it
      • vague AC / missing files / missing testPlan / undefined domain → apply the
        bead's own `remediations` (tighten in place)
   (next pass re-scores the mutated set)
```
Splitting, dep-wiring, and AC-tightening become the *same* loop driven by the *same* 95
bar. Correct epic ordering falls out of the quality bar (a feature bead missing its
foundation edge is just a `-10` the loop fixes by adding the edge and re-scoring).

### Enforcement — three layers
1. **Generate** — the rework loop wires the cross-epic bead-level edges.
2. **Assert** — a pure-JS gate in Dep-audit (deterministic, not an LLM call): build the
   dependency graph and require
   - no cycles;
   - the initial `ready` set ⊆ foundational entry beads (nothing dispatchable jumps a tier);
   - every non-foundational bead transitively reaches the foundation via deps;
   - every vision-declared `requires`/tier edge is present as bead edges.
   Any violation → **NEEDS-FIX with the exact missing edges**. Folds into the `blessed`
   condition as `DepAuditResult.topologyValid`.
3. **Runtime backstop** — build-batch already won't dispatch a bead with open deps, so
   correct edges enforce order at build time too.

## Verdict integration (decompose.js:984)
`blessed` already requires `allBeadsAt95`; after this change the *workflow itself* makes
that reachable. Add `&& DepAuditResult.topologyValid` to the conjunction. Atomize's
separate `persistentlyOversized`/`unsplittable` accumulators are absorbed into the rework
loop's terminal state (a bead still `<95` after MAX_REWORK passes, with its blocking
reason, is the NEEDS-FIX signal).

## Apply to smbuild
After the workflow change lands and validates: re-run `/vision` (to stamp the epic tiers
into the lock) → `/decompose` → expect a BLESSED, topologically-ordered DAG → resume
`/build-batch`. (Decompose's tier *derivation* fallback means even the current lock would
order correctly, but re-vision makes the order authoritative.)
