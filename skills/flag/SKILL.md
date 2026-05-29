---
name: flag
description: Flag a workflow problem (the loop did the wrong thing, the gate/formula/vision was wrong, etc.) so it reaches /retro. Two modes — local (label a loop-touched bead in the app's beads) and `--upstream` (file a triage bead straight into autonomous-build from inside an app you're hand-working). Use when the user says "flag this", "this is wrong", "the loop got that wrong", "flag this upstream", "/flag", or notices a workflow-level issue while working an app.
---

# flag

In-flight capture of "the workflow itself misbehaved." Cheap, takes seconds, prevents signal loss between now and the next `/retro` run.

## Two modes

- **Local flag (default)** — you are mid-loop in an app repo and want to mark a *bead the loop just touched* as a workflow problem. The label rides the app's beads; `/retro --app-path <app>` harvests it later. This is the original behavior, documented below.
- **Upstream capture (`--upstream`)** — you are **hand-working an app** (e.g. smbuild) and notice a workflow gap, but there is no relevant loop-touched bead to label — or you want the signal to reach autonomous-build's backlog *now* instead of waiting for a `/retro`. `--upstream` files a lightweight **triage** bead directly into autonomous-build, regardless of whether a loop is running. See "Upstream capture" below.

Pick `--upstream` whenever the natural target is "the workflow," not "this app's bead" — that is the path that actually closes the loop from manual app work back to this repo.

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

## Upstream capture (`--upstream`)

Files a **triage** bead straight into autonomous-build's backlog from inside an app repo. Use when you hit a workflow gap while hand-working the app and there's no loop-touched bead to label (or you don't want to wait for `/retro`). Same cheap-and-fast ethos as a local flag — one bead, one observation.

Invocation: `/flag --upstream "<one-line observation>"` (optionally with a `category` — same enum as local flags). The reason is required; if not given, ask for it (T1 — don't invent the observation).

1. **Resolve the meta repo.** Use the canonical rule in `docs/META_PATH_RESOLUTION.md` — bootstraps from `$HOME` (env var → installed-skill-link trace → candidate probe), validates `.beads/` + `skills/build-next/SKILL.md`. POSIX:
   ```bash
   META="$AUTONOMOUS_BUILD_HOME"
   [ -n "$META" ] && [ -d "$META/.beads" ] || META="$(readlink -f ~/.claude/skills/flag 2>/dev/null | xargs -r dirname | xargs -r dirname)"
   { [ -d "$META/.beads" ] && [ -f "$META/skills/build-next/SKILL.md" ]; } \
     || for c in "$HOME/.openclaw/workspace/autonomous-build" "$HOME/Documents/Github/autonomous-build"; do
          [ -d "$c/.beads" ] && [ -f "$c/skills/build-next/SKILL.md" ] && META="$c" && break
        done
   ```
   **If `$META` does not validate, FAIL LOUDLY** — tell the user to `set AUTONOMOUS_BUILD_HOME=<path>` and stop. Never silently skip; a lost upstream signal is exactly the failure this mode exists to prevent.

   *Already in meta mode?* If cwd **is** autonomous-build (`./skills/build-next/SKILL.md` exists), `--upstream` is a no-op redirect — just create the bead in the local repo with the same labels below.

2. **Compute the app name** — basename of the app repo's git root (`basename "$(git rev-parse --show-toplevel)"`). If it can't be determined, ask.

3. **Idempotency.** Don't double-file the same observation in a session:
   ```bash
   bd --db "$META/.beads" list --label triage --label "from-app:<app>" --all 2>/dev/null  # scan for a matching open title
   ```
   If a near-identical open triage bead exists, append to it (`bd --db "$META/.beads" update <id> --append-notes "..."`) instead of creating a duplicate.

4. **File the triage bead** into the meta repo:
   ```bash
   bd --db "$META/.beads" create "<one-line observation>" --type=task --priority=3 \
      --labels "workflow-improvement,triage,from-app:<app>" \
      --description "Upstream capture from <app> (hand-work, $(date +%F)). Category: <category|unset>. Observation: <reason>. Evidence: <files/ids/commands the user pointed at, if any>."
   ```
   - Top-level (no `--parent`): the anchor epic `autonomous-build-1zq` is **closed**, and these are *un-vetted*. The `triage` label **is** the inbox — `bd --db "$META/.beads" list --label triage --all` lists everything awaiting vetting.
   - `workflow-improvement` keeps it in the same backlog `/retro` files into; `triage` distinguishes "captured, not yet cross-checked" from a vetted improvement; `from-app:<app>` records origin so the fix can later be re-confirmed against that app.

5. **Confirm.** Echo: `Captured upstream as <new-id> (triage, from-app:<app>): <observation>. Lives in autonomous-build; vet/promote it with the triage drain.`

> Triage beads are intentionally *raw* — capture is meant to cost seconds. Promotion to a vetted `workflow-improvement` (adversarial cross-check + re-parent under a per-drain epic, drop the `triage` label) is the job of the triage-drain step (`/retro --inbox`, tracked separately). Do not cross-check or fix here.

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

User (hand-editing smbuild): "the crud-feature formula keeps emitting REST handlers but this is a gRPC stack — flag this upstream"
→ resolve meta repo, then:
```bash
bd --db "$META/.beads" create "crud-feature formula emits REST handlers on a gRPC-locked stack" --type=task --priority=3 \
   --labels "workflow-improvement,triage,from-app:smbuild" \
   --description "Upstream capture from smbuild (hand-work, 2026-05-29). Category: formula-issue. Observation: crud-feature poured REST handlers; stack is gRPC/tonic per DEFAULT_STACK. Evidence: formulas/crud-feature.formula.toml vs crud-feature-rust."
```

## Do not

- Do not reopen the flagged issue. The work itself may have been fine — flag is about the *workflow*, not the deliverable.
- Do not modify code, run gates, or do anything beyond labeling and noting (local) or filing one triage bead (`--upstream`).
- Do not flag more than one issue per invocation. One flag, one issue.
- (`--upstream`) Do not cross-check, fix, or promote — capture raw and move on. Vetting is the triage drain's job.
