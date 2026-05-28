---
name: vision
description: Convert a filled-out vision.md into a concrete plan.md (tech stack, data model, feature order, formula picks). Use when the user says "run vision", "vision-to-plan", or invokes /vision on a fresh app repo that has vision.md present.
---

# vision

Turn a `vision.md` into a `plan.md` the rest of the pipeline can consume.

## Inputs

- `vision.md` in the current working directory (filled out from `autonomous-build/templates/vision.md`).
- The user is present for this stage — it's the last human-in-the-loop checkpoint before the autonomous build begins.

## Process

1. **Read `vision.md` end to end.** Do not skim. Quote back to the user the *non-goals*, *constraints*, and *success metric* so they can correct you before you commit to choices.

2. **Resolve every "no preference" with a recommendation and one-line justification.** Do not leave choices for later — the loop will not ask.

3. **Decide the architecture.** Choose:
   - Language(s) and framework(s)
   - Database
   - Auth approach (if app needs auth)
   - Hosting target
   - Test framework
   - Lint/format tools

4. **Sketch the data model.** Entities, key fields, relationships. Just enough to drive the first migration.

5. **Order the features.** List from must-haves §3 in dependency order. Each feature is one to a few formulas (see `~/.beads/formulas/`).

6. **Pick formulas.** For each feature, identify which formula(s) from `bd formula list` will be poured, and the variable bindings. If no formula fits, note "needs new formula" — escalate to the user before `/compose` runs.

7. **Set the escalation budget.** Copy from vision.md §9, fill defaults for anything left blank.

## Outputs: `plan.md` + `plan.lock.json`

`/vision` writes two paired files in the app repo CWD:

- **`plan.md`** — the human-readable contract (structure below). Quoted to the user, edited if they want, and kept in git as the narrative.
- **`plan.lock.json`** — the machine-readable mirror that `/compose` consumes. Same content in structured form, validated against [`autonomous-build/schemas/plan.lock.schema.json`](../../schemas/plan.lock.schema.json) before writing. See [`docs/PLAN_LOCK.md`](../../docs/PLAN_LOCK.md) for the field reference.

Write both. If schema validation fails, stop — do not write a partial lock. If `plan.md` §"Open questions for human" has any items the user must answer before composing, write the lock anyway with `incomplete: true` and `openQuestions[].blockingCompose: true` for those items; `/compose` will refuse cleanly with the structured reason.

### `plan.md` structure

Use this exact structure so `/compose`'s fallback parser (for repos that pre-date plan.lock.json) still works:

```markdown
# Plan: <app name>

## Stack
| Layer | Choice | Why |
| --- | --- | --- |
| Language | ... | ... |
| Backend framework | ... | ... |
| Frontend framework | ... | ... |
| Database | ... | ... |
| ORM/driver | ... | ... |
| Auth | ... | ... |
| Hosting | ... | ... |
| Tests | ... | ... |
| Lint/format | ... | ... |

## Data model
- **Entity**: fields, relationships, notes
- ...

## Feature order
1. <feature> — formulas: `[app-skeleton]`, vars: `{name=...}`
2. <feature> — formulas: `[crud-feature]`, vars: `{entity=Habit, fields=[name,description]}`
3. ...

## Cross-feature dependencies
- Feature 3 depends on feature 1's auth tasks (use `bd dep add`)

## Escalation budget
- Max session cost: $...
- Max failures per task: ...
- Additional block triggers: ...

## Open questions for human
> If this section is non-empty, /compose will NOT run. Resolve here first.
- ...
```

## Stopping conditions

- vision.md has internal contradictions (e.g. "no paid APIs" + "must integrate Stripe") → list them under "Open questions", ask the user, do not write a plan.
- A must-have feature has no matching formula → list under "Open questions", recommend either picking a closer formula with adjustments or writing a new one in `autonomous-build/formulas/`.
- vision.md is missing entire sections → ask the user to fill them in before continuing.

## Do not

- Do not run `bd init` or create any issues — that is `/compose`'s job.
- Do not start implementing — even a `package.json` is too early.
- Do not pick a stack the user explicitly excluded.
