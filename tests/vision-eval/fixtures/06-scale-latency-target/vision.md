# Vision: sniplink

## 1. The problem

Our marketing team needs short links for campaigns that redirect instantly and survive traffic spikes when a post goes viral. The free shorteners we've tried add visible latency and occasionally 5xx under load, which kills click-through.

## 2. Users

- **Anonymous click** — the public follows a short link and expects an immediate redirect. No login.
- **Marketer** — creates short links from an internal page. Small, trusted internal group.

## 3. Must-haves

- [ ] A marketer can create a short code that maps to a destination URL.
- [ ] A public `GET /{code}` issues a 301/302 redirect to the destination.
- [ ] Each redirect increments a click count visible to the marketer.

## 4. Nice-to-haves

- [ ] Custom (vanity) codes.

## 5. Non-goals

- This app will NOT do click analytics beyond a raw count (no geo, no device breakdown) in v1.

## 6. Constraints

- **Infra**: must handle campaign spikes without manual scaling.

## 7. Tech preferences

(Pinned stack — no preferences.)

## 8. Success metric

Under a load test of 1,000 requests/second against the redirect endpoint, p99 latency stays under 50ms and the error rate is 0; the click count for a code matches the number of successful redirects.

## 9. Escalation budget

- **Max session cost before pausing**: $20
- **Tasks may fail at most**: 1 time before escalating.

## 10. Anything else

The redirect hot path is what matters; link creation can be slower.
