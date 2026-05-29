# Vision: zipfacts

## 1. The problem

Developers building address forms need a free, fast lookup that turns a US ZIP code into city/state/county and a rough population. The existing free options are flaky or rate-limit aggressively without warning.

## 2. Users

- **Anonymous API consumer** — any developer's app calls the endpoint with no login. Wants a stable JSON response and a documented, predictable rate limit.

## 3. Must-haves

- [ ] A public `GET /zip/{code}` endpoint returns city, state, county, and population as JSON, with no authentication.
- [ ] Unknown or malformed ZIP codes return a clear 404/400 with a machine-readable error body.
- [ ] Each client IP is rate-limited with documented limits and a 429 + Retry-After when exceeded.

## 4. Nice-to-haves

- [ ] A bulk lookup endpoint accepting up to 100 codes.

## 5. Non-goals

- This app will NOT support non-US postal codes in v1.
- No user accounts or API keys in v1 — fully anonymous.

## 6. Constraints

- **Budget**: < $25/mo infra.

## 7. Tech preferences

(Pinned stack — no preferences.)

## 8. Success metric

I can `curl /zip/94110` and get back `{ "city": "San Francisco", "state": "CA", ... }`; `curl /zip/00000` returns a 404 with an error body; hammering the endpoint past the limit returns 429 with a Retry-After header.

## 9. Escalation budget

- **Max session cost before pausing**: $15
- **Tasks may fail at most**: 1 time before escalating.

## 10. Anything else

The ZIP dataset is a static public-domain file loaded at boot.
