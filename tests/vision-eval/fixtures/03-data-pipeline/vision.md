# Vision: feedsink

## 1. The problem

Our analytics team gets daily CSV exports from three partners dropped into an S3 bucket. Someone manually cleans and loads them into Postgres every morning. It's error-prone and nobody loads them on weekends, so Monday dashboards are stale.

## 2. Users

- **Data operator** — runs and monitors the pipeline; does not interact with a UI day-to-day, reads run logs when something breaks. There are no end-user accounts.

## 3. Must-haves

- [ ] On a schedule, ingest new CSVs from the source bucket and validate each row against the partner's expected schema.
- [ ] Load validated rows into the warehouse tables, recording rejected rows with their reason.
- [ ] Each run is idempotent: re-running over an already-processed file does not double-load.

## 4. Nice-to-haves

- [ ] A summary email after each run.

## 5. Non-goals

- This app will NOT serve a query API or dashboard — it only lands data.
- No real-time streaming; batch only.

## 6. Constraints

- **Infra**: runs as a scheduled job; no always-on web server.

## 7. Tech preferences

(Pinned stack — no preferences.)

## 8. Success metric

After a scheduled run over a bucket containing one valid file and one file with two bad rows, the warehouse table has the valid file's rows loaded, the two bad rows appear in a rejects table with reasons, and a re-run loads nothing new.

## 9. Escalation budget

- **Max session cost before pausing**: $20
- **Tasks may fail at most**: 2 times before escalating.

## 10. Anything else

Partner credentials for the source bucket are provisioned out of band.
