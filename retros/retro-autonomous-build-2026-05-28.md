# Retro: autonomous-build (2026-05-28)

**Window:** 2026-05-28 11:58 → 17:30 MDT  |  **Mode:** self (meta-retro)
**Tasks:** 35 closed, 0 blocked, 14 flagged (`workflow-improvement` label)
**Data sources:**
- app-beads (`.beads/issues.jsonl`) ✓
- app-git (`git log` in window, 35 commits) ✓
- meta-git (same; --self mode) ✓
- interactions (`.beads/interactions.jsonl`) — **skipped: 0 bytes, no writer in repo**
- jankurai (`target/jankurai/*.json`) — **skipped: directory empty**
- prior-retros (`retros/*.md`) — **skipped: this is the first retro**

## Headline

Day-one of the autonomous-build workflow repo. The loop scaffolded itself, then iterated on its own skills (`compose`, `build-next`) and gate (`post-build-gate.ps1`) live across 35 commits — landing 35 beads, zero reverts, and beginning the migration from turn-by-turn skills to dynamic workflows (`decompose`, `retro` spec, `build-batch` spec). The headline finding is that the heavily-iterated files (`compose` and `build-next` SKILL.md, each edited 9 times today) grew by accretion rather than from a structural spec — a pattern the in-flight workflow migration is already correcting. All six improvement signals passed adversarial cross-check and are filed under a single retro epic.

## What worked

- **Formula library batch (1zq.6.1 → 1zq.6.5):** auth, page, migration, background-job, integration-http — five formulas added in ~25 minutes, each one bead, each closed sequentially, zero reverts. Memory candidate: the per-formula "one bead, one file" sizing is the right shape for atomic pours.
- **Dynamic-workflow migration is self-aware:** `decompose.spec.md` + `decompose.js` (mvh.1.1, mvh.1.2) and `build-batch.spec.md` (mvh.2.1) landed in-window. The retro skill itself was converted from a turn-by-turn SKILL.md to a workflow spec mid-window (commit 94e076f) — the workflow is actively shedding the patterns that caused today's churn.
- **TOML schema migration for formulas (ud0):** clean swap from YAML to bd-canonical TOML; the `.yaml` files were deleted in the same commit. No half-migration left behind.
- **Tenets system landed in one bead (yxn):** `docs/TENETS.md` + `templates/tenets.md` + /vision integration in one shot. Tenets work feeding directly into build-next read-tenets (2g0).
- **Vision "don't ask the user tech questions" (xmu):** validated user preference (already in auto-memory) is now codified in the skill.
- **Gate caught real work:** `hooks/post-build-gate.ps1` ran on every commit; no commits were reverted, suggesting the gate's checks held.

## What didn't (filed as improvements)

Each filed bead's verification line shows the two-verifier outcomes:

**Filed under epic `autonomous-build-or4` — Improvements from autonomous-build retro (2026-05-28).**

1. **`autonomous-build-or4.1` — compose: add Responsibilities header (Owns vs Delegates)** [P2]
   - Evidence: shas `cf6238d, 7854e36, cf6a930, f45fd5a, c52cd24, 4a771db, d4c152f, a778129, fd9245a` — 9 edits to `skills/compose/SKILL.md` in one day
   - Verification: evidence ✓, fix ✓ after rewrite (sharper AC pins section ordering)

2. **`autonomous-build-or4.2` — build-next: add Phases or Decision tree header before ## Process** [P2]
   - Evidence: shas `6fa41f3, 1d58591, fff0741, d0e1625, ad6553d, 9df5cb2, a778129, cb641dd, fd9245a` — 9 edits to `skills/build-next/SKILL.md`
   - Verification: evidence ✓, fix ✓ after rewrite (anchor must be placed before `## Process`)

3. **`autonomous-build-or4.3` — post-build-gate: add ordered '# Gate checks' header comment block** [P2]
   - Evidence: shas `fdedb1a, fff0741, a778129, fd9245a` — 4 edits to `hooks/post-build-gate.ps1`
   - Verification: evidence ✓, fix ✓ after rewrite (numbered `# 1.` lines, ≥5 entries)

4. **`autonomous-build-or4.4` — retro spec: document `claimed_at` fallback to `created_at` (bd 0.55.x)** [P1]
   - Evidence: `.beads/issues.jsonl` sample of 10 issues — none contain `claimed_at`; `workflows/retro.spec.md:52,67` reference it
   - Verification: evidence ✓, fix ✓ after rewrite (patches all three consumers: Phase 1 query, Phase 2 output shape, Phase 5 metrics table)

5. **`autonomous-build-or4.5` — docs/INSTALL.md: fix stale `gastownhall/beads` URL + bd troubleshoot** [P2]
   - Evidence: commit 94e076f says `(bd: pending -- bd.exe broken on host)`; `docs/INSTALL.md:7` + `README.md:3` point at stale `gastownhall/beads` URL; `.beads/README.md` (bd-bootstrap) points at `steveyegge/beads` — two upstream URLs disagree inside this repo
   - Verification: evidence ✓, fix ✓ after rewrite (URL correction + observable failure symptom)

6. **`autonomous-build-or4.6` — retro spec: mark `interactions.jsonl` as optional with empty-status fallback** [P3]
   - Evidence: `.beads/interactions.jsonl` is 0 bytes; no writer exists in `skills/`, `hooks/`, or `workflows/`; spec row 70 marks it as required without an empty fallback
   - Verification: evidence ✓, fix ✓ after rewrite (force path-a: mark optional and propagate empty-status to row 107 signal-tenet)

## Uncertain (human triage)

None of the six adversarially-verified signals fell into this bucket — all passed both checks. One additional observation surfaced during filing that is worth recording but did not go through Phase 4:

- **`workflows/retro.spec.md` references the wrong `bd create` flag.** The spec's Phase 5 file-beads step uses `--add-label` (line ≈193), but bd 0.55.3 `bd create --help` shows the flag is `--labels <comma-separated>`. `--add-label` is a `bd update` flag, not a `bd create` flag. This caused the first six file-bead invocations to error during this retro run; they succeeded on retry with `--labels`. Recommend a follow-on patch to `workflows/retro.spec.md` Phase 5 + a note about the asymmetry between `bd create --labels` and `bd update --add-label`. Did not file as a separate bead because it overlaps with `or4.4` (the broader "retro spec needs bd 0.55.x fixes" theme) — fold into that bead's scope or file as `or4.7` after human triage.

## Speed metrics

| Metric | Value |
| --- | --- |
| Wall time | 2026-05-28 11:58:35 → 17:01:11 MDT (≈5h 02m elapsed; one additional commit at 17:07 lands during retro itself) |
| Median task duration | **not computable** — bd 0.55.3 does not emit `claimed_at` (see filed improvement #4) |
| p90 task duration | **not computable** — same |
| Commits in window | 35 |
| Beads closed in window | 35 |
| Revert rate | 0% (0 reverts) |
| Post-close edit rate (substantive) | ~12% (≈4 of 35 beads had a follow-on touching a non-`.beads/issues.jsonl` file by another bead; the remaining ~109 raw "post-close edits" are `.beads/issues.jsonl` churn from every commit rewriting that file in-place) |
| Flag rate | 14 / 35 = 40% (label `workflow-improvement` treated as the flag category in the absence of a literal `workflow-issue` label) |
| Cross-check fileability rate | 6 / 6 = 100% |

## Data sources

- App beads DB: `.beads/dolt` (45 issues total; 35 closed in window; 10 open — `mvh` epic family for the skill→workflow migration)
- App git commits in window: 35
- autonomous-build edits in window: 53 unique files across 11 path categories (skills 9, formulas 10, hooks 1, docs 4, schemas 1, templates 1, workflows 4, root 5, beads-meta 16, other 2)
- Jankurai receipts: 0 (directory empty)
- Failed sources: `.beads/interactions.jsonl` (empty — no writer), `target/jankurai/*.json` (directory empty), `retros/*.md` (no prior retros)

## Notes & known data gaps

- `claimed_at` is absent from bd 0.55.3's JSONL emission → duration/p90 metrics not available this run; filed as improvement #4 with a `created_at`-based fallback.
- The "bd.exe broken on host" note in commit 94e076f references a separate session — bd worked fine for create/close during this retro run.
- The 113 raw "post-close edits" from the git collector are dominated by `.beads/issues.jsonl` rewrites (every bd state change rewrites the file). True post-close edits on workflow files (SKILL.md / formula / hook) are ~4, not 113. The filed `compose`/`build-next` churn beads address the real signal; the headline number is filtered for substance.
