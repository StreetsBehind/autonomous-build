# plan.lock.json

Machine-readable mirror of `plan.md`. Emitted by `/vision` alongside the human narrative; consumed by `/compose` as the authoritative source for stack, data model, features, formula picks, cross-feature dependencies, and the escalation budget.

`plan.md` remains the human-readable contract. `plan.lock.json` exists because `/compose` used to regex-parse markdown for feature names — a fragile parse where a typo in an em-dash placement silently dropped a feature, caught only by the end-of-pour coverage check. The lock removes the parse fragility without removing the narrative.

## Schema

The full JSON Schema lives at [`schemas/plan.lock.schema.json`](../schemas/plan.lock.schema.json) (draft 2020-12).

Top-level shape:

```jsonc
{
  "schemaVersion": 1,
  "app": { "name": "habit-tracker", "description": "..." },
  "stack": {
    "language":  { "choice": "TypeScript", "why": "team familiarity" },
    "backend":   { "choice": "Next.js API routes", "why": "single deploy target" },
    "frontend":  { "choice": "Next.js + React", "why": "..." },
    "database":  { "choice": "SQLite", "why": "simple-v1, file-backed" },
    "orm":       { "choice": "Drizzle", "why": "..." },
    "auth":      { "choice": "email+password", "why": "..." },
    "hosting":   { "choice": "Fly.io", "why": "..." },
    "tests":     { "choice": "Vitest + Playwright", "why": "..." },
    "lint":      { "choice": "Biome", "why": "..." }
  },
  "dataModel": [
    {
      "entity": "Habit",
      "fields": ["id", "name", "description", "createdAt"],
      "relationships": ["belongs_to User"],
      "notes": "name is unique per user"
    }
  ],
  "featureOrder": [
    {
      "name": "App skeleton",
      "formulas": ["app-skeleton"],
      "vars": { "name": "habit-tracker" }
    },
    {
      "name": "Habits CRUD",
      "formulas": ["crud-feature"],
      "vars": { "entity": "Habit", "fields": ["name", "description"] }
    }
  ],
  "crossFeatureDependencies": [
    {
      "blocked": "Habits CRUD",
      "blocker": "App skeleton",
      "reason": "auth routes must exist first"
    }
  ],
  "escalationBudget": {
    "maxSessionCostUsd": 5.00,
    "maxFailuresPerTask": 2,
    "additionalBlockTriggers": ["schema migration on existing data"]
  },
  "openQuestions": [
    {
      "question": "Should habits be soft-deleted or hard-deleted?",
      "blockingCompose": false,
      "context": "Defaulted to soft-delete; flag for review pre-launch."
    }
  ],
  "agentConsults": [
    {
      "question": "Habit-streak push notifications: add a queue (Redis/SQS) or run inline?",
      "decision": "Run inline on the Rust core; revisit if p99 latency on the streak endpoint exceeds 200ms in real load.",
      "rationale": "Counter-arguer showed the streak endpoint is read-mostly and the notification fan-out is <100 users for v1; architect's queue addition added a new infra row without serving a current pain point.",
      "reversalCost": "Adding a queue later is a single new service + one Rust worker crate — no data migration needed since streak state stays in Postgres."
    }
  ],
  "incomplete": false
}
```

## Field reference

### `schemaVersion` (required)
Integer `1`. `/compose` refuses unknown versions rather than guessing at compatibility.

### `app` (required)
- `name` — slug used in `bd create "<app name>" --type=epic`.
- `description` — optional one-liner for the epic body.

### `stack` (required)
Object keyed by layer name. Allowed keys: `language`, `backend`, `frontend`, `database`, `orm`, `auth`, `hosting`, `tests`, `lint`. Each value is `{choice, why}`. Mirrors the Stack table in `plan.md`. Layers that don't apply (e.g. no frontend for a CLI app) are omitted, not nulled.

### `dataModel` (required, may be empty)
Array of entities. `fields` and `relationships` are free-form strings — schema-as-prose, not schema-as-DDL. The first migration formula will translate.

### `featureOrder` (required)
Ordered array. Each entry names one or more formulas to pour and the variable bindings. `vars` values may be strings, numbers, booleans, or arrays of those (everything the bd CLI `--var k=v` syntax accepts). Order is significant — `/compose` pours in this order, and cross-feature deps assume earlier entries pour first.

### `crossFeatureDependencies` (required, may be empty)
Each entry becomes a `bd dep add <blocked> <blocker>` call after the pour. `blocked` and `blocker` are either feature names (matching `featureOrder[].name` — `/compose` resolves to the pour root) or specific bead IDs if known in advance.

### `escalationBudget` (required)
- `maxSessionCostUsd` — `/build-next` cumulative session cost ceiling.
- `maxFailuresPerTask` — block after this many gate failures on the same bead.
- `additionalBlockTriggers` — free-form strings appended to `docs/ESCALATION_RULES.md`'s defaults for this app.

### `openQuestions` (required, may be empty)
**Product/scope questions** `/vision` could not resolve. Each has `question`, `blockingCompose` (bool), and optional `context`. If any item has `blockingCompose: true`, `incomplete` MUST be `true` and `/compose` will refuse with the question list.

Tech ambiguity does **not** belong here — it routes to `agentConsults`. See `skills/vision/SKILL.md` step 7 for the consult protocol and `docs/DEFAULT_STACK.md` for the pinned stack.

### `agentConsults` (optional, may be empty or omitted)
Decisions `/vision` made via the 3-agent off-stack consult (architect / reviewer / counter-arguer) rather than paging the human. Each entry has `question`, `decision`, `rationale`, and `reversalCost` — all required strings. The human reviews these at the `plan.md` gate after `/vision` finishes and can reverse them by editing the plan; they are not surfaced as blocking questions during planning.

### `incomplete` (required)
Boolean. True iff any `openQuestions[].blockingCompose === true`. Written explicitly (not derived at read time) so a malformed lock fails validation rather than silently passing.

## How `/vision` writes it

After producing `plan.md`, `/vision` writes the structured equivalent to `plan.lock.json` in the same directory and validates against `schemas/plan.lock.schema.json` before saving. If validation fails, `/vision` stops — do not write a partial lock.

If `openQuestions` contains any `blockingCompose: true` entry, write the lock anyway with `incomplete: true`. This gives `/compose` a structured reason to refuse rather than silently parsing an unfinished plan.md.

## How `/compose` reads it

`/compose` Step 4 reads `plan.lock.json` before touching `plan.md`:

1. If present and valid:
   - If `incomplete: true` → refuse with the open-question list.
   - Otherwise, use `featureOrder` for the pour loop and `crossFeatureDependencies` for Step 6. `plan.md` is only read for the human narrative (printed in summaries, never parsed).
2. If absent → fall back to the legacy `plan.md` regex parse with a deprecation warning: `plan.lock.json missing — falling back to plan.md parse; rerun /vision to generate the lock`.
3. If present but schema-invalid → refuse with the validator error. Do NOT fall back; a malformed lock indicates a `/vision` bug that should be fixed at the source.

The coverage check in compose Step 5 still runs (cheap insurance), but with the lock as source of truth it should never fire — it's now backstop for the fallback path.

## Versioning

Schema is versioned via the top-level `schemaVersion` integer. Bumping rules:

- **Non-breaking additions** (new optional field, new allowed enum value) — no version bump.
- **Breaking changes** (renamed/removed field, changed type, new required field) — bump `schemaVersion`. `/compose` refuses unknown versions; bump in lockstep with the `/compose` reader.

The schema file itself is the source of truth; this doc is a guide.
