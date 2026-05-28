---
name: retro
description: Generate a workflow performance retro for an app the loop just finished (or is mid-build). Pulls beads history, flagged issues, app git log (revert + post-close edits), and autonomous-build git log during the build window. Outputs a markdown report and files concrete improvement issues into autonomous-build's own beads DB. Use when the user says "retro", "/retro", "review the workflow", "how did that go", or when /build-next exits with DONE.
---

# retro

The feedback loop's analysis stage. Turns raw evidence from a completed (or in-progress) build into a structured review of the workflow itself, plus filed improvement tasks.

## Inputs

- **App repo path** (default: current working directory). Must be a `bd init`'d repo.
- **Time window** (default: from the first `bd ready` claim to now, or to the most recent `bd close`). Override with `--since YYYY-MM-DD` if invoking manually for a partial review.
- **autonomous-build path** (default: `~/Documents/Github/autonomous-build/`). Used to read the workflow git log and to file improvement issues.

## Pre-flight

1. `bd info` succeeds in the app repo (it's bd-initialized).
2. `~/Documents/Github/autonomous-build/.beads/` exists (the meta-DB is initialized — Layer 3). If not, skip the "file improvement issues" step and just produce the markdown report.

## Data collection

### From the app's beads DB

```powershell
# Closed issues in the window
bd query "status=closed AND closed>$since" --json > .retro-tmp/closed.json

# Workflow-flagged issues (any status)
bd list --label workflow-issue --all --json > .retro-tmp/flagged.json

# Blocked issues (current)
bd blocked --json > .retro-tmp/blocked.json

# Audit log entries in the window
# .beads/interactions.jsonl — filter by ts >= since
```

For each closed issue, extract:
- `id`, `title`, `type`, `priority`, `labels`
- `created_at`, `claimed_at` (first in_progress timestamp from audit), `closed_at`
- Duration: closed - claimed
- Retry count: number of status transitions touching this issue
- Parent epic / formula source (from labels or parent)

### From the app's git log

```powershell
# All loop commits in the window
git log --since="$since" --format="%H|%ct|%s|%an" > .retro-tmp/git-log.txt

# Revert detection: any commit whose subject starts with "Revert" referencing a loop commit
git log --since="$since" --grep="Revert" --format="%H|%s" > .retro-tmp/reverts.txt

# Post-close edit detection: for each loop commit C that closed bd-X,
#   find any commit C' after C that touches the same files as C
#   AND was authored within 24h AND is by the user (not the loop's git config)
```

Surface for each:
- Loop commit reverted within window → high-signal "loop got it wrong"
- Loop commit whose files were edited by the user within 24h → medium-signal "loop got it incomplete"
- Issues closed in <30s → low-signal "did the gate actually run? was the work a no-op?"

### From the autonomous-build git log

```powershell
cd ~/Documents/Github/autonomous-build
git log --since="$since" --format="%H|%ct|%s|%an" --name-only > .retro-tmp/aubuild-changes.txt
```

For each changed file in the window:
- `skills/<name>/SKILL.md` edited → that skill needed fixing mid-build (high signal)
- `formulas/<name>.formula.yaml` edited → that formula needed fixing mid-build (high signal)
- `hooks/post-build-gate.ps1` edited → gate logic needed adjustment (high signal)

## Analysis

Group findings into these buckets:

### Speed metrics (low-priority — context, not action)
- Total wall time of the build
- Median task duration
- 90th percentile task duration
- Tasks with duration < 30s (suspicious — see "no-op detection" below)

### Quality signals (the action-driving section)

| Signal | What it means | Action template |
| --- | --- | --- |
| Loop commit reverted | Loop made a wrong call the gate didn't catch | File issue: "tighten gate for <pattern>" or "add formula step covering <thing>" |
| Loop commit edited by user within 24h | Acceptance was incomplete | File issue: "expand acceptance criteria for <step> in <formula>" |
| Task closed in <30s | Possibly a no-op | File issue: "verify <step> actually does work, not just declares done" |
| Same formula's same step blocked >1x in this build | Formula step is structurally wrong | File issue: "rework <step> in <formula> — blocks repeatedly" |
| `workflow-issue:vision-error` flag | /vision misjudged | File issue: "update /vision SKILL.md — <specific bias to correct>" |
| `workflow-issue:formula-issue` flag | Formula was wrong shape | File issue with the user's reason verbatim |
| `workflow-issue:gate-issue` flag | Gate too lax/strict | File issue: "adjust hooks/post-build-gate.ps1 — <reason>" |
| `workflow-issue:escalation-issue` flag | Escalation rule wrong | File issue: "update docs/ESCALATION_RULES.md — <reason>" |
| Mid-build edit to skill/formula in autonomous-build | The user had to fix something live | File issue: "investigate why <file> needed editing — pattern to capture in skill" |

### What worked (capture wins too, for memory)

- Formulas that poured cleanly and whose steps closed first try
- Steps that the gate caught a real failure on (gate working as designed)
- Escalations that were correctly raised (human responded with a real decision)

## Output 1: the markdown report

Write to `~/Documents/Github/autonomous-build/retros/retro-<app-name>-<YYYY-MM-DD>.md`:

```markdown
# Retro: <app-name> (<date>)

**Window:** <since> → <now>
**Tasks:** <total> closed, <n> blocked, <n> flagged

## Headline

<one paragraph: did the workflow earn its keep, or did it cost more than it saved?>

## What worked

- ...

## What didn't

- ...

## Concrete improvements filed (in autonomous-build beads)

- bd-<id> — <subject>
- ...

## Raw metrics

| Metric | Value |
| --- | --- |
| Wall time | ... |
| Median task duration | ... |
| Revert rate | ... |
| Post-close edit rate | ... |
| Flag rate | ... |

## Data sources

- App beads DB at <path>
- Audit log entries: <count>
- App git commits in window: <count>
- autonomous-build edits in window: <count>
```

## Output 2: filed improvement issues

For each action template that matched, file in autonomous-build's beads DB:

```powershell
cd ~/Documents/Github/autonomous-build
bd create "<subject from action template>" \
  --type=task --priority=2 \
  --description "Source: retro-<app>-<date>. Evidence: <specifics>" \
  --acceptance "<concrete change: edit which file, what behavior changes>" \
  --add-label workflow-improvement --add-label "from-app:<app-name>"
```

Group related improvements under a per-retro epic for traceability:

```powershell
bd create "Improvements from <app-name> retro" --type=epic --priority=2
# capture epic id, then create children with --parent <epic-id>
```

## Auto-trigger from /build-next

`/build-next` calls `/retro` at the DONE exit (when both `bd ready` and `bd blocked` are empty). For mid-build manual review, the user invokes `/retro` directly.

## Stopping conditions

- App repo isn't bd-initialized → tell user, do nothing.
- No closed issues in the window → no signal to analyze, print "nothing to retro yet" and exit.
- autonomous-build beads DB not initialized (Layer 3 not done) → produce markdown report only, skip filing issues, mention in the report what would have been filed.

## Do not

- Do not modify any code in the app repo. Read-only.
- Do not change task statuses. Read-only on the app's beads.
- Do not file improvement issues for things the user didn't flag and that have no signal in the data. The retro is evidence-driven, not speculative.
- Do not skip the "what worked" section — it prevents the workflow from drifting toward over-engineering.
