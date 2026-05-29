---
name: vision
description: Convert a filled-out vision.md into a concrete plan.md (tech stack, data model, feature order, formula picks). Use when the user says "run vision", "vision-to-plan", or invokes /vision on a fresh app repo that has vision.md present.
---

# vision

`/vision` is the product checkpoint of the pipeline — the last human-in-the-loop gate before the autonomous build begins. It is implemented as a **hybrid** (epic `autonomous-build-ih5`): this skill is the **thin conversational shell**, and the deterministic planning engine lives in the **`vision` dynamic workflow** (`workflows/vision.js`, spec `workflows/vision.spec.md`).

**This skill does NOT contain the planning procedure.** Stack resolution, the data model, feature order, formula picks, the concern fan-out (one agent per applicable concern), the four gates (forward-coverage, reverse-trace, decidedness, must-have↔non-goal), the required+excluded contradiction scan, NFR lifting, `plan.lock.json` schema validation, and `plan.md` / `tenets.md` rendering **all live in the workflow.** The shell only holds the parts that need a human turn: the product conversation, the off-stack consult, and presenting the gate. (Meta vs app discipline: keeping the heavy logic in the workflow is the whole point of the hybrid.)

## Inputs

- `vision.md` in the current working directory (filled out from `autonomous-build/templates/vision.md`).
- The user is present — **the checkpoint is for product, not tech.** Stack, framework, database, auth, hosting, tests, lint all come from the pinned `docs/DEFAULT_STACK.md`, which the workflow reads itself. Never ask the user a technical question.
- The workflow inlines `docs/DEFAULT_STACK.md` and `docs/PLAN_CONCERNS.md` (it runs in the app cwd where those docs don't exist), so the shell does not need to read them.

## Process

### 1. Read `vision.md` and quote it back for correction

Read it end to end — do not skim. Then, **for the human-correction quote-back only** (the workflow re-derives these canonically), assign:
- a stable ID to each §3 must-have — `M1`, `M2`, … in document order (one per discrete capability; split a bullet that bundles two);
- a step ID to each observable in the §8 success metric — `S1`, `S2`, …

**Quote back** to the user the §5 *non-goals*, §6 *constraints*, §8 *success metric*, and the IDed §3 *must-haves* (`M1: …`, `M2: …`) so they can catch a mis-split or missed must-have **before** the engine runs. Do **not** ask any technical question.

### 2. Fill missing product sections (conversation, not invention)

The workflow's load-bearing sections are §1 (problem), §3 (must-haves), §8 (success metric). If any is empty or still a template placeholder, **help the human fill it now** — otherwise the workflow returns NEEDS-INPUT with a `missing-product-sections` block. Missing §7 (tech preferences) is fine; that section is ignored. **Do not invent product content** (T1) — ask the human.

### 3. Off-stack consult — the one technical decision the shell owns

If a §3 must-have plainly needs something outside the pinned stack (a queue, a websocket gateway, a vector DB, a third-party API integration shape), do **not** page the human and do **not** add a tech question. Spawn the 3-agent consult in a single message:
- `Agent(subagent_type=Plan, prompt="Given the Jankurai stack in docs/DEFAULT_STACK.md and feature <X>, propose the minimal addition or an alternative that stays on-stack. Argue for your recommendation.")`
- `Agent(subagent_type=general-purpose, prompt="For feature <X> on the Jankurai stack, list the load-bearing risks of any off-stack addition and what we lose by staying on-stack.")`
- `Agent(subagent_type=general-purpose, prompt="Argue that feature <X> can be served entirely from the Jankurai stack with no additions. Show how.")`

Synthesize one decision. To feed it into the engine, record it as a `Decided: <one line>` note in `vision.md` §10 (anything-else) so the workflow's headless skeleton build picks it up, **or** carry it in a frozen skeleton and pass `--skeleton` (see step 4). Most apps are fully on-stack and skip this step entirely.

### 4. Invoke the workflow

Hand off to the `vision` dynamic workflow — the engine that builds + freezes the skeleton, fans out one agent per applicable concern over it, runs the four gates + the required+excluded scan, computes the decidedness verdict, and **assembles + validates + writes** `plan.lock.json` (schemaVersion 2) + `plan.md` + `tenets.md`. The shell writes none of those files itself.

Invoke it with the **Workflow tool**, not as a slash command:

```
Workflow(name: "vision", args: "--vision vision.md")
```

- Add `--no-file` to dry-run the derivation and inspect the would-be lock + verdict before anything lands.
- Pass `--skeleton <path>` only when step 3 produced a frozen skeleton to inject a consult decision; otherwise the workflow builds the skeleton headlessly from `vision.md`.
- **Replan** (epic 0ms): `Workflow(name: "vision", args: "--replan-from N")` is `/replan` — a scoped re-run that **freezes** built phases `< N` and **re-derives** phases `>= N` using the prior build's outcomes + the latest retro. Use it between phases of a phased build (driven by `/orchestrate`). A must-have dropped (not deferred) during the re-cut comes back as a blocking `replan-dropped-musthave` openQuestion — a product decision to confirm at the gate, not a silent edit. Present the revised phase split (`plan.md` §Phases) at the same human gate `/vision` uses.

The workflow returns:

```
{ status: 'ok' | 'needs-input' | 'failed', incomplete: <bool>, openQuestions: [...], reportPaths: { planLock, planMd, tenets } }
```

### 5. Present the gate (the human checkpoint)

Branch on the return. This is the surface `/orchestrate` Stage 1 reads, so relay `incomplete` + `openQuestions` faithfully.

- **COMPLETE** (`status: 'ok'`, `incomplete: false`) — present the gate. Show the human the written `plan.md`, and from it the **Coverage table** (every must-have → the feature(s) that deliver it + *how*) and the **Concerns table** (every concern → status + falsifiable evidence / exclusion reason). State **PASS** explicitly. The human can edit `plan.md` or reverse a consult here; otherwise: *"ready for /decompose."*

- **NEEDS-INPUT** (`status: 'needs-input'`, `incomplete: true`) — surface the blocking `openQuestions`, grouped by their gate token (the `context` prefix):
  - `missing-product-sections` → name the empty §section to fill.
  - `forward-coverage` (a must-have maps to no feature) / `reverse-trace` (an orphan feature) / `musthave-nongoal-contradiction` / `required-excluded-contradiction` / `concern-decidedness` → state the product question to resolve.
  - `no-matching-formula` or a stack-deviation block → this is an **off-stack signal**, not a human gate: run the step-3 consult, record the decision, and re-run. Do **not** page the human for it.

  For the product blocks, instruct the human to **edit `vision.md`** (the durable input — edits land there, not as in-chat patches; T10), then **re-run `/vision`**. The lock was written with `incomplete: true`, so `/decompose` pre-flight refuses it cleanly until the questions are resolved.

- **FAILED** (`status: 'failed'`) — the assembled lock failed schema validation. This is a *workflow bug*, not a product gap; nothing was written. Surface the `validationErrors` and treat it as a `/flag --upstream` signal, not a human product gate.

## Outputs

The workflow writes the three paired files in the app repo CWD: `plan.md` (human-readable contract), `plan.lock.json` (schemaVersion 2, validated against `schemas/plan.lock.schema.json`), and `tenets.md` (T1–T10 inherited + app-specific). The shell writes nothing — it relays the verdict and presents the gate.

## Stopping conditions

Only **product/scope** ambiguity stops the plan; tech ambiguity is never a stopping condition — it routes to the step-3 consult or to `docs/DEFAULT_STACK.md`.

- A load-bearing product section (§1/§3/§8) is empty → fill it with the human (step 2) before invoking.
- The workflow returns a blocking `openQuestion` on a product gate → surface it, the human edits `vision.md`, re-run.

## Do not

- **Do not re-implement the planning procedure in this skill.** Stack resolution, data model, feature order, formula picks, concern derivation, the gates, NFR lifting, validation, and rendering live in `workflows/vision.js`. If the engine needs a change, edit the workflow (and its spec, in lockstep) — not this shell.
- Do not run `bd init` or create any issues — that is `/decompose`'s job.
- **Do not ask the user any technical question.** Off-stack needs go through the step-3 consult, not the human.
- Do not edit `vision.md` yourself to paper over a NEEDS-INPUT block — the human edits it and re-runs (T10). (The one exception: recording a step-3 consult `Decided:` note in §10.)
- Do not invent product content (must-haves, users, features) to get past a NEEDS-INPUT (T1).
