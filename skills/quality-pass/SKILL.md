---
name: quality-pass
description: Read-only audit of a beads epic before dispatching builders. Scores each child bead 0-100 against a penalty rubric (sizing, spec concreteness, context, risk), proposes specific remediations to reach >=95, and verifies the epic faithfully implements its source plan. Use when invoked by /quality-pass, when /compose suggests running it before /loop /build-next, when the user asks "is epic X buildable", or when the user wants to audit/score/review a planned epic before dispatching builders.
---

# quality-pass

Predict whether each bead in a given epic is buildable in one shot by `/build-next` (target: ≤70k tokens of work) and whether the epic, as a whole, faithfully implements its source plan. Output is a markdown report the user reads and applies manually.

The skill is **read-only and propose-only**. It scores, suggests fixes, and never writes to bd.

## When to use

- Invoked by `/quality-pass <epicId>`.
- Suggested by `/compose` after a fresh DAG is created — run before `/loop /build-next`.
- Any time the user asks "what's the confidence on epic X" or "is this epic ready to build".

## Inputs

A single epic ID (e.g., `app-myapp-1ab`). If no ID is given, run `bd list --type=epic --status=open --json` and ask the user to pick one. Accept the ID whether the user passes it bare or in a sentence.

## Tools

- **Bash/PowerShell**: `bd show`, `bd list`, `bd dep`, `bd ready` — READ commands only.
- **Read**: `plan.md`, `AGENTS.md`, `formulas/*.formula.toml` (in `~/.beads/formulas/` or repo `.beads/formulas/`).
- **Glob/Grep**: sanity-check that file paths named in bead descriptions exist.

> ⛔ **Read-only enforcement**
> Never call `bd update`, `bd create`, `bd close`, `bd dep add`, or any other mutating bd subcommand. Never use Write or Edit. The output of this skill is text in your response — the user copies suggestions into bd themselves.

## Workflow

```
1. Resolve epic and child beads
2. Locate the source plan (plan.md in CWD by default; report each lookup attempt)
3. Read AGENTS.md for locked decisions (Phase-0 invariants)
4. For each child: freshness check → rubric score (or "stale" → recommend closure)
5. For each bead under 95: propose specific remediations
6. Epic-level faithfulness checks (coverage, drift, deps, invariants)
7. Emit the report
```

### Step 1: resolve epic + children

```powershell
bd show $epicId --json                       # epic itself
bd list --parent $epicId --status=open --json   # open children
bd list --parent $epicId --status=closed --json # closed children (count toward coverage)
```

If the epic doesn't exist or has no children, report this and stop.

### Step 2: locate the source plan

Try in order. **Report each thing tried** — transparency matters here.

| Order | Source | How |
|-------|--------|-----|
| 1 | `plan.md` in repo root | Read directly |
| 2 | Epic description references | Grep epic description for paths like `plan.md`, `specs/*.md` |
| 3 | Parent epic chain | If this epic has a parent epic, recurse up |
| 4 | Bead-level breadcrumbs | Many bead descriptions cite a plan section; collect the most-referenced path |

If nothing matches: cap epic faithfulness score at **60**, emit:

```
Faithfulness: 60/100 (capped — no source plan identified)
Tried: plan.md (missing), epic.description (no path refs), parent chain (none), bead breadcrumbs (none).
Action: please point me at the source plan (path or URL) and I'll re-run the faithfulness check.
```

Then continue with per-bead scoring (which doesn't depend on the plan) but skip Step 6.

### Step 3: read AGENTS.md for invariants

If `AGENTS.md` exists at repo root, read it once. Extract any locked decisions ("do not revisit", "Phase 0", explicit non-goals). These feed the **Phase-0 invariant check** in Step 6.

### Step 4: per-bead scoring

For each child bead, run `bd show $beadId --json`. Inspect:

- `title`, `description`, parsed acceptance criteria
- `metadata.testPlanFile`, `metadata.testPlanCases`, `metadata.testPlanCoverage` (written by `/compose` post-pour, see autonomous-build-5au)
- `dependencies` (from the dep graph)
- `labels`

#### Freshness check (run BEFORE the rubric)

Each bead description is a snapshot of the codebase at filing time. Sibling beads or manual edits may have already satisfied the AC. If you score a stale bead with the rubric, you'll produce a confident-looking number for a bead that should just be closed.

Verify the bead's **load-bearing claims**:

- "File X does not exist" → `Test-Path X` or Glob
- "X is not wired into Y" → grep for the wiring, confirm absent
- "X has N lines / imports" → check the current numbers

Three outcomes:

- **Stale** — AC already met by code that landed after the bead was filed. Mark `score: N/A (stale)`, skip the rubric, **recommend closure** with reason "AC already met". Cite the file path if you can pinpoint it.
- **Drifted** — claims partially out of date, AC still not met. Score normally, but **list the drift in a "Freshness notes" line** under the score.
- **Fresh** — claims match current code. Proceed to scoring with no note.

#### Rubric (start at 100, apply penalties, floor at 0)

**Sizing penalties** — protect the builder's context budget

| Signal | Detection | Penalty |
|---|---|---|
| Acceptance criteria > 6 | Count `- ` or `* ` lines in the Acceptance section | −10 |
| Files in description > 5 | Count tokens matching `\b[\w/.-]+\.(ts|tsx|js|jsx|py|sql|md|toml|yaml|json|rs|go|java|kt|swift|rb|php|html|css)\b` | −10 |
| Cross-layer reach > 2 layers | Mentions of UI/component, API/endpoint, DB/migration, test — each extra layer beyond 2 | −15 each |
| testPlanCases missing or 0 | `metadata.testPlanCases` is null or 0 | −5 |

**Spec concreteness penalties**

| Signal | Detection | Penalty |
|---|---|---|
| Vague AC | "works correctly", "handles errors gracefully", "is performant" without numeric thresholds | −5 each |
| File paths missing | No file paths named for new code, not inferrable from existing structure | −10 |
| API contract missing | New endpoint/RPC mentioned but no request/response shape, no schema | −10 |
| testPlanFile missing | `metadata.testPlanFile` empty — `/compose` should have written it from the formula's `[steps.testPlan]` (autonomous-build-5au). If empty, either the formula step had no testPlan or compose's metadata write failed. | −10 |
| Edge cases unstated | No "out of scope:" or edge-case enumeration | −5 |

**Context completeness penalties**

| Signal | Detection | Penalty |
|---|---|---|
| No links to prior beads/specs | No bead IDs, no spec paths, no existing-code pointers | −5 |
| Domain terms undefined | Project-specific jargon without definition | −5 |
| Dependency graph mismatch | Bead asserts "after X" but no `bd dep` link exists, OR a link exists for a non-real dependency | −10 |
| Open questions left for builder | "?", "TBD", "we should decide…" | −5 each |

**Risk-signal penalties** (additive)

| Signal | Penalty |
|---|---|
| New external library/API integration | −10 |
| Schema migration coupled to UI in same bead | −15 |
| Browser verification required, no test harness | −10 |
| "And/also/plus" in title/AC suggesting two beads merged | −5 |

**Always record** the exact phrase or absence that triggered each penalty, and the amount. A bare number is unfalsifiable.

### Step 5: remediations

For every bead with score < 95, propose remediations **specific to this bead** — paste exact types, name exact files, suggest exact seams. Generic advice is worthless.

| Pattern | When | Output |
|---|---|---|
| **Split** | Sizing penalties dominate, especially cross-layer | Suggest the seam: "Split into Xa (DB+API) and Xb (UI consuming the API). The API is the stable boundary." |
| **Pin contracts** | API contract missing | Paste the proposed schema/types directly. |
| **Add file map** | File paths missing | Enumerate: "Files to read: A, B, C. Files to create: X. Files to modify: Y." |
| **Add test list** | testPlanFile missing | Name target file and cases: "`tests/services/widgets.test`: 1) create succeeds, 2) read by id, 3) delete removes, 4) list paginates". This is the kind of thing the formula's `[steps.testPlan]` should have declared — if /compose dropped it, surface that as a separate issue too. |
| **Lift ambiguity** | Open questions | Convert each "?" into an answer with rationale. |
| **Insert prerequisite bead** | Read-cost > 15k tokens just to understand existing code | Suggest a research bead whose deliverable is a design note the builder reads. |

After listing remediations, sum the penalty amounts they would clear. If that sum brings the score to ≥95, say so. If not, surface that the bead is genuinely too big and recommend splitting even if you suggested other remediations.

### Step 6: faithfulness checks (epic-level)

Skip if no plan was found.

| Check | How | Severity |
|---|---|---|
| **Coverage** | Parse `plan.md` §"Feature order"; for each feature, check ≥1 child bead implements it. List unmapped requirements. | each gap = listed |
| **Traceability** | Each bead should cite the plan section / formula it serves. Flag beads with no citation. | listed |
| **Scope drift** | Each bead should derive from the plan. Flag beads that introduce work the plan doesn't describe. | listed; recommend trim OR plan amendment |
| **Phase-0 invariants** | For each locked decision in `AGENTS.md`, scan bead descriptions for language that revisits it. | each violation = ⛔ |
| **Dependency sanity** | Check `bd dep` graph: serialized work that could be parallel, missing deps where B clearly needs A's output. | listed with suggested fixes |
| **testPlan coverage** | Every implementation bead (non-chore, non-epic) should have `metadata.testPlanFile` populated. Beads missing this metadata indicate either the formula step had no testPlan declaration or compose's metadata write failed. | each missing = listed |

Compute faithfulness: start at 100. Each coverage gap −5, each ⛔ invariant violation −15, each scope-drift bead −5, each dep mismatch −5, each testPlan-coverage gap −5. Floor at 0.

### Step 7: output

Use this template. The user has tooling that may parse it.

```
# Quality Pass: <epicId> — <epic title>

**Faithfulness:** <N>/100
**Source plan:** <path or "not identified">
**Locked decisions checked:** <list from AGENTS.md, or "none — AGENTS.md absent">
**Generated:** <ISO timestamp>

---

## Faithfulness analysis

### Coverage
- plan.md §<section> (<requirement>) → <beadId> ✓
- plan.md §<section> (<requirement>) → **GAP** (no bead)
- ...

### Drift
- <beadId> adds <what> not described in plan — recommend <trim | amend plan>
- ...

### Phase-0 invariants
- ✓ <invariant from AGENTS.md>
- ⛔ <beadId> violates <invariant>
- ...

### Dependency graph
- ✓ Topology reflects technical reality
- ⚠ <beadA> and <beadB> could run in parallel; consider removing the `bd dep` link
- ⚠ <beadC> needs <beadD>'s output but no link exists

### testPlan coverage
- ✓ <beadId> — metadata.testPlanFile = <path>
- **GAP** — <beadId> — no metadata.testPlanFile; formula step <name> declared no testPlan

---

## Per-bead scores

### <beadId> — <title> — <score>/100  <✓ ready | ⚠ needs work | ⛔ at risk | ◌ stale>

**Freshness:** <fresh | drifted: <note> | stale: AC already met by <file/ref>>

(For stale, stop here — recommend closure, do not run rubric or remediations.)

**Penalties applied:**
- −10 (>6 ACs; counted 9)
- −15 (cross-layer: UI + API + migration in one bead)
- −10 (testPlanFile missing — formula step had no [steps.testPlan])
- −5 (vague AC: "handles edge cases gracefully")

**Remediations to reach ≥95:**

1. **Split into <idea-a> and <idea-b>** along the API boundary.
   - <idea-a>: migration + RPC. Deliverable: working RPC with tests.
   - <idea-b>: UI consuming the RPC. Deliverable: form, submission, success state.
   - Estimated penalty cleared: −25.

2. **Add testPlanFile** in the formula's `[steps.testPlan]` (autonomous-build-5au will then write it to the bead metadata at next pour):
   ```toml
   [steps.testPlan]
   file = "tests/endpoints/widgets.test"
   cases = 5
   coverage = "POST 201; GET 200; GET 404; PUT updates; DELETE removes"
   ```
   Estimated penalty cleared: −10.

3. **Replace AC-7** ("handles edge cases gracefully") with concrete ACs:
   - AC-7a: duplicate submission within 60s returns the existing ID (idempotent)
   - AC-7b: submission against a deleted parent returns 404 with no row written
   Estimated penalty cleared: −5.

**Projected score after remediation: 100/100.**

---

(Repeat for each bead under 95. Beads ≥95 get a one-liner: "<beadId> — <title> — <score>/100 ✓".)
```

## Critical rules

> ⛔ **Read-only**
> Never call any mutating bd command, never Write/Edit, never modify a worktree. Output is text only.
>
> ⛔ **Plan inference must be transparent**
> List every source you tried, even if the first succeeded. The user needs to know whether you cheated by using a stale plan.
>
> ⛔ **Score breakdown is mandatory**
> Never report a score without the penalty list. A bare number is unfalsifiable.
>
> ⛔ **Remediations must be specific**
> "Add an API contract" is not a remediation. "Add this exact schema: `{ id: string, name: string }`" is.
>
> **Cap epic faithfulness at 60 if no source plan**
> The skill is dishonest if it confidently scores faithfulness without knowing what the epic was supposed to do.

## When NOT to trigger

- The user asks for *current state* of an epic ("how many beads are done?") → that's `bd stats` / `bd show`, not this skill.
- The user wants to *modify* a bead → direct them to do it via bd. This skill only proposes.
- The user wants the skill to actually fix the issues it finds. It can't. It's propose-only by design.
- The user asks for a quality pass on a single bead → operates at epic granularity; recommend wrapping in a one-bead epic or running against the bead's parent epic.

## Tips for a useful pass

- **Sanity-check file paths before scoring.** If a bead names `src/components/Foo.tsx`, glob to confirm the parent dir exists. Paths in nonexistent directories get the "file paths missing" penalty.
- **Dependency mismatches are subtle.** Read for "after X" or "depends on Y" and cross-check the actual `bd dep` graph.
- **AGENTS.md is the project's constitution.** Treat it as ground truth for invariants. If a bead contradicts it, the bead loses.
- **The rubric is opinionated, not divine.** If a penalty rule produces nonsense for a specific bead, say so in the report ("rubric flagged X but I think it's actually fine because Y") and let the user decide. Mechanical scoring is a tool, not a verdict.
