# jankurai Repo Score

- Standard: `jankurai`
- Auditor: `1.5.1`
- Schema: `1.9.0`
- Paper edition: `2026.05-ed8`
- Target stack ID: `rust-ts-vite-react-postgres-bounded-python`
- Target stack: `Rust core + TypeScript/React/Vite + PostgreSQL + generated contracts + exception-only Python AI/data service`
- Repo: `.`
- Run ID: `1780035239`
- Started at: `1780035239`
- Elapsed: `3159` ms
- Scope: `full`
- Raw score: `37`
- Final score: `37`
- Decision: `fail`
- Minimum score: `85`
- Caps applied: `no-one-command-setup-or-validation, no-deterministic-fast-lane, no-security-lane-on-high-risk-repo, generated-contracts-or-public-api-drift-untested, no-secret-or-dependency-scanning-in-ci, no-jankurai-audit-lane-in-ci, non-optimal-product-language-found, future-hostile-dead-language-in-product-code, input-boundary-gap, release-readiness-gap, no-agent-friendly-exception-pattern, missing-agent-readable-docs, git-bad-behavior`

## Hard Rule Caps

| Rule | Max Score | Applied |
| --- | ---: | --- |
| `no-root-agent-instructions` | 75 | no |
| `no-one-command-setup-or-validation` | 70 | yes |
| `no-deterministic-fast-lane` | 65 | yes |
| `no-security-lane-on-high-risk-repo` | 60 | yes |
| `generated-contracts-or-public-api-drift-untested` | 80 | yes |
| `python-direct-product-truth-or-db-ownership` | 72 | no |
| `no-secret-or-dependency-scanning-in-ci` | 78 | yes |
| `no-jankurai-audit-lane-in-ci` | 82 | yes |
| `jankurai-required-tool-ci-evidence-gap` | 88 | no |
| `non-optimal-product-language-found` | 74 | yes |
| `too-much-python-in-product-surface` | 72 | no |
| `boundary-reclassification-evidence-gap` | 72 | no |
| `vibe-placeholders-in-product-code` | 68 | no |
| `fallback-soup-in-product-code` | 70 | no |
| `future-hostile-dead-language-in-product-code` | 64 | yes |
| `severe-duplication-in-product-code` | 70 | no |
| `generated-zone-mutation-risk` | 76 | no |
| `direct-db-access-from-wrong-layer` | 66 | no |
| `missing-web-e2e-lane` | 82 | no |
| `missing-rendered-ux-qa-lane` | 84 | no |
| `prompt-injection-risk` | 78 | no |
| `overbroad-agent-agency` | 65 | no |
| `secret-like-content-detected` | 60 | no |
| `false-green-test-risk` | 76 | no |
| `destructive-migration-risk` | 70 | no |
| `authz-or-data-isolation-gap` | 78 | no |
| `input-boundary-gap` | 78 | yes |
| `agent-tool-supply-chain-gap` | 78 | no |
| `release-readiness-gap` | 80 | yes |
| `missing-rust-property-or-integration-tests` | 82 | no |
| `no-agent-friendly-exception-pattern` | 76 | yes |
| `missing-agent-readable-docs` | 80 | yes |
| `streaming-runtime-drift` | 78 | no |
| `rust-bad-behavior` | 72 | no |
| `sql-bad-behavior` | 72 | no |
| `typescript-bad-behavior` | 72 | no |
| `docker-bad-behavior` | 72 | no |
| `python-bad-behavior` | 72 | no |
| `ci-bad-behavior` | 70 | no |
| `git-bad-behavior` | 70 | yes |
| `gittools-bad-behavior` | 70 | no |
| `release-bad-behavior` | 70 | no |
| `web-security-bad-behavior` | 68 | no |
| `repo-rot-bad-behavior` | 88 | no |
| `comment-hygiene-dangerous-residue` | 72 | no |
| `ci-local-parity` | 70 | no |

## Copy-Code Redundancy

- Status: `pass` hard=`0` warning=`0` files=`3`
- Policy: min-lines=`10` min-tokens=`100` max-findings=`50` include-tests=`false` strict=`false`
- Duplicate volume: lines=`0` tokens=`0` bytes=`0`

- Notes:
  - hard classes are limited to exact active-source file matches and substantial exact same-name units
  - warning classes include same-body different-name units and token/block duplication
  - tests, fixtures, stories, config, Docker, and migrations are omitted unless --include-tests is set

## Dimensions

| Dimension | Weight | Score | Weighted | Evidence |
| --- | ---: | ---: | ---: | --- |
| Ownership and navigation surface | 13 | 58 | 7.54 | root `AGENTS.md` present; root `README.md` routes to workspace layout |
| Contract and boundary integrity | 13 | 65 | 8.45 | contract surface found; machine-readable schemas present |
| Proof lanes and test routing | 12 | 24 | 2.88 | web e2e lane present or no web surface; rendered UX QA lane present or no web surface |
| Security and supply-chain posture | 12 | 14 | 1.68 | git bad-behavior hard findings: 1; gittools bad-behavior advisory signals: 3 |
| Code shape and semantic surface | 12 | 0 | 0.00 | largest authored code file: workflows/decompose.js (1121 LOC); code file exceeds 500 LOC |
| Data truth and workflow safety | 8 | 60 | 4.80 | constraint or RLS language found |
| Observability and repair evidence | 8 | 38 | 3.04 | observability libraries or patterns found; repair receipts or raw artifact language found |
| Context economy and agent instructions | 7 | 67 | 4.69 | root `AGENTS.md` present; root `AGENTS.md` stays short |
| Jankurai tool adoption and CI replacement | 7 | 10 | 0.70 | control-plane files present; applicable=13 |
| Python containment and polyglot hygiene | 4 | 90 | 3.60 | no Python files in scope; non-optimal product language marker |
| Build speed signals | 4 | 0 | 0.00 |  |

## Reference Profile Structure

- Applicable cells: `0` canonical=`0` noncanonical=`0` guidance missing=`0`

| Cell | Status | Canonical | Detected | Aliases | Guidance | Owner | Proof lane | Agent fix |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `web` | `not_applicable` | `apps/web/` | `-` | `frontend/, ui/, packages/web/, packages/ui/` | `not_required` | `apps/web` | `rendered UX / Playwright` | `no action` |
| `api` | `not_applicable` | `apps/api/` | `-` | `api/, server/, backend/` | `not_required` | `apps/api` | `edge handler / contract tests` | `no action` |
| `domain` | `not_applicable` | `crates/domain/` | `-` | `domain/, core/` | `not_required` | `crates/domain` | `unit / property tests` | `no action` |
| `application` | `not_applicable` | `crates/application/` | `-` | `application/, usecases/, use-cases/` | `not_required` | `crates/application` | `use-case / authz tests` | `no action` |
| `adapters` | `not_applicable` | `crates/adapters/` | `-` | `adapters/, infra/, integrations/` | `not_required` | `crates/adapters` | `adapter integration tests` | `no action` |
| `workers` | `not_applicable` | `crates/workers/` | `-` | `workers/, jobs/, scheduler/, queue/` | `not_required` | `crates/workers` | `workflow / replay tests` | `no action` |
| `contracts` | `not_applicable` | `contracts/` | `-` | `openapi/, protobuf/, json-schema/, generated/` | `not_required` | `contracts` | `generation / drift checks` | `no action` |
| `db` | `not_applicable` | `db/` | `-` | `migrations/, constraints/, sql/` | `not_required` | `db` | `migration / constraint tests` | `no action` |
| `python-ai` | `not_applicable` | `python/ai-service/` | `-` | `python/, ai-service/, evals/, embeddings/, model/` | `not_required` | `python/ai-service` | `eval / contract tests` | `no action` |
| `ops` | `not_applicable` | `ops/` | `-` | `.github/, .github/workflows/, ci/, release/, observability/, security/` | `not_required` | `ops` | `security lane / workflow lint` | `no action` |

## Rendered UX QA

- Web surface: `false`
- Layered UX lane: `true`
- Missing: `none`

## Tool Adoption

- Control plane present: `true`
- Applicable tools: `13`
- Configured: `0`
- CI evidence: `0`
- Artifact verified: `0`
- Replaced count: `0`
- Missing CI evidence: `audit-ci, proof-routing, proofbind, copy-code, security, ci-bad-behavior, git-bad-behavior, release-bad-behavior, contract-drift, authz-matrix, input-boundary, release-readiness, cost-budget`

| Tool | Category | Mode | Status | Replaced | Artifacts |
| --- | --- | --- | --- | --- | --- |
| `audit-ci` | `audit` | `auto` | `missing` | `manual repo scoring, ad hoc score gates` | `.jankurai/repo-score.json, .jankurai/repo-score.md` |
| `proof-routing` | `proof` | `auto` | `missing` | `ad hoc proof lane selection, manual proof receipts` | `.jankurai/repo-score.json, .jankurai/repo-score.md, target/jankurai/repair-queue.jsonl` |
| `proofbind` | `proof` | `auto` | `missing` | `manual changed-surface routing, ad hoc proof obligation lists` | `target/jankurai/proofbind/surface-witness.json, target/jankurai/proofbind/obligations.json` |
| `proofmark-rust` | `proof` | `auto` | `not_applicable` | `line-only coverage review, manual in-diff mutation review` | `target/jankurai/proofmark/proofmark-receipt.json, target/jankurai/proofmark/proof-receipt.json` |
| `copy-code` | `audit` | `auto` | `missing` | `ad hoc copy-code review, manual duplication triage` | `target/jankurai/copy-code.json, target/jankurai/copy-code.md` |
| `security` | `security` | `auto` | `missing` | `gitleaks, dependency review, SBOM/provenance` | `target/jankurai/security/evidence.json` |
| `ci-bad-behavior` | `security` | `auto` | `missing` | `mutable workflow refs, secret echo/debug workflow checks, non-blocking security scans` | `target/jankurai/language-bad-behavior.log` |
| `git-bad-behavior` | `audit` | `auto` | `missing` | `destructive git automation, force-push release scripts, hidden stash-based state` | `target/jankurai/language-bad-behavior.log` |
| `release-bad-behavior` | `release` | `auto` | `missing` | `manual release checklist, ad hoc tag and artifact review, manual provenance review` | `target/jankurai/language-bad-behavior.log` |
| `ux-qa` | `ux` | `auto` | `not_applicable` | `playwright, axe-core, visual baselines` | `target/jankurai/ux-qa.json` |
| `db-migration-analyze` | `db` | `auto` | `not_applicable` | `manual migration review` | `target/jankurai/migration-report.json` |
| `contract-drift` | `contract` | `auto` | `missing` | `handwritten contract drift checks, openapi diff` | `.jankurai/repo-score.json, .jankurai/repo-score.md` |
| `rust-witness` | `rust` | `auto` | `not_applicable` | `manual witness graphing` | `target/jankurai/rust/witness-graph.json` |
| `vibe-coverage` | `audit` | `auto` | `not_applicable` | `manual vibe-coding coverage spreadsheet` | `target/jankurai/vibe-coverage.json, target/jankurai/vibe-coverage.md` |
| `coverage-evidence` | `proof` | `auto` | `not_applicable` | `manual coverage report review, ad hoc mutation survivor review` | `target/jankurai/coverage/coverage-audit.json, target/jankurai/coverage/coverage-audit.md` |
| `authz-matrix` | `security` | `auto` | `missing` | `manual authz matrix review` | `.jankurai/repo-score.json, .jankurai/repo-score.md` |
| `input-boundary` | `security` | `auto` | `missing` | `manual unsafe sink review` | `.jankurai/repo-score.json, .jankurai/repo-score.md` |
| `agent-tool-supply` | `security` | `auto` | `not_applicable` | `manual MCP/tool trust review` | `.jankurai/repo-score.json, .jankurai/repo-score.md` |
| `release-readiness` | `release` | `auto` | `missing` | `manual launch checklist` | `.jankurai/repo-score.json, .jankurai/repo-score.md` |
| `cost-budget` | `release` | `auto` | `missing` | `manual spend review` | `.jankurai/repo-score.json, .jankurai/repo-score.md` |

## Boundary Reclassifications

No audited runtime boundary reclassifications declared.

## Findings

1. `medium` `shape` `.`
   Rule: `HLT-001-DEAD-MARKER`
   Check: `HLT-001-DEAD-MARKER:shape` `soft` confidence `0.76`
   Route: TLR `Entropy`, lane `fast`, owner `tools`
   Docs: `docs/audit-rubric.md#future-hostile-language-rule`
   Reason: `Code shape and semantic surface` scored 0 below the standard floor of 85
   Fix: split large or ambiguous authored code into smaller semantic modules with focused tests
   Rerun: `just fast`
   Fingerprint: `sha256:e8a8511375f24651d4987003e1cef1cc8f47eaf539484dc00403ae4792c174b0`
   Evidence: largest authored code file: workflows/decompose.js (1121 LOC), code file exceeds 500 LOC, code file exceeds 1000 LOC, future-hostile/dead-language marker found
2. `high` `proof` `.`
   Rule: `HLT-004-UNMAPPED-PROOF`
   Check: `HLT-004-UNMAPPED-PROOF:proof` `hard` confidence `0.88`
   Route: TLR `Verification`, lane `fast`, owner `tools`
   Docs: `agent/JANKURAI_STANDARD.md#proof-lanes`
   Reason: no deterministic fast lane was detected
   Fix: add a fast lane that runs the narrowest deterministic proof loop and keep it canonical
   Rerun: `just fast`
   Fingerprint: `sha256:8f5faf682afa829927a322d200bd31f22afd36836db985a72e97a44de7487584`
   Evidence: no fast lane markers found
3. `high` `proof` `.`
   Check: `HLT-000-SCORE-DIMENSION:proof` `hard` confidence `0.88`
   Route: TLR `Verification`, lane `fast`, owner `unmapped`
   Reason: no one-command setup or validation lane was detected
   Fix: add a canonical `setup`, `check`, `test`, or `verify` lane in one root command file
   Rerun: `just fast`
   Fingerprint: `sha256:7010147691f443ae19d3d8603c11ec84958d455885b09e09eca0b9fa91933bde`
   Evidence: no root setup/check/test/verify target surfaced
4. `high` `agent` `.claude/agents/beads-builder.md:164`
   Rule: `HLT-035-GIT-BAD-BEHAVIOR`
   Check: `HLT-035-GIT-BAD-BEHAVIOR:agent` `hard` confidence `0.95`
   Route: TLR `Context/setup`, lane `audit`, owner `agent`
   Docs: `docs/testing.md`
   Matched term: `git.stage.unbounded`
   Reason: automation commits broad untracked state or bypasses verification
   Fix: enumerate the exact paths and keep verification on
   Rerun: `just score`
   Fingerprint: `sha256:b6301daa16cdda11b029c8036fc4122b6511087b8b67565b75dc12c1ac0acd57`
   Evidence: detector=git.stage.unbounded, path=.claude/agents/beads-builder.md, line=164, proof_window=None, snippet=git add -A
5. `high` `audit` `.github/workflows`
   Check: `HLT-000-SCORE-DIMENSION:audit` `hard` confidence `0.88`
   Route: TLR `Context/setup`, lane `audit`, owner `ops`
   Reason: CI does not run the jankurai audit lane
   Fix: add a CI job that runs `jankurai . --json .jankurai/repo-score.json --md .jankurai/repo-score.md` and uploads both artifacts
   Rerun: `just score`
   Fingerprint: `sha256:dcdd57510181477041c184ca8e3087ad93965fd92fe3357b1be5d73986e805ae`
   Evidence: audit output must stay JSON plus Markdown for agent repair routing
6. `high` `security` `.github/workflows`
   Rule: `HLT-009-GENERATED-SECURITY`
   Check: `HLT-009-GENERATED-SECURITY:security` `hard` confidence `0.95`
   Route: TLR `Security, secrets, agency`, lane `security`, owner `ops`
   Docs: `docs/audit-rubric.md#top-level-risk-mapping`
   Reason: high-risk repo has no explicit security lane
   Fix: add a dedicated security lane with secret scanning, dependency review, and workflow linting
   Rerun: `just security`
   Fingerprint: `sha256:c249be982d975721833fe396cdfff422f53a2d61819df881968fba63fdd6b9bf`
   Evidence: no security lane markers found
7. `high` `security` `.github/workflows`
   Rule: `HLT-016-SUPPLY-CHAIN-DRIFT`
   Check: `HLT-016-SUPPLY-CHAIN-DRIFT:security` `hard` confidence `0.95`
   Route: TLR `Security, secrets, agency`, lane `security`, owner `ops`
   Docs: `docs/audit-rubric.md#top-level-risk-mapping`
   Reason: no secret or dependency scanning was found in CI
   Fix: add secret scanning, dependency review, and SBOM or provenance checks to CI
   Rerun: `just security`
   Fingerprint: `sha256:2e22551cbdbd8da1f6fedd2d509dba064990dc4b1505df71609f431d11901099`
   Evidence: no CI scan markers found
8. `medium` `security` `.github/workflows/jankurai.yml`
   Rule: `HLT-016-SUPPLY-CHAIN-DRIFT`
   Check: `HLT-016-SUPPLY-CHAIN-DRIFT:security` `soft` confidence `0.76`
   Route: TLR `Security, secrets, agency`, lane `security`, owner `ops`
   Docs: `docs/audit-rubric.md#top-level-risk-mapping`
   Reason: `Security and supply-chain posture` scored 14 below the standard floor of 85
   Fix: wire secret, dependency, provenance, and workflow scans into an operational CI lane
   Rerun: `just security`
   Fingerprint: `sha256:4843d1528708ccca7266ee7785c6b1b6d4a65357f9e9b37b42c2f1a429646bd9`
   Evidence: git bad-behavior hard findings: 1, gittools bad-behavior advisory signals: 3, no explicit security lane found, CI does not run the jankurai audit
9. `medium` `context` `AGENTS.md`
   Rule: `HLT-015-CONTEXT-SETUP-GAP`
   Check: `HLT-015-CONTEXT-SETUP-GAP:context` `soft` confidence `0.76`
   Route: TLR `Context/setup`, lane `fast`, owner `agent`
   Docs: `docs/agent-native-standard.md`
   Reason: `Context economy and agent instructions` scored 67 below the standard floor of 85
   Fix: keep root guidance short and route durable detail through agent-readable manifests and docs
   Rerun: `just fast`
   Fingerprint: `sha256:9f598f489653e485c6af72ee6789194c326c4aac5fbe376f6f569d5c6594ffdc`
   Evidence: root `AGENTS.md` present, root `AGENTS.md` stays short, thin IDE/agent adapters are present, root README routes to the right docs
10. `medium` `proof` `Justfile`
   Rule: `HLT-018-PERF-CONCURRENCY-DRIFT`
   Check: `HLT-018-PERF-CONCURRENCY-DRIFT:proof` `soft` confidence `0.76`
   Route: TLR `Verification`, lane `fast`, owner `workspace`
   Docs: `docs/testing.md`
   Reason: `Build speed signals` scored 0 below the standard floor of 85
   Fix: add fast deterministic build/test targets, caches, and narrow proof lanes for agent iteration
   Rerun: `just fast`
   Fingerprint: `sha256:0cf9476a83002d0f15381836511b813d73708c221d9dfc8a5f807059e514534d`
   Evidence: missing one-command setup/validation, missing deterministic fast lane
11. `medium` `boundary` `agent/boundaries.toml`
   Rule: `HLT-007-HANDWRITTEN-CONTRACT`
   Check: `HLT-007-HANDWRITTEN-CONTRACT:boundary` `soft` confidence `0.76`
   Route: TLR `Contracts/data`, lane `contract`, owner `agent`
   Docs: `docs/audit-rubric.md#known-vibe-coding-insults`
   Reason: `Contract and boundary integrity` scored 65 below the standard floor of 85
   Fix: add generated contracts and boundary checks for public APIs, data access, and cross-runtime seams
   Rerun: `just fast`
   Fingerprint: `sha256:e013d67ed1ea5b312da3d2646cdda71405d8814a08fecad7f8ce5aaf79116c37`
   Evidence: contract surface found, machine-readable schemas present, all contract sources have generated zone entries
12. `medium` `context` `agent/owner-map.json`
   Rule: `HLT-003-OWNERLESS-PATH`
   Check: `HLT-003-OWNERLESS-PATH:context` `soft` confidence `0.76`
   Route: TLR `Context/setup`, lane `fast`, owner `agent`
   Docs: `agent/JANKURAI_STANDARD.md#ownership-boundaries`
   Reason: `Ownership and navigation surface` scored 58 below the standard floor of 85
   Fix: tighten owner/test maps and root routing until agents can localize ownership without inference
   Rerun: `just fast`
   Fingerprint: `sha256:78e8b39ce08c90e54c7db0d9c9a6fe3ecdaee9a43f27b21c5a394582b982ee0d`
   Evidence: root `AGENTS.md` present, root `README.md` routes to workspace layout, owner map covers audited paths, test map covers audited paths
13. `medium` `proof` `agent/test-map.json`
   Rule: `HLT-004-UNMAPPED-PROOF`
   Check: `HLT-004-UNMAPPED-PROOF:proof` `soft` confidence `0.76`
   Route: TLR `Verification`, lane `fast`, owner `agent`
   Docs: `agent/JANKURAI_STANDARD.md#proof-lanes`
   Reason: `Proof lanes and test routing` scored 24 below the standard floor of 85
   Fix: route each owned path to a deterministic proof command and make the lane executable in CI
   Rerun: `just fast`
   Fingerprint: `sha256:022a80c623acbae612b9f10a4e356b87f219ebfff81285c2a8175c31f6d9a9a2`
   Evidence: web e2e lane present or no web surface, rendered UX QA lane present or no web surface, Rust property/integration tests present or no Rust surface, no one-command setup/validation lane
14. `high` `boundary` `contracts/`
   Rule: `HLT-007-HANDWRITTEN-CONTRACT`
   Check: `HLT-007-HANDWRITTEN-CONTRACT:boundary` `hard` confidence `0.95`
   Route: TLR `Contracts/data`, lane `contract`, owner `tools`
   Docs: `docs/audit-rubric.md#known-vibe-coding-insults`
   Reason: generated contracts or public API drift are not being checked
   Fix: generate boundary clients and gate drift with public-API or semver checks
   Rerun: `just fast`
   Fingerprint: `sha256:0a2019778e7d60c5172a4b51d0fcbf7b0443bf1b8c747c2429fc4d409b2b8028`
   Evidence: contract surface exists
15. `high` `exceptions` `crates/domain`
   Rule: `HLT-017-OPAQUE-OBSERVABILITY`
   Check: `HLT-017-OPAQUE-OBSERVABILITY:exceptions` `hard` confidence `0.88`
   Route: TLR `Repair`, lane `observability`, owner `tools`
   Docs: `agent/JANKURAI_STANDARD.md#repair-receipts`
   Reason: no agent-friendly exception/error pattern was detected
   Fix: define a typed exception surface with purpose, reason, common fixes, docs_url, and repair_hint so the next rerun is local
   Rerun: `just score`
   Fingerprint: `sha256:538667a01e35d8e91eae100627364816dd225911862fa2fa1578642af63d4af8`
   Evidence: route repair work to the next agent, opaque failures slow local debugging and reruns, add a typed repair hint; name the common fixes; point at the local docs URL, docs/testing.md
16. `medium` `data` `db/`
   Rule: `HLT-006-DIRECT-DB-WRONG-LAYER`
   Check: `HLT-006-DIRECT-DB-WRONG-LAYER:data` `soft` confidence `0.76`
   Route: TLR `Contracts/data`, lane `db`, owner `tools`
   Docs: `docs/audit-rubric.md#required-shape`
   Reason: `Data truth and workflow safety` scored 60 below the standard floor of 85
   Fix: move durable truth into migrations, constraints, adapters, and application-owned transactions
   Rerun: `just fast`
   Fingerprint: `sha256:fa84ba15b06d7072c8e4834fbcb6d4c707eee3e94616a153c0d6113e3b6c8f66`
   Evidence: constraint or RLS language found
17. `medium` `docs` `docs/`
   Check: `HLT-000-SCORE-DIMENSION:docs` `soft` confidence `0.76`
   Route: TLR `Context/setup`, lane `audit`, owner `standard`
   Reason: agent-readable documentation is incomplete
   Fix: add concise docs for architecture, boundaries, tests, generated zones, and audit rules; route them from root `AGENTS.md`
   Rerun: `just score`
   Fingerprint: `sha256:69745f6509a75aa876595328afe84d8ccb6b7f8188ea94e5213d5ac68c4b0eb1`
   Evidence: docs/architecture.md or docs/boundaries.md
18. `high` `release` `docs/release.md`
   Rule: `HLT-025-RELEASE-READINESS-GAP`
   Check: `HLT-025-RELEASE-READINESS-GAP:release` `hard` confidence `0.88`
   Route: TLR `Verification`, lane `release`, owner `standard`
   Docs: `docs/testing.md`
   Matched term: `release structure`
   Reason: launch gates need artifact-backed release evidence
   Fix: add a release control surface with version source, changelog, release process docs, CI or script evidence, integrity/provenance evidence, and rollback guidance
   Rerun: `just check`
   Fingerprint: `sha256:b98e66fc5058939ee17b349f6940227a96dfbe0a0b8c1a691452b75489907c92`
   Evidence: release structure missing: version source, changelog, release process doc, release automation or command policy
19. `medium` `observability` `docs/testing.md`
   Rule: `HLT-017-OPAQUE-OBSERVABILITY`
   Check: `HLT-017-OPAQUE-OBSERVABILITY:observability` `soft` confidence `0.76`
   Route: TLR `Repair`, lane `observability`, owner `standard`
   Docs: `agent/JANKURAI_STANDARD.md#repair-receipts`
   Reason: `Observability and repair evidence` scored 38 below the standard floor of 85
   Fix: add structured errors, telemetry, and repair receipts that tell the next agent where to rerun proof
   Rerun: `just score`
   Fingerprint: `sha256:fdb3a84a21c55960774c72b44aa6af4228427d0ba1a9eeb7d25802508b687411`
   Evidence: observability libraries or patterns found, repair receipts or raw artifact language found, no agent-friendly exception pattern found, free-form logging appears in scope
20. `medium` `release` `docs/testing.md`
   Rule: `HLT-026-COST-BUDGET-GAP`
   Check: `HLT-026-COST-BUDGET-GAP:release` `soft` confidence `0.88`
   Route: TLR `Verification`, lane `release`, owner `standard`
   Docs: `docs/testing.md`
   Matched term: `budget`
   Reason: unbounded paid work needs budgets and stop conditions
   Fix: add explicit budgets, quotas, stop conditions, and kill-switch evidence for paid or unbounded operations
   Rerun: `just check`
   Fingerprint: `sha256:edd248b7afc24b644107205fa5b84a88103ac4b622009ff9f19b779de8798f59`
   Evidence: cost surface found without budget/stop-condition policy
21. `high` `vibe` `install.sh:162`
   Rule: `HLT-001-DEAD-MARKER`
   Check: `HLT-001-DEAD-MARKER:vibe` `hard` confidence `0.88`
   Route: TLR `Entropy`, lane `fast`, owner `tools`
   Docs: `docs/audit-rubric.md#future-hostile-language-rule`
   Reason: future-hostile/dead-language term `stale` appears in product/runtime code
   Fix: remove or rename the marker, implement the intended behavior, model a typed unsupported state, or move docs/generated/vendor/product-copy text into an allowlisted context
   Rerun: `just fast`
   Fingerprint: `sha256:43b837ccd86837df460faeed95e08f20594f84c7a0e4aa976631400640c79625`
   Evidence: install.sh:162, future-hostile/dead-language term `stale` appears
22. `high` `vibe` `install.sh:173`
   Rule: `HLT-001-DEAD-MARKER`
   Check: `HLT-001-DEAD-MARKER:vibe` `hard` confidence `0.88`
   Route: TLR `Entropy`, lane `fast`, owner `tools`
   Docs: `docs/audit-rubric.md#future-hostile-language-rule`
   Reason: future-hostile/dead-language term `stale` appears in product/runtime code
   Fix: remove or rename the marker, implement the intended behavior, model a typed unsupported state, or move docs/generated/vendor/product-copy text into an allowlisted context
   Rerun: `just fast`
   Fingerprint: `sha256:f81cb62e0dacf7e5444bf828adb83eb0ba7c813386fbc4f3547a717f51be9e1e`
   Evidence: install.sh:173, future-hostile/dead-language term `stale` appears
23. `high` `vibe` `install.sh:176`
   Rule: `HLT-001-DEAD-MARKER`
   Check: `HLT-001-DEAD-MARKER:vibe` `hard` confidence `0.88`
   Route: TLR `Entropy`, lane `fast`, owner `tools`
   Docs: `docs/audit-rubric.md#future-hostile-language-rule`
   Reason: future-hostile/dead-language term `stale` appears in product/runtime code
   Fix: remove or rename the marker, implement the intended behavior, model a typed unsupported state, or move docs/generated/vendor/product-copy text into an allowlisted context
   Rerun: `just fast`
   Fingerprint: `sha256:0e17dad6ffeae32045ab009af4633d6920dbc038f87d4e0cd29838e655cbef7c`
   Evidence: install.sh:176, future-hostile/dead-language term `stale` appears
24. `high` `vibe` `install.sh:184`
   Rule: `HLT-001-DEAD-MARKER`
   Check: `HLT-001-DEAD-MARKER:vibe` `hard` confidence `0.88`
   Route: TLR `Entropy`, lane `fast`, owner `tools`
   Docs: `docs/audit-rubric.md#future-hostile-language-rule`
   Reason: future-hostile/dead-language term `stale` appears in product/runtime code
   Fix: remove or rename the marker, implement the intended behavior, model a typed unsupported state, or move docs/generated/vendor/product-copy text into an allowlisted context
   Rerun: `just fast`
   Fingerprint: `sha256:563963e03f9fdb4a187305dd3b3ff042a0ceca6dfe904b6b71f566fe1208ba1b`
   Evidence: install.sh:184, future-hostile/dead-language term `stale` appears
25. `medium` `proof` `tests/vision-eval/fixtures/10-adversarial-empty-product-sections/expect.json:22`
   Rule: `HLT-027-HUMAN-REVIEW-EVIDENCE-GAP`
   Check: `HLT-027-HUMAN-REVIEW-EVIDENCE-GAP:proof` `soft` confidence `0.88`
   Route: TLR `Repair`, lane `audit`, owner `tools`
   Docs: `docs/testing.md`
   Matched term: `review evidence`
   Reason: proof and review claims need receipts
   Fix: attach raw CI logs, review receipts, and replayable commands instead of accepting claims or summaries
   Rerun: `just score`
   Fingerprint: `sha256:7ff73528343739f164d0e1b4d0a975adbd3520659c2e29a882178e2d5a483b33`
   Evidence: "notes": "The hardest negative: with no product input, concern applicability is UNDERIVABLE (applicability is derived from §3/§6/§8 — there is nothing to derive
26. `high` `stack` `workflows/build-batch.js`
   Check: `HLT-000-SCORE-DIMENSION:stack` `hard` confidence `0.88`
   Route: TLR `Context/setup`, lane `audit`, owner `unmapped`
   Reason: runtime code uses a language outside the chosen optimal stack
   Fix: move product runtime behavior to Rust core, TypeScript web, SQL migrations, or generated contracts; Python needs a dated advanced-ML/data exception
   Rerun: `just score`
   Fingerprint: `sha256:cb761bfd0905e87c735f65b68367fd1f801f15135660327acae3c2a868dced93`
   Evidence: workflows/build-batch.js uses `.js`, Rust core + TypeScript/React/Vite + PostgreSQL + generated contracts + exception-only Python AI/data service
27. `high` `vibe` `workflows/build-batch.js:194`
   Rule: `HLT-001-DEAD-MARKER`
   Check: `HLT-001-DEAD-MARKER:vibe` `hard` confidence `0.88`
   Route: TLR `Entropy`, lane `fast`, owner `tools`
   Docs: `docs/audit-rubric.md#future-hostile-language-rule`
   Reason: future-hostile/dead-language term `stale` appears in product/runtime code
   Fix: remove or rename the marker, implement the intended behavior, model a typed unsupported state, or move docs/generated/vendor/product-copy text into an allowlisted context
   Rerun: `just fast`
   Fingerprint: `sha256:9e711bfda213162dff9e272b7659e1054bdc00af78a6815a8e990bf924621e96`
   Evidence: workflows/build-batch.js:194, future-hostile/dead-language term `stale` appears
28. `high` `vibe` `workflows/build-batch.js:197`
   Rule: `HLT-001-DEAD-MARKER`
   Check: `HLT-001-DEAD-MARKER:vibe` `hard` confidence `0.88`
   Route: TLR `Entropy`, lane `fast`, owner `tools`
   Docs: `docs/audit-rubric.md#future-hostile-language-rule`
   Reason: future-hostile/dead-language term `stale` appears in product/runtime code
   Fix: remove or rename the marker, implement the intended behavior, model a typed unsupported state, or move docs/generated/vendor/product-copy text into an allowlisted context
   Rerun: `just fast`
   Fingerprint: `sha256:3dafe7d10cc6b8ab433e4f6384cb59ebabfcd6bbdb7a42d9ff4b69f829877da9`
   Evidence: workflows/build-batch.js:197, future-hostile/dead-language term `stale` appears
29. `high` `vibe` `workflows/build-batch.js:200`
   Rule: `HLT-001-DEAD-MARKER`
   Check: `HLT-001-DEAD-MARKER:vibe` `hard` confidence `0.88`
   Route: TLR `Entropy`, lane `fast`, owner `tools`
   Docs: `docs/audit-rubric.md#future-hostile-language-rule`
   Reason: future-hostile/dead-language term `stale` appears in product/runtime code
   Fix: remove or rename the marker, implement the intended behavior, model a typed unsupported state, or move docs/generated/vendor/product-copy text into an allowlisted context
   Rerun: `just fast`
   Fingerprint: `sha256:f8664b67d7eeffabc70be4f5b0994cee1297291366addbc9003c60431bc9f68b`
   Evidence: workflows/build-batch.js:200, future-hostile/dead-language term `stale` appears
30. `high` `vibe` `workflows/build-batch.js:212`
   Rule: `HLT-001-DEAD-MARKER`
   Check: `HLT-001-DEAD-MARKER:vibe` `hard` confidence `0.88`
   Route: TLR `Entropy`, lane `fast`, owner `tools`
   Docs: `docs/audit-rubric.md#future-hostile-language-rule`
   Reason: future-hostile/dead-language term `stale` appears in product/runtime code
   Fix: remove or rename the marker, implement the intended behavior, model a typed unsupported state, or move docs/generated/vendor/product-copy text into an allowlisted context
   Rerun: `just fast`
   Fingerprint: `sha256:8c33c4c43d594dc3959a05ec135adfbe5f739113afc65ee0766804bcd9a18704`
   Evidence: workflows/build-batch.js:212, future-hostile/dead-language term `stale` appears
31. `high` `security` `workflows/build-batch.js:361`
   Rule: `HLT-023-INPUT-BOUNDARY-GAP`
   Check: `HLT-023-INPUT-BOUNDARY-GAP:security` `hard` confidence `0.88`
   Route: TLR `Security, secrets, agency`, lane `security`, owner `ops`
   Docs: `docs/audit-rubric.md#top-level-risk-mapping`
   Matched term: `string sql`
   Reason: input handling risk needs deterministic negative tests
   Fix: replace unsafe sinks with typed schemas, parameterized APIs, allowlists, or sandboxed execution plus negative tests
   Rerun: `just security`
   Fingerprint: `sha256:744e40b4bfd3f925eea50e8f48e4d17bdd8d0ab0d76215009bc96deefce50036`
   Evidence: 2. From the remaining beads, select up to ${parsedArgs.workers} candidates, enforcing pairwise filesTouched disjointness within the wave:
32. `high` `vibe` `workflows/build-batch.js:518`
   Rule: `HLT-001-DEAD-MARKER`
   Check: `HLT-001-DEAD-MARKER:vibe` `hard` confidence `0.88`
   Route: TLR `Entropy`, lane `fast`, owner `tools`
   Docs: `docs/audit-rubric.md#future-hostile-language-rule`
   Reason: future-hostile/dead-language term `fallback` appears in product/runtime code
   Fix: remove or rename the marker, implement the intended behavior, model a typed unsupported state, or move docs/generated/vendor/product-copy text into an allowlisted context
   Rerun: `just fast`
   Fingerprint: `sha256:f28682b8c6f4ebef8b6df4bf82818e55183480b58c757eef630684d78fcff0c6`
   Evidence: workflows/build-batch.js:518, future-hostile/dead-language term `fallback` appears
33. `high` `vibe` `workflows/build-batch.js:520`
   Rule: `HLT-001-DEAD-MARKER`
   Check: `HLT-001-DEAD-MARKER:vibe` `hard` confidence `0.88`
   Route: TLR `Entropy`, lane `fast`, owner `tools`
   Docs: `docs/audit-rubric.md#future-hostile-language-rule`
   Reason: future-hostile/dead-language term `fallback` appears in product/runtime code
   Fix: remove or rename the marker, implement the intended behavior, model a typed unsupported state, or move docs/generated/vendor/product-copy text into an allowlisted context
   Rerun: `just fast`
   Fingerprint: `sha256:6a075e61bf5ee449ccb249194f8b1abd4ed1639f47b926c14c635c330d500d68`
   Evidence: workflows/build-batch.js:520, future-hostile/dead-language term `fallback` appears
34. `high` `vibe` `workflows/build-batch.js:521`
   Rule: `HLT-001-DEAD-MARKER`
   Check: `HLT-001-DEAD-MARKER:vibe` `hard` confidence `0.88`
   Route: TLR `Entropy`, lane `fast`, owner `tools`
   Docs: `docs/audit-rubric.md#future-hostile-language-rule`
   Reason: future-hostile/dead-language term `fallback` appears in product/runtime code
   Fix: remove or rename the marker, implement the intended behavior, model a typed unsupported state, or move docs/generated/vendor/product-copy text into an allowlisted context
   Rerun: `just fast`
   Fingerprint: `sha256:2096a9905f9a7828e3e07fd81de1e484893d9e4c83f32adfce6c7522d3c08b07`
   Evidence: workflows/build-batch.js:521, future-hostile/dead-language term `fallback` appears
35. `high` `vibe` `workflows/decompose.js:240`
   Rule: `HLT-001-DEAD-MARKER`
   Check: `HLT-001-DEAD-MARKER:vibe` `hard` confidence `0.88`
   Route: TLR `Entropy`, lane `fast`, owner `tools`
   Docs: `docs/audit-rubric.md#future-hostile-language-rule`
   Reason: future-hostile/dead-language term `temp` appears in product/runtime code
   Fix: remove or rename the marker, implement the intended behavior, model a typed unsupported state, or move docs/generated/vendor/product-copy text into an allowlisted context
   Rerun: `just fast`
   Fingerprint: `sha256:0b79bb4114cdc2cdba3b2c63506f06e7892397e3c82b22a573a4dd8246b27fa2`
   Evidence: workflows/decompose.js:240, future-hostile/dead-language term `temp` appears
36. `high` `vibe` `workflows/decompose.js:306`
   Rule: `HLT-001-DEAD-MARKER`
   Check: `HLT-001-DEAD-MARKER:vibe` `hard` confidence `0.88`
   Route: TLR `Entropy`, lane `fast`, owner `tools`
   Docs: `docs/audit-rubric.md#future-hostile-language-rule`
   Reason: future-hostile/dead-language term `fallback` appears in product/runtime code
   Fix: remove or rename the marker, implement the intended behavior, model a typed unsupported state, or move docs/generated/vendor/product-copy text into an allowlisted context
   Rerun: `just fast`
   Fingerprint: `sha256:fd4f1a23260f8b9188c7559862d4045ef2e1f682d25cc3003088d950d6741d57`
   Evidence: workflows/decompose.js:306, future-hostile/dead-language term `fallback` appears

## Policy

- Policy file: `./agent/audit-policy.toml`
- Minimum score: `85`
- Fail on: `critical, high`

## Agent Fix Queue

1. `high` `HLT-007-HANDWRITTEN-CONTRACT` `contracts/` - generate boundary clients and gate drift with public-API or semver checks
   Route: `Contracts/data`/`contract`
2. `medium` `HLT-007-HANDWRITTEN-CONTRACT` `agent/boundaries.toml` - add generated contracts and boundary checks for public APIs, data access, and cross-runtime seams
   Route: `Contracts/data`/`contract`
3. `medium` `HLT-006-DIRECT-DB-WRONG-LAYER` `db/` - move durable truth into migrations, constraints, adapters, and application-owned transactions
   Route: `Contracts/data`/`db`
4. `high` `HLT-004-UNMAPPED-PROOF` `.` - add a fast lane that runs the narrowest deterministic proof loop and keep it canonical
   Route: `Verification`/`fast`
5. `high` `.` - add a canonical `setup`, `check`, `test`, or `verify` lane in one root command file
   Route: `Verification`/`fast`
6. `high` `HLT-025-RELEASE-READINESS-GAP` `docs/release.md` - add a release control surface with version source, changelog, release process docs, CI or script evidence, integrity/provenance evidence, and rollback guidance
   Route: `Verification`/`release`
7. `medium` `HLT-018-PERF-CONCURRENCY-DRIFT` `Justfile` - add fast deterministic build/test targets, caches, and narrow proof lanes for agent iteration
   Route: `Verification`/`fast`
8. `medium` `HLT-004-UNMAPPED-PROOF` `agent/test-map.json` - route each owned path to a deterministic proof command and make the lane executable in CI
   Route: `Verification`/`fast`
9. `medium` `HLT-026-COST-BUDGET-GAP` `docs/testing.md` - add explicit budgets, quotas, stop conditions, and kill-switch evidence for paid or unbounded operations
   Route: `Verification`/`release`
10. `high` `HLT-017-OPAQUE-OBSERVABILITY` `crates/domain` - define a typed exception surface with purpose, reason, common fixes, docs_url, and repair_hint so the next rerun is local
   Route: `Repair`/`observability`
11. `medium` `HLT-017-OPAQUE-OBSERVABILITY` `docs/testing.md` - add structured errors, telemetry, and repair receipts that tell the next agent where to rerun proof
   Route: `Repair`/`observability`
12. `medium` `HLT-027-HUMAN-REVIEW-EVIDENCE-GAP` `tests/vision-eval/fixtures/10-adversarial-empty-product-sections/expect.json` - attach raw CI logs, review receipts, and replayable commands instead of accepting claims or summaries
   Route: `Repair`/`audit`
13. `high` `HLT-035-GIT-BAD-BEHAVIOR` `.claude/agents/beads-builder.md` - enumerate the exact paths and keep verification on
   Route: `Context/setup`/`audit`
14. `high` `.github/workflows` - add a CI job that runs `jankurai . --json .jankurai/repo-score.json --md .jankurai/repo-score.md` and uploads both artifacts
   Route: `Context/setup`/`audit`
15. `high` `workflows/build-batch.js` - move product runtime behavior to Rust core, TypeScript web, SQL migrations, or generated contracts; Python needs a dated advanced-ML/data exception
   Route: `Context/setup`/`audit`
16. `medium` `HLT-015-CONTEXT-SETUP-GAP` `AGENTS.md` - keep root guidance short and route durable detail through agent-readable manifests and docs
   Route: `Context/setup`/`fast`
17. `medium` `HLT-003-OWNERLESS-PATH` `agent/owner-map.json` - tighten owner/test maps and root routing until agents can localize ownership without inference
   Route: `Context/setup`/`fast`
18. `medium` `docs/` - add concise docs for architecture, boundaries, tests, generated zones, and audit rules; route them from root `AGENTS.md`
   Route: `Context/setup`/`audit`
19. `high` `HLT-009-GENERATED-SECURITY` `.github/workflows` - add a dedicated security lane with secret scanning, dependency review, and workflow linting
   Route: `Security, secrets, agency`/`security`
20. `high` `HLT-016-SUPPLY-CHAIN-DRIFT` `.github/workflows` - add secret scanning, dependency review, and SBOM or provenance checks to CI
   Route: `Security, secrets, agency`/`security`
21. `high` `HLT-001-DEAD-MARKER` `install.sh` - remove or rename the marker, implement the intended behavior, model a typed unsupported state, or move docs/generated/vendor/product-copy text into an allowlisted context
   Route: `Entropy`/`fast`
22. `high` `HLT-001-DEAD-MARKER` `workflows/build-batch.js` - remove or rename the marker, implement the intended behavior, model a typed unsupported state, or move docs/generated/vendor/product-copy text into an allowlisted context
   Route: `Entropy`/`fast`
23. `high` `HLT-023-INPUT-BOUNDARY-GAP` `workflows/build-batch.js` - replace unsafe sinks with typed schemas, parameterized APIs, allowlists, or sandboxed execution plus negative tests
   Route: `Security, secrets, agency`/`security`
24. `high` `HLT-001-DEAD-MARKER` `workflows/decompose.js` - remove or rename the marker, implement the intended behavior, model a typed unsupported state, or move docs/generated/vendor/product-copy text into an allowlisted context
   Route: `Entropy`/`fast`
25. `medium` `HLT-001-DEAD-MARKER` `.` - split large or ambiguous authored code into smaller semantic modules with focused tests
   Route: `Entropy`/`fast`
26. `medium` `HLT-016-SUPPLY-CHAIN-DRIFT` `.github/workflows/jankurai.yml` - wire secret, dependency, provenance, and workflow scans into an operational CI lane
   Route: `Security, secrets, agency`/`security`
