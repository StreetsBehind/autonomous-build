# Vision: lumen

## 1. The problem

People managing a chronic condition want to log symptoms, mood, and meds daily and spot patterns over time. They're wary of health apps that sell or leak their data, so they avoid the mainstream ones and fall back to paper.

## 2. Users

- **Patient** — logs entries daily and reviews their own trends. High sensitivity about who can see their data; moderate friction tolerance.

## 3. Must-haves

- [ ] A patient can sign in and record a dated entry (symptom severity, mood, meds taken).
- [ ] A patient sees a trend view of their own entries over a chosen date range.
- [ ] A patient can permanently delete their account and all associated entries.

## 4. Nice-to-haves

- [ ] Export my data as CSV.

## 5. Non-goals

- This app will NOT share data with any third party or run third-party analytics.
- No clinician/multi-patient dashboard in v1.

## 6. Constraints

- **Privacy**: user health data stays in the EU region; no third-party analytics or trackers; data is the user's and fully deletable.
- **Budget**: < $40/mo infra.

## 7. Tech preferences

(Pinned stack — no preferences.)

## 8. Success metric

A patient signs in, records three daily entries, views a trend chart of those entries for the week, then deletes their account and confirms their entries are gone.

## 9. Escalation budget

- **Max session cost before pausing**: $25
- **Tasks may fail at most**: 1 time before escalating.

## 10. Anything else

Data residency (EU) is a hard requirement, not a preference.
