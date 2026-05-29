# Vision: Tasklane

## 1. The problem

Small agencies juggle client work across spreadsheets and chat. Nothing shows, in one place, who owns what and what's due. Today they use a mix of Trello and a shared sheet; the sheet drifts out of date and tasks fall through.

## 2. Users

- **Workspace admin** — sets up the workspace, invites members, manages billing. Low friction tolerance; sets it up once.
- **Member** — creates and works tasks across the boards they belong to. Lives in the app daily; wants it fast.

## 3. Must-haves

- [ ] Workspace admins can invite members to a workspace; each member only sees boards in workspaces they belong to.
- [ ] Members can create, assign, and move tasks across columns on a board.
- [ ] A member sees a "My tasks" view across all their boards, sorted by due date.

## 4. Nice-to-haves

- [ ] Slack notifications when a task is assigned to you.

## 5. Non-goals

- This app will NOT do time tracking or invoicing.
- No native mobile app in v1 (responsive web only).

## 6. Constraints

- **Budget**: < $30/mo infra for the pilot.
- **Deadline**: pilot with one agency by 2026-07-01.

## 7. Tech preferences

(Pinned stack — no preferences.)

## 8. Success metric

An admin can create a workspace, invite a member, the member logs in, creates a board, adds a task assigned to themselves, and sees that task in their "My tasks" view.

## 9. Escalation budget

- **Max session cost before pausing**: $20
- **Tasks may fail at most**: 1 time before escalating.

## 10. Anything else

Multi-tenant from day one — workspaces are the tenant boundary.
