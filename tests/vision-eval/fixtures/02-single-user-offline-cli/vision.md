# Vision: jot

## 1. The problem

I take meeting notes in scattered text files and can never find them later. I want one local command-line tool that captures a timestamped note and lets me grep my own history — no cloud, no account, works on a plane.

## 2. Users

- **Me** (single user, the developer running it on my own laptop). High tolerance for terse UX; zero tolerance for anything that phones home.

## 3. Must-haves

- [ ] `jot add "<text>"` appends a timestamped note to a local store.
- [ ] `jot search <term>` prints matching notes newest-first.
- [ ] `jot list --since <date>` prints notes in a date range.

## 4. Nice-to-haves

- [ ] Tag notes and filter by tag.

## 5. Non-goals

- This app will NOT sync to any server or cloud.
- No multi-user support, no accounts, ever.
- No network access at all.

## 6. Constraints

- **Privacy**: data never leaves the machine; no telemetry.
- **Infra**: runs as a single self-contained binary.

## 7. Tech preferences

(Pinned stack — no preferences.)

## 8. Success metric

I can run `jot add "talked to Sam about Q3"`, then `jot search Sam` later the same day and see that note printed with its timestamp.

## 9. Escalation budget

- **Max session cost before pausing**: $10
- **Tasks may fail at most**: 1 time before escalating.

## 10. Anything else

Offline-first is the whole point.
