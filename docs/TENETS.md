# Tenets

The principles the loop falls back on when the bead spec, plan.lock.json, formulas, and gate don't decide for it.

This document is the **last layer of decision-making before model intuition**. If you're about to make a judgment call — "should I add a fallback here?", "should I fix this unrelated lint warning while I'm in the file?", "the spec is ambiguous, should I guess or block?" — stop and check this document first.

This file is workflow-level. Every app the loop builds inherits it via the per-app `tenets.md` that `/vision` produces. Edits here ripple into every future build.

---

## How to use this document

1. **Trigger**: you're about to take an action and the bead spec, plan.lock, formula, and gate don't dictate it.
2. **Check the source-of-truth ordering first** — most "judgment calls" are actually just unread spec.
3. **Then check the tenets** — work top to bottom; lower-numbered tenets win conflicts.
4. **If no tenet covers it**, that's a workflow gap — file a `workflow-improvement` bead and either escalate or make the most-reversible decision you can.

---

## Source of truth ordering

When two signals disagree, the higher item wins. Always.

1. **The quality gate** (`hooks/post-build-gate.ps1`) — if it says no, it's no.
2. **`plan.lock.json`** — the structured contract; what `/compose` and `/build-next` actually consume.
3. **`plan.md`** — human narrative. Where it disagrees with the lock, the lock wins; flag the divergence with `/flag`.
4. **The bead spec** — title, description, acceptance criteria, testPlan, filesTouched. The unit of work.
5. **Formula output** — whatever `bd mol pour` produced. Errors at this layer are formula bugs; fix the formula, not the output.
6. **Existing code in the app repo** — useful context, but not a contract. The fact that something exists is not evidence it's correct.
7. **`docs/DEFAULT_STACK.md`** — for stack decisions, the pinned source.
8. **Model intuition** — last resort. Treat as a guess. If a tenet says "escalate when guessing", escalate.

The per-app `tenets.md` rewrites this list rooted in that app's files but the ordering does not change.

---

## The tenets

Each tenet has the same shape: a one-sentence rule, why it exists, and how to apply it. Lower-numbered tenets win when two tenets pull opposite directions — see "Hard conflicts" at the end.

### T1. Escalate over guess

- **Rule**: When in doubt, `bd update <id> --status=blocked --notes "<reason>"` and let `/escalate` notify the human. Do not guess.
- **Why**: A wrong decision compounds across the rest of the build. The cost of a brief pause is bounded; the cost of a wrong-direction implementation is not.
- **How to apply**: The threshold is "could a reasonable contractor finish this without calling the human?" If yes, do it. If no, block. See `docs/ESCALATION_RULES.md` for the hard-stop list and the non-reasons.

### T2. The gate is the contract

- **Rule**: `hooks/post-build-gate.ps1` defines "done." Do not disable steps, weaken rules, or skip stages to make the gate pass.
- **Why**: The gate is the only thing that prevents the loop from drifting. A passing gate with a weakened rule is worse than a failing gate with a strong rule — the latter at least surfaces.
- **How to apply**: If the gate fails, fix the code or fix the spec. Edits to the gate itself require their own bead in autonomous-build with explicit justification — never bundled with the bead the gate just failed.

### T3. Atomic bead, atomic commit

- **Rule**: One bead = one logical change = one commit. No bundling, no opportunistic cleanups, no "while I'm in here" edits.
- **Why**: Reverts must be cheap. The DAG only makes sense if its nodes are independent. Bundled changes make every retro harder and every regression more expensive to bisect.
- **How to apply**: If your change wouldn't pass the gate on its own, split the bead. If you find yourself editing files outside the bead's `filesTouched`, stop and ask whether that edit should be its own bead. The answer is usually yes.

### T4. Scope discipline — build the bead, not the project

- **Rule**: Implement exactly what the acceptance criteria require. No invented requirements, no defensive code for impossible cases, no abstractions for hypothetical futures, no "nice while we're here" features.
- **Why**: Spec inflation is the loop's single largest failure mode. Every uncommanded edit is a chance for a regression the gate cannot catch.
- **How to apply**: If you find yourself writing code the AC does not require, ask: "would the gate fail without this?" If no, delete it. If yes, the AC is wrong — flag with `/flag`, don't paper over it.

### T5. Reversibility bias

- **Rule**: Prefer reversible decisions. For irreversible ones (destructive migrations, paid API integrations, breaking schema changes, public-facing copy), escalate explicitly even if not on the hard-stop list.
- **Why**: Reversible mistakes cost time; irreversible mistakes cost money, data, or trust. The loop is allowed to make time-mistakes — that's why retros exist.
- **How to apply**: Before any irreversible step, ask: "if we change our minds about this in three months, what does it cost?" Record the answer (this is the `reversalCost` field in `agentConsults`). High cost → escalate.

### T6. Formula precedence over ad-hoc

- **Rule**: Stack picks and structural patterns come from the formula or `docs/DEFAULT_STACK.md`. Do not improvise.
- **Why**: Formulas encode patterns vetted across many builds. Ad-hoc choices during `/build-next` have no such vetting and create subtle divergence across apps that makes shared skills and formulas more expensive to maintain.
- **How to apply**: If the formula doesn't cover what you need, the formula is missing a step — surface it (`/flag` or a `workflow-improvement` bead in autonomous-build), don't paper over. If the stack table doesn't have a layer you need, use the 3-agent off-stack consult (see `skills/vision/SKILL.md` step 7), don't pick yourself.

### T7. Failure visibility — loud and recoverable over silent and clean

- **Rule**: Failures should be loud, logged, and recoverable. No silent fallbacks, no swallowed exceptions, no "best-effort" behavior that hides real bugs.
- **Why**: The loop runs autonomously. If a failure is silent, nobody is watching to catch it. Loud failures cost a build tick; silent failures poison every build downstream until someone notices.
- **How to apply**: Catching an exception requires one of: a re-raise, a logged line with the original error preserved, or a documented reason in a comment that it's safe to swallow. "Just in case" try/except is forbidden.

### T8. Idempotency by default

- **Rule**: Every install step, migration, hook setup, scaffolding step, and bootstrap script should be safely re-runnable without harm.
- **Why**: The loop can be interrupted, retried, restarted on a different machine. Non-idempotent steps poison restarts.
- **How to apply**: `CREATE TABLE IF NOT EXISTS`; check before create; junctions tested before linked; hooks installed via "remove-then-add" if necessary. If a step *cannot* be made idempotent (e.g., a destructive migration), gate it with an explicit confirmation and document why.

### T9. Meta vs app discipline

- **Rule**: Workflow changes (skills, formulas, hooks, gates) propagate to every future app. App changes are scoped to one app.
- **Why**: A bug in a workflow skill is a bug in every build that uses that skill. The blast radius of a meta edit is much larger than the blast radius of an app edit.
- **How to apply**: If you're editing autonomous-build, ask: "would I want this behavior in every future app?" If no, the change belongs in an app's repo, not in the workflow. `/build-batch` refuses meta mode for the same reason — parallel workers cannot race on the shared workflow surface.

### T10. plan.lock.json is the contract, plan.md is the narrative

- **Rule**: Where the lock and the narrative disagree, the lock wins. Do not edit a bead spec to match `plan.md` when `plan.lock.json` says something different. Re-run `/vision` to regenerate both.
- **Why**: The lock is what `/compose` pours from and `/build-next` reads. The narrative is for the human and is hand-editable. A drift between the two is a `/vision` bug or a manual edit that bypassed the schema — both need to be fixed at the source.
- **How to apply**: At build time, read the lock first. If the lock is missing or the narrative contradicts it, flag and escalate; do not pick a side.

---

## Hard conflicts

Where tenets pull opposite directions, this section is the tiebreaker. Lower-numbered tenets generally win, but specific scenarios deserve a named resolution.

### Atomic bead (T3) vs. don't leave the tree broken
- **Tension**: Splitting a bead mid-build would leave the working tree in a broken state with no easy commit boundary.
- **Resolution**: The bead was sized wrong. Atomicity still wins — split the bead via `/split`, finish the originally-scoped half cleanly, and let the second half become its own bead with a `blocked-by` dependency on the first.

### Scope discipline (T4) vs. obvious bug in adjacent code
- **Tension**: You're editing `foo.ts` and spot an obvious bug in `bar.ts` next to it.
- **Resolution**: Scope wins. File a separate bead (`bd create --type=bug`) and continue with your current bead. The exception: if the bug *will be hit by your test* and your test would falsely pass without fixing it, the bug is in-scope — fix it and note in your commit.

### Escalate over guess (T1) vs. spec ambiguity that has a default
- **Tension**: The bead spec is ambiguous, but a reasonable default exists.
- **Resolution**: Check whether the default is documented (in the formula, in the per-app `tenets.md`, in `docs/DEFAULT_STACK.md`). If yes, use the default and proceed. If no, escalate. "Reasonable to me" is not "documented as default."

### Gate is the contract (T2) vs. gate is wrong
- **Tension**: The gate is failing because it itself has a bug.
- **Resolution**: Block the bead, file a separate workflow-improvement bead in autonomous-build for the gate fix, and let a human authorize the gate edit. Never silently edit the gate to make your bead pass — that breaks every future build that should have failed.

### Reversibility bias (T5) vs. formula precedence (T6)
- **Tension**: The formula prescribes an irreversible action (e.g., a destructive migration step).
- **Resolution**: T5 wins. Escalate the irreversible step explicitly, even if the formula authorizes it. The formula encodes patterns, not blanket permission for one-way doors.

---

## Not tenets

These look like tenets but aren't load-bearing — they're preferences. Don't treat them as binding:

- **"Prefer functional over imperative."** A style preference. Use whatever fits the surrounding code.
- **"Write comments to explain why."** True but already in the system prompt; not a tenet.
- **"Don't use `var` in JS."** A lint rule, not a tenet. The gate enforces it; you don't need to think about it.
- **"Keep PRs small."** This is T3 restated. Read T3, not this bullet.
- **"DRY."** Sometimes. Premature abstraction is often worse than duplication. Tenet T4 trumps any DRY impulse during a build.

If something feels like a tenet but you can't write "you violated this tenet when you did X" in a specific scenario, it's not a tenet. It's taste.

---

## When this file changes

This is workflow-pinned. Edits ripple into every future app. Treat changes the same as `docs/DEFAULT_STACK.md`:

- File a `bd create --type=task --labels workflow-improvement` describing the change and the scenario that motivated it.
- Cite the bead or build where the missing tenet was needed.
- Do not edit during an app build. The per-app `tenets.md` is the place to capture app-specific exceptions — this file stays universal.
