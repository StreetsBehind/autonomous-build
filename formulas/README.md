# Formulas

This is the reusable IP of the workflow. Each `.formula.toml` here is a beads workflow template — `bd cook`'d into a proto, then `bd mol pour`'d to spawn real issues with a working DAG.

## How beads formulas work (cheat sheet)

```
formula (TOML)  ──bd cook──▶  proto (template workflow)  ──bd mol pour──▶  molecule (real issues)
```

- **Compile-time** (`bd cook --mode=compile`, default): `{{variable}}` stay as placeholders. Use for inspection.
- **Runtime** (`bd cook --mode=runtime --var k=v`): vars get substituted. Use to actually pour.
- **Persist** (`--persist`): writes the proto to the beads DB so it can be poured later by ID. Default is ephemeral.

Search paths in order:
1. `.beads/formulas/` (project)
2. `~/.beads/formulas/` (user) — **this is where autonomous-build's formulas land via directory junction**
3. `$GT_ROOT/.beads/formulas/` (orchestrator)

## Format

bd 0.55.3 accepts `.formula.json` and `.formula.toml`. **YAML is not supported by the loader despite what some bd help text suggests** — confirmed empirically 2026-05-28. Use TOML for everything new (better ergonomics: multi-line strings, comments).

## Schema

Top-level fields (required unless noted):

| Field | Type | Notes |
|---|---|---|
| `formula` | string | The formula's identifier. **Not `name:`** — that's a bd-schema gotcha. |
| `description` | string (multi-line OK) | One-paragraph summary. |
| `type` | string | `"workflow"` for normal formulas. |
| `version` | int | Schema version, currently `1`. |
| `phase` | string (optional) | `"vapor"` to indicate this should be poured as a wisp rather than persistent issues. Omit for normal formulas. |

Variables go in `[vars.<name>]` tables, one per variable:

```toml
[vars.entity]
description = "Entity name (e.g. Habit, Customer)"
required = true        # optional, default false
default = "value"      # optional
```

Steps are an array of tables:

```toml
[[steps]]
id = "model"                       # required, unique within formula
title = "{{entity}}: data model"   # required, supports {{var}} substitution
type = "feature"                   # bd issue type: task, feature, chore, bug, epic
priority = 1                       # 0-4
needs = ["other-step-id"]          # array of step IDs this depends on
labels = ["ui"]                    # optional, applied to spawned issue
description = """
Free-form body. Acceptance criteria embedded as a markdown section
since bd has no separate `acceptance:` field.

**Acceptance:**
- AC 1
- AC 2
"""
```

For gate steps (async waits on external state):

```toml
[steps.gate]
type = "gh:run"
id = "release.yml"
timeout = "30m"
```

### Test Plan declarations (testPlan)

Steps that produce code with verifiable tests SHOULD declare where those tests live and what they cover. This tells `/build-next` where to extend (vs. inventing a new test file per bead) and feeds the `/quality-pass` audit.

```toml
[steps.testPlan]
file = "tests/services/{{entity_plural}}.test"   # convention path; builder resolves extension
cases = 5
coverage = "create succeeds; read returns by id; update mutates; delete removes; list paginates"
```

Fields:
- `file` — convention path (no extension); the builder resolves to a real file given the stack
- `cases` — integer count of test cases this bead should add to the file
- `coverage` — semicolon-separated list of behaviors covered

**Important:** bd 0.55.3 does not propagate unknown step fields into the spawned issue. `[steps.testPlan]` lives in the formula but bd cook silently drops it. The `/decompose` skill is responsible for parsing the formula TOML after pour and writing the testPlan as bd issue metadata (`testPlanFile`, `testPlanCases`, `testPlanCoverage`). See `autonomous-build-5au` for that work.

### File ownership declarations (`files`)

Steps that write code SHOULD declare the file paths they own, so the orchestrator (`/build-batch`) can avoid dispatching two workers whose touched-file sets intersect. The declaration is an inline array on the step table:

```toml
[[steps]]
id = "service"
title = "{{entity}}: service / repository layer"
type = "feature"
priority = 2
needs = ["migration"]
files = [
  "services/{{entity_plural}}.*",
  "src/services/{{entity_plural}}.*",
  "tests/services/{{entity_plural}}.*",
]
description = """..."""
```

Rules:
- `files` is an array of strings; each entry is a path or glob (`*`, `**`).
- `{{var}}` substitution applies, same as other formula fields.
- Use **multiple alternatives** for stack-dependent paths (e.g. `services/X.*` and `src/services/X.*`) — the orchestrator unions them for intersection checks; the builder picks the one that fits the actual stack.
- Include test files the step also writes (mirrors what `testPlan.file` declares — listing both is fine, the orchestrator dedupes).
- For repo-wide chore steps (lint config, CI workflow), list the specific config files only — don't catch-all with `**`, or every step will conflict with every other step.

Like `testPlan`, the `files` array is dropped by bd cook. `/decompose` parses it from the formula TOML and writes it as bd issue metadata (`filesTouched`). The orchestrator reads `metadata.filesTouched` during dispatch — see `workflows/build-batch.spec.md` ("Dispatch-Bead" / the conflict-aware filter) for the intersection logic, and autonomous-build-1zq.2 for the wiring change.

A step with no `files` declared falls back to the old behavior: the post-merge gate is what catches the conflict. `/build-batch` will warn when it dispatches a bead with no `filesTouched`, so missing declarations surface.

## Templating

bd does **simple variable substitution only**: `{{varname}}`. No Jinja-style filters (`{{name | lower}}` is left literal). If you need lowercased or otherwise transformed values, pass them pre-transformed via `--var`.

## Pouring

Validated end-to-end against bd 0.55.3 on 2026-05-28:

- `bd mol pour <formula-name> --var k=v ...` works directly — no need to `bd cook --persist` first. The compose skill's two-step pattern (`bd cook ... --persist` then `bd mol pour <proto-id>`) is unnecessary indirection.
- Pouring spawns 1 root epic + N child issues (one per step) with `needs:` dependencies translated to bd blocker edges.
- The `--parent <epic-id>` flag that compose documents **does not exist** on `bd mol pour`. To put a poured molecule under an app-level epic, pour first, then run `bd dep add <pour-root-id> <app-epic-id> --type parent-child` to reparent.
- `bd ready` after a pour includes the molecule's root epic. /build-next filters epics client-side (autonomous-build-yk9 fix); any other consumer must do the same.

## Authoring guidance

- **Acceptance is the contract.** If the builder can't self-verify it (e.g. "looks good"), the step blocks. Write acceptance as runnable checks: "endpoint returns 201 on POST with valid body, 400 on missing fields, and an integration test covers both".
- **Keep steps small enough to finish in one tick.** A step that needs 5+ files is usually 2+ steps. (See the sizing audit in `/decompose`, autonomous-build-66t, for the enforced thresholds.)
- **Use `needs` liberally.** Cheap to add, drives parallelism later.
- **Don't bake stack choices into formulas.** A `crud-feature` formula should work for FastAPI+Postgres and Express+SQLite alike. Use variables for the parts that change.

## When to write a new formula

If `/vision` produces a plan that has no good formula for a feature, the answer is *write a new one*, not *handcraft issues with `bd create`*. The library compounds; one-off issues don't.

Process:
1. Sketch the steps as a flat list.
2. Identify what varies between uses → those become variables.
3. Identify what depends on what → `needs`.
4. Write the TOML.
5. `bd cook <new-formula> --mode=runtime --var ...` to validate against the current bd build.
6. Commit to `autonomous-build/formulas/`.
