---
name: split
description: Take an oversized beads issue and a named seam, decompose it into N atomic child beads with dependency rewiring, then close the source as superseded. Use when invoked by /split, when the user says "split this bead", "atomize bead X", or "decompose bead X", or when /quality-pass flags a bead with sizing penalties (>6 ACs, cross-layer reach, file count) and you want to mechanize the fix rather than re-pour the formula.
---

# split

Atomize an oversized beads issue along a named **seam**. Outputs N child beads with rewired dependencies; closes the source as `superseded`. The skill is *propose-then-mutate* — it never writes to bd before the user confirms.

## When to use

- Invoked by `/split <beadId> [seam]`.
- Recommended by `/quality-pass` for any bead scoring under 95 on sizing penalties — splitting is the mechanical fix when remediation rewrites aren't enough.
- The user names a bead they consider too large to build in one /build-next tick.

## When NOT to use

- The bead has empty or one-line acceptance ("works correctly"). That's a /quality-pass rewrite job, not a split. Splitting a vague bead just produces N vague beads.
- The bead is currently `in_progress` by another agent. Wait for it to finish, fail, or unclaim.
- The bead is part of an active formula pour mid-stream. Re-pour the formula with better vars instead.

## Inputs

1. **Bead ID** (required). Accept bare (`bd-1ab.2`) or in a sentence ("split bd-1ab.2 at the API boundary"); extract.
2. **Seam description** (required). The seam IS the decomposition criterion. Without it, splitting is just guessing.
   - If omitted, refuse with a prompt: print the source bead's title + a brief sizing audit, suggest likely seams (cross-layer split, sequential vs. parallel subsystems), and ask the user which to use.
   - Common seam shapes: `"API boundary"`, `"DB migration vs. app code"`, `"per-entity"`, `"read path vs. write path"`, `"happy path vs. edge cases"`.

## Process

### Step 1: resolve and read source

```powershell
bd show $id --json
```

Capture: title, description (parse Acceptance section), `labels`, `priority`, `issue_type`, `metadata` (testPlanFile, filesTouched once autonomous-build-1zq.2 lands), `dependencies` (incoming — what this depends on, including the parent epic), and `dependents` (outgoing — what depends on this).

Identify the parent epic via the parent-child dep edge. Children will be created under the same parent.

If the bead's status is not `open`, refuse — splitting an `in_progress` or `closed` bead is not a meaningful operation.

### Step 2: sizing audit

Apply the /quality-pass sizing rubric to the source:

| Signal | Detection | Penalty |
|---|---|---|
| Acceptance criteria > 6 | Count `- ` / `* ` lines in Acceptance | −10 |
| Files in description > 5 | Count `\b[\w/.-]+\.(ts\|tsx\|js\|py\|sql\|md\|toml\|yaml\|json\|rs\|go\|kt\|swift\|rb\|php\|html\|css)\b` | −10 |
| Cross-layer reach > 2 layers | Mentions of {UI, API, DB, test} | −15 per extra |
| `metadata.testPlanCases` 0/null | Empty | −5 |

If the resulting score ≥95, warn: "this bead looks already-atomic — split anyway?". Some seams (parallelizing two independent sub-deliverables) are valid even on small beads. Proceed if confirmed.

### Step 3: propose the split

From the seam + AC, propose N children. Each child must have:

- A **distinct title** derived from the source title + seam term (e.g. source "Habits CRUD" + seam "API boundary" → "Habits CRUD (DB+API)" and "Habits CRUD (UI)").
- **Acceptance criteria partitioned along the seam.** Each AC of the source bead lands in exactly one child. Do not invent new ACs — children's contracts must be subsets/derivations of the source's. If an AC straddles the seam, that's a hint the seam is wrong; refuse and ask for a different one.
- **File path ownership** — each child enumerates which paths it owns (basis for `filesTouched` metadata once autonomous-build-1zq.2 lands). Ownership sets must be disjoint, or the split doesn't actually decouple the work.
- **Dep graph between children:**
  - **Sequential seam** (UI consumes API; child B uses child A's output): `bd dep add <child_n+1> <child_n>` for each adjacent pair.
  - **Parallel seam** (independent subsystems): no inter-child deps.

**Preserve external edges:**

- For each existing incoming dep on the source (something the source depends on): the **first child** (sequential) or **all children** (parallel) inherits the dep.
- For each existing dependent of the source (something that depends on the source): the **last child** (sequential) or **all children** (parallel) becomes the new blocker.
- The parent-child edge to the parent epic is replaced: each new child gets a fresh parent-child edge to that same epic.

**Re-audit each proposed child** against the rubric. If any child still scores under 95, refuse the split and tell the user: "seam <X> still produces oversized children — try seam <Y>". Better to refuse than ship a same-sized problem twice.

### Step 4: confirm before mutate

This step is the contract: **no bd mutations happen before explicit user confirmation.**

Print the proposal as a readable plan:

```
SPLIT PROPOSAL — <sourceId> "<source title>"

Seam: <seam description>
Mode: <sequential | parallel>

Children:
  A. <title-A>
     ACs: <n> (lifted from source ACs <i,j,k>)
     Files: <list of owned paths>
     Sizing score: <score>/100
  B. <title-B>
     ACs: <n> (lifted from source ACs <l,m>)
     Files: <list of owned paths>
     Sizing score: <score>/100

Dep graph:
  <sequential: A → B    | parallel: A ∥ B>

External edges preserved:
  Incoming: <external-blocker-id> → A
  Outgoing: <external-dependent-id> ← B

Source <sourceId> will close with reason: "superseded by <A-id, B-id>"

Confirm?
```

Use AskUserQuestion with options `Confirm`, `Refine seam`, `Cancel`. Until the user picks `Confirm`, do NOT call any mutating bd command (`bd create`, `bd update`, `bd close`, `bd dep add`). This rule is absolute — if the user picks "Refine seam", go back to Step 3 with the new seam and re-propose.

### Step 5: mutate (only after Confirm)

For each child, write its body to a temp file (multi-line descriptions are easier this way), then:

```powershell
bd create "<child title>" `
  --type=task --priority=<source priority> `
  --parent=<parent-epic-id> `
  --labels=<source labels joined by comma> `
  --body-file=<tmp-path> `
  --silent
```

Capture each new ID into `$newIds`.

Then rewire deps:

```powershell
# Inter-child (sequential only):
for ($i = 1; $i -lt $newIds.Count; $i++) {
  bd dep add $newIds[$i] $newIds[$i-1]
}

# Preserve incoming edges (deps the source had on external blockers):
foreach ($blocker in $externalIncoming) {
  if ($mode -eq 'sequential') { bd dep add $newIds[0] $blocker }
  else                        { foreach ($c in $newIds) { bd dep add $c $blocker } }
}

# Preserve outgoing edges (things that depended on the source):
foreach ($dependent in $externalOutgoing) {
  if ($mode -eq 'sequential') { bd dep add $dependent $newIds[-1] }
  else                        { foreach ($c in $newIds) { bd dep add $dependent $c } }
}
```

Close the source:

```powershell
bd close <sourceId> --reason "superseded by $($newIds -join ', ')"
```

(`bd close --reason` is supported as of bd 0.55.3; verified 2026-05-28.)

### Step 6: validate

```powershell
bd dep cycles                    # must report none
bd ready --json                  # the first child (sequential) or all children (parallel) should appear
bd show <sourceId> --json        # status must be 'closed' with the reason populated
```

If `bd dep cycles` reports a cycle, **rollback**:

1. Close each newly-created child with reason "split rolled back: introduced cycle".
2. Reopen the source: `bd update <sourceId> --status=open`.
3. Report the cycle to the user and exit. Do not retry — the seam choice produced a malformed graph.

### Step 7: sync

```powershell
bd sync --flush-only
```

## Output

One-paragraph summary:

```
SPLIT COMPLETE — <sourceId> → <new-id-A>, <new-id-B>, ...
  Seam: <seam>
  Mode: <sequential | parallel>
  Ready now: <ids of newly-ready children>
  Parent epic: <parent-id>
```

If the source's children include the next /build-next target, mention it.

## Stopping conditions (refuse, do not guess)

- Bead ID doesn't resolve → exit and ask for clarification.
- Seam missing → refuse with prompt for a seam (Step "Inputs").
- Source bead status ≠ open → refuse.
- Source AC straddles the proposed seam (an AC can't land cleanly in one child) → refuse, recommend a different seam.
- Re-audit shows any child is still oversized → refuse, recommend a different seam.
- User picks `Cancel` or anything other than `Confirm` → exit clean, zero mutations.
- `bd dep cycles` reports a cycle after mutation → rollback (Step 6), report, exit.

## Do not

- Do not mutate without explicit user confirmation. **Confirm before mutate** is the contract of this skill — propose, wait, then write.
- Do not split a bead with vague AC. Run /quality-pass first to rewrite the AC concretely; splitting a vague bead just produces N vague beads.
- Do not split a bead that is `in_progress` by another agent. Status check is non-negotiable.
- Do not invent new ACs. Children's ACs must be partitions of the source's ACs. Adding requirements during the split is a different operation (call it scope-creep) and must be refused.
- Do not drop external dep edges. Preserving incoming and outgoing edges is a correctness requirement, not a polish step.
- Do not use this skill to merge two beads. That's a different operation — file it separately if you need it.
- Do not chain splits in one invocation. One bead → N children per /split call. If a child still needs splitting, run /split again on the child.

## Relationship to other skills

- **/quality-pass** is the natural caller: it scores beads and recommends `/split` for any bead under 95 on sizing penalties. The "Remediations" section of quality-pass output names the seam; this skill executes the decomposition.
- **/compose** pours formulas to produce beads in the first place. If you find yourself splitting the same shape of bead repeatedly, the formula is wrong — fix the formula, not the per-bead split.
- **/build-next** consumes the children. After a split, the next /build-next tick will pick the first child (sequential) or one of the leaves (parallel).
