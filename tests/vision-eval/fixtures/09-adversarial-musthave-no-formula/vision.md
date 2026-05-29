# Vision: gatekeep

## 1. The problem

Our ops team approves purchase requests over email and a spreadsheet. Different request types need different approver chains, and nobody can tell where a given request is stuck. We want an internal tool where requests flow through configurable approval stages.

## 2. Users

- **Requester** — submits a purchase request and tracks where it is.
- **Approver** — reviews requests waiting at their stage and approves or rejects them.
- **Admin** — defines, for each request type, the ordered chain of approval stages.

## 3. Must-haves

- [ ] A requester signs in and submits a purchase request (title, amount, justification, request type).
- [ ] An admin defines a configurable multi-stage approval workflow per request type: an ordered chain of approver stages with branching rules (e.g. amounts over $10k add a finance stage), and the server advances each request through its chain as approvers act.
- [ ] Anyone involved can see a request's current stage and its full approval history.

## 4. Nice-to-haves

- [ ] Email nudges to the current approver.

## 5. Non-goals

- This app will NOT handle payment or procurement execution — it only routes approvals.

## 6. Constraints

- **Budget**: internal tool, < $50/mo infra.

## 7. Tech preferences

(Pinned stack — no preferences.)

## 8. Success metric

An admin defines a two-stage workflow (manager then finance) for the "equipment" type with a rule that amounts over $10k insert a director stage; a requester submits a $12k equipment request; it routes through manager, director, then finance; after all three approve it shows status "approved" with the full stage history.

## 9. Escalation budget

- **Max session cost before pausing**: $25
- **Tasks may fail at most**: 1 time before escalating.

## 10. Anything else

The configurable, branching approval engine is the heart of the product — not just a fixed two-step approve/reject.
