# Escalation Rules

The loop's prime directive: **escalate over guess**. When in doubt, `bd update <id> --status=blocked --notes "<reason>"` and let `/escalate` notify the human. A wrong decision compounds across the rest of the build; a brief pause for a human answer does not.

## Hard stops — always block, never guess

| Trigger | Why |
| --- | --- |
| Schema migration on a table that already has data in a deployed environment **— and the migration stance was not decided in plan.lock** | Destructive; reversal costs a backup restore. |
| Making an authentication or authorization model choice **de novo** (session vs. JWT, who can do what) **that plan.lock did not already decide** | Wrong-direction work is hard to retrofit. |
| Adding a paid third-party API (Stripe, Twilio, OpenAI, etc.) | Cost + credentials need human approval. |
| Deciding secrets handling **de novo** (where keys live, how they're rotated) **that plan.lock did not already decide** | Security incident risk. |
| Public-facing copy or branding decisions | Subjective; better to ask than to redo. |
| Any task whose acceptance criteria the builder cannot self-verify | If the gate can't tell you it's done, you don't know it's done. |
| Same task fails the quality gate twice | Symptom of a wrong approach or missing context. |
| Cumulative session API cost exceeds the budget in `plan.md` | Stop the burn. |

### Front-loaded decisions are not escalations (auth / secrets / migration)

These three escalate only when the decision is **unmade**. `/vision` front-loads them at human-present planning time into `plan.lock.json` `concerns[]`: the auth model under `authn`/`authz`, secrets handling under `secrets`, migration stance under `data-lifecycle` — each `addressed` with concrete, falsifiable evidence (the mechanism, the model, where secrets live, whether migrations are destructive). When a bead merely *touches* auth/secrets/migration and the relevant concern is **`addressed` in plan.lock**, the decision already exists — the builder **implements the decided model and proceeds; it does not block.** A `touches-auth` label by itself is therefore not a hard stop. Block only when:

- the relevant concern is **absent or `excluded`** in plan.lock (no decision was front-loaded — pre-`/vision`-concerns app, or the lock omits it), **or**
- the bead would require a **new** decision *beyond* what plan.lock decided (e.g. plan decided OIDC login but the bead must now pick an authz tenancy model the plan never addressed).

The `needs-decision` label is unconditional — it is an explicit "a human must answer this" marker and always blocks.

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
   - Update the issue: `bd update <id> --status=open --append-notes "decision: <answer>"`.
   - Or split the issue: close it and create a more specific child task.

The loop does **not** need a manual restart. After a drain-to-blocked, `/loop /build-next` stays alive in resume-poll mode (re-checking `bd ready` every ~20–30 min — see build-next Step 12 "Resume-poll on full block"), so it picks the bead back up on its next poll the moment you reopen it. A manual `/loop /build-next` is only needed if you explicitly stopped the loop or the backstop window has elapsed.

## What is NOT a reason to escalate

- A unit test is wrong — fix it.
- A type error — fix it.
- A lint warning — fix it.
- A dependency needs adding — add it.
- An obvious typo in the formula's variable name — fix it locally and note for the formula author.

The threshold for escalation: "could a reasonable contractor finish this without calling me?" If yes, do it. If no, block.
