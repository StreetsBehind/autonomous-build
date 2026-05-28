# Formulas

This is the reusable IP of the workflow. Each `.formula.yaml` here is a beads workflow template — `bd cook`'d into a proto, then `bd mol pour`'d to spawn real issues with a working DAG.

## How beads formulas work (cheat sheet)

```
formula (YAML)  ──bd cook──▶  proto (template epic)  ──bd mol pour──▶  molecule (real issues)
```

- **Compile-time** (`bd cook --mode=compile`, default): `{{vars}}` stay as placeholders. Use for inspection.
- **Runtime** (`bd cook --mode=runtime --var k=v`): vars get substituted. Use to actually pour.
- **Persist** (`--persist`): writes the proto to the beads DB so it can be poured later by ID. Default is ephemeral.

Search paths in order:
1. `.beads/formulas/` (project)
2. `~/.beads/formulas/` (user) — **this is where autonomous-build's formulas land via symlink**
3. `$GT_ROOT/.beads/formulas/` (orchestrator)

## Schema (current best understanding)

> The formulas below are first-cut. **Validate by running `bd cook <name> --dry-run` inside a `bd init`'d project before relying on them.** If the schema differs, fix the formula and update this README.

A formula is YAML/JSON with these top-level keys:

```yaml
name: <kebab-case-id>           # also the filename stem
description: <one line>
extends: <other-formula-name>   # optional inheritance
variables:
  - name: <var>
    default: <value>            # optional
    required: true|false
    validate: <regex or rule>   # optional
steps:
  - id: <step-id>
    title: <issue title, may contain {{vars}}>
    type: task|feature|chore    # beads issue type
    priority: 0..4
    description: |
      <issue body>
    acceptance: |
      <how the builder knows it's done — concrete, verifiable>
    design: |
      <implementation hints>
    depends_on: [<step-id>, ...]
    labels: [<label>, ...]
```

## Authoring guidance

- **Acceptance is the contract.** If the builder can't self-verify it (e.g. "looks good"), the step blocks. Write acceptance as runnable checks: "endpoint returns 201 on POST with valid body, 400 on missing fields, and an integration test covers both".
- **Keep steps small enough to finish in one tick.** A step that needs 5+ files is usually 2+ steps.
- **Use `depends_on` liberally.** Cheap to add, drives parallelism later.
- **Don't bake stack choices into formulas.** A `crud-feature` formula should work for FastAPI+Postgres and Express+SQLite alike. Use variables for the parts that change.

## When to write a new formula

If `/vision` produces a plan that has no good formula for a feature, the answer is *write a new one*, not *handcraft issues with `bd create`*. The library compounds; one-off issues don't.

Process:
1. Sketch the steps as a flat list.
2. Identify what varies between uses → those become variables.
3. Identify what depends on what → `depends_on`.
4. Write the YAML.
5. `bd cook <new-formula> --dry-run --var ...` to validate.
6. Commit to `autonomous-build/formulas/`.
