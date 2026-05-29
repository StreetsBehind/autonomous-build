# Upstream feature request (DRAFT — NOT FILED)

**Target:** https://github.com/neverhuman/jankurai
**Status:** Drafted for `autonomous-build-igu.4` (D3). **Not filed** — owner chose to record the draft only rather than open a public issue under the project account. This is a non-blocking cleanup: if it lands upstream we can delete the bespoke receipt parser in `hooks/post-build-gate.{sh,ps1}`.
**Tracked by:** the follow-up bead created when igu.4 closed (see `bd list --label workflow-improvement`).
**Title:** `feat: witness --mode ratchet (floor-free regression-only gate)`
**Label:** `enhancement`

To file later (verbatim):

```bash
gh issue create --repo neverhuman/jankurai \
  --title "feat: witness --mode ratchet (floor-free regression-only gate)" \
  --label enhancement \
  --body-file docs/upstream/jankurai-witness-mode-ratchet.md
```

(The header section above is harmless context for maintainers; trim it if you prefer to file only the body below.)

---

## Problem

`jankurai witness` is the natural per-commit regression gate, but its `decision` bakes in the absolute score floor (the standard's `minimum_score`, 85 by default). Empirically, accepting a tree as baseline and then running `witness` against the *identical* tree (`score_delta: 0`, `changed_paths: 0`) still returns `decision: block`, driven by carried `"…scored N below the standard floor of 85"` findings.

This makes `witness` unusable as a pure regression ratchet for projects that legitimately start below the floor (freshly-scaffolded apps, staged / HL1 adoption). Such a project deadlocks an unattended build: every commit fails witness because the repo starts well below 85 even when the change introduces zero regression. There is no "never make it worse, but don't impose an absolute floor yet" posture available from `witness`.

(Tested against jankurai 1.5.1, standard 0.9.0, schema 1.9.0.)

## Proposal

Add `jankurai witness --mode ratchet` (a floor-free mode) that decides **only** on the delta vs the baseline and ignores the absolute floor:

- BLOCK iff `score_delta < -allowed_drop` **or** the new-hard-findings set is non-empty **or** the new-caps set is non-empty.
- Do **not** carry "below the standard floor of N" findings into the `witness` decision in this mode.
- Keep the current floor-aware behavior as the default (e.g. `--mode floor`).

This matches the staged-adoption ladder `jankurai ci install --mode observe|advisory|ratchet` already advertises — the `ratchet` rung reads like a true regression-only gate, but `witness` today can only do floor+ratchet.

## Alternatives

Today, to get a floor-free ratchet we parse the `audit --changed-fast` receipt ourselves: read `decision.ratchet` from `audit-fast.json` and block iff `score_delta < -TOLERANCE OR len(new_hard_findings) > 0 OR len(new_caps) > 0`, deliberately never reading `decision.passed` / `ratchet.passed` (floor-contaminated). This works but is bespoke parsing, and the `audit` receipt differs in field names from the `witness` receipt (`new_hard_findings`/`new_caps` vs `new_findings`/`caps_added`) — an easy footgun. A first-class `witness --mode ratchet` would let downstreams delete the parser and gate on one canonical receipt.

## Compatibility

Additive — a new `--mode` value with the default unchanged. Affects `witness` CLI behavior and its receipt's `conformance_decision` only in the new mode; no change to report schemas, generated scaffold paths, or proof lanes. The `audit` receipt and its `decision.ratchet` block are unaffected.
