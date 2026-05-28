# Escalation Rules

The loop's prime directive: **escalate over guess**. When in doubt, `bd update <id> --status=blocked --notes "<reason>"` and let `/escalate` notify the human. A wrong decision compounds across the rest of the build; a brief pause for a human answer does not.

## Hard stops — always block, never guess

| Trigger | Why |
| --- | --- |
| Schema migration on a table that already has data in a deployed environment | Destructive; reversal costs a backup restore. |
| Authentication or authorization model choice (session vs. JWT, who can do what) | Wrong-direction work is hard to retrofit. |
| Adding a paid third-party API (Stripe, Twilio, OpenAI, etc.) | Cost + credentials need human approval. |
| Secrets handling (where keys live, how they're rotated) | Security incident risk. |
| Public-facing copy or branding decisions | Subjective; better to ask than to redo. |
| Any task whose acceptance criteria the builder cannot self-verify | If the gate can't tell you it's done, you don't know it's done. |
| Same task fails the quality gate twice | Symptom of a wrong approach or missing context. |
| Cumulative session API cost exceeds the budget in `plan.md` | Stop the burn. |

## Soft stops — block if the formula or plan didn't pre-decide

These usually have a default in the formula, but if the formula leaves them open, escalate rather than guess:

- ORM / DB driver choice
- Test framework choice
- CSS / styling approach
- Deployment target
- Logging / observability stack

## What "blocked" means in beads

```powershell
bd update <id> --status=blocked --notes "<one-line reason>" --append-notes "<diagnostic detail>"
```

The `--notes` line is what `/escalate` puts in the push notification. Keep it short and actionable: "needs auth model decision: sessions or JWT?", not "could not proceed".

## What the human does to unblock

1. Read the push notification.
2. `bd show <id>` to see the diagnostic detail.
3. Make the decision — either:
   - Update the issue: `bd update <id> --status=open --append-notes "decision: <answer>"`, then restart `/loop /build-next`.
   - Or split the issue: close it and create a more specific child task.

## What is NOT a reason to escalate

- A unit test is wrong — fix it.
- A type error — fix it.
- A lint warning — fix it.
- A dependency needs adding — add it.
- An obvious typo in the formula's variable name — fix it locally and note for the formula author.

The threshold for escalation: "could a reasonable contractor finish this without calling me?" If yes, do it. If no, block.
