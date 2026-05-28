# Default Stack (Jankurai)

The pipeline's canonical tech stack. `/vision` defaults every app to this stack without asking the user. `/compose`, `/build-next`, and the formulas all assume it.

> Jankurai itself is stack-agnostic (per `github.com/neverhuman/jankurai`). This file pins the specific stack profile this workflow uses — it is *not* prescribed by Jankurai's CLI, it is the choice this repo has made for every app it builds.

## The stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Core / services | **Rust** | All product truth, authorization, direct Postgres writes, backend glue. |
| Product surface | **TypeScript + React + Vite** | User-facing UI and any product-surface JS. |
| Database | **PostgreSQL** | The truth layer. SQLite is *not* a v1 fallback. |
| Cross-language contracts | **Generated** | TS types generated from Rust (e.g. `ts-rs` or OpenAPI). Hand-maintained duplicate types are a smell. |
| AI / data service | **Python — exception only** | Allowed only when the AI/data ecosystem requires it (e.g. a model serving sidecar). Never for repo tooling, product truth, services, authorization, direct PostgreSQL writes, or general backend glue. |
| Tests | Rust: `cargo test`. TS: `vitest`. Python (when present): `pytest`. | |
| Lint / format | Rust: `cargo fmt` + `clippy`. TS: `biome`. Python: `ruff`. | |
| Hosting | Per-app — chosen at deploy time, not vision time. | Default: whatever the app needs; Postgres-compatible host. |

## Why this is pinned, not chosen per-app

The human checkpoint in `/vision` is for **product** (problem, users, must-haves, non-goals, success metric), not **tech**. Re-litigating the stack per app burns the human's time on a decision that almost never changes the product outcome — and inconsistent stacks across apps make the formulas, retros, and shared skills more expensive to maintain.

## How `/vision` uses this file

- For every required `plan.md` Stack row, fill in from this table. Do not ask the user.
- If a feature in `vision.md` §3 needs something outside this stack (e.g. a real-time websocket service, a queue, a vector DB), do **not** escalate to the user. Spawn a 3-agent consult (architect / reviewer / counter-arguer), synthesize, and write the decision into `plan.md` under "Decided by agent consult" with the rationale. See `skills/vision/SKILL.md` for the consult protocol.
- The only stack-related thing that escalates to the human is a direct contradiction in `vision.md` itself (e.g. "must run on a TI-84 calculator" + a must-have feature that requires a Postgres backend). That's a product-scope problem disguised as a tech one.

## Off-stack escalation (agent consult, not human)

When a must-have feature can't be served by the pinned stack:

1. Spawn 3 `Agent` calls in parallel in a single message:
   - **Architect**: "Given Jankurai stack + this feature, propose the minimal addition (or alternative shape using only the pinned stack)."
   - **Reviewer**: "Given the same constraints, identify the load-bearing risks of adding anything off-stack and what we'd lose by staying on-stack."
   - **Counter-arguer**: "Argue against any addition; show how to satisfy the must-have with what's already in the stack."
2. Synthesize their outputs into one decision in `plan.md`:
   ```
   ## Decided by agent consult
   - **Question**: <what we asked>
   - **Decision**: <one line>
   - **Rationale**: <2–4 lines, citing whichever agent's argument carried>
   - **Reversal cost**: <what changes if we change our minds in 3 months>
   ```
3. Do not ask the human. The human reviews `plan.md` after — they can still reverse the decision at that gate, but they should not be paged for it during planning.

## When this file changes

Edits to this stack are workflow improvements — file a `bd create --type=task --add-label workflow-improvement` and discuss before flipping a row. A row change here ripples into every future app, so it deserves a deliberate commit, not a drive-by edit during a build.
