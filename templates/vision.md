# Vision: <app name>

> Fill in every section. Empty sections become escalation points later — easier to think it through here.

## 1. The problem

What problem does this app solve? Who has it today? How are they solving it without this app, and what's bad about that?

## 2. Users

Who uses this? If multiple roles, list each. For each: what do they want to accomplish, and what's their tolerance for friction?

## 3. Must-haves

The features without which this app does not work. Be ruthless — anything optional goes in §4.

- [ ] ...
- [ ] ...

## 4. Nice-to-haves

Features worth building if the must-haves come together quickly. Explicitly *not* required for v1.

- [ ] ...

## 5. Non-goals

Things this app explicitly will NOT do. This is the most valuable section — it's what prevents scope creep during autonomous build.

- ...

## 6. Constraints

- **Budget**: e.g. "<$10/mo infra", "no paid APIs in v1"
- **Deadline**: e.g. "want a working demo by 2026-06-15"
- **Infra**: e.g. "must run on my personal Vercel", "self-hosted only"
- **Privacy**: e.g. "no third-party analytics", "user data stays in my region"

## 7. Tech preferences

> The stack is pinned. The workflow defaults every app to the Jankurai stack documented in [`docs/DEFAULT_STACK.md`](../docs/DEFAULT_STACK.md) (Rust core + TS/React/Vite product surface + PostgreSQL + generated contracts + exception-only Python for AI/data). `/vision` will not ask you to pick a language, framework, database, test runner, lint tool, or hosting target.
>
> If you need a stack change for *this app*, edit `docs/DEFAULT_STACK.md` first — it's a workflow-level change, not a vision-level one.
>
> If your app needs something outside the pinned stack (e.g. a queue, vector DB, websocket gateway), leave that to `/vision`'s agent consult. Do not pre-decide it here.

## 8. Success metric

How will you know the app is working? One concrete observable, not a vibe.

> e.g. "I can sign up, create a habit, log it for 3 days, and see a streak count of 3."

## 9. Escalation budget

- **Max session cost before pausing**: e.g. "$5", "$20"
- **Tasks may fail at most**: 1 time before escalating (default)
- **Block on these decisions** (in addition to defaults in ESCALATION_RULES.md):
  - ...

## 10. Anything else

Free-form. Drawings, links, half-formed ideas, things you don't want forgotten.
