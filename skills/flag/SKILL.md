---
name: flag
description: Flag the current or a specified beads issue as a workflow problem (the loop did the wrong thing, the gate was wrong, the formula was wrong, etc.) so /retro can review it later. Use when the user says "flag this", "this is wrong", "the loop got that wrong", "/flag", or otherwise indicates a workflow-level issue with a build the loop just did.
---

# flag

In-flight capture of "the workflow itself misbehaved." Cheap, takes seconds, prevents signal loss between now and the next `/retro` run.

## When to use this vs. just fixing the bug

- **A bug in the code the loop wrote** → fix it. Don't flag. The retro will detect it via revert/edit detection.
- **The loop should not have written that code at all** → flag. Categorize.
- **The gate said "pass" on something broken** → flag with category `gate-issue`.
- **`/vision` made a stack/architecture choice you wouldn't have** → flag the relevant epic with category `vision-error`.
- **The formula's acceptance was vague or its steps were the wrong shape** → flag the relevant task with category `formula-issue`.
- **The loop escalated something it should have handled, or didn't escalate something it should have** → flag with category `escalation-issue`.

## Process

1. **Determine the target issue.**
   - If the user named an ID (`bd-abc12`), use it.
   - Otherwise default to the last-touched issue:
     ```powershell
     bd update --append-notes "<reason>"   # no ID = last touched
     ```
     (But for flag we want an explicit ID for clarity — capture it via `bd list --closed-after $(Get-Date).AddHours(-1).ToString('yyyy-MM-dd') --limit 5` if no ID was given, ask the user which one if ambiguous.)

2. **Determine the category.** Ask the user if not stated. One of:
   - `vision-error` — bad stack/architecture/data-model decision
   - `formula-issue` — formula shape, acceptance, or step ordering was wrong
   - `gate-issue` — quality gate let something bad through, or blocked on noise
   - `escalation-issue` — escalation triggered when it shouldn't have (or didn't when it should have)
   - `pacing-issue` — loop ticked too fast or too slow
   - `other` — capture the reason in notes

3. **Apply the labels and note.**
   ```powershell
   bd update <id> --add-label workflow-issue --add-label workflow-issue:<category> --append-notes "FLAG: <one-line reason>"
   ```

4. **Confirm.** Echo back to the user: `Flagged bd-<id> as <category>: <reason>. /retro will surface this.`

## Examples

User: "flag bd-a1f3, /vision picked Postgres but my vision.md said SQLite for v1"
→
```powershell
bd update bd-a1f3 --add-label workflow-issue --add-label workflow-issue:vision-error --append-notes "FLAG: vision picked Postgres but vision.md said SQLite for v1"
```

User: "the gate passed on that last task but the test was skipped — flag it"
→ Look up the last-closed issue, confirm with user, then:
```powershell
bd update bd-<id> --add-label workflow-issue --add-label workflow-issue:gate-issue --append-notes "FLAG: gate passed but test was skipped, gate is too lax"
```

## Do not

- Do not reopen the flagged issue. The work itself may have been fine — flag is about the *workflow*, not the deliverable.
- Do not modify code, run gates, or do anything beyond labeling and noting.
- Do not flag more than one issue per invocation. One flag, one issue.
