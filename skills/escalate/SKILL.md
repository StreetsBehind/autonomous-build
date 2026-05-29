---
name: escalate
description: Summarize all blocked beads issues and send a single push notification so the human can unblock. Use when invoked by /escalate, when /build-next reports BLOCKED, or when the user asks "what's blocked" or "what needs my input".
---

# escalate

The loop's exit point when it can't proceed on its own.

## Process

1. **List blockers.**
   ```powershell
   bd list --status=blocked --json
   ```
   Use the **status field** (`--status=blocked`), not `bd blocked`. `bd blocked` lists only *dependency*-blocked beads; the loop escalates by setting `--status=blocked` (build-next Step 8, build-batch's failed/blocked marking), and those have no open dependency — so `bd blocked` would summarize *zero* and this skill would page the human with an empty list (autonomous-build-gh4).

2. **Group by reason category.** Read each issue's notes (the first line is the short reason; subsequent appended notes have the diagnostic detail). Bucket into:
   - **Decisions needed** — auth model, schema changes, paid APIs, branding, secrets
   - **Build failures** — quality gate red twice
   - **Scope ambiguity** — acceptance criteria too vague, scope creep detected
   - **Tooling** — missing required dependencies
   - **Other**

3. **Format a single notification.**

   ```
   Build paused. <N> blocked issue(s):

   DECISIONS NEEDED (<n>):
     - bd-abc12: <short reason>
     - bd-def34: <short reason>

   BUILD FAILURES (<n>):
     - bd-xyz56: <short reason>

   To inspect:    bd show <id>
   To unblock:    bd update <id> --status=open --append-notes "decision: ..."
   To restart:    /loop /build-next
   ```

4. **Send the notification.**
   ```
   PushNotification(message=<formatted summary>)
   ```

5. **Print the same summary to the user-visible output** in case they're at the terminal.

## Do not

- Do not try to resolve blockers yourself. Even ones that seem obvious — if the loop blocked it, treat that as a signal.
- Do not send one notification per issue. One consolidated summary, always.
- Do not modify issue status. Only the human (or `/build-next` on re-pickup) does that.
