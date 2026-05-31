# Triage drain (2026-05-29)

Inbox size: 4 — promoted: 4, uncertain (left in inbox): 0. All four `triage`-labelled beads survived both verifier passes and were moved under drain epic `autonomous-build-jw9` (the `triage` label was dropped on promotion).

## Promoted

### autonomous-build-ebk
- **Title:** No first-class product-phase/milestone: cannot decompose/build a plan one phase at a time
- **From app:** smbuild
- **Now under epic:** autonomous-build-jw9
- **Verification:** evidence ✓, fix ✓
- **Acceptance:**

  A product-phasing primitive is plumbed through the three artifacts named in the proposal, verifiable by grep/file-exists on autonomous-build:

  1. SCHEMA — `schemas/plan.lock.schema.json` defines an optional phase/milestone field on `featureOrder[]` items (and/or on `mustHaves[]`): `grep -E '"(phase|milestone|tier)"' schemas/plan.lock.schema.json` returns a match, and `docs/PLAN_LOCK.md` documents it (a "### `phase`" / milestone field-reference heading is present).

  2. /decompose — `workflows/decompose.spec.md` documents a `--phase`/`--milestone` (or `--label`/`--epic`) scope option that restricts which `featureOrder[]` entries are poured: a new row in the Inputs/flags table (the `| \`--phase` table line) AND the Phase-3 pour text reference the field. The companion `workflows/decompose.js` references the flag/field name (`grep -nE 'phase|milestone' workflows/decompose.js` matches the new option).

  3. /build-batch — `workflows/build-batch.spec.md` documents a `--phase`/`--milestone`/`--label`/`--epic` subset filter applied to the `bd ready` candidate set in Phase 2.1, and `workflows/build-batch.js` references it, so a single phase builds incrementally instead of draining ALL ready non-epic beads (`grep -nE 'phase|milestone|--label|--epic' workflows/build-batch.spec.md workflows/build-batch.js` matches the new filter, not just existing internal "Phase N" headings).

  Each spec change is co-committed with its `.js` script (per CLAUDE.md kept-in-sync rule), and the new option is exercised by a workflow test under `workflows/test/`. Acceptance passes when all three greps match and the decompose/build-batch specs and their scripts agree on the option name.

### autonomous-build-ep2
- **Title:** vision.js workflow not linked into ~/.claude/workflows — /vision-as-skill fails in installed env
- **From app:** smbuild
- **Now under epic:** autonomous-build-jw9
- **Verification:** evidence ✓, fix ✓
- **Acceptance:**

  vision.js (and vision-eval.js) must be wired into the workflow-install path so /vision works as a Workflow in an installed env. Concrete, self-verifiable AC on files in autonomous-build:

  1. Both installers link every workflows/*.js (no per-file allowlist): `install.sh` globs `"$WORKFLOWS_SRC"/*.js` (currently lines 128-137) and `install.ps1` uses `Get-ChildItem $workflowsSrc -File -Filter '*.js'` (currently ~line 197). Verify with grep that these glob patterns are present and NOT a hardcoded list of {build-batch,decompose,retro}.js — they must remain glob-based so vision.js/vision-eval.js are picked up automatically. (This is ALREADY true today — the install scripts are correct; the live bug is operational, install was simply never re-run after vision.js landed ~2026-05-29.)

  2. The fix that the observation's "verify 'link vision.js' is in that migration's done-criteria" actually points to is a doc/test guard. Provable AC: add a regression assertion that `./install.sh --dry-run` lists `vision.js` (and `vision-eval.js`) under "workflows/ -> ~/.claude/workflows/" — i.e. its output contains a line matching `workflow .*vision\.js` (either `[ok]`, `[link]`, or `[dry] symlink ...vision.js`). Equivalently, a doc invariant: README.md / CLAUDE.md state that every workflows/*.js (explicitly naming vision and vision-eval) ships to ~/.claude/workflows/ on install — grep README.md for `vision-eval` in the workflows row (currently present at README.md line 48).

  Verification commands (run from repo root):
    grep -nE 'WORKFLOWS_SRC.*\*\.js|"\$WORKFLOWS_SRC"/\*\.js' install.sh        # glob present
    grep -nE "Get-ChildItem .*workflowsSrc .*-Filter '\*\.js'" install.ps1       # glob present
    ./install.sh --dry-run | grep -E 'workflow .*vision\.js'                     # vision.js covered

  Note: a file-exists check on ~/.claude/workflows/vision.js cannot serve as the AC because that path is outside the autonomous-build repo (it is per-machine install state, fixed by re-running ./install.sh, not by an in-repo edit). The durable in-repo guard is the glob + dry-run assertion above.

### autonomous-build-g63
- **Title:** vision gate 8.6 musthave-nongoal: substring check false-positives on a NEGATED must-have
- **From app:** smbuild
- **Now under epic:** autonomous-build-jw9
- **Verification:** evidence ✓, fix ✓
- **Acceptance:**

  FIX `musthaveNongoalConflicts()` in `/home/cstaulbee/.openclaw/workspace/autonomous-build/workflows/vision.js` (~L607-627) so a must-have that NEGATES a forbidden phrase no longer false-positives as a must-have/non-goal contradiction (gate 8.6).

  Concrete, self-verifiable acceptance:

  1. Code presence: In the must-have match loop (currently L616-622), the `m.text.toLowerCase().includes(phrase)` check (L618) must be guarded by the same negation-awareness already applied to the non-goal side at L613. Specifically: a match must be SKIPPED when the occurrence of `phrase` inside the must-have text is immediately preceded by a negator (no/not/never/without/don't/avoid/exclude(s/d)). Verify: `grep -n` in `workflows/vision.js` shows, inside `musthaveNongoalConflicts`, a regex/check applying the negator token set (`/\b(?:no|not|never|without|don'?t|avoid|exclude[ds]?)\b/`) to the must-have text around the phrase position — not only to the non-goal at L613.

  2. Behavioral / gate-pass: A unit-level or gate-level check proving the regression case no longer fires. Given mustHaves = [{ id: "M1", text: "Natural-language intake -> closed-grammar composition ... no free-form code generation" }] and nonGoals = ["Free-form / arbitrary code generation — closed-grammar only"], `musthaveNongoalConflicts(mustHaves, nonGoals)` MUST return an empty array (no conflict). The corresponding gate 8.6 must NOT emit a musthave-nongoal-contradiction openQuestion for this input. Equivalently, a test asserting `out.length === 0` for this fixture passes, while a genuine contradiction (must-have text "Generate free-form code at runtime" vs the same non-goal) still returns one conflict — confirming the fix narrows false positives without disabling real detection.

  NOTE: `workflows/vision.js` is under active ih5 migration; coordinate (meta-quiescence) before editing.

### autonomous-build-xp3
- **Title:** vision intake: consider surfacing prose-derived candidate must-haves before hard NEEDS-INPUT
- **From app:** smbuild
- **Now under epic:** autonomous-build-jw9
- **Verification:** evidence ✓, fix ✓
- **Acceptance:**

  In workflows/vision.js, the intake stage surfaces prose-derived candidate must-haves before hard NEEDS-INPUT, provable by file inspection: (1) the `intakePrompt` agent prompt (currently ~lines 920-933) instructs the intake agent that when load-bearing prose sections (§1 problem / §2 users) name candidate capabilities but the structured §3 must-haves is empty/placeholder, it must extract those named capabilities and return them under a `candidateMustHaves` array (and the intake output schema, ~lines 1046-1063, declares that key); and (2) the headless needs-input path (`buildNeedsInput`, ~lines 189-202, and/or `validateIntake` ~lines 207-229) includes those extracted candidates in the `missing-product-sections` openQuestion text so the human/shell can confirm them rather than re-typing. Verify: `grep -i "candidateMustHave" workflows/vision.js` returns matches in both the intake prompt and the needs-input/openQuestion construction, and the same candidate-surfacing behavior is documented in workflows/vision.spec.md Phase 1 (~lines 81-82). The repo's existing gate (`node workflows/vision.js --selftest`) still passes. Today none of these strings exist (`grep -ri "candidateMustHave" workflows/` is empty), so the AC reduces to: those instruction/field/openQuestion additions are present in the two synced files and the selftest is green.

## Uncertain (stay in inbox)

None — all 4 inbox beads passed both verifier verdicts (evidence ✓ + fix ✓) and were promoted. No beads were left labelled `triage` for human triage.
