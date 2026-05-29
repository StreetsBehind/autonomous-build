---
name: retro
description: Generate a workflow performance retro for an app the loop just finished (or is mid-build). Runs as a dynamic workflow — fans out independent analyzer agents per data source, cross-checks proposed workflow-improvement beads adversarially before filing, and writes a markdown report. Use when the user says "retro", "/retro", "review the workflow", "how did that go", or when /build-next exits with DONE.
---

# retro

The feedback loop's analysis stage, implemented as a **dynamic workflow** (see https://code.claude.com/docs/en/workflows). Turns raw evidence from a completed (or in-progress) build into a structured review of the workflow itself, plus filed improvement tasks — with each data source analyzed by an independent agent and every filed improvement adversarially cross-checked before it lands.

## How this spec runs

This file is a **workflow spec**, not a skill. The canonical script lives at `workflows/retro.js` in this repo (hand-authored from this spec per bead `autonomous-build-lbq.21`) and is linked to `~/.claude/workflows/retro.js` by the installers (`install.sh` symlink / `install.ps1` hardlink) so the runtime finds it user-globally from any app repo.

`retro.js` **already exists** and is the source of truth the runtime executes. Keep it in sync with this spec **in the same commit**, the same convention `decompose.js`/`build-batch.js` follow — when this spec changes meaningfully, edit `workflows/retro.js` to match (do not rely on first-run regeneration; the script is hand-maintained). `/retro` invokes the saved workflow directly.

**Why a workflow instead of a single-context skill:** independent data-source agents prevent cross-contamination, the adversarial cross-check pattern (two agents must agree before a workflow-improvement bead is filed) gives evidence-grounded findings, intermediate per-source JSON stays in script variables instead of bloating Claude's context, and the run is resumable in-session if a phase hits a transient failure.

---

## Inputs

The workflow accepts these arguments (parsed from the `/retro` invocation; all optional):

| Arg | Default | Meaning |
| --- | --- | --- |
| `--app-path <path>` | cwd | App repo to analyze. Must be `bd init`'d. |
| `--since <YYYY-MM-DD>` | first claim in the window | Start of the analysis window. |
| `--until <YYYY-MM-DD>` | now | End of the window. |
| `--meta-path <path>` | resolved per `docs/META_PATH_RESOLUTION.md` | Where to file improvement beads. When omitted, pre-flight resolves the autonomous-build repo from `$HOME` (env → installed-skill-link trace → candidate probe). The old hardcoded `~/Documents/Github/autonomous-build` did not exist on every host and silently produced file-only (zero-bead) runs. |
| `--no-file` | false | Produce report only; skip filing beads (debug mode). |
| `--self` | false | Meta-retro: analyze autonomous-build itself, treating its own beads + git log as the build window. |
| `--inbox` | false | Triage-drain mode: vet the `triage` inbox (`bd list --label triage --all`) via the adversarial cross-check and **promote survivors in place** (re-parent under a per-drain epic, drop the `triage` label) instead of analyzing a build window. Counterpart to `/flag --upstream`. See "Inbox mode" below — it short-circuits Phases 1–5 of the build-window flow. |

---

## Phase 1 — Pre-flight (sequential, 1 agent)

Verify the run is viable. Produces a `Context` object the rest of the workflow consumes.

**Agent:** `preflight`
**Tools:** `Bash`, `Read`
**Steps:**
1. **Resolve `meta-path`** per `docs/META_PATH_RESOLUTION.md`: if `--meta-path` was passed, use it; else resolve from `$HOME` (`$AUTONOMOUS_BUILD_HOME` → trace the `~/.claude/skills/flag` link up two dirs → candidate probe `~/.openclaw/workspace/autonomous-build`, `~/Documents/Github/autonomous-build`). A resolved path must contain both `.beads/` and `skills/build-next/SKILL.md`.
2. `bd info` in `app-path`; fail loud if not bd-initialized.
3. Resolve `since`/`until`: if `since` not given, query `bd query "status in (in_progress, closed) ORDER BY created_at ASC LIMIT 1"` for the first timestamp. (bd <=0.55.x emits no `claimed_at` in `.beads/issues.jsonl`, so order by `created_at` — the only reliably-present timestamp — as the window start.)
4. Compute `app-name` from `app-path` directory basename.
5. Check `meta-path` resolved AND `meta-path/.beads/` exists → `metaAvailable`. If not, set `metaAvailable=false` and continue with file-only mode, **logging a loud line** ("meta-path unresolved — file-only; set `AUTONOMOUS_BUILD_HOME` or pass `--meta-path`") so the fallback is never silent (T7).
6. If `--self`, set `app-path == meta-path` and `app-name = "autonomous-build"` — and if `meta-path` did not resolve, fail loud (a `--self` retro cannot run without finding this repo).
**Output:** `Context = { appName, appPath, metaPath, metaAvailable, since, until, isSelf, isMetaRetro }`
**Failure:** any pre-flight failure stops the workflow with a clear message — do not proceed to data collection on bad context (T1, T7).

---

## Phase 2 — Data collection (parallel fan-out, 6 agents)

Six independent agents, one per data source. Each returns a typed JSON blob; nothing else. **No cross-source reasoning at this phase** — keep collection mechanical and isolated.

| Agent | Source | Output shape |
| --- | --- | --- |
| `collect-app-beads` | `bd query`, `bd list --label workflow-issue`, `bd blocked`, `bd list --status=in_progress` | `{ closed: [{id, title, type, priority, labels, claimedAt, closedAt, created_to_closed_sec, retries, parentEpic}], flagged: [...], blocked: [...], inProgress: [...] }`. If `claimed_at` is absent (bd <=0.55.x), fall back to `created_at` as the start of the duration and name the field `created_to_closed_sec` (= `closedAt − createdAt`) so downstream phases know the metric is created-to-closed, not claimed-to-closed. |
| `collect-app-git` | `git log --since=$since --until=$until --format=...`, `git log --grep=Revert`, file-level diff inspection | `{ commits: [{sha, ts, subject, author, files: [...]}], reverts: [{sha, revertedSha}], postCloseEdits: [{beadId, loopSha, userSha, hoursAfter, files}], subThirtySecondCloses: [{beadId, durationSec}] }` |
| `collect-meta-git` | `git log` in `meta-path` for the window, broken out by path category | `{ skills: [{file, shas, subjects}], formulas: [...], hooks: [...], docs: [...], tenets: [...], schemas: [...], templates: [...], other: [...] }` |
| `collect-interactions` | `.beads/interactions.jsonl` (optional; many bd installs do not emit this file), filtered to window | `{ perBead: { <beadId>: { toolCallCount, toolBreakdown, gateInvocations, gateOutcomes } }, totals: {...} }`. If the file is missing or 0 bytes, return `{ status: "empty" }` (distinct from the `{ status: "failed" }` error path — empty is expected, not a failure). |
| `collect-jankurai` | `target/jankurai/*.json` in window | `{ kickoffRefusals: [{beadId, reason}], auditFindings: [{beadId, count, severities}], witnessRegressions: [{beadId, baselineDelta}] }` (return empty object if `target/jankurai/` doesn't exist) |
| `collect-app-retros` | `retros/*.md` in `meta-path` for this app, prior runs | `{ priorRetros: [{path, date, headline, filedBeadIds: [...]}] }` (used for "what did the prior retro file, and did it close?") |

**Per T7:** if a source errors (file missing, bd transient failure, parse error), the agent returns `{ status: "failed", reason: "<message>" }` instead of throwing. The synthesis phase reports this in the markdown so the human knows which signals were skipped.

**Concurrency cap:** 6 agents fit well under the runtime's 16-concurrent limit; let the runtime parallelize freely.

---

## Phase 3 — Signal extraction (parallel fan-out, 5 agents)

Each agent reads the Phase 2 blobs (they're already in script variables) and emits a **typed list of signals**. Signals are atomic — one signal per concrete observation.

### Signal type definition

```
Signal = {
  category: "quality" | "speed" | "meta-edit" | "tenet" | "win",
  severity: "high" | "medium" | "low",
  evidence: { source: <which Phase 2 blob>, refs: [<beadIds | shas | filepaths>] },
  observation: <one sentence describing what happened>,
  proposed: {                                  // null for "win" category
    title: <bead title>,
    targetFile: <which file in autonomous-build to edit>,
    acceptance: <a self-verifiable AC: grep, file exists, line count, gate-pass condition>,
    labelExtras: [<extra labels beyond workflow-improvement and from-app:<name>>]
  } | null
}
```

### Agents

| Agent | Reads | Emits signals for |
| --- | --- | --- |
| `signal-quality` | app-beads + app-git | reverts, post-close edits (medium signal: incomplete AC), sub-30s closes (low signal: possible no-op), repeat-blocks on same formula step (high signal: structural formula bug), all flagged-issue categories (`vision-error`, `formula-issue`, `gate-issue`, `escalation-issue`, `pacing-issue`) |
| `signal-meta-edit` | meta-git | every skill/formula/hook/gate/tenet file edited during the build window is a workflow gap — the workflow needed adjusting live. Emit one `high`-severity signal per file, with `proposed.targetFile = <the file>` and `acceptance` = "the documented pattern that motivated this mid-build edit is captured in the file" |
| `signal-tenet` | app-beads + interactions + meta-git | tenets cited in bead notes (working as designed), tenets that should have fired and didn't (e.g., T4 scope discipline: bead closed with files outside `filesTouched`), tenets the workflow needs but doesn't have yet. If `collect-interactions` returned `{ status: "empty" }`, derive signals from app-beads + meta-git alone — do not treat the empty interactions blob as a missing-data failure. |
| `signal-jankurai` | jankurai + app-beads | kickoff refusals (the bead spec was too broad — formula AC is undercooked), audit findings the gate let through, witness regressions that should have failed the gate but didn't |
| `signal-wins` | all sources | formulas that poured cleanly + closed first try, gate catches on real failures, escalations the human resolved quickly. Memory candidates. Emit `proposed: null`. |
| `signal-semantic` | app-beads + jankurai + app-git + `plan.lock.json` + `docs/DEFAULT_STACK.md` | three structural detectors the smbuild retros needed but couldn't auto-detect: **formula-pick vs DEFAULT_STACK** (a generic fallback formula poured where a stack-native variant exists, or a stack choice diverging from the pinned stack — e.g. SQLite, a Python backend), **quality-scored-zero** (a jankurai quality score of 0 the gate let through), **cross-dep edges declared≠present** (a code cross-dependency with no declared bead edge, or a declared edge with no code dependency). Emits nothing for a detector whose inputs are absent. |

**Output:** flat array of `Signal` objects, deduped on `(category, evidence.refs sorted)`.

---

## Phase 4 — Adversarial cross-check (parallel, 2× signals-with-proposed agents + reconciliation)

This is the load-bearing phase that makes the workflow worth more than the skill: every signal carrying a `proposed` bead goes through two independent verifiers before it can be filed.

### Spawn pattern

For each `Signal` where `proposed != null`:

1. **`verify-evidence`** — given the signal and *only* the cited evidence refs (not the proposed fix), does the evidence actually support the observation? Returns `{ supports: true|false, note: "<why>" }`.
2. **`verify-fix`** — given the signal's observation and the proposed fix, is the AC concrete enough that the gate or a grep could prove the fix worked? Returns `{ verifiable: true|false, suggestedRewrite?: "<sharper AC>" }`.

Both verifiers run in parallel per signal; with N signals you spawn 2N verifier agents. The runtime caps concurrency at 16 — schedule in batches if N > 8.

### Reconciliation

One `reconcile` agent reads all verifier outputs and bins each signal:

| Bin | Condition | Disposition |
| --- | --- | --- |
| `file` | both verifiers pass | file the improvement bead in Phase 5 |
| `file-with-sharper-AC` | evidence passes, fix verifier suggested rewrite | use `suggestedRewrite` as the AC, file in Phase 5 |
| `report-only` | evidence does not support OR fix not verifiable AND no rewrite | drop into "uncertain" section of the markdown for human triage; do not file |
| `disagree` | verifiers conflict | report-only with both verdicts shown |

**Output:** the original signal array partitioned into `toFile` and `reportOnly`.

---

## Phase 5 — Synthesis & file (sequential, 2 agents)

### `write-report`
Writes the markdown report to `<meta-path>/retros/retro-<app-name>-<YYYY-MM-DD>.md`. Schema:

```markdown
# Retro: <app-name> (<date>)

**Window:** <since> → <until>  |  **Mode:** <build|self|mid-build>
**Tasks:** <closed> closed, <blocked> blocked, <flagged> flagged
**Data sources:** <list with status; "skipped: <reason>" for failed Phase 2 agents>

## Headline
<one paragraph synthesizing the run>

## What worked
<from `signal-wins`>

## What didn't (filed as improvements)
- bd-<id> — <title> [<labels>]   ← link to the filed bead
  - Evidence: <evidence.refs>
  - Verification: evidence ✓, fix ✓ <or "fix ✓ after rewrite">

## Uncertain (human triage)
<from `reportOnly` bin; one entry per unfiled signal with both verifier verdicts>

## Speed metrics
| Metric | Value |
| --- | --- |
| Wall time | ... |
| Median task duration | ... |   ← label as "Median created-to-closed" when on the `created_at` fallback (bd <=0.55.x, no `claimed_at`) |
| p90 task duration | ... |   ← label as "p90 created-to-closed" on the same fallback |
| Revert rate | ... |
| Post-close edit rate | ... |
| Flag rate | ... |
| Cross-check fileability rate | <toFile.length> / <signals-with-proposed.length> |

## Data sources
- App beads DB: <path>
- App git commits in window: <count>
- autonomous-build edits in window: <count>
- Jankurai receipts: <count>
- Failed sources: <list>
```

### `file-beads`
For each entry in `toFile`:

1. **Idempotency check (T8):** query `bd query "labels CONTAINS 'from-app:<app-name>' AND labels CONTAINS 'retro-date:<YYYY-MM-DD>' AND title = <proposed.title>"` — if a match exists, skip (already filed in a prior re-run of this same retro).
2. Create per-retro epic if not yet created: `bd create "Improvements from <app-name> retro (<date>)" --type=epic --priority=2 --labels "workflow-improvement,from-app:<app-name>,retro-date:<date>"`. Capture its ID. (`bd create` takes `--labels <comma-separated>`, **not** `--add-label` — the latter is update-only and errors on create.)
3. For each signal: `bd create "<proposed.title>" --type=task --priority=2 --parent <epicId> --description "Source: retro-<app>-<date>. Evidence: <refs>. Verification: both checks passed." --acceptance "<proposed.acceptance>" --labels "workflow-improvement,from-app:<app-name>,retro-date:<date>,<each proposed.labelExtras entry>"` — fold every `labelExtras` value into the single comma-separated `--labels` list.
4. Collect the filed bead IDs; pass back to `write-report` so the report's "What didn't" section can link them.

**If `metaAvailable=false` or `--no-file`:** skip step 1–3 and instead emit the would-be-filed list into a "would-file" section at the bottom of the markdown report (T7: visible, not silent).

**If `bd` itself errors at file time** (the host bug we just hit, for example): catch, record the error in the report under a "FAILED TO FILE" section with the full bead spec for manual re-entry. Workflow returns success with a partial-state warning rather than crashing — but the warning is loud (T7).

---

## Inbox mode (`--inbox`, triage drain)

The counterpart to `/flag --upstream`. `/flag --upstream` files **raw** triage beads into autonomous-build (`workflow-improvement,triage,from-app:<app>`, top-level, no acceptance) — intentionally un-vetted, accumulating until something drains them. `/retro --inbox` is that drain: it vets the inbox with the **same adversarial 2-agent cross-check** as a normal retro (Phase 4), then **promotes survivors in place** instead of filing new beads.

It is a distinct flow — different *source* (existing `triage` beads, not a build window) and different *action* (mutate survivors, not create) — so the script branches on `parsedArgs.isInbox` right after arg-parse and `return`s before the build-window Phases 1–5, reusing only the cross-check + report machinery.

| Inbox phase | Does |
| --- | --- |
| **Inbox pre-flight** | Resolve `metaPath` per `docs/META_PATH_RESOLUTION.md`. The triage inbox lives ONLY in the meta repo, so an unresolved `metaPath` is a **fail-loud** stop (nothing to drain) — never a file-only fallback (T7). |
| **Inbox collect** | `bd list --label triage --all --json`; keep `open`/`in_progress` beads (still awaiting vetting — `closed` ones are already resolved). Empty inbox → write a short "inbox empty" report and return cleanly. |
| **Inbox cross-check** | Per triage bead, run the two independent verifiers: `verify-evidence` (may read the cited files / from-app repo to confirm the observation holds), `verify-fix` (judges whether a concrete, gate/grep-verifiable AC is derivable, and supplies it). Same reconciliation bins as Phase 4: both pass → promote; evidence ✓ + suggested AC → promote with that AC; otherwise → uncertain. |
| **Inbox promote** | Idempotently create a per-drain epic `Triage drain (<date>)` (`workflow-improvement,triage-drain,retro-date:<date>`). For each survivor: `bd update <id> --parent <epic> --remove-label triage` (+ `--acceptance` when the cross-check sharpened one). `workflow-improvement` + `from-app:<app>` are kept untouched. bd errors are caught into a FAILED-TO-PROMOTE list (T7). |
| **Inbox report** | Write `<meta-path>/retros/triage-drain-<date>.md` with **## Promoted** (survivors + their new epic + AC + verification), **## Uncertain** (non-survivors *left in the inbox*, with both verifier verdicts) and a loud **## FAILED TO PROMOTE** section if any. |

**Promote, don't re-file.** Survivors are the *same* beads, re-parented and de-`triage`d — never new duplicates. Non-survivors are *left in the inbox* (still labelled `triage`) and reported as Uncertain for human triage — not closed, not deleted — so a later drain re-vets them.

The workflow returns `{ status, mode: 'inbox', reportPath, epicId, promotedBeadIds, uncertainCount, failedToPromoteCount }`.

---

## Run-completion behavior

When the workflow finishes:
- Returns to the conversation: `{ reportPath, filedEpicId, filedBeadIds: [...], reportOnlyCount, failedSources: [...] }`
- The orchestrator turn prints a one-line summary: `"Retro: filed <N> improvements under <epicId>; <M> uncertain in <reportPath>"` plus any failed-source warnings.

---

## Stopping conditions

- App repo isn't bd-initialized → Phase 1 stops; nothing else runs.
- No closed issues in the window → Phase 2 returns empty; Phases 3–5 short-circuit with "nothing to retro" report.
- `metaAvailable=false` and `--no-file` not set → still produce the report, append the would-file list, no error.

---

## Do not

- Do not modify any code in the app repo. Read-only on the app.
- Do not change task statuses on the app's beads. Read-only.
- Do not file improvement beads that didn't pass cross-check. The whole point of Phase 4 is that single-pass speculation has historically produced noise.
- Do not skip the "What worked" section. It prevents the workflow from drifting toward over-engineering.
- Do not silently swallow data-source failures. Each one is surfaced in the report's "Data sources" line (T7).

---

## Keeping `retro.js` in sync

`retro.js` is already authored and hand-maintained. When this spec changes, edit `workflows/retro.js` in the same commit to match, then `./install.sh` (or `install.ps1`) keeps `~/.claude/workflows/retro.js` linked to it. The historical "generate via /workflows then save" path below is retained only for reference — the script is now repo-tracked and edited directly.

### (Historical) save-as-workflow checklist — first-generation path

1. `/workflows`
2. Arrow-select this run
3. Press `s`
4. Tab to **personal** (`~/.claude/workflows/`) and save as `retro.js`
5. Copy the saved script into this repo so it's distributable:
   ```powershell
   Copy-Item "$env:USERPROFILE\.claude\workflows\retro.js" `
             "<autonomous-build>\workflows\retro.js"
   ```
6. Commit: `git add workflows/retro.js && git commit -m "retro: save dynamic workflow script"`
7. Re-run `./install.ps1` — it replaces the copy at `~/.claude/workflows/retro.js` with a hardlink to the repo file, so future edits propagate.

This `retro.spec.md` remains as the spec source-of-truth. When the workflow needs changes, edit this file, delete `workflows/retro.js` and `~/.claude/workflows/retro.js`, and re-invoke `/retro` to regenerate.

---

## Auto-trigger from /build-next

`/build-next` calls `/retro` at the DONE exit (when both `bd ready` and `bd blocked` are empty). For mid-build manual review, the user invokes `/retro` directly. For a retro of the workflow itself, invoke `/retro --self` from inside autonomous-build. `/retro --inbox` is invoked manually (or on a cadence) to drain the `triage` inbox — it is the counterpart to `/flag --upstream` and never auto-fires from `/build-next`.
