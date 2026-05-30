export const meta = {
  name: 'vision',
  description: 'Workflow half of the hybrid /vision (epic autonomous-build-ih5). Turns a filled vision.md into plan.lock.json (schemaVersion 2) + plan.md + tenets.md. Phase 1 intake validates the product brief (NEEDS-INPUT, never invents content, when §1/§3/§8 are unfilled); Phase 2 builds the frozen skeleton (data model + feature order + stack-native formula picks) and emits the observable signals from which a pure-JS deriveApplicability resolves each of the ten concerns; Phase 3 fans out one agent per APPLICABLE concern over the frozen skeleton, each seeing ONLY its own concern bar — addressed-with-falsifiable-evidence or excluded-with-reason, undecidable -> a concern-decidedness block; Phase 4 reconciles (folds in excluded-by-default concerns) + runs the four gates (decidedness, forward-coverage, reverse-trace, musthave-nongoal) + the required+excluded contradiction scan, computes the decidedness verdict, and BUILDS + VALIDATES the lock/plan.md/tenets.md in pure JS (the lone agent only writes the files). SYNC: spec is workflows/vision.spec.md (edit in lockstep, T3); CONCERN_IDS / CONCERN_BARS / EVIDENCE_BAR / GATE_TOKENS mirror docs/PLAN_CONCERNS.md + vision-eval.js; validateLock is a superset of vision-eval.js L1; lock shape mirrors schemas/plan.lock.schema.json; TENETS_INHERITED_MD mirrors templates/tenets.md + docs/TENETS.md; DEFAULT_STACK mirrors docs/DEFAULT_STACK.md.',
  whenToUse: 'Invoked by the /vision skill shell for the concern-derivation engine, or directly (Workflow vision) for a headless run over a vision.md (the path vision-eval grades). Use --no-file to derive without writing, --selftest to CI the pure-JS intake/applicability/skeleton/concern/reconcile/assemble logic with NO agents.',
  phases: [
    { title: 'Intake',   detail: 'Read + validate vision.md; NEEDS-INPUT on unfilled §1/§3/§8 (1 agent)' },
    { title: 'Skeleton', detail: 'Build the frozen skeleton + observable signals; derive applicability in pure JS (1 agent)' },
    { title: 'Concerns', detail: 'Fan out 1 agent per applicable concern over the frozen skeleton (addressed+evidence | excluded+reason | block)' },
    { title: 'Assemble', detail: 'Reconcile + four gates + decidedness verdict; build+validate lock/plan.md/tenets.md in pure JS; 1 agent writes the files' }
  ]
};

// ===========================================================================
// Args (same runtime-arg discovery convention as decompose.js / vision-eval.js)
// ===========================================================================
const rawArgs =
  (typeof args !== 'undefined') ? args :
  (typeof userArgs !== 'undefined') ? userArgs :
  (typeof input !== 'undefined') ? input : '';

function parseArgs(s) {
  // replanFrom: when set, this is /replan (epic 0ms) — a scoped re-run that FREEZES phases < N
  // (already built) and re-derives phases >= N with the prior build's outcomes + /retro as context.
  // null = a normal from-scratch /vision.
  const out = { visionPath: 'vision.md', skeletonPath: null, outPath: 'plan.lock.json', dryRun: false, selftest: false, replanFrom: null };
  const tokens = (typeof s === 'string') ? s.trim().split(/\s+/).filter(Boolean) : (Array.isArray(s) ? s : []);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--vision' && tokens[i + 1]) { out.visionPath = tokens[++i]; }
    else if (tokens[i] === '--skeleton' && tokens[i + 1]) { out.skeletonPath = tokens[++i]; }
    else if (tokens[i] === '--out' && tokens[i + 1]) { out.outPath = tokens[++i]; }
    else if (tokens[i] === '--no-file') { out.dryRun = true; }
    else if (tokens[i] === '--selftest') { out.selftest = true; }
    else if (tokens[i] === '--replan-from' && tokens[i + 1]) { const n = parseInt(tokens[++i], 10); if (Number.isInteger(n) && n >= 1) out.replanFrom = n; }
  }
  return out;
}
const parsedArgs = parseArgs(rawArgs);

// ===========================================================================
// Inlined consts (SYNC). The workflow runs in the APP cwd where docs/PLAN_CONCERNS.md
// and docs/DEFAULT_STACK.md do NOT exist, so everything an agent needs is inlined as a
// JS const — the same documented-sync discipline vision-eval.js uses for CONCERN_IDS /
// EVIDENCE_BAR / GATE_TOKENS. When the docs change, these change in the same commit.
// ===========================================================================

// SYNC: docs/PLAN_CONCERNS.md "The concern vocabulary" + vision-eval.js CONCERN_IDS (verbatim).
const CONCERN_IDS = [
  'data-model', 'authn', 'authz', 'secrets', 'data-lifecycle',
  'error-handling', 'observability', 'external-integrations', 'perf-envelope', 'abuse-surface'
];

// The load-bearing product sections (by NAME — the intake agent maps headings, not numbers).
// templates/vision.md ships: §1 problem, §3 must-haves, §8 success metric are the three a plan
// cannot be derived without (§5 non-goals / §2 users are read for signals but do not block).
const LOAD_BEARING = ['problem', 'mustHaves', 'successMetric'];

// The observable booleans the skeleton agent reports; deriveApplicability() maps them to tiers.
const SIGNAL_NAMES = [
  'impliesAccounts', 'multipleHumanRoles', 'multiplePrincipals', 'crossUserData',
  'privacyConstraint', 'holdsPii', 'productionOperation', 'externalIntegrations',
  'scaleTarget', 'publicSurface'
];

// SYNC: docs/PLAN_CONCERNS.md "Evidence — what counts" + vision-eval.js EVIDENCE_BAR (verbatim).
// Phase 3 (ih5.3) hands this to each concern agent; vision-eval L4 grades against the same bar.
const EVIDENCE_BAR = `An "addressed" concern's evidence must point at something a verifier can check EXISTS. Falsifiable evidence is ONE of:
  1. a featureOrder[] entry (by name) that delivers the concern,
  2. a formula that encodes it (e.g. oidc-client-rust, otel-bootstrap-rust),
  3. a tenet, by number (e.g. "T7: no swallowed exceptions"),
  4. the quality gate (hooks/post-build-gate.{sh,ps1}),
  5. a DEFAULT_STACK.md pin.
A BARE ASSERTION ("handled", "we handle auth", "we take security seriously", "standard practices", "users log in", "permissions enforced", "we use env vars") is NOT evidence — it is unfalsifiable and FAILS the bar. Naming a concrete mechanism cited to one of the five anchors above passes; a vibe does not.`;

// SYNC: docs/PLAN_CONCERNS.md "The concern vocabulary" table, column "addressed requires (falsifiable)" — verbatim
// per concern. Each Phase-3 concern agent receives ONLY its own line (it must never see the others' contracts or
// outputs — that is the independence the fan-out exists for). One entry per CONCERN_ID (selftest asserts coverage).
const CONCERN_BARS = {
  'data-model': `Every must-have entity appears in the plan's Data model with fields + relationships — not "we'll have a database."`,
  'authn': `Names *who* authenticates (which §2 role) **and** the mechanism, cited to a feature/formula (e.g. "OIDC login for the Operator role via \`oidc-client-rust\`") — not "users log in."`,
  'authz': `The authorization boundary: who may read/write whose data, cited to a feature or enforcement point (e.g. "OpenFGA model: a user reads only their own habits; tenants isolated") — not "permissions enforced."`,
  'secrets': `Where each secret lives + that it is not in the repo, enumerated (e.g. "DB URL + OIDC client secret via env from the host secret store; \`.env\` gitignored") — not "we use env vars."`,
  'data-lifecycle': `Retention/deletion stance for user data **and** whether migrations are destructive (e.g. "habits soft-deleted; user hard-delete cascades; migrations additive in v1"). Ties to **T5 reversibility** + **T8 idempotency**.`,
  'error-handling': `Names the failure modes that need *design* (partial failure, retries, dependency-down) **and** cites **T7** for the rest — not silence. Cheap to address, but must be named.`,
  'observability': `A feature/formula that emits them (e.g. "\`otel-bootstrap-rust\` emits traces+metrics") **or** \`excluded\` with reason.`,
  'external-integrations': `Each integration named with its shape (auth, data flow, failure mode) **or** "none." A silent integration is a hidden dependency + a secrets/abuse surface.`,
  'perf-envelope': `A concrete envelope **if** the success metric implies one (e.g. "p99 < 200ms on the streak endpoint at 100 concurrent users") **or** \`excluded\` ("v1 single-user, no perf target") — not a vibe.`,
  'abuse-surface': `For each public surface: an input-validation + rate-limit stance. By default this is the **pinned abuse-surface posture** (DEFAULT_STACK §"Pinned abuse-surface posture": per-tenant \`tower-governor\` token-bucket + WAFv2 rate-based rule + body-size/\`validator\` bounds, realized by \`concern-enforcement-abuse-surface\`) — an auth'd/public app cites that DEFAULT_STACK pin + formula as evidence and is \`addressed\`, not blocked. \`excluded\` only when there is no public/unauthenticated network surface.`
};

// SYNC: skills/vision/SKILL.md gates + vision-eval.js GATE_TOKENS. The controlled openQuestions[].context
// vocabulary; each blocking question's context STARTS WITH one of these tokens so downstream maps it.
const GATE_TOKENS = {
  'forward-coverage':                 /forward[-\s]?coverage/i,
  'reverse-trace':                    /reverse[-\s]?trace/i,
  'success-metric-oracle':            /success[-\s]?metric/i,
  'concern-decidedness':              /decidedness/i,
  'required-excluded-contradiction':  /required[-\s]?\+?[-\s]?excluded|required.{0,12}excluded|contradiction/i,
  'musthave-nongoal-contradiction':   /non[-\s]?goal|musthave[-\s]?nongoal|forbidden/i,
  'no-matching-formula':              /no[-\s]?matching[-\s]?formula|needs new formula|formula gap/i,
  'missing-product-sections':         /missing[-\s]?product[-\s]?section|empty.{0,12}section|unfilled/i
};

// SYNC: docs/DEFAULT_STACK.md "The stack" + "Stack-native formulas". Inlined so the headless
// skeleton agent resolves the stack without reading the repo. Compact, but faithful to the pins.
const DEFAULT_STACK = `Layers (copy verbatim into stack[]; "why" cites DEFAULT_STACK):
  - Core/services: Rust (all product truth, authorization, direct Postgres writes, backend glue).
  - Product surface: TypeScript + React + Vite (user-facing UI / product-surface JS).
  - Database: PostgreSQL (the truth layer; SQLite is NOT a v1 fallback).
  - Cross-language contracts: generated (TS types from Rust — ts-rs / OpenAPI; no hand-duplicated types).
  - AI/data service: Python — EXCEPTION ONLY (model-serving sidecar etc); never for tooling/truth/services/authz/glue.
  - Tests: Rust cargo test; TS vitest; Python pytest. Lint/format: Rust cargo fmt + clippy; TS biome; Python ruff.
  - Hosting: per-app, chosen at deploy time (not vision time).

Stack-native formulas — PREFER the native variant; a generic formula is a FALLBACK only when no native covers the capability:
  - Repo/workspace skeleton (Rust core): app-skeleton (generic) -> app-skeleton-rust-cargo (native)
  - Frontend skeleton:                    app-skeleton (generic) -> app-skeleton-vite-react (native)
  - CRUD entity vertical slice:           crud-feature (generic) -> crud-feature-rust (native)
  - Non-CRUD gRPC service:                (none)                 -> grpc-tonic-service
  - Closed grammar / composer version:    (none)                 -> composer-grammar-version
  - Observability bootstrap:              (misuse app-skeleton)  -> otel-bootstrap-rust
  - Audit chain:                          background-job (gen)   -> audit-chain-rust
  - Tenant-boot chokepoint:               background-job (gen)   -> tenant-boot-rust
  - OIDC auth client:                     integration-http (gen) -> oidc-client-rust
  - ReBAC authz model:                    integration-http (gen) -> openfga-model
  - IaC / cloud baseline:                 app-skeleton (gen)     -> terraform-aws-baseline
  - Schema migration:                     (shared)               -> migration (supply Rust/sqlx up/down_outline)

The off-enum tell: the generic formulas declare JS/Python enum vars. If binding a feature to a generic formula
forces an OFF-ENUM value (package_manager=cargo, language=rust, trigger_type=internal|cron), that is proof the
generic pick is wrong on this stack — switch to the native variant (defect autonomous-build-3fr.1), do NOT remap.`;

// Off-enum detector inputs (the 3fr.1 determinism check). A generic formula bound to one of these
// values is the wrong-pick signal a native variant exists for.
const GENERIC_FORMULAS = new Set(['app-skeleton', 'crud-feature', 'background-job', 'integration-http']);
const OFF_ENUM_TELLS = [
  { var: 'package_manager', val: 'cargo' },
  { var: 'language', val: 'rust' },
  { var: 'trigger_type', val: 'internal' },
  { var: 'trigger_type', val: 'cron' }
];

const PLACEHOLDER_RX = /^[.…]+$/; // "...", "…" — an unedited template ellipsis bullet.

// ===========================================================================
// Pure helpers + logic. No workflow globals, no side effects — reached by the node
// selftest via the globalThis bridge at the bottom (the runtime forbids `export` other
// than `meta`, so these are plain declarations exposed under node only).
// ===========================================================================
const isArr = Array.isArray;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const nonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;

// Pull a JSON object out of a possibly-fenced / prose-wrapped agent reply (mirrors vision-eval).
function extractJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first !== -1 && last > first) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { return null; }
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

function stripBullet(s) {
  return String(s).replace(/^\s*[-*]\s*(\[[ xX]?\]\s*)?/, '').trim();
}

// Mechanical emptiness backstop: a section has content if (any) entry is non-empty, non-ellipsis text.
function hasContent(v) {
  if (isArr(v)) return v.some((x) => hasContent(x));
  if (!isStr(v)) return false;
  const t = stripBullet(v);
  return t.length > 0 && !PLACEHOLDER_RX.test(t);
}

function mkBlocking(token, question) {
  return { question, blockingCompose: true, context: `${token}: ${question}` };
}

// The headless NEEDS-INPUT block: incomplete:true + a missing-product-sections openQuestion, and
// every concern marked 'underivable' (applicability derives from §3/§5/§8 — nothing to derive from).
// Matches the vision-eval oracle for the empty-product-sections fixture.
function buildNeedsInput(missing) {
  const m = isArr(missing) ? missing : [];
  return {
    status: 'needs-input',
    incomplete: true,
    missing: m,
    skeleton: null,
    applicability: Object.fromEntries(CONCERN_IDS.map((id) => [id, 'underivable'])),
    openQuestions: [
      mkBlocking('missing-product-sections',
        `Vision is missing load-bearing product section(s): ${m.join(', ')}. Fill them in vision.md and re-run /vision — /vision will not invent product content (T1).`)
    ]
  };
}

// Phase 1 verdict. Pure JS over the intake agent's raw extraction: a load-bearing section is
// "filled" only if the agent judged it real content AND it survives the mechanical backstop
// (so a wrong agent filled-flag on an "..." bullet still fails). Returns ok | needs-input | failed.
function validateIntake(raw) {
  if (!isObj(raw)) return { status: 'failed', reason: 'intake returned no object' };
  if (raw.visionExists !== true) return { status: 'failed', reason: `no vision.md found (intake.visionExists=${JSON.stringify(raw.visionExists)})` };
  const sections = isObj(raw.sections) ? raw.sections : {};
  const filled = isObj(raw.filled) ? raw.filled : {};
  const missing = [];
  for (const name of LOAD_BEARING) {
    const mechanical = hasContent(sections[name]);
    const agentFilled = filled[name] === true;
    if (!(mechanical && agentFilled)) missing.push(name);
  }
  if (missing.length) return { status: 'needs-input', missing, sections };

  // Assign stable M-ids in document order — load-bearing for coverage[] binding downstream.
  const rawMH = isArr(sections.mustHaves) ? sections.mustHaves : [];
  const mustHaves = rawMH
    .map(stripBullet)
    .filter((t) => t.length > 0 && !PLACEHOLDER_RX.test(t))
    .map((text, i) => ({ id: `M${i + 1}`, text }));
  if (!mustHaves.length) return { status: 'needs-input', missing: ['mustHaves'], sections };

  const skeleton = isObj(raw.skeleton) ? raw.skeleton : null;
  return { status: 'ok', sections, mustHaves, headless: !skeleton, skeleton };
}

// The applicability derivation table, as code (SYNC: docs/PLAN_CONCERNS.md "Applicability — and how
// it is derived"). The agent reports observable signals; THIS resolves the tier — so the derivation
// is reproducible and selftestable. data-model / error-handling / external-integrations are always
// required-to-decide; data-lifecycle / observability default optional; the other five are
// excluded-by-default and elevate to required only on a signal.
//
// ORACLE-GROUNDED (fixture 04-public-unauth-api): a §6 BUDGET line is a cost ceiling, NOT a
// secret-management signal — elevating secrets on budget there manufactures a false required+excluded
// contradiction. So secrets elevates only on authn / external-integrations / PRIVACY (not budget),
// and data-lifecycle only on privacy / PII. A paid-API budget surfaces as external-integrations, which
// already elevates secrets. (docs/PLAN_CONCERNS.md reconciled — "budget" dropped from the secrets
// elevator, bead autonomous-build-lvl; skills/vision/SKILL.md no longer carries the prose post-ih5.5.)
function deriveApplicability(signals) {
  const s = isObj(signals) ? signals : {};
  const sig = (k) => s[k] === true;
  const authn = (sig('impliesAccounts') || sig('multipleHumanRoles')) ? 'required' : 'excluded-by-default';
  const authz = (authn === 'required' && (sig('multiplePrincipals') || sig('crossUserData'))) ? 'required' : 'excluded-by-default';
  const secrets = (authn === 'required' || sig('externalIntegrations') || sig('privacyConstraint')) ? 'required' : 'excluded-by-default';
  const dataLifecycle = (sig('privacyConstraint') || sig('holdsPii')) ? 'required' : 'optional';
  const observability = sig('productionOperation') ? 'required' : 'optional';
  const perf = sig('scaleTarget') ? 'required' : 'excluded-by-default';
  const abuse = sig('publicSurface') ? 'required' : 'excluded-by-default';
  return {
    'data-model': 'required',
    'authn': authn,
    'authz': authz,
    'secrets': secrets,
    'data-lifecycle': dataLifecycle,
    'error-handling': 'required',
    'observability': observability,
    'external-integrations': 'required',
    'perf-envelope': perf,
    'abuse-surface': abuse
  };
}

// Applicable = required | optional. excluded-by-default concerns are NOT fanned out in Phase 3 —
// they are folded in directly as status:excluded with the standard reason (Phase 4).
function applicableConcerns(applicability) {
  const a = isObj(applicability) ? applicability : {};
  return CONCERN_IDS.filter((id) => a[id] !== 'excluded-by-default');
}

// Coerce the skeleton agent's raw output into the canonical frozen shape; collect shape errors
// (a malformed skeleton is a Phase-2 failure, not a guess to paper over — T7).
function normalizeSkeleton(raw) {
  const errors = [];
  if (!isObj(raw)) return { skeleton: null, errors: ['skeleton not an object'] };
  const app = isObj(raw.app) ? raw.app : {};
  if (!nonEmptyStr(app.name)) errors.push('app.name missing/empty');
  if (!nonEmptyStr(app.slug)) errors.push('app.slug missing/empty');

  const mustHaves = isArr(raw.mustHaves) ? raw.mustHaves : (errors.push('mustHaves must be an array'), []);
  if (isArr(raw.mustHaves) && !mustHaves.length) errors.push('mustHaves empty');
  mustHaves.forEach((m, i) => { if (!isObj(m) || !nonEmptyStr(m.id) || !nonEmptyStr(m.text)) errors.push(`mustHaves[${i}] needs {id,text}`); });

  const sm = isObj(raw.successMetric) ? raw.successMetric : (errors.push('successMetric must be an object'), {});
  if (!nonEmptyStr(sm.statement)) errors.push('successMetric.statement missing/empty');
  if (!isArr(sm.steps)) errors.push('successMetric.steps must be an array');

  if (!isObj(raw.stack)) errors.push('stack must be an object');

  const dataModel = isArr(raw.dataModel) ? raw.dataModel : (errors.push('dataModel must be an array'), []);
  dataModel.forEach((e, i) => { if (!isObj(e) || !nonEmptyStr(e.entity)) errors.push(`dataModel[${i}].entity missing`); });

  const featureOrder = isArr(raw.featureOrder) ? raw.featureOrder : (errors.push('featureOrder must be an array'), []);
  featureOrder.forEach((f, i) => {
    if (!isObj(f) || !nonEmptyStr(f.name)) errors.push(`featureOrder[${i}].name missing`);
    if (f && !isArr(f.formulas)) errors.push(`featureOrder[${i}].formulas must be an array`);
  });

  const skeleton = {
    app: { name: app.name, slug: app.slug, summary: nonEmptyStr(app.summary) ? app.summary : '' },
    mustHaves,
    successMetric: { statement: sm.statement, steps: isArr(sm.steps) ? sm.steps : [] },
    stack: isObj(raw.stack) ? raw.stack : {},
    dataModel,
    featureOrder,
    nonGoals: isArr(raw.nonGoals) ? raw.nonGoals : [],
    agentConsults: isArr(raw.agentConsults) ? raw.agentConsults : []
  };
  return { skeleton, errors };
}

// 3fr.1 determinism reference: a feature bound to a GENERIC formula whose vars carry a stack-native
// off-enum value is a wrong pick (a native variant exists). Phase 2 turns each hit into a
// no-matching-formula block carried to Phase 4. Reference check; does not resolve 3fr.1.
function detectOffEnumPicks(featureOrder) {
  const off = [];
  (isArr(featureOrder) ? featureOrder : []).forEach((f) => {
    if (!isObj(f)) return;
    const formulas = isArr(f.formulas) ? f.formulas : [];
    const generic = formulas.find((x) => GENERIC_FORMULAS.has(x));
    if (!generic) return;
    const vars = isObj(f.vars) ? f.vars : {};
    for (const tell of OFF_ENUM_TELLS) {
      const v = vars[tell.var];
      if (isStr(v) && v.toLowerCase() === tell.val) {
        off.push({ feature: f.name, formula: generic, var: tell.var, value: v });
      }
    }
  });
  return off;
}

// ---- Phase 3 (concern fan-out) pure helpers ----

// A Phase-3 ConcernResult.blockingQuestion: { question, context } whose context LEADS WITH the
// concern-decidedness gate token so Phase 4's gate 6.5 can route it (mkBlocking adds blockingCompose
// when it is promoted to an openQuestion). Reuses the agent's own context detail when it gave one.
function concernBlock(concernId, question, agentContext) {
  const detail = nonEmptyStr(agentContext) ? agentContext.replace(/^\s*concern-decidedness:\s*/i, '').trim() : '';
  return { question, context: `concern-decidedness: ${detail || question}` };
}

// A ConcernResult is DECIDED when addressed-with-evidence or excluded-with-reason; anything carrying a
// blockingQuestion (status 'failed') is UNDECIDED and trips the Phase-4 decidedness gate (T7: never silent).
function isDecided(r) {
  return isObj(r) && (r.status === 'addressed' || r.status === 'excluded');
}

// Build the per-agent inputs for the Phase-3 fan-out: ONE entry per APPLICABLE concern, each carrying
// ONLY its own CONCERN_BARS line + the shared EVIDENCE_BAR + the frozen skeleton + the read vision sections.
// excluded-by-default concerns are NOT fanned out (Phase 4 folds them in directly) — same rule applicableConcerns uses.
function concernInputs(frozen, applicability, sections) {
  return applicableConcerns(applicability).map((concernId) => ({
    concernId,
    applicability: applicability[concernId],
    concernBar: CONCERN_BARS[concernId],
    frozenSkeleton: frozen,
    visionSections: isObj(sections) ? sections : {}
  }));
}

// Coerce + validate a concern agent's reply into the canonical ConcernResult and enforce the contract the
// JSON schema cannot express: addressed REQUIRES falsifiable evidence; excluded REQUIRES a reason; an explicit
// blockingQuestion / a 'failed' / a garbled reply is undecided. The bare-assertion screen is the agent's job
// (it holds the EVIDENCE_BAR + its concernBar), but an addressed claim with NO evidence at all is downgraded
// here to undecided rather than passed silently (T7) — never let a rubber-stamp slip the gate.
function normalizeConcernResult(raw, concernId, applicability) {
  const r = isObj(raw) ? raw : {};
  const cid = nonEmptyStr(r.concernId) ? r.concernId : concernId;
  const appl = nonEmptyStr(r.applicability) ? r.applicability : applicability;
  const bq = isObj(r.blockingQuestion) ? r.blockingQuestion : null;

  // Explicit undecidable, agent-reported failure, or a blocking question -> undecided.
  if (r.status === 'failed' || (bq && nonEmptyStr(bq.question))) {
    const q = (bq && nonEmptyStr(bq.question)) ? bq.question
      : (nonEmptyStr(r.reason) ? r.reason : `concern ${cid} could not be decided from the skeleton + vision`);
    return { concernId: cid, applicability: appl, status: 'failed', blockingQuestion: concernBlock(cid, q, bq && bq.context) };
  }

  if (r.status === 'addressed') {
    if (!nonEmptyStr(r.evidence)) {
      const q = `concern ${cid} was claimed addressed with no falsifiable evidence`;
      return { concernId: cid, applicability: appl, status: 'failed', blockingQuestion: concernBlock(cid, q) };
    }
    const out = { concernId: cid, applicability: appl, status: 'addressed', evidence: r.evidence };
    if (isObj(r.coverageLink) && nonEmptyStr(r.coverageLink.mustHaveId) && isArr(r.coverageLink.features)) {
      const features = r.coverageLink.features.filter(nonEmptyStr);
      if (features.length) out.coverageLink = { mustHaveId: r.coverageLink.mustHaveId, features };
    }
    return out;
  }

  if (r.status === 'excluded') {
    if (!nonEmptyStr(r.reason)) {
      const q = `concern ${cid} was marked excluded with no reason`;
      return { concernId: cid, applicability: appl, status: 'failed', blockingQuestion: concernBlock(cid, q) };
    }
    return { concernId: cid, applicability: appl, status: 'excluded', reason: r.reason };
  }

  // Unrecognized / missing status -> undecided (never a silent drop).
  const q = `concern ${cid} returned an unrecognized status ${JSON.stringify(r.status)}`;
  return { concernId: cid, applicability: appl, status: 'failed', blockingQuestion: concernBlock(cid, q) };
}

// ===========================================================================
// Phase 4 (reconcile + four gates + decidedness verdict + assemble) — consts + pure helpers.
// The lock object, plan.md, and tenets.md are BUILT + VALIDATED in pure JS (deterministic +
// selftestable — the same discipline the spec applies to the gates); the lone Phase-4 agent only
// WRITES the three files (the sandbox has no filesystem). A schema-invalid assembled lock is a
// workflow bug surfaced LOUD — there is no agent to retry an object the workflow built, so we fail
// rather than paper it (T7). validateLock is a strict SUPERSET of vision-eval.js's L1 validatePlanLock
// (same checks + the additionalProperties / stack-key-enum constraints the schema enforces).
// ===========================================================================

// The standard exclusion reason folded in for each excluded-by-default concern the vision did NOT
// elevate (no agent is spawned for these — Phase 4 records them directly; PLAN_CONCERNS.md §Applicability).
const STANDARD_EXCLUSIONS = {
  'authn':         'no must-have implies user accounts or login (single-user / unauthenticated v1).',
  'authz':         'no authentication or multi-principal / cross-user data — nothing to authorize.',
  'secrets':       'no auth, external integration, or privacy constraint requiring managed secrets in v1.',
  'perf-envelope': 'the success metric names no scale / latency / throughput target (no perf envelope in v1).',
  'abuse-surface': 'no public or unauthenticated network surface exposed.'
};
function standardExclusion(concernId) {
  return STANDARD_EXCLUSIONS[concernId] || `concern ${concernId} does not apply (excluded by default, not elevated by the vision).`;
}

// Concerns whose 'required' applicability means "required to DECIDE", not "required to ADDRESS" — excluding
// them WITH a reason is a valid decision (external-integrations "none"; data-model "stateless CLI"; error-handling),
// NOT a contradiction. The required+excluded scan (the acceptance's contradiction check) fires only for the
// SIGNAL-elevated concerns the product actually needs (authn/authz/secrets/data-lifecycle/observability/perf/abuse).
const DECIDE_ONLY_CONCERNS = new Set(['data-model', 'error-handling', 'external-integrations']);

// schemas/plan.lock.schema.json stack.propertyNames enum — the ONLY keys the lock's stack may carry.
const STACK_ENUM = ['language', 'backend', 'frontend', 'database', 'orm', 'auth', 'hosting', 'tests', 'lint'];
// Map the skeleton's DEFAULT_STACK layer names (normalized lowercase) onto those enum keys. Layers with no
// enum slot (cross-language contracts, ai/data sidecar) are DROPPED from the lock's stack and live in plan.md
// prose instead — the lock stays schema-valid (stack has no REQUIRED keys, only an allowed-key enum).
const STACK_KEY_MAP = {
  'core/services': 'backend', 'core': 'backend', 'services': 'backend', 'backend': 'backend', 'server': 'backend',
  'product surface': 'frontend', 'product-surface': 'frontend', 'frontend': 'frontend', 'ui': 'frontend', 'web': 'frontend',
  'language': 'language',
  'database': 'database', 'db': 'database',
  'orm': 'orm',
  'auth': 'auth', 'authn': 'auth', 'authentication': 'auth',
  'tests': 'tests', 'test': 'tests', 'testing': 'tests',
  'lint': 'lint', 'lint/format': 'lint', 'lint-format': 'lint', 'format': 'lint', 'formatting': 'lint',
  'hosting': 'hosting'
};

// reverse-trace allowlist: a feature with no mustHaveId is NOT scope creep if it pours infra / auth /
// observability (it delivers a cross-cutting concern, not a product must-have). Conservative by design —
// reverse-trace should flag only obvious orphans, never a legitimate platform feature.
const TRACED_FORMULA_RX = /(app-skeleton|oidc-client|openfga-model|otel-bootstrap|terraform|migration|tenant-boot|audit-chain|grpc-tonic|composer-grammar|integration-http|background-job)/i;

const DEFAULT_ESCALATION = { maxSessionCostUsd: 25, maxFailuresPerTask: 2 };

// Inherited workflow tenets, inlined verbatim from templates/tenets.md (the agent runs in the app cwd and
// cannot read the template/doc). SYNC with templates/tenets.md + docs/TENETS.md when the tenet set changes.
const TENETS_INHERITED_MD = `## How to use this document

1. Check the source-of-truth ordering below — most "judgment calls" are unread spec.
2. Check the inherited workflow tenets (T1–T10) — they cover the universal cases.
3. Check the app-specific tenets (A1+) — they cover what this app's vision/plan locked in.
4. If no tenet covers the question, escalate via \`bd update <id> --status=blocked\`.

---

## Source of truth ordering

When two signals disagree, the higher item wins. Always.

1. The quality gate (\`hooks/post-build-gate.{sh,ps1}\` from autonomous-build).
2. **This app's** \`plan.lock.json\`.
3. **This app's** \`plan.md\` (narrative only; lock wins where they disagree).
4. The bead spec (description + acceptance criteria + testPlan + filesTouched).
5. Formula output from \`bd mol pour\`.
6. **This app's** \`tenets.md\` (this file) — for judgment calls the above don't cover.
7. The workflow-level \`docs/TENETS.md\` in autonomous-build.
8. \`docs/DEFAULT_STACK.md\` in autonomous-build (stack decisions only).
9. Existing code in this repo (context, not contract).
10. Model intuition (last resort; treat as a guess).

---

## Inherited workflow tenets

These come from autonomous-build/docs/TENETS.md and apply to every build. One-line summaries below; read the source doc for rationale and how-to-apply.

- **T1. Escalate over guess** — when in doubt, block the bead and let \`/escalate\` page the human.
- **T2. The gate is the contract** — never weaken or skip gate steps to make a bead pass.
- **T3. Atomic bead, atomic commit** — one bead = one logical change = one commit.
- **T4. Scope discipline — build the bead, not the project** — implement exactly the AC; no invented requirements.
- **T5. Reversibility bias** — escalate irreversible steps even if not on the hard-stop list.
- **T6. Formula precedence over ad-hoc** — stack and structure come from formulas / DEFAULT_STACK, not improvisation.
- **T7. Failure visibility** — loud + recoverable beats silent + clean. No swallowed exceptions.
- **T8. Idempotency by default** — every setup step is safely re-runnable.
- **T9. Meta vs app discipline** — workflow changes propagate to every app; app changes are local.
- **T10. plan.lock.json is the contract, plan.md is the narrative** — lock wins.

For the full text, hard-conflict resolutions, and "not tenets" list, see the workflow doc.`;

// Top-level + nested allowed-key sets, mirroring the schema's additionalProperties:false.
const LOCK_TOP_KEYS = ['schemaVersion', 'app', 'mustHaves', 'successMetric', 'phases', 'stack', 'dataModel', 'featureOrder', 'coverage', 'concerns', 'crossFeatureDependencies', 'escalationBudget', 'openQuestions', 'incomplete', 'nfrs', 'agentConsults'];

function extraKeys(obj, allowed) {
  return isObj(obj) ? Object.keys(obj).filter((k) => !allowed.includes(k)) : [];
}

function siblingPath(outPath, name) {
  const s = String(outPath || '');
  const idx = s.lastIndexOf('/');
  return idx >= 0 ? s.slice(0, idx + 1) + name : name;
}

// Reconcile Phase-3 results with the excluded-by-default fold-in into the lock's concerns[] (status is
// addressed|excluded ONLY — undecided concerns can't be represented in the lock, so they surface as
// blocking openQuestions instead). Also flags the required+excluded contradiction (the acceptance's scan).
function reconcileConcerns(phase3, applicability) {
  const byId = {};
  (isArr(phase3) ? phase3 : []).forEach((c) => { if (isObj(c) && nonEmptyStr(c.concernId)) byId[c.concernId] = c; });
  const lockConcerns = [];
  const undecided = [];
  const contradictions = [];
  for (const id of CONCERN_IDS) {
    const appl = (isObj(applicability) ? applicability[id] : undefined) || 'excluded-by-default';
    if (appl === 'excluded-by-default') {
      lockConcerns.push({ concernId: id, status: 'excluded', reason: standardExclusion(id) });
      continue;
    }
    const r = byId[id];
    const hasBQ = r && isObj(r.blockingQuestion) && nonEmptyStr(r.blockingQuestion.question);
    if (!r || r.status === 'failed' || hasBQ) {
      const q = hasBQ ? r.blockingQuestion.question : `concern ${id} was not decided by the fan-out`;
      const ctx = (hasBQ && nonEmptyStr(r.blockingQuestion.context)) ? r.blockingQuestion.context : `concern-decidedness: ${q}`;
      undecided.push({ concernId: id, question: q, context: ctx });
      continue;
    }
    if (r.status === 'addressed' && nonEmptyStr(r.evidence)) {
      lockConcerns.push({ concernId: id, status: 'addressed', evidence: r.evidence });
    } else if (r.status === 'excluded' && nonEmptyStr(r.reason)) {
      lockConcerns.push({ concernId: id, status: 'excluded', reason: r.reason });
      if (appl === 'required' && !DECIDE_ONLY_CONCERNS.has(id)) contradictions.push({ concernId: id, reason: r.reason });
    } else {
      const q = `concern ${id} returned status ${JSON.stringify(r.status)} without ${r.status === 'addressed' ? 'evidence' : 'a reason'}`;
      undecided.push({ concernId: id, question: q, context: `concern-decidedness: ${q}` });
    }
  }
  return { lockConcerns, undecided, contradictions };
}

// ---- Phased builds (epic autonomous-build-0ms) -------------------------------------------------
// The skeleton AGENT applies the trigger+cut heuristic (judgment: which must-haves belong in a later
// phase) and tags them — an explicit mustHaves[].phase (int) or the legacy boolean deferred (=> phase 2).
// Pure JS here derives the phase NUMBER and the phases[] structure mechanically: the agent judges, the
// workflow assembles (the determinism discipline). A plan whose must-haves are all phase 1 is a SINGLE-phase
// plan — no phases[], no phase tags — byte-identical to the pre-phases lock (backward-compatible).
function phaseOf(entry) {
  if (!isObj(entry)) return 1;
  if (Number.isInteger(entry.phase) && entry.phase >= 1) return entry.phase;
  if (entry.deferred === true) return 2;
  return 1;
}
// A feature's phase: explicit phase, else the phase of the must-have it delivers (mustHaveId), else 1
// (skeleton/infra features with no must-have binding ride in phase 1).
function featurePhase(feature, mustHaves) {
  if (isObj(feature) && Number.isInteger(feature.phase) && feature.phase >= 1) return feature.phase;
  const mhId = isObj(feature) ? feature.mustHaveId : null;
  if (nonEmptyStr(mhId)) {
    const m = (isArr(mustHaves) ? mustHaves : []).find((x) => isObj(x) && x.id === mhId);
    if (m) return phaseOf(m);
  }
  return 1;
}
// ── Build-order tier (Layer 1, epic autonomous-build-onv) ────────────────────────────────────────
// THE single source-of-truth mapping from a featureOrder[] entry's formula picks to its build-order
// tier. /decompose consumes this to wire foundational -> platform -> feature -> enforcement ordering
// edges (and falls back to deriving it from the formula category for old locks with no tier).
//
// Tier order (most- to least-foundational): foundational < platform < feature < enforcement.
//   foundational — the compile/build scaffolding the whole tree depends on (app-skeleton, OTel/observability bootstrap).
//   platform     — shared services/infra every feature builds on (tenancy, auth[nz], audit, IaC, migrations, secrets, composer grammar).
//   feature      — product features (CRUD, gRPC, integrations, background jobs); the DEFAULT for anything unmatched.
//   enforcement  — concern-enforcement + acceptance/e2e gates that assert the finished surface; built last.
//
// PRECEDENCE: each rule is a list of case-insensitive substrings; the FIRST rule (in foundational ->
// platform -> feature -> enforcement source order) that any formula matches wins for that formula.
// A featureOrder entry with MULTIPLE formulas takes the MOST-FOUNDATIONAL (lowest/earliest) tier among
// them — e.g. an entry pouring app-skeleton + crud-feature is `foundational`, so its bead can't jump
// ahead of the scaffolding it also lays down. enforcement is checked first per-formula (a formula whose
// name screams enforcement is enforcement), but loses to any more-foundational formula in the same entry
// via the entry-level min — matching the documented foundational < ... < enforcement ordering.
const FEATURE_TIERS = ['foundational', 'platform', 'feature', 'enforcement'];
const TIER_RULES = {
  // order within a list does not matter; cross-tier precedence is the entry-level min below.
  enforcement: ['concern-enforcement', 'e2e-acceptance', '-acceptance'],
  foundational: ['app-skeleton', 'otel-bootstrap', 'otel', 'observability'],
  platform: ['tenant-boot', 'oidc-client', 'oidc', 'openfga', 'authz', 'authn', 'audit-chain',
             'terraform', 'iac', 'migration', 'composer-grammar', 'secrets'],
  // feature is the DEFAULT (crud-feature*, grpc-tonic*, integration-http, background-job, anything unmatched).
};
function tierOfFormula(name) {
  const n = isStr(name) ? name.toLowerCase() : '';
  if (!n) return 'feature';
  // `-acceptance` is a suffix check; the rest are plain substrings. enforcement first so an
  // *-acceptance formula isn't misread, but the entry-level min still demotes it under any
  // more-foundational sibling formula.
  if (n.includes('concern-enforcement') || n.includes('e2e-acceptance') || n.endsWith('-acceptance')) return 'enforcement';
  if (TIER_RULES.foundational.some((p) => n.includes(p))) return 'foundational';
  if (TIER_RULES.platform.some((p) => n.includes(p))) return 'platform';
  return 'feature';
}
// deriveFeatureTier(formulas): a featureOrder entry's formulas[] (formula-name strings) -> its tier.
// Returns the most-foundational tier present (min over the FEATURE_TIERS ordering); empty/absent -> 'feature'.
function deriveFeatureTier(formulas) {
  const list = (isArr(formulas) ? formulas : []).filter(nonEmptyStr);
  if (!list.length) return 'feature';
  let best = FEATURE_TIERS.length - 1; // most-derived = enforcement
  for (const f of list) {
    const idx = FEATURE_TIERS.indexOf(tierOfFormula(f));
    if (idx >= 0 && idx < best) best = idx;
  }
  return FEATURE_TIERS[best];
}

// Distinct phase numbers across must-haves + features, ascending. <=1 distinct phase => single-phase (null).
// Phase 1 is the walking skeleton (active, non-provisional); every later phase is planned + provisional
// (a sketch /replan firms up when reached). name/goal use the agent's `phases` hint when it gave one, else
// are synthesized (phase 1 from the success metric; later phases from their assigned must-have texts).
function derivePhases(mustHaves, featureOrder, successMetric, agentPhases) {
  const mh = isArr(mustHaves) ? mustHaves : [];
  const fo = isArr(featureOrder) ? featureOrder : [];
  const nums = new Set();
  for (const m of mh) nums.add(phaseOf(m));
  for (const f of fo) nums.add(featurePhase(f, mh));
  const ids = Array.from(nums).filter((n) => Number.isInteger(n) && n >= 1).sort((a, b) => a - b);
  if (ids.length <= 1) return null; // single-phase plan: emit no phases[]
  const meta = {};
  (isArr(agentPhases) ? agentPhases : []).forEach((p) => { if (isObj(p) && Number.isInteger(p.id)) meta[p.id] = p; });
  const sm = isObj(successMetric) ? successMetric : {};
  const smText = nonEmptyStr(sm.statement) ? sm.statement : (isArr(sm.steps) ? sm.steps.filter(nonEmptyStr).join(' → ') : '');
  return ids.map((id) => {
    const m = meta[id] || {};
    const mhTexts = mh.filter((x) => phaseOf(x) === id && nonEmptyStr(x.text)).map((x) => x.text);
    const name = nonEmptyStr(m.name) ? m.name : (id === 1 ? 'Walking skeleton' : `Phase ${id}`);
    const goal = nonEmptyStr(m.goal) ? m.goal
      : (id === 1
        ? (smText ? `Walking skeleton: make the success metric run end-to-end (${smText}).` : 'Walking skeleton: the minimal end-to-end flow.')
        : (mhTexts.length ? `Deliver: ${mhTexts.join('; ')}.` : `Phase ${id}.`));
    return { id, name, goal, status: id === 1 ? 'active' : 'planned', provisional: id !== 1 };
  });
}

// Forward-coverage map: each must-have -> the feature(s) delivering it (from featureOrder mustHaveId
// bindings + addressed-concern coverageLinks) + a falsifiable HOW. Returns the uncovered ids too. A
// future-phase (deferred) must-have with no feature yet is a legitimate deferral (covered-in-phase-N,
// epic 0ms), NOT an uncovered gap — only a PHASE-1 must-have with no feature counts as uncovered.
function buildCoverage(mustHaves, featureOrder, phase3) {
  const mh = isArr(mustHaves) ? mustHaves : [];
  const fo = isArr(featureOrder) ? featureOrder : [];
  const linkByMh = {};
  (isArr(phase3) ? phase3 : []).forEach((c) => {
    const cl = isObj(c) ? c.coverageLink : null;
    if (cl && nonEmptyStr(cl.mustHaveId) && isArr(cl.features)) {
      (linkByMh[cl.mustHaveId] = linkByMh[cl.mustHaveId] || []).push(...cl.features.filter(nonEmptyStr));
    }
  });
  const coverage = [];
  const uncovered = [];
  for (const m of mh) {
    if (!isObj(m) || !nonEmptyStr(m.id)) continue;
    const fromFeatures = fo.filter((f) => isObj(f) && f.mustHaveId === m.id && nonEmptyStr(f.name)).map((f) => f.name);
    const features = Array.from(new Set([...fromFeatures, ...(linkByMh[m.id] || [])]));
    if (!features.length) { if (phaseOf(m) === 1) uncovered.push(m.id); continue; }
    const hows = features.map((name) => {
      const f = fo.find((x) => isObj(x) && x.name === name);
      const formulas = (f && isArr(f.formulas)) ? f.formulas.filter(nonEmptyStr) : [];
      return formulas.length ? `${name} (${formulas.join(', ')})` : name;
    });
    coverage.push({ mustHaveId: m.id, features, how: `Delivered by ${hows.join('; ')}.` });
  }
  return { coverage, uncovered };
}

// reverse-trace: a featureOrder feature that maps to no must-have and pours no allowlisted infra formula
// is possible scope creep. Conservative — infra/auth/observability features are exempt (TRACED_FORMULA_RX).
function reverseTraceOrphans(featureOrder, coverage) {
  const fo = isArr(featureOrder) ? featureOrder : [];
  const covered = new Set();
  (isArr(coverage) ? coverage : []).forEach((c) => (isArr(c.features) ? c.features : []).forEach((n) => covered.add(n)));
  const orphans = [];
  for (const f of fo) {
    if (!isObj(f) || !nonEmptyStr(f.name)) continue;
    if (nonEmptyStr(f.mustHaveId) || covered.has(f.name)) continue;
    if (TRACED_FORMULA_RX.test((isArr(f.formulas) ? f.formulas : []).join(' '))) continue;
    orphans.push(f.name);
  }
  return orphans;
}

// musthave <-> non-goal contradiction (gate 8.6). Conservative substring check: a §5 non-goal forbids a
// phrase (after stripping a leading negation, split on connectors); a must-have that CONTAINS that phrase
// (>=6 chars) is requiring what the vision forbade. The phrase match is negation-aware on BOTH sides: just as
// the non-goal strips a leading negator, a must-have occurrence that is itself NEGATED (e.g. "...no free-form
// code generation") AGREES with the non-goal and must not fire — only a non-negated occurrence is a real
// contradiction (g63). Substring keeps it precise — it errs toward NOT firing (a false block of a coherent
// plan is the worse failure for a determinism harness; semantic depth is future work).
function musthaveNongoalConflicts(mustHaves, nonGoals) {
  const mh = isArr(mustHaves) ? mustHaves : [];
  const out = [];
  const seen = new Set();
  for (const goal of (isArr(nonGoals) ? nonGoals : [])) {
    if (!nonEmptyStr(goal)) continue;
    const stripped = goal.toLowerCase().replace(/^\s*(?:no|not|never|without|don'?t|avoid|exclude[ds]?)\b[:\s-]*/i, '');
    const phrases = stripped.split(/\b(?:or|and)\b|[,;/]/).map((p) => p.trim()).filter((p) => p.length >= 6);
    for (const phrase of phrases) {
      for (const m of mh) {
        if (!isObj(m) || !nonEmptyStr(m.text)) continue;
        const text = m.text.toLowerCase();
        // Negation-aware: walk every occurrence of the phrase; a real conflict needs at least one occurrence
        // that is NOT immediately preceded by a negator (mirrors the leading-negation strip on the non-goal).
        let idx = text.indexOf(phrase);
        let conflict = false;
        while (idx !== -1) {
          const before = text.slice(0, idx).match(/([a-z']+)[\s:_/–—-]*$/);
          if (!(before && /^(?:no|not|never|without|don'?t|avoid|exclude[ds]?)$/.test(before[1]))) { conflict = true; break; }
          idx = text.indexOf(phrase, idx + phrase.length);
        }
        if (conflict) {
          const key = `${m.id}|${goal}`;
          if (!seen.has(key)) { seen.add(key); out.push({ mustHaveId: m.id, nonGoal: goal, phrase }); }
          break;
        }
      }
    }
  }
  return out;
}

// §9 escalation budget: parse a $ ceiling + a per-task failure count out of the free-text section; defaults
// (DEFAULT_ESCALATION) when the human left it loose. Always returns a schema-valid {maxSessionCostUsd, maxFailuresPerTask}.
function parseEscalationBudget(text) {
  const out = { maxSessionCostUsd: DEFAULT_ESCALATION.maxSessionCostUsd, maxFailuresPerTask: DEFAULT_ESCALATION.maxFailuresPerTask };
  if (nonEmptyStr(text)) {
    const dollar = text.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/) || text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:usd|dollars?)/i);
    if (dollar) { const n = Number(dollar[1]); if (Number.isFinite(n) && n >= 0) out.maxSessionCostUsd = n; }
    const fails = text.match(/([0-9]+)\s*(?:failures?|attempts?|retries|tries)/i);
    if (fails) { const n = parseInt(fails[1], 10); if (Number.isInteger(n) && n >= 1) out.maxFailuresPerTask = n; }
  }
  return out;
}

// Map the skeleton's stack (arbitrary DEFAULT_STACK layer names) onto the schema's enum keys; drop layers
// with no enum slot (first-wins on collisions). Always returns an object whose keys are a subset of STACK_ENUM.
function mapStack(skeletonStack) {
  const out = {};
  if (!isObj(skeletonStack)) return out;
  for (const [k, v] of Object.entries(skeletonStack)) {
    if (!isObj(v)) continue;
    const enumKey = STACK_KEY_MAP[String(k).trim().toLowerCase()];
    if (!enumKey || out[enumKey]) continue;
    if (!nonEmptyStr(v.choice)) continue;
    out[enumKey] = { choice: v.choice, why: nonEmptyStr(v.why) ? v.why : 'pinned by docs/DEFAULT_STACK.md.' };
  }
  return out;
}

// The four gates -> blocking openQuestions[], each carrying its controlled gate token (GATE_TOKENS) in context.
function runGatesV4(g) {
  const oq = [];
  for (const b of (isArr(g.blocks) ? g.blocks : [])) {
    if (isObj(b) && nonEmptyStr(b.token)) oq.push(mkBlocking(b.token, nonEmptyStr(b.note) ? b.note : b.token));
  }
  for (const u of (isArr(g.undecided) ? g.undecided : [])) oq.push({ question: u.question, blockingCompose: true, context: u.context });
  for (const c of (isArr(g.contradictions) ? g.contradictions : [])) oq.push(mkBlocking('required-excluded-contradiction', `concern "${c.concernId}" is REQUIRED by the vision but was excluded ("${c.reason}") — correct the vision or confirm the exclusion.`));
  for (const id of (isArr(g.uncovered) ? g.uncovered : [])) oq.push(mkBlocking('forward-coverage', `must-have ${id} maps to no feature in featureOrder[] — add a feature that delivers it or mark it deferred.`));
  for (const name of (isArr(g.orphans) ? g.orphans : [])) oq.push(mkBlocking('reverse-trace', `feature "${name}" traces to no must-have or declared infra need (possible scope creep) — bind it to a must-have or drop it.`));
  for (const c of (isArr(g.nongoalConflicts) ? g.nongoalConflicts : [])) oq.push(mkBlocking('musthave-nongoal-contradiction', `must-have ${c.mustHaveId} appears to require "${c.phrase}", which §5 lists as a non-goal ("${c.nonGoal}") — the vision is internally inconsistent.`));
  return oq;
}

// Build the schemaVersion-2 lock OBJECT from the frozen skeleton + reconciled concerns + coverage + the
// gate openQuestions. This is the mechanical skeleton->lock mapping: drop app.slug, mustHaves[].deferred,
// successMetric.statement, and featureOrder[].mustHaveId (none are lock keys); decompose successMetric into
// {id,text} steps; map stack to enum keys. incomplete falls out of the blocking openQuestions (schema def).
// Phased builds (epic 0ms): when the skeleton splits work across phases, derive phases[] and tag every
// mustHaves[]/featureOrder[] entry with its phase; a single-phase plan emits neither (backward-compatible).
function assembleLock(a) {
  const f = a.frozen;
  const sm = isObj(f.successMetric) ? f.successMetric : {};
  const steps = (isArr(sm.steps) ? sm.steps.filter(nonEmptyStr) : []);
  const successSteps = steps.length
    ? steps.map((text, i) => ({ id: `S${i + 1}`, text }))
    : [{ id: 'S1', text: nonEmptyStr(sm.statement) ? sm.statement : 'Success metric.' }];
  const mhList = (isArr(f.mustHaves) ? f.mustHaves : []).filter((m) => isObj(m) && nonEmptyStr(m.id) && nonEmptyStr(m.text));
  const rawFeatures = (isArr(f.featureOrder) ? f.featureOrder : [])
    .filter((x) => isObj(x) && nonEmptyStr(x.name) && isArr(x.formulas) && x.formulas.filter(nonEmptyStr).length >= 1);
  const phases = derivePhases(mhList, rawFeatures, sm, f.phases);
  const multiPhase = isArr(phases) && phases.length > 1;
  const featureOrder = rawFeatures.map((x) => {
    const formulas = x.formulas.filter(nonEmptyStr);
    // tier: authoritative build-order tier from the formula picks (Layer 1, onv). requires: reserved
    // for finer cross-feature ordering vision can determine — empty for now (shape must be valid).
    const out = { name: x.name, formulas, tier: deriveFeatureTier(formulas), requires: [] };
    if (isObj(x.vars) && Object.keys(x.vars).length) out.vars = x.vars;
    if (nonEmptyStr(x.notes)) out.notes = x.notes;
    if (multiPhase) out.phase = featurePhase(x, mhList);
    return out;
  });
  const dataModel = (isArr(f.dataModel) ? f.dataModel : [])
    .filter((e) => isObj(e) && nonEmptyStr(e.entity))
    .map((e) => {
      const out = { entity: e.entity, fields: isArr(e.fields) ? e.fields.filter(nonEmptyStr) : [] };
      if (isArr(e.relationships) && e.relationships.length) out.relationships = e.relationships.filter(isStr);
      if (nonEmptyStr(e.notes)) out.notes = e.notes;
      return out;
    });
  const app = { name: (isObj(f.app) && nonEmptyStr(f.app.name)) ? f.app.name : 'app' };
  if (isObj(f.app) && nonEmptyStr(f.app.summary)) app.description = f.app.summary;
  const openQuestions = isArr(a.openQuestions) ? a.openQuestions : [];
  // Pass through ONLY skill-shell consults that already match the lock schema's four required fields —
  // never synthesize the missing question/reversalCost (that would invent product decisions, T1). The headless
  // path emits none; the skill shell (ih5.5) supplies lock-ready entries.
  const agentConsults = (isArr(f.agentConsults) ? f.agentConsults : [])
    .filter((c) => isObj(c) && nonEmptyStr(c.question) && nonEmptyStr(c.decision) && nonEmptyStr(c.rationale) && nonEmptyStr(c.reversalCost))
    .map((c) => ({ question: c.question, decision: c.decision, rationale: c.rationale, reversalCost: c.reversalCost }));
  const lock = {
    schemaVersion: 2,
    app,
    mustHaves: mhList.map((m) => { const o = { id: m.id, text: m.text }; if (multiPhase) o.phase = phaseOf(m); return o; }),
    successMetric: { steps: successSteps },
    stack: mapStack(f.stack),
    dataModel,
    featureOrder,
    coverage: isArr(a.coverage) ? a.coverage : [],
    concerns: isArr(a.lockConcerns) ? a.lockConcerns : [],
    crossFeatureDependencies: [],
    escalationBudget: parseEscalationBudget(a.sections && a.sections.escalationBudget),
    openQuestions,
    incomplete: openQuestions.some((q) => q && q.blockingCompose === true)
  };
  if (multiPhase) lock.phases = phases;
  if (agentConsults.length) lock.agentConsults = agentConsults;
  return lock;
}

// /replan (epic 0ms): merge a freshly re-derived lock with the existing one, scoped at phase N.
// Phases < N are BUILT — frozen verbatim from `existing` (status forced to 'built'); phases >= N are taken
// from the re-derived lock (re-cut: add/drop/reorder/merge of downstream provisional phases). Global fields
// (stack, concerns, escalationBudget, ...) come from the re-derivation. The freeze is enforced HERE in pure
// JS, so it holds regardless of what the skeleton agent re-proposed for the already-built phases.
// A must-have that existed at phase >= N in the OLD lock but is ABSENT from the re-derivation is a DROP — a
// loud blocking openQuestion (a product decision, never a silent edit), not a deferral. Returns { lock, dropped }.
function mergeReplan(existing, rederived, replanFrom) {
  const N = (Number.isInteger(replanFrom) && replanFrom >= 1) ? replanFrom : 1;
  const ex = isObj(existing) ? existing : {};
  const rd = isObj(rederived) ? rederived : {};
  const phOf = (e) => (isObj(e) && Number.isInteger(e.phase)) ? e.phase : 1;

  const frozenMH = (isArr(ex.mustHaves) ? ex.mustHaves : []).filter((m) => phOf(m) < N);
  const newMH    = (isArr(rd.mustHaves) ? rd.mustHaves : []).filter((m) => phOf(m) >= N);
  const frozenFO = (isArr(ex.featureOrder) ? ex.featureOrder : []).filter((f) => phOf(f) < N);
  const newFO    = (isArr(rd.featureOrder) ? rd.featureOrder : []).filter((f) => phOf(f) >= N);
  const frozenPhases = (isArr(ex.phases) ? ex.phases : []).filter((p) => isObj(p) && p.id < N).map((p) => ({ ...p, status: 'built', provisional: false }));
  const newPhases    = (isArr(rd.phases) ? rd.phases : []).filter((p) => isObj(p) && p.id >= N);

  const newIds = new Set(newMH.map((m) => m.id));
  const dropped = (isArr(ex.mustHaves) ? ex.mustHaves : [])
    .filter((m) => isObj(m) && phOf(m) >= N && nonEmptyStr(m.id) && !newIds.has(m.id))
    .map((m) => ({ id: m.id, text: m.text, fromPhase: phOf(m) }));

  const frozenMHIds = new Set(frozenMH.map((m) => m.id));
  const frozenCov = (isArr(ex.coverage) ? ex.coverage : []).filter((c) => isObj(c) && frozenMHIds.has(c.mustHaveId));
  const newCov    = (isArr(rd.coverage) ? rd.coverage : []).filter((c) => isObj(c) && newIds.has(c.mustHaveId));

  const mergedPhases = [...frozenPhases, ...newPhases];
  const lock = { ...rd, mustHaves: [...frozenMH, ...newMH], featureOrder: [...frozenFO, ...newFO], coverage: [...frozenCov, ...newCov] };
  if (mergedPhases.length > 1) lock.phases = mergedPhases; else delete lock.phases;

  const droppedGates = dropped.map((d) => ({
    question: `Replan dropped must-have ${d.id} ("${d.text}"), previously assigned to phase ${d.fromPhase} — confirm the removal in vision.md or restore it. Dropping a must-have is a product decision, not a silent edit.`,
    blockingCompose: true,
    context: `replan-dropped-musthave: ${d.id} was phase ${d.fromPhase}`
  }));
  lock.openQuestions = [...(isArr(rd.openQuestions) ? rd.openQuestions : []), ...droppedGates];
  lock.incomplete = lock.openQuestions.some((q) => q && q.blockingCompose === true);
  return { lock, dropped };
}

// Strict schema validation (a superset of vision-eval.js validatePlanLock: same checks + additionalProperties
// + stack-key-enum). Returns { ok, errors[] }. A non-empty errors[] on an assembled lock is a workflow bug.
function validateLock(pl, concernIds = CONCERN_IDS) {
  const errors = [];
  if (pl === null) return { ok: false, errors: ['unparseable: not valid JSON'] };
  if (!isObj(pl)) return { ok: false, errors: ['not an object'] };
  if (pl.schemaVersion !== 2) errors.push(`schemaVersion must be 2 (got ${JSON.stringify(pl.schemaVersion)})`);
  const requiredKeys = ['schemaVersion', 'app', 'mustHaves', 'successMetric', 'stack', 'dataModel', 'featureOrder', 'coverage', 'concerns', 'crossFeatureDependencies', 'escalationBudget', 'openQuestions', 'incomplete'];
  for (const k of requiredKeys) if (!(k in pl)) errors.push(`missing required key: ${k}`);
  for (const k of extraKeys(pl, LOCK_TOP_KEYS)) errors.push(`unknown top-level key: ${k}`);

  if (!isObj(pl.app) || !nonEmptyStr(pl.app && pl.app.name)) errors.push('app.name missing/empty');
  else for (const k of extraKeys(pl.app, ['name', 'description'])) errors.push(`app.${k} not allowed`);

  if (!isArr(pl.mustHaves)) errors.push('mustHaves must be an array');
  else pl.mustHaves.forEach((m, i) => {
    if (!isObj(m) || !nonEmptyStr(m.id) || !nonEmptyStr(m.text)) errors.push(`mustHaves[${i}] needs {id,text}`);
    else {
      if ('phase' in m && !(Number.isInteger(m.phase) && m.phase >= 1)) errors.push(`mustHaves[${i}].phase must be an integer >= 1`);
      for (const k of extraKeys(m, ['id', 'text', 'phase'])) errors.push(`mustHaves[${i}].${k} not allowed`);
    }
  });

  if (!isObj(pl.successMetric) || !isArr(pl.successMetric.steps)) errors.push('successMetric.steps must be an array');
  else {
    for (const k of extraKeys(pl.successMetric, ['steps'])) errors.push(`successMetric.${k} not allowed`);
    pl.successMetric.steps.forEach((s, i) => { if (!isObj(s) || !nonEmptyStr(s.id) || !isStr(s.text)) errors.push(`successMetric.steps[${i}] needs {id,text}`); });
  }

  if (!isObj(pl.stack)) errors.push('stack must be an object');
  else for (const [k, v] of Object.entries(pl.stack)) {
    if (!STACK_ENUM.includes(k)) errors.push(`stack key "${k}" not in allowed enum`);
    if (!isObj(v) || !nonEmptyStr(v.choice) || !nonEmptyStr(v.why)) errors.push(`stack.${k} needs {choice,why}`);
    else for (const kk of extraKeys(v, ['choice', 'why'])) errors.push(`stack.${k}.${kk} not allowed`);
  }

  if (!isArr(pl.dataModel)) errors.push('dataModel must be an array');
  else pl.dataModel.forEach((e, i) => {
    if (!isObj(e) || !nonEmptyStr(e.entity) || !isArr(e.fields)) errors.push(`dataModel[${i}] needs {entity,fields}`);
    else for (const k of extraKeys(e, ['entity', 'fields', 'relationships', 'notes'])) errors.push(`dataModel[${i}].${k} not allowed`);
  });

  if (!isArr(pl.featureOrder)) errors.push('featureOrder must be an array');
  else pl.featureOrder.forEach((f, i) => {
    if (!isObj(f) || !nonEmptyStr(f.name) || !isArr(f.formulas) || f.formulas.length < 1) errors.push(`featureOrder[${i}] needs {name,formulas>=1}`);
    else {
      if ('phase' in f && !(Number.isInteger(f.phase) && f.phase >= 1)) errors.push(`featureOrder[${i}].phase must be an integer >= 1`);
      // tier (required, Layer 1/onv): authoritative build-order tier. requires (optional): array of strings.
      if (!FEATURE_TIERS.includes(f.tier)) errors.push(`featureOrder[${i}].tier must be one of ${FEATURE_TIERS.join('|')}`);
      if ('requires' in f && (!isArr(f.requires) || !f.requires.every(nonEmptyStr))) errors.push(`featureOrder[${i}].requires must be an array of strings`);
      for (const k of extraKeys(f, ['name', 'formulas', 'vars', 'notes', 'phase', 'tier', 'requires'])) errors.push(`featureOrder[${i}].${k} not allowed`);
    }
  });

  // phases[] (optional; epic 0ms): well-formed when present. A single-phase plan omits it entirely.
  if ('phases' in pl) {
    if (!isArr(pl.phases)) errors.push('phases must be an array');
    else pl.phases.forEach((p, i) => {
      if (!isObj(p)) { errors.push(`phases[${i}] not an object`); return; }
      if (!(Number.isInteger(p.id) && p.id >= 1)) errors.push(`phases[${i}].id must be an integer >= 1`);
      if (!nonEmptyStr(p.name)) errors.push(`phases[${i}].name missing`);
      if (!nonEmptyStr(p.goal)) errors.push(`phases[${i}].goal missing`);
      if (!['planned', 'active', 'built'].includes(p.status)) errors.push(`phases[${i}].status must be planned|active|built`);
      if (typeof p.provisional !== 'boolean') errors.push(`phases[${i}].provisional must be a boolean`);
      for (const k of extraKeys(p, ['id', 'name', 'goal', 'status', 'provisional'])) errors.push(`phases[${i}].${k} not allowed`);
    });
  }

  if (!isArr(pl.coverage)) errors.push('coverage must be an array');
  else pl.coverage.forEach((c, i) => {
    if (!isObj(c)) { errors.push(`coverage[${i}] not an object`); return; }
    if (!nonEmptyStr(c.mustHaveId)) errors.push(`coverage[${i}].mustHaveId missing`);
    if (!isArr(c.features) || c.features.length < 1) errors.push(`coverage[${i}].features needs >=1 entry`);
    if (!nonEmptyStr(c.how)) errors.push(`coverage[${i}].how missing (anti-vagueness)`);
    for (const k of extraKeys(c, ['mustHaveId', 'features', 'how'])) errors.push(`coverage[${i}].${k} not allowed`);
  });

  if (!isArr(pl.concerns)) errors.push('concerns must be an array');
  else pl.concerns.forEach((c, i) => {
    if (!isObj(c)) { errors.push(`concerns[${i}] not an object`); return; }
    if (!nonEmptyStr(c.concernId)) errors.push(`concerns[${i}].concernId missing`);
    if (c.status !== 'addressed' && c.status !== 'excluded') errors.push(`concerns[${i}].status must be addressed|excluded`);
    if (c.status === 'addressed' && !nonEmptyStr(c.evidence)) errors.push(`concerns[${i}] addressed but no evidence`);
    if (c.status === 'excluded' && !nonEmptyStr(c.reason)) errors.push(`concerns[${i}] excluded but no reason`);
    for (const k of extraKeys(c, ['concernId', 'status', 'evidence', 'reason'])) errors.push(`concerns[${i}].${k} not allowed`);
  });

  if (!isArr(pl.crossFeatureDependencies)) errors.push('crossFeatureDependencies must be an array');
  if (!isObj(pl.escalationBudget) || typeof pl.escalationBudget.maxSessionCostUsd !== 'number' || !Number.isInteger(pl.escalationBudget.maxFailuresPerTask)) errors.push('escalationBudget needs {maxSessionCostUsd:number, maxFailuresPerTask:int}');
  else for (const k of extraKeys(pl.escalationBudget, ['maxSessionCostUsd', 'maxFailuresPerTask', 'additionalBlockTriggers'])) errors.push(`escalationBudget.${k} not allowed`);

  if (!isArr(pl.openQuestions)) errors.push('openQuestions must be an array');
  else pl.openQuestions.forEach((q, i) => {
    if (!isObj(q) || !nonEmptyStr(q.question)) errors.push(`openQuestions[${i}].question missing`);
    if (q && typeof q.blockingCompose !== 'boolean') errors.push(`openQuestions[${i}].blockingCompose must be boolean`);
    if (isObj(q)) for (const k of extraKeys(q, ['question', 'blockingCompose', 'context'])) errors.push(`openQuestions[${i}].${k} not allowed`);
  });

  if (typeof pl.incomplete !== 'boolean') errors.push('incomplete must be a boolean');
  const hasBlocking = isArr(pl.openQuestions) && pl.openQuestions.some((q) => q && q.blockingCompose === true);
  if (typeof pl.incomplete === 'boolean' && pl.incomplete !== hasBlocking) errors.push(`incomplete (${pl.incomplete}) must equal "any openQuestion.blockingCompose" (${hasBlocking})`);

  if (pl.incomplete === false) {
    if (isArr(pl.concerns)) {
      const decided = new Set(pl.concerns.map((c) => c && c.concernId));
      for (const id of concernIds) if (!decided.has(id)) errors.push(`complete plan leaves concern "${id}" undecided`);
    }
    if (isArr(pl.mustHaves) && isArr(pl.coverage)) {
      const covered = new Set(pl.coverage.filter((c) => isArr(c.features) && c.features.length >= 1).map((c) => c.mustHaveId));
      // A future-phase (phase >= 2) must-have is a deliberate deferral (covered-in-phase-N, epic 0ms),
      // exempt from the phase-1 forward-coverage requirement; a phase-1 must-have must still be covered.
      for (const m of pl.mustHaves) {
        if (!m) continue;
        const ph = Number.isInteger(m.phase) ? m.phase : 1;
        if (ph === 1 && !covered.has(m.id)) errors.push(`complete plan leaves must-have "${m.id}" uncovered`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// Render tenets.md: the inherited T1–T10 block + source ordering (verbatim) + app-specific tenets derived
// from §5 non-goals + the locked-stack tenet + the escalation budget. (templates/tenets.md, populated.)
function renderTenets(frozen, sections) {
  const name = (isObj(frozen.app) && nonEmptyStr(frozen.app.name)) ? frozen.app.name : 'this app';
  const nonGoals = isArr(frozen.nonGoals) ? frozen.nonGoals.filter(nonEmptyStr) : [];
  const eb = parseEscalationBudget(sections && sections.escalationBudget);
  let app = '';
  if (nonGoals.length) {
    app += '### From vision.md §5 (non-goals)\n\n> One tenet per non-goal. These prevent scope creep during build.\n\n';
    nonGoals.forEach((ng, i) => {
      app += `- **A${i + 1}. Do not build: ${ng}**\n  - **Rule**: Never implement "${ng}".\n  - **Why**: Explicitly excluded in vision.md §5.\n  - **How to apply**: If a bead's AC drifts toward "${ng}", flag with \`/flag\` rather than implementing.\n\n`;
    });
  } else {
    app += '_No non-goal tenets — vision.md §5 was empty._\n\n';
  }
  app += '### From plan.lock §stack (locked-in stack)\n\n- **A_stack. The stack is locked at /vision time**\n  - **Rule**: Do not swap layers (database, framework, ORM, auth) during a build. Stack changes require re-running `/vision`.\n  - **Why**: Mid-build stack changes invalidate every prior decision and most prior beads.\n  - **How to apply**: If a bead seems to require a different stack layer, the bead is wrong — flag it.';
  return [
    `# Tenets: ${name}`,
    '',
    '> Generated by `/vision` from `vision.md` + `plan.lock.json` + the workflow-level `docs/TENETS.md` in autonomous-build.',
    '> Read this when about to make a judgment call during a build — before guessing, before escalating.',
    '> This file is hand-editable. If you change it during a build, note why in the commit.',
    '',
    '---',
    '',
    TENETS_INHERITED_MD,
    '',
    '---',
    '',
    '## App-specific tenets',
    '',
    "> App tenets do **not** override inherited workflow tenets — they complement them. If an app tenet conflicts with a workflow tenet, the workflow tenet wins; flag the conflict with `/flag`.",
    '',
    app,
    '',
    '---',
    '',
    '## Escalation budget',
    '',
    `- **Max session cost**: $${eb.maxSessionCostUsd}`,
    `- **Max failures per task**: ${eb.maxFailuresPerTask}`,
    ''
  ].join('\n');
}

// Render plan.md: the human-readable narrative of the lock (lock wins where they disagree — T10).
function renderPlanMd(lock) {
  const L = [];
  const name = (isObj(lock.app) && nonEmptyStr(lock.app.name)) ? lock.app.name : 'App';
  L.push(`# ${name} — plan`, '');
  if (lock.incomplete) {
    const n = (lock.openQuestions || []).filter((q) => q && q.blockingCompose).length;
    L.push(`> ⚠️ **INCOMPLETE** — ${n} blocking open question(s). \`/decompose\` will refuse this plan until they are resolved in vision.md and \`/vision\` is re-run.`, '');
  }
  if (isObj(lock.app) && nonEmptyStr(lock.app.description)) L.push(lock.app.description, '');
  if (isArr(lock.phases) && lock.phases.length) {
    L.push('## Phases', '');
    L.push('> Proposed phase split (epic 0ms) — review at the vision gate. Phase 1 is fully decided and decompose-ready; later phases are provisional sketches that `/replan` firms up when reached.', '');
    lock.phases.forEach((p) => L.push(`${p.id}. **${p.name}** — _${p.status}${p.provisional ? ', provisional' : ''}_ — ${p.goal}`));
    L.push('');
  }
  L.push('## Must-haves', '');
  (lock.mustHaves || []).forEach((m) => L.push(`- **${m.id}**${Number.isInteger(m.phase) ? ` _(phase ${m.phase})_` : ''}: ${m.text}`));
  L.push('', '## Success metric', '');
  (lock.successMetric.steps || []).forEach((s) => L.push(`- **${s.id}**: ${s.text}`));
  L.push('', '## Stack', '');
  for (const [k, v] of Object.entries(lock.stack || {})) L.push(`- **${k}**: ${v.choice} — ${v.why}`);
  L.push('', '## Data model', '');
  (lock.dataModel || []).forEach((e) => L.push(`- **${e.entity}** — fields: ${(e.fields || []).join(', ') || '(none)'}${(e.relationships && e.relationships.length) ? `; relationships: ${e.relationships.join(', ')}` : ''}`));
  L.push('', '## Feature order', '');
  (lock.featureOrder || []).forEach((f, i) => L.push(`${i + 1}. **${f.name}**${Number.isInteger(f.phase) ? ` _(phase ${f.phase})_` : ''} — formulas: ${(f.formulas || []).join(', ')}`));
  L.push('', '## Coverage (must-have → feature)', '');
  (lock.coverage || []).forEach((c) => L.push(`- **${c.mustHaveId}** → ${(c.features || []).join(', ')}: ${c.how}`));
  L.push('', '## Concerns', '');
  (lock.concerns || []).forEach((c) => L.push(`- **${c.concernId}**: ${c.status} — ${c.status === 'addressed' ? c.evidence : c.reason}`));
  if ((lock.openQuestions || []).length) {
    L.push('', '## Open questions', '');
    lock.openQuestions.forEach((q) => L.push(`- ${q.blockingCompose ? '**[BLOCKING]** ' : ''}${q.question}${q.context ? ` _(${q.context})_` : ''}`));
  }
  L.push('', '## Escalation budget', '', `- Max session cost: $${lock.escalationBudget.maxSessionCostUsd}`, `- Max failures per task: ${lock.escalationBudget.maxFailuresPerTask}`, '');
  return L.join('\n');
}

// Pure-JS Phase 4 orchestration: reconcile -> coverage -> the four gates -> assemble + validate + render.
// No agents (the file write is the only agent, dispatched by main()). Returns everything main() needs.
function reconcileAndAssemble(input) {
  const frozen = isObj(input.frozen) ? input.frozen : {};
  const carried = isArr(input.blocks) ? input.blocks.slice() : [];
  const allFeatures = isArr(frozen.featureOrder) ? frozen.featureOrder : [];
  const featuresWithFormula = allFeatures.filter((f) => isObj(f) && nonEmptyStr(f.name) && isArr(f.formulas) && f.formulas.filter(nonEmptyStr).length >= 1);
  for (const f of allFeatures) {
    if (isObj(f) && nonEmptyStr(f.name) && !(isArr(f.formulas) && f.formulas.filter(nonEmptyStr).length >= 1)) {
      carried.push({ token: 'no-matching-formula', note: `feature "${f.name}" has no formula bound — pick a stack-native formula or drop the feature.` });
    }
  }
  const { lockConcerns, undecided, contradictions } = reconcileConcerns(input.concerns, input.applicability);
  const { coverage, uncovered } = buildCoverage(frozen.mustHaves, featuresWithFormula, input.concerns);
  const orphans = reverseTraceOrphans(featuresWithFormula, coverage);
  const nongoalConflicts = musthaveNongoalConflicts(frozen.mustHaves, frozen.nonGoals);
  const openQuestions = runGatesV4({ blocks: carried, undecided, contradictions, uncovered, orphans, nongoalConflicts });
  const lock = assembleLock({ frozen: { ...frozen, featureOrder: featuresWithFormula }, lockConcerns, coverage, openQuestions, sections: input.sections });
  const { ok, errors } = validateLock(lock);
  return { ok, validationErrors: errors, incomplete: lock.incomplete, lock, openQuestions, tenetsMd: renderTenets(frozen, input.sections), planMd: renderPlanMd(lock) };
}

// ===========================================================================
// Agent prompts (self-contained — the agents run in the app cwd, no repo docs).
// ===========================================================================
function intakePrompt(A) {
  return `
You are the INTAKE agent for the /vision workflow (Phase 1). You run in the APP repo's cwd. Read the human's product brief and return its sections as structured data. DO NOT invent, complete, or improve any content — report exactly what is there (T1). A section still showing the template's instructional prose, an example, or a placeholder ("...", "- [ ] ...", "What problem does this app solve?") is NOT filled.

STEPS:
1. Check whether ${JSON.stringify(A.visionPath)} exists (e.g. \`test -f ${A.visionPath} && echo yes\`). If it does NOT exist, return { "visionExists": false, "sections": {}, "filled": {} } and stop.
2. Read ${JSON.stringify(A.visionPath)}. Parse its sections by HEADING ("## N. <name>"), NOT by number, and map each heading to one of: problem, users, mustHaves, niceToHaves, nonGoals, constraints, techPreferences, successMetric, escalationBudget, anythingElse. (templates/vision.md ships 10 sections; "Success metric" is the success-metric section, "Non-goals" is non-goals — match on the title text.)
3. For mustHaves / niceToHaves / nonGoals return an ARRAY of the bullet texts (strip "- [ ]" / "-" / "*" markers; drop empty or "..." bullets). For the prose sections (problem, users, constraints, techPreferences, successMetric, escalationBudget, anythingElse) return the text as a string.
4. For EVERY section set "filled.<name>" to true ONLY if it carries real, app-specific content; false if it is empty, whitespace, "...", an unedited "- [ ] ..." bullet, or the template's instructional question / example prose.
5. ${A.skeletonPath ? `A frozen skeleton was provided at ${JSON.stringify(A.skeletonPath)} — read it and return it verbatim under "skeleton" (do NOT re-derive it).` : `No skeleton was provided (headless path) — set "skeleton": null.`}

Return ONLY the structured object (its schema is enforced).
`.trim();
}

function skeletonPrompt(intake, A, replan) {
  const validated = JSON.stringify({ mustHaves: intake.mustHaves, sections: intake.sections }, null, 2);
  const headlessNote = intake.skeleton
    ? `A skeleton was already built by the skill shell — NORMALIZE it into the shape below; do NOT re-derive (the human already had that conversation). The provided skeleton:\n${JSON.stringify(intake.skeleton, null, 2)}`
    : `No skeleton was provided — DERIVE it headlessly from the validated vision below. There is NO human to ask.`;
  const replanNote = (isObj(replan) && nonEmptyStr(replan.note))
    ? `\nREPLAN MODE (epic 0ms) — this is /replan --replan-from ${replan.from}. Phases < ${replan.from} are BUILT and FROZEN: the workflow keeps them verbatim no matter what you output, so do NOT re-litigate them. Re-derive phases >= ${replan.from}, RE-CUTTING the downstream provisional phases (add / drop / reorder / merge) in light of what actually shipped — keep already-built must-haves' ids stable. Prior plan + build outcomes / retro context:\n${replan.note}\n`
    : '';
  return `
You are the SKELETON agent for the /vision workflow (Phase 2). You run in the APP repo's cwd. Build the FROZEN skeleton the concern fan-out will reason against. NEVER invent product content (must-haves, users, features) to fill a gap — if a must-have has no matching formula, record a block, do not paper it (T1).

${headlessNote}
${replanNote}
VALIDATED VISION (must-have ids already assigned — keep them VERBATIM):
${validated}

THE PINNED STACK (docs/DEFAULT_STACK.md — inlined; resolve silently, never ask, never deviate without a recorded agentConsults entry):
${DEFAULT_STACK}

PRODUCE (return ONLY the structured object; its schema is enforced):
1. app: { name, slug, summary } — name/summary from §1 + §10; slug = kebab-case of the name.
2. mustHaves: echo the ids + texts above VERBATIM. PHASING (epic 0ms) — default to a SINGLE phase. Propose a multi-phase split ONLY when (a) the must-have set is too big to be one reviewable build, OR (b) a subset is not needed for the core end-to-end success-metric flow ("could ship without it"). When you split, tag each must-have with \`phase\` (integer, 1-based): phase 1 = the WALKING SKELETON — the minimal must-haves that make successMetric run end-to-end; later phases = the remaining must-haves grouped by dependency layer + subsystem cohesion, with any risky / off-stack feature isolated into its OWN phase. Cross-phase deps point backward only (phase N+1 may rely on N, never the reverse). NEVER drop a later-phase must-have — tag it, never omit it (this is the vanishing-must-have fix). (\`deferred:true\` is the legacy spelling of phase 2.)
3. successMetric: { statement: <the success-metric text>, steps: [<one observable action per step, in order>] }.
4. stack: one entry per layer from the pinned table above, each { choice, why } where "why" cites DEFAULT_STACK.
5. dataModel: [{ entity, fields:[...], relationships:[...] }] — the entities the §3 must-haves imply. Do NOT invent entities no must-have needs.
6. featureOrder: [{ name, formulas:[...], vars:{...}, mustHaveId, phase }] — build order, deps respected (auth before per-user data). Pick the STACK-NATIVE formula variant per the map above; a generic formula (app-skeleton / crud-feature / background-job / integration-http) is a FALLBACK only when no native variant covers the capability. Honor the off-enum tell. Run \`bd formula list\` / \`bd formula show <name>\` to bind only declared var names and enum-valid values. If a must-have has NO matching formula, add { token:'no-matching-formula', note } to blocks instead of forcing a near-miss. When you split phases (item 2), tag each feature's \`phase\` to match the must-have it delivers (a skeleton/infra feature with no must-have binding rides in phase 1); the workflow defaults an untagged feature to phase 1.
7. phases: ONLY when you proposed a multi-phase split — [{ id, name, goal }], one entry per phase number you used, in order (phase 1 = the walking skeleton). Give a short name + one-line goal; the workflow sets status/provisional mechanically (phase 1 active+decided, later phases planned+provisional). Omit this field entirely for a single-phase plan.
8. nonGoals: the non-goals (§5) array verbatim.
9. signals: report ONLY observable facts about the vision as booleans (the workflow derives concern applicability from these in PURE JS — be accurate, not generous):
   - impliesAccounts: a must-have implies user accounts / per-user data / login.
   - multipleHumanRoles: §2 lists more than one human role.
   - multiplePrincipals: more than one distinct principal (human or service) acts on data.
   - crossUserData: data is shared across or isolated between users/tenants ("only sees their own", multi-tenant).
   - privacyConstraint: a constraint states a PRIVACY / PII / compliance / data-residency rule (NOT a budget or deadline).
   - holdsPii: the data model holds personally-identifying / regulated data about real people (NOT one local user's own notes).
   - productionOperation: the success metric describes a multi-user / running-in-production flow (NOT a one-shot local CLI run).
   - externalIntegrations: the app depends on a third-party service/API (a real v1 dependency, not a nice-to-have you exclude).
   - scaleTarget: the success metric names a concrete scale / latency / throughput number.
   - publicSurface: the app exposes a public or unauthenticated network surface.
`.trim();
}

// One per APPLICABLE concern. Self-contained: the frozen skeleton, the vision sections, this concern's OWN
// bar, and the shared EVIDENCE_BAR are all inlined — the agent runs in the app cwd and cannot read any repo
// doc, and it must never see another concern's contract or another agent's output (the fan-out is the isolation).
function concernPrompt(C) {
  return `
You are the CONCERN agent for the /vision workflow (Phase 3). You decide EXACTLY ONE concern: "${C.concernId}" (applicability: ${C.applicability}). You run in the APP repo's cwd. You see ONLY this concern — you do not know how any other concern was decided and must not assume it. The FROZEN skeleton below is READ-ONLY: reason against it, never propose to change it (T10).

Decide this concern against the frozen skeleton + the vision sections. Return exactly one of:
  - status:"addressed" — the skeleton actually delivers this concern, WITH falsifiable evidence (see the bars).
  - status:"excluded"  — the concern legitimately does not apply here, WITH a one-line reason.
  - a blockingQuestion — the concern CANNOT be honestly decided from the skeleton + vision (genuinely underspecified). Do NOT guess (T1).

THIS CONCERN'S "addressed requires" CONTRACT (the ONLY concern bar that applies to you — derived from docs/PLAN_CONCERNS.md, inlined):
${C.concernBar}

THE EVIDENCE BAR (what makes "addressed" evidence falsifiable):
${EVIDENCE_BAR}

FROZEN SKELETON (read-only):
${JSON.stringify(C.frozenSkeleton, null, 2)}

VISION SECTIONS (the human's product brief — read-only context):
${JSON.stringify(C.visionSections, null, 2)}

RULES:
- "addressed" REQUIRES "evidence" meeting the bar above — cite a featureOrder[] entry by name, a formula, a numbered tenet (T#), the quality gate, or a DEFAULT_STACK pin. A BARE ASSERTION ("handled", "we use env vars", "permissions enforced") is NOT evidence and is REJECTED. If the only honest evidence would be a bare assertion, the concern is NOT addressed: mark it "excluded" with a reason, OR (if it SHOULD be addressed but no feature delivers it) return a blockingQuestion.
- "excluded" REQUIRES a one-line "reason" ("CLI tool, no network surface").
- If your "addressed" evidence cites a featureOrder[] feature that delivers a §3 must-have, ALSO emit "coverageLink": { "mustHaveId": "<the M-id>", "features": ["<feature name>"] } so reconcile can assemble coverage[].
- A blockingQuestion's "context" MUST START WITH the literal token "concern-decidedness:" so the downstream gate can route it.
- Echo "concernId":"${C.concernId}" and "applicability":"${C.applicability}" verbatim.

Return ONLY the structured object (its schema is enforced).
`.trim();
}

// The lone Phase-4 agent. The lock/plan.md/tenets.md are ALREADY built + validated by the workflow — the
// agent is a dumb file-writer (the sandbox has no filesystem). It must write the bytes verbatim, never
// re-derive or "improve" them (T10 — the lock is the contract; reformatting it would desync it from the verdict).
function assemblePrompt(A) {
  return `
You are the ASSEMBLE agent for the /vision workflow (Phase 4). The plan.lock.json, plan.md, and tenets.md content below has ALREADY been built and schema-validated by the workflow. Your ONLY job is to WRITE each to its path EXACTLY as given — do NOT edit, reformat, re-derive, pretty-print differently, or "improve" any byte (T10: the lock is the machine contract; any drift desyncs it from the computed verdict).

Write these three files (create parent directories if needed), each with the EXACT content shown:

FILE 1 — ${A.outPath}
\`\`\`json
${A.lockJson}
\`\`\`

FILE 2 — ${A.planMdPath}
\`\`\`markdown
${A.planMd}
\`\`\`

FILE 3 — ${A.tenetsPath}
\`\`\`markdown
${A.tenetsMd}
\`\`\`

Use the Write tool once per file. When all three are written, return { "status": "ok", "written": ["${A.outPath}", "${A.planMdPath}", "${A.tenetsPath}"] }. If any write fails, return { "status": "failed", "written": [<paths that succeeded>], "failedReason": "<the error>" } — surface the failure, never report success you did not achieve (T7).
`.trim();
}

// ===========================================================================
// Structured-output schemas (the runtime validates the agent's reply shape).
// ===========================================================================
const INTAKE_SCHEMA = {
  type: 'object',
  required: ['visionExists', 'sections', 'filled'],
  properties: {
    visionExists: { type: 'boolean' },
    sections: {
      type: 'object',
      required: ['problem', 'mustHaves', 'successMetric'],
      properties: {
        problem: { type: 'string' },
        users: { type: 'string' },
        mustHaves: { type: 'array', items: { type: 'string' } },
        niceToHaves: { type: 'array', items: { type: 'string' } },
        nonGoals: { type: 'array', items: { type: 'string' } },
        constraints: { type: 'string' },
        techPreferences: { type: 'string' },
        successMetric: { type: 'string' },
        escalationBudget: { type: 'string' },
        anythingElse: { type: 'string' }
      }
    },
    filled: {
      type: 'object',
      properties: Object.fromEntries(
        ['problem', 'users', 'mustHaves', 'niceToHaves', 'nonGoals', 'constraints', 'techPreferences', 'successMetric', 'escalationBudget', 'anythingElse']
          .map((k) => [k, { type: 'boolean' }])
      )
    },
    skeleton: {},
    note: { type: 'string' }
  }
};

const SKELETON_SCHEMA = {
  type: 'object',
  required: ['skeleton', 'signals'],
  properties: {
    skeleton: {
      type: 'object',
      required: ['app', 'mustHaves', 'successMetric', 'stack', 'dataModel', 'featureOrder', 'nonGoals'],
      properties: {
        app: { type: 'object', required: ['name', 'slug'], properties: { name: { type: 'string' }, slug: { type: 'string' }, summary: { type: 'string' } } },
        mustHaves: { type: 'array', items: { type: 'object', required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string' }, deferred: { type: 'boolean' }, phase: { type: 'integer' } } } },
        successMetric: { type: 'object', required: ['statement', 'steps'], properties: { statement: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } } },
        stack: { type: 'object' },
        dataModel: { type: 'array', items: { type: 'object', required: ['entity'], properties: { entity: { type: 'string' }, fields: { type: 'array' }, relationships: { type: 'array' } } } },
        featureOrder: { type: 'array', items: { type: 'object', required: ['name', 'formulas'], properties: { name: { type: 'string' }, formulas: { type: 'array', items: { type: 'string' } }, vars: { type: 'object' }, mustHaveId: { type: 'string' }, phase: { type: 'integer' } } } },
        nonGoals: { type: 'array', items: { type: 'string' } },
        agentConsults: { type: 'array' },
        phases: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, name: { type: 'string' }, goal: { type: 'string' } } } }
      }
    },
    signals: {
      type: 'object',
      required: SIGNAL_NAMES,
      properties: Object.fromEntries(SIGNAL_NAMES.map((k) => [k, { type: 'boolean' }]))
    },
    blocks: { type: 'array', items: { type: 'object', required: ['token', 'note'], properties: { token: { type: 'string' }, note: { type: 'string' } } } }
  }
};

// Phase 3 per-concern result. status is enforced; the addressed-needs-evidence / excluded-needs-reason
// contract the schema cannot express is enforced in normalizeConcernResult (a defensive JS backstop, T7).
const CONCERN_SCHEMA = {
  type: 'object',
  required: ['concernId', 'status', 'applicability'],
  properties: {
    concernId: { type: 'string' },
    status: { type: 'string', enum: ['addressed', 'excluded', 'failed'] },
    applicability: { type: 'string' },
    evidence: { type: 'string' },
    reason: { type: 'string' },
    coverageLink: { type: 'object', required: ['mustHaveId', 'features'], properties: { mustHaveId: { type: 'string' }, features: { type: 'array', items: { type: 'string' } } } },
    blockingQuestion: { type: 'object', required: ['question', 'context'], properties: { question: { type: 'string' }, context: { type: 'string' } } }
  }
};

// Phase 4 assemble agent reply — it only reports which files it wrote (the lock content is the workflow's, not the agent's).
const ASSEMBLE_SCHEMA = {
  type: 'object',
  required: ['status', 'written'],
  properties: {
    status: { type: 'string', enum: ['ok', 'failed'] },
    written: { type: 'array', items: { type: 'string' } },
    failedReason: { type: 'string' }
  }
};

// ===========================================================================
// --selftest: pure-JS unit checks (NO agents). Exercises Phase-1 intake validation,
// the applicability derivation table (incl. the oracle-grounded budget-vs-secrets rule),
// skeleton normalization + freeze, and the 3fr.1 off-enum detector. Importable + runnable
// via node tests/vision/selftest.mjs.
// ===========================================================================
function runSelftest() {
  const results = [];
  const check = (name, cond) => { results.push({ name, pass: !!cond }); };

  // ---- Phase 1: validateIntake ----
  const coherentRaw = {
    visionExists: true,
    sections: {
      problem: 'Agencies juggle client work across spreadsheets and chat; nothing shows who owns what.',
      users: 'Workspace admin; Member.',
      mustHaves: ['Admins invite members; members see only their workspaces', 'Members create, assign, move tasks'],
      niceToHaves: ['Slack notifications'],
      nonGoals: ['No time tracking or invoicing'],
      constraints: 'Budget < $30/mo infra.',
      techPreferences: '',
      successMetric: 'An admin invites a member who logs in, creates a board, adds a task, and sees it in My tasks.',
      escalationBudget: '$20',
      anythingElse: 'Multi-tenant from day one.'
    },
    filled: { problem: true, users: true, mustHaves: true, niceToHaves: true, nonGoals: true, constraints: true, techPreferences: false, successMetric: true, escalationBudget: true, anythingElse: true },
    skeleton: null
  };
  const okIntake = validateIntake(coherentRaw);
  check('Phase1 accepts a coherent vision', okIntake.status === 'ok');
  check('Phase1 assigns stable M-ids in document order', okIntake.status === 'ok' && okIntake.mustHaves[0].id === 'M1' && okIntake.mustHaves[1].id === 'M2');
  check('Phase1 coherent headless run when no skeleton provided', okIntake.status === 'ok' && okIntake.headless === true);

  const emptyRaw = JSON.parse(JSON.stringify(coherentRaw));
  emptyRaw.sections.problem = 'What problem does this app solve? Who has it today?';
  emptyRaw.sections.mustHaves = ['...', '...'];
  emptyRaw.sections.successMetric = 'How will you know the app is working? One concrete observable, not a vibe.';
  emptyRaw.filled = Object.assign({}, coherentRaw.filled, { problem: false, mustHaves: false, successMetric: false });
  const niRes = validateIntake(emptyRaw);
  check('Phase1 NEEDS-INPUT on empty product sections (fixture-10 style)', niRes.status === 'needs-input');
  check('Phase1 reports all 3 load-bearing sections missing', niRes.missing.length === 3 && ['problem', 'mustHaves', 'successMetric'].every((n) => niRes.missing.includes(n)));

  const lyingRaw = JSON.parse(JSON.stringify(coherentRaw));
  lyingRaw.sections.mustHaves = ['...'];
  lyingRaw.filled.mustHaves = true; // agent wrongly claims filled
  check('Phase1 JS backstop overrides a wrong agent filled-flag', validateIntake(lyingRaw).missing.includes('mustHaves'));

  check('Phase1 fails on a missing vision file', validateIntake({ visionExists: false, sections: {}, filled: {} }).status === 'failed');

  const ni = buildNeedsInput(['mustHaves']);
  check('NEEDS-INPUT is a blocking missing-product-sections openQuestion', ni.incomplete === true && ni.openQuestions.length === 1 && ni.openQuestions[0].blockingCompose === true && /^missing-product-sections/.test(ni.openQuestions[0].context));
  check('NEEDS-INPUT marks every concern underivable', Object.keys(ni.applicability).length === CONCERN_IDS.length && Object.values(ni.applicability).every((v) => v === 'underivable'));
  check('NEEDS-INPUT context matches the GATE_TOKENS regex', GATE_TOKENS['missing-product-sections'].test(ni.openQuestions[0].context));

  // ---- deriveApplicability ----
  const none = deriveApplicability({});
  check('applicability: always-required trio', none['data-model'] === 'required' && none['error-handling'] === 'required' && none['external-integrations'] === 'required');
  check('applicability: no-signal optional pair (data-lifecycle, observability)', none['data-lifecycle'] === 'optional' && none['observability'] === 'optional');
  check('applicability: no-signal excluded-by-default five', ['authn', 'authz', 'secrets', 'perf-envelope', 'abuse-surface'].every((id) => none[id] === 'excluded-by-default'));

  const f01 = deriveApplicability({ impliesAccounts: true, multipleHumanRoles: true, multiplePrincipals: true, crossUserData: true, holdsPii: true, productionOperation: true, publicSurface: true });
  check('applicability f01: authn/authz/secrets required', f01.authn === 'required' && f01.authz === 'required' && f01.secrets === 'required');
  check('applicability f01: data-lifecycle+observability+abuse required, perf excluded', f01['data-lifecycle'] === 'required' && f01.observability === 'required' && f01['abuse-surface'] === 'required' && f01['perf-envelope'] === 'excluded-by-default');

  const f04 = deriveApplicability({ publicSurface: true, productionOperation: true }); // budget line present, but budget is not a signal
  check('applicability f04: budget-only leaves authn + secrets excluded (oracle-grounded)', f04.authn === 'excluded-by-default' && f04.secrets === 'excluded-by-default');
  check('applicability f04: public surface => abuse required', f04['abuse-surface'] === 'required');

  const f06 = deriveApplicability({ impliesAccounts: true, scaleTarget: true, publicSurface: true, productionOperation: true });
  check('applicability f06: authn required but authz excluded (single trusted group, no cross-user data)', f06.authn === 'required' && f06.authz === 'excluded-by-default');
  check('applicability f06: scale target => perf-envelope required', f06['perf-envelope'] === 'required');

  const fp = deriveApplicability({ privacyConstraint: true });
  check('applicability: privacy constraint elevates secrets + data-lifecycle without authn', fp.secrets === 'required' && fp['data-lifecycle'] === 'required');

  const appList = applicableConcerns(none);
  check('applicableConcerns drops excluded-by-default, keeps optional + required', !appList.includes('authn') && appList.includes('data-model') && appList.includes('data-lifecycle') && appList.includes('observability'));

  // ---- normalizeSkeleton + freeze ----
  const goodSkel = {
    app: { name: 'Tasklane', slug: 'tasklane', summary: 'tasks' },
    mustHaves: [{ id: 'M1', text: 'invite members' }],
    successMetric: { statement: 'admin invites, member logs in, sees task', steps: ['S1 sign in'] },
    stack: { language: { choice: 'rust', why: 'DEFAULT_STACK core' } },
    dataModel: [{ entity: 'User', fields: ['id'] }],
    featureOrder: [{ name: 'Auth', formulas: ['oidc-client-rust'], vars: {}, mustHaveId: 'M1' }],
    nonGoals: ['no invoicing']
  };
  const norm = normalizeSkeleton(goodSkel);
  check('normalizeSkeleton accepts a well-formed skeleton', norm.errors.length === 0 && norm.skeleton.app.name === 'Tasklane');
  const frozen = deepFreeze(norm.skeleton);
  check('skeleton freezes (deeply immutable)', Object.isFrozen(frozen) && Object.isFrozen(frozen.featureOrder) && Object.isFrozen(frozen.featureOrder[0]));
  let mutated = false;
  try { frozen.featureOrder.push({ name: 'x' }); } catch { mutated = true; }
  check('frozen skeleton rejects mutation', mutated || frozen.featureOrder.length === 1);

  const badSkel = JSON.parse(JSON.stringify(goodSkel)); delete badSkel.featureOrder;
  check('normalizeSkeleton flags a malformed skeleton (missing featureOrder)', normalizeSkeleton(badSkel).errors.length > 0);

  // ---- detectOffEnumPicks (3fr.1) ----
  check('detectOffEnumPicks flags a generic formula bound off-enum (package_manager=cargo)', detectOffEnumPicks([{ name: 'Core', formulas: ['app-skeleton'], vars: { package_manager: 'cargo' } }]).length === 1);
  check('detectOffEnumPicks passes a stack-native pick', detectOffEnumPicks([{ name: 'Core', formulas: ['app-skeleton-rust-cargo'], vars: { package_manager: 'cargo' } }]).length === 0);

  // ---- Phase 3: CONCERN_BARS sync + concern fan-out plumbing ----
  check('CONCERN_BARS has one non-empty bar per CONCERN_ID (SYNC with PLAN_CONCERNS.md)',
    CONCERN_IDS.every((id) => nonEmptyStr(CONCERN_BARS[id])));
  check('CONCERN_BARS carries no concern outside the vocabulary',
    Object.keys(CONCERN_BARS).every((id) => CONCERN_IDS.includes(id)) && Object.keys(CONCERN_BARS).length === CONCERN_IDS.length);

  // concernInputs: one input per APPLICABLE concern, each with ONLY its own bar; excluded-by-default dropped.
  const ci = concernInputs(frozen, none, coherentRaw.sections);
  check('concernInputs yields one input per applicable concern (excludes excluded-by-default)',
    ci.length === applicableConcerns(none).length && !ci.some((i) => i.concernId === 'authn') && ci.some((i) => i.concernId === 'data-model'));
  check('each concern input carries ONLY its own bar + the frozen skeleton',
    ci.every((i) => i.concernBar === CONCERN_BARS[i.concernId] && i.frozenSkeleton === frozen));

  // concernPrompt: self-contained (inlines this concern's bar + the EVIDENCE_BAR + the skeleton); never tells
  // the agent to read a repo doc by relative path; instructs the concern-decidedness block token.
  const cPrompt = concernPrompt(ci.find((i) => i.concernId === 'data-model'));
  check('concernPrompt inlines this concern bar + EVIDENCE_BAR + skeleton (self-contained)',
    cPrompt.includes(CONCERN_BARS['data-model']) && cPrompt.includes('falsifiable') && cPrompt.includes('Tasklane'));
  check('concernPrompt never instructs reading PLAN_CONCERNS.md / vision.spec.md by relative path',
    !/Read .*PLAN_CONCERNS\.md/i.test(cPrompt) && !cPrompt.includes('vision.spec.md'));
  check('concernPrompt instructs the concern-decidedness block token',
    cPrompt.includes('concern-decidedness:'));

  // normalizeConcernResult: the contract the schema can't express.
  const addr = normalizeConcernResult({ concernId: 'data-model', status: 'addressed', evidence: 'User entity in Data model with fields', applicability: 'required', coverageLink: { mustHaveId: 'M1', features: ['Auth'] } }, 'data-model', 'required');
  check('normalize: addressed+evidence is decided and keeps coverageLink',
    addr.status === 'addressed' && isDecided(addr) && addr.coverageLink.mustHaveId === 'M1' && addr.coverageLink.features[0] === 'Auth');
  const bareAddr = normalizeConcernResult({ concernId: 'authn', status: 'addressed', applicability: 'required' }, 'authn', 'required');
  check('normalize: addressed WITHOUT evidence downgrades to undecided (no silent rubber-stamp, T7)',
    bareAddr.status === 'failed' && !isDecided(bareAddr) && /^concern-decidedness:/.test(bareAddr.blockingQuestion.context));
  const excl = normalizeConcernResult({ concernId: 'abuse-surface', status: 'excluded', reason: 'no public surface', applicability: 'required' }, 'abuse-surface', 'required');
  check('normalize: excluded+reason is decided', excl.status === 'excluded' && isDecided(excl) && excl.reason === 'no public surface');
  const exclNoReason = normalizeConcernResult({ concernId: 'secrets', status: 'excluded', applicability: 'required' }, 'secrets', 'required');
  check('normalize: excluded WITHOUT reason downgrades to undecided', exclNoReason.status === 'failed' && !isDecided(exclNoReason));
  const blocked = normalizeConcernResult({ concernId: 'authz', status: 'addressed', blockingQuestion: { question: 'who owns whose data?', context: 'underspecified' }, applicability: 'required' }, 'authz', 'required');
  check('normalize: a blockingQuestion is undecided and its context leads with the gate token',
    blocked.status === 'failed' && /^concern-decidedness:/.test(blocked.blockingQuestion.context) && GATE_TOKENS['concern-decidedness'].test(blocked.blockingQuestion.context));
  const garbled = normalizeConcernResult('not an object', 'observability', 'optional');
  check('normalize: a garbled / unrecognized reply is undecided, never dropped (T7)',
    garbled.status === 'failed' && garbled.concernId === 'observability' && !isDecided(garbled));

  // concernBlock: context always leads with the token (reuses agent detail when present).
  check('concernBlock leads with the concern-decidedness token and reuses agent context detail',
    concernBlock('x', 'q?', 'concern-decidedness: needs an IdP').context === 'concern-decidedness: needs an IdP' &&
    concernBlock('x', 'q?').context === 'concern-decidedness: q?');

  // Fan-out shape (the bead's "Verify"): one DECIDED record per applicable concern when every agent answers well.
  const fakeReplies = ci.map((i) => i.concernId === 'data-model'
    ? { concernId: i.concernId, status: 'addressed', evidence: 'User entity in Data model', applicability: i.applicability }
    : { concernId: i.concernId, status: 'excluded', reason: `not applicable to ${i.concernId}`, applicability: i.applicability });
  const fanned = ci.map((i, k) => normalizeConcernResult(fakeReplies[k], i.concernId, i.applicability));
  check('fan-out yields exactly one record per applicable concern, all decided',
    fanned.length === ci.length && fanned.every(isDecided) && new Set(fanned.map((r) => r.concernId)).size === ci.length);

  // ---- Phase 4: reconcile + gates + assemble + validate ----
  check('STANDARD_EXCLUSIONS covers the five excluded-by-default concerns',
    ['authn', 'authz', 'secrets', 'perf-envelope', 'abuse-surface'].every((id) => nonEmptyStr(standardExclusion(id))));

  // A fully-decided scenario: signals -> authn/authz/secrets/observability applicable; perf+abuse folded.
  const p4appl = deriveApplicability({ impliesAccounts: true, multipleHumanRoles: true, multiplePrincipals: true, crossUserData: true, productionOperation: true });
  const p4frozen = deepFreeze({
    app: { name: 'Tasklane', slug: 'tasklane', summary: 'Multi-tenant task boards.' },
    mustHaves: [{ id: 'M1', text: 'Admins invite members' }, { id: 'M2', text: 'Members create and assign tasks' }],
    successMetric: { statement: 'An admin invites a member who logs in and sees a task.', steps: ['admin invites member', 'member logs in', 'member sees task'] },
    stack: { 'Core/services': { choice: 'Rust', why: 'DEFAULT_STACK core' }, 'Database': { choice: 'PostgreSQL', why: 'DEFAULT_STACK truth layer' }, 'Product surface': { choice: 'TypeScript + React', why: 'DEFAULT_STACK product surface' }, 'AI/data service': { choice: 'n/a', why: 'no model serving' } },
    dataModel: [{ entity: 'User', fields: ['id', 'email'] }, { entity: 'Task', fields: ['id', 'title'], relationships: ['belongs_to User'] }],
    featureOrder: [
      { name: 'Platform', formulas: ['app-skeleton-rust-cargo'] },
      { name: 'Auth', formulas: ['oidc-client-rust'], vars: { provider: 'zitadel' }, mustHaveId: 'M1' },
      { name: 'Tasks', formulas: ['crud-feature-rust'], mustHaveId: 'M2' }
    ],
    nonGoals: ['No time tracking']
  });
  const decidedConcerns = [
    { concernId: 'data-model', status: 'addressed', evidence: 'User + Task entities in Data model', applicability: 'required' },
    { concernId: 'authn', status: 'addressed', evidence: "feature 'Auth' via oidc-client-rust", applicability: 'required', coverageLink: { mustHaveId: 'M1', features: ['Auth'] } },
    { concernId: 'authz', status: 'addressed', evidence: "feature 'Auth' enforces per-tenant access", applicability: 'required' },
    { concernId: 'secrets', status: 'addressed', evidence: 'OIDC client secret via env; .env gitignored', applicability: 'required' },
    { concernId: 'data-lifecycle', status: 'addressed', evidence: 'tasks soft-deleted; migrations additive in v1 (T5)', applicability: 'optional' },
    { concernId: 'error-handling', status: 'addressed', evidence: 'no swallowed exceptions (T7)', applicability: 'required' },
    { concernId: 'observability', status: 'addressed', evidence: "feature 'Platform' wires otel-bootstrap-rust", applicability: 'required' },
    { concernId: 'external-integrations', status: 'addressed', evidence: 'OIDC IdP (Zitadel) via oidc-client-rust; no other third-party deps', applicability: 'required' }
  ];
  const asmOk = reconcileAndAssemble({ frozen: p4frozen, applicability: p4appl, concerns: decidedConcerns, blocks: [], sections: { escalationBudget: 'Budget < $30/mo; 3 failures per task' } });
  check('Phase4 VERIFY: a fully-decided plan validates as a COMPLETE v2 lock',
    asmOk.ok && asmOk.incomplete === false && asmOk.lock.schemaVersion === 2 && asmOk.validationErrors.length === 0);
  check('Phase4 reconcile folds in excluded-by-default concerns -> all 10 decided',
    asmOk.lock.concerns.length === CONCERN_IDS.length && CONCERN_IDS.every((id) => asmOk.lock.concerns.some((c) => c.concernId === id)) && asmOk.lock.concerns.some((c) => c.concernId === 'perf-envelope' && c.status === 'excluded'));
  check('Phase4 assemble strips non-lock fields (app.slug, mustHaves.deferred, successMetric.statement, featureOrder.mustHaveId)',
    !('slug' in asmOk.lock.app) && asmOk.lock.mustHaves.every((m) => !('deferred' in m)) && !('statement' in asmOk.lock.successMetric) && asmOk.lock.featureOrder.every((f) => !('mustHaveId' in f)));
  check('Phase4 assemble maps stack to the schema enum keys and drops unmappable layers',
    Object.keys(asmOk.lock.stack).every((k) => STACK_ENUM.includes(k)) && asmOk.lock.stack.backend && asmOk.lock.stack.frontend && asmOk.lock.stack.database);
  check('Phase4 builds coverage for every must-have (forward-coverage clean)',
    asmOk.lock.coverage.length === 2 && asmOk.lock.coverage.every((c) => c.features.length >= 1 && nonEmptyStr(c.how)));
  check('Phase4 parses the §9 escalation budget ($30, 3 failures)',
    asmOk.lock.escalationBudget.maxSessionCostUsd === 30 && asmOk.lock.escalationBudget.maxFailuresPerTask === 3);
  check('Phase4 renders non-empty plan.md + tenets.md (tenets inherit T1..T10)',
    asmOk.planMd.includes('# Tasklane — plan') && asmOk.tenetsMd.includes('T1. Escalate over guess') && asmOk.tenetsMd.includes('T10.') && asmOk.tenetsMd.includes('Do not build: No time tracking'));

  // VERIFY: a required+excluded concern -> NEEDS-INPUT + incomplete:true (the acceptance's contradiction scan).
  const contraConcerns = decidedConcerns.map((c) => c.concernId === 'authn' ? { concernId: 'authn', status: 'excluded', reason: 'no login', applicability: 'required' } : c);
  const asmContra = reconcileAndAssemble({ frozen: p4frozen, applicability: p4appl, concerns: contraConcerns, blocks: [], sections: {} });
  check('Phase4 VERIFY: a required+excluded concern returns NEEDS-INPUT (incomplete:true) and a valid lock',
    asmContra.ok && asmContra.incomplete === true && asmContra.lock.incomplete === true);
  check('Phase4 contradiction scan emits the required-excluded-contradiction gate token',
    asmContra.openQuestions.some((q) => GATE_TOKENS['required-excluded-contradiction'].test(q.context) && q.blockingCompose === true));

  // decide-only concerns (external-integrations "none" etc) excluded != contradiction; a signal-elevated one is.
  const recDecideOnly = reconcileConcerns([{ concernId: 'external-integrations', status: 'excluded', reason: 'none', applicability: 'required' }], { ...p4appl, 'external-integrations': 'required' });
  check('Phase4 reconcile: a decide-only concern (external-integrations) excluded is NOT a contradiction',
    recDecideOnly.contradictions.length === 0);
  const recElevated = reconcileConcerns([{ concernId: 'authn', status: 'excluded', reason: 'no login', applicability: 'required' }], { ...p4appl, authn: 'required' });
  check('Phase4 reconcile: a signal-elevated concern (authn) excluded IS a contradiction',
    recElevated.contradictions.some((c) => c.concernId === 'authn'));

  // An undecided applicable concern -> decidedness block.
  const undecConcerns = decidedConcerns.map((c) => c.concernId === 'observability' ? { concernId: 'observability', status: 'failed', applicability: 'required', blockingQuestion: { question: 'are metrics required?', context: 'concern-decidedness: undecided' } } : c);
  const asmUndec = reconcileAndAssemble({ frozen: p4frozen, applicability: p4appl, concerns: undecConcerns, blocks: [], sections: {} });
  check('Phase4 decidedness gate: an undecided applicable concern blocks with concern-decidedness',
    asmUndec.incomplete === true && asmUndec.openQuestions.some((q) => GATE_TOKENS['concern-decidedness'].test(q.context)));

  // forward-coverage: drop the feature delivering M2 -> M2 uncovered -> blocking.
  const noM2 = deepFreeze({ ...JSON.parse(JSON.stringify(p4frozen)), featureOrder: p4frozen.featureOrder.filter((f) => f.mustHaveId !== 'M2') });
  const asmNoCov = reconcileAndAssemble({ frozen: noM2, applicability: p4appl, concerns: decidedConcerns, blocks: [], sections: {} });
  check('Phase4 forward-coverage gate: an uncovered must-have blocks with forward-coverage',
    asmNoCov.incomplete === true && asmNoCov.openQuestions.some((q) => GATE_TOKENS['forward-coverage'].test(q.context)));

  // musthave<->nongoal contradiction (and NO false-fire on the coherent fixture).
  check('Phase4 musthave-nongoal: a must-have requiring a §5 non-goal phrase conflicts',
    musthaveNongoalConflicts([{ id: 'M1', text: 'Provide time tracking for members' }], ['No time tracking']).length === 1);
  check('Phase4 musthave-nongoal: no false-fire when no must-have requires the non-goal',
    musthaveNongoalConflicts(p4frozen.mustHaves, p4frozen.nonGoals).length === 0);
  // g63: a must-have that NEGATES the forbidden phrase agrees with the non-goal -> no conflict...
  check('Phase4 musthave-nongoal: a negated must-have phrase does NOT false-fire (g63)',
    musthaveNongoalConflicts(
      [{ id: 'M1', text: 'Natural-language intake -> closed-grammar composition ... no free-form code generation' }],
      ['Free-form / arbitrary code generation — closed-grammar only']).length === 0);
  // ...but a genuine (non-negated) requirement of the same phrase still fires.
  check('Phase4 musthave-nongoal: a non-negated contradiction still fires (g63)',
    musthaveNongoalConflicts(
      [{ id: 'M1', text: 'Generate free-form code at runtime' }],
      ['Free-form / arbitrary code generation — closed-grammar only']).length === 1);

  // validateLock catches a schema breach the skeleton->lock mapping must prevent (a stray app.slug).
  const dirtyLock = JSON.parse(JSON.stringify(asmOk.lock)); dirtyLock.app.slug = 'tasklane';
  check('validateLock rejects a disallowed additionalProperty (app.slug)',
    validateLock(dirtyLock).ok === false && validateLock(dirtyLock).errors.some((e) => /app\.slug/.test(e)));
  const badStack = JSON.parse(JSON.stringify(asmOk.lock)); badStack.stack['core/services'] = { choice: 'Rust', why: 'x' };
  check('validateLock rejects a stack key outside the enum',
    validateLock(badStack).ok === false && validateLock(badStack).errors.some((e) => /not in allowed enum/.test(e)));

  // agentConsults pass-through: lock-shaped entries survive; malformed ones drop (never invented, T1).
  const consultFrozen = deepFreeze({ ...JSON.parse(JSON.stringify(p4frozen)), agentConsults: [
    { question: 'Queue or cron?', decision: 'Use a cron poller', rationale: 'simpler for v1', reversalCost: 'low — swap the trigger' },
    { decision: 'partial — no question', rationale: 'x', alternatives: ['y'] }
  ] });
  const asmConsult = reconcileAndAssemble({ frozen: consultFrozen, applicability: p4appl, concerns: decidedConcerns, blocks: [], sections: {} });
  check('Phase4 agentConsults: lock-shaped consult passes through, malformed one dropped, lock still valid',
    asmConsult.ok && isArr(asmConsult.lock.agentConsults) && asmConsult.lock.agentConsults.length === 1 && asmConsult.lock.agentConsults[0].reversalCost === 'low — swap the trigger');

  // ---- Phased builds (epic autonomous-build-0ms): phase split + retained deferred must-haves ----
  // Single-phase baseline: the p4 fixture has no deferred must-have -> NO phases[], no phase tags (backward-compatible).
  check('Phased: a single-phase plan emits NO phases[] and no phase tags (backward-compatible)',
    !('phases' in asmOk.lock) && asmOk.lock.mustHaves.every((m) => !('phase' in m)) && asmOk.lock.featureOrder.every((f) => !('phase' in f)));

  // Multi-phase: the skeleton agent defers M2 (its judgment via deferred:true); pure JS derives phases[] + phase tags.
  const phasedFrozen = deepFreeze({
    ...JSON.parse(JSON.stringify(p4frozen)),
    mustHaves: [{ id: 'M1', text: 'Admins invite members' }, { id: 'M2', text: 'Members create and assign tasks', deferred: true }],
    featureOrder: [
      { name: 'Platform', formulas: ['app-skeleton-rust-cargo'] },
      { name: 'Auth', formulas: ['oidc-client-rust'], vars: { provider: 'zitadel' }, mustHaveId: 'M1' },
      { name: 'Tasks', formulas: ['crud-feature-rust'], mustHaveId: 'M2' }
    ]
  });
  const asmPhased = reconcileAndAssemble({ frozen: phasedFrozen, applicability: p4appl, concerns: decidedConcerns, blocks: [], sections: {} });
  check('Phased VERIFY: a multi-phase plan yields phases[] (phase 1 active+decided, phase 2 planned+provisional)',
    isArr(asmPhased.lock.phases) && asmPhased.lock.phases.length === 2
    && asmPhased.lock.phases[0].id === 1 && asmPhased.lock.phases[0].status === 'active' && asmPhased.lock.phases[0].provisional === false && nonEmptyStr(asmPhased.lock.phases[0].goal)
    && asmPhased.lock.phases[1].id === 2 && asmPhased.lock.phases[1].status === 'planned' && asmPhased.lock.phases[1].provisional === true);
  check('Phased VERIFY: the deferred must-have survives into the lock with a phase tag (no vanishing)',
    asmPhased.lock.mustHaves.some((m) => m.id === 'M2' && m.phase === 2) && asmPhased.lock.mustHaves.some((m) => m.id === 'M1' && m.phase === 1));
  check('Phased: features inherit the phase of the must-have they deliver (Tasks->2, Auth->1, infra Platform->1)',
    asmPhased.lock.featureOrder.find((f) => f.name === 'Tasks').phase === 2 && asmPhased.lock.featureOrder.find((f) => f.name === 'Auth').phase === 1 && asmPhased.lock.featureOrder.find((f) => f.name === 'Platform').phase === 1);
  check('Phased: the assembled multi-phase lock is schema-valid + complete (deferred M2 covered-in-phase, not a gap)',
    asmPhased.ok && asmPhased.validationErrors.length === 0 && asmPhased.incomplete === false);
  check('Phased: plan.md renders the phase split at the human gate',
    asmPhased.planMd.includes('## Phases') && /Walking skeleton/.test(asmPhased.planMd) && /phase 2/.test(asmPhased.planMd));

  // The forward-coverage gate is NOT weakened: a PHASE-1 must-have with no feature still blocks.
  const phasedGap = deepFreeze({ ...JSON.parse(JSON.stringify(phasedFrozen)), featureOrder: phasedFrozen.featureOrder.filter((f) => f.mustHaveId !== 'M1') });
  const asmGap = reconcileAndAssemble({ frozen: phasedGap, applicability: p4appl, concerns: decidedConcerns.filter((c) => c.concernId !== 'authn'), blocks: [], sections: {} });
  check('Phased: a PHASE-1 must-have with no feature still blocks forward-coverage (gate not weakened)',
    asmGap.incomplete === true && asmGap.openQuestions.some((q) => GATE_TOKENS['forward-coverage'].test(q.context)));

  // A deferred (phase-2) must-have with NO feature yet is a legitimate deferral (covered-in-phase-N), NOT a block.
  const phasedDeferNoFeat = deepFreeze({
    ...JSON.parse(JSON.stringify(p4frozen)),
    mustHaves: [{ id: 'M1', text: 'Admins invite members' }, { id: 'M2', text: 'Members create and assign tasks', deferred: true }],
    featureOrder: [
      { name: 'Platform', formulas: ['app-skeleton-rust-cargo'] },
      { name: 'Auth', formulas: ['oidc-client-rust'], vars: { provider: 'zitadel' }, mustHaveId: 'M1' }
    ]
  });
  const asmDeferNoFeat = reconcileAndAssemble({ frozen: phasedDeferNoFeat, applicability: p4appl, concerns: decidedConcerns, blocks: [], sections: {} });
  check('Phased: a deferred phase-2 must-have with no feature yet is a legitimate deferral, not a forward-coverage block',
    asmDeferNoFeat.ok && asmDeferNoFeat.incomplete === false
    && asmDeferNoFeat.lock.mustHaves.some((m) => m.id === 'M2' && m.phase === 2)
    && !asmDeferNoFeat.openQuestions.some((q) => GATE_TOKENS['forward-coverage'].test(q.context)));

  // validateLock guards the new fields directly.
  const badPhaseTag = JSON.parse(JSON.stringify(asmPhased.lock)); badPhaseTag.mustHaves[0].phase = 0;
  check('validateLock rejects a must-have phase < 1', validateLock(badPhaseTag).ok === false);
  const badPhaseStatus = JSON.parse(JSON.stringify(asmPhased.lock)); badPhaseStatus.phases[1].status = 'bogus';
  check('validateLock rejects a phases[].status outside planned|active|built',
    validateLock(badPhaseStatus).ok === false && validateLock(badPhaseStatus).errors.some((e) => /status must be/.test(e)));
  const badPhaseKey = JSON.parse(JSON.stringify(asmPhased.lock)); badPhaseKey.phases[0].owner = 'x';
  check('validateLock rejects an unknown phases[] key (additionalProperties)', validateLock(badPhaseKey).ok === false);

  // derivePhases / phaseOf unit edges: explicit phase int wins over deferred; all-phase-1 => single-phase (null).
  check('phaseOf: explicit phase int wins; deferred=>2; default=>1',
    phaseOf({ phase: 3 }) === 3 && phaseOf({ deferred: true }) === 2 && phaseOf({}) === 1);
  check('derivePhases: an all-phase-1 must-have set is single-phase (returns null)',
    derivePhases([{ id: 'M1', text: 'a' }, { id: 'M2', text: 'b' }], [], {}) === null);

  // ---- /replan (epic 0ms / autonomous-build-0ms.4): freeze phases < N, re-derive phases >= N ----
  const existingForReplan = JSON.parse(JSON.stringify(asmPhased.lock)); // a valid 2-phase lock (M1 phase 1, M2 phase 2)
  const rederived = JSON.parse(JSON.stringify(asmPhased.lock));
  rederived.mustHaves = [
    { id: 'M1', text: 'REWRITTEN phase-1 must-have (must be discarded by the freeze)', phase: 1 },
    { id: 'M2', text: 'Members create and assign tasks (revised)', phase: 2 },
    { id: 'M3', text: 'New phase-3 capability', phase: 3 }
  ];
  rederived.featureOrder = [
    { name: 'Platform', formulas: ['app-skeleton-rust-cargo'], phase: 1 },
    { name: 'Auth', formulas: ['oidc-client-rust'], phase: 1 },
    { name: 'Tasks2', formulas: ['crud-feature-rust'], phase: 2 },
    { name: 'NewThing', formulas: ['crud-feature-rust'], phase: 3 }
  ];
  rederived.phases = [
    { id: 1, name: 'Walking skeleton', goal: 'g1', status: 'active', provisional: false },
    { id: 2, name: 'Streaks revised', goal: 'g2', status: 'planned', provisional: true },
    { id: 3, name: 'New phase', goal: 'g3', status: 'planned', provisional: true }
  ];
  rederived.coverage = [
    { mustHaveId: 'M1', features: ['Auth'], how: 'rewritten cover' },
    { mustHaveId: 'M2', features: ['Tasks2'], how: 'revised cover' },
    { mustHaveId: 'M3', features: ['NewThing'], how: 'new cover' }
  ];
  rederived.openQuestions = []; rederived.incomplete = false;
  const { lock: replanned, dropped: drop0 } = mergeReplan(existingForReplan, rederived, 2);
  check('Replan VERIFY: phases < N are FROZEN verbatim from the existing lock (re-derived phase-1 text discarded)',
    replanned.mustHaves.find((m) => m.id === 'M1').text === existingForReplan.mustHaves.find((m) => m.id === 'M1').text
    && replanned.mustHaves.find((m) => m.id === 'M1').text !== rederived.mustHaves.find((m) => m.id === 'M1').text);
  check('Replan VERIFY: a phase < N is marked built (status=built, non-provisional)',
    replanned.phases.find((p) => p.id === 1).status === 'built' && replanned.phases.find((p) => p.id === 1).provisional === false);
  check('Replan VERIFY: phases >= N are re-derived (M2 revised + new M3/phase 3 carried from the re-derivation)',
    replanned.mustHaves.find((m) => m.id === 'M2').text === 'Members create and assign tasks (revised)'
    && replanned.mustHaves.some((m) => m.id === 'M3' && m.phase === 3) && replanned.phases.some((p) => p.id === 3));
  check('Replan: the merged lock is schema-valid and clean (no drops here)',
    validateLock(replanned).ok && drop0.length === 0 && replanned.incomplete === false);

  // Dropped must-have: existing M2 (phase 2) absent from the re-derivation, not deferred -> loud blocking gate.
  const rederivedDrop = JSON.parse(JSON.stringify(rederived));
  rederivedDrop.mustHaves = rederivedDrop.mustHaves.filter((m) => m.id !== 'M2');
  rederivedDrop.featureOrder = rederivedDrop.featureOrder.filter((f) => f.name !== 'Tasks2');
  rederivedDrop.coverage = rederivedDrop.coverage.filter((c) => c.mustHaveId !== 'M2');
  const { lock: replannedDrop, dropped: drop1 } = mergeReplan(existingForReplan, rederivedDrop, 2);
  check('Replan VERIFY: a dropped (not deferred) must-have is a loud blocking gate, not a silent edit',
    drop1.some((d) => d.id === 'M2') && replannedDrop.incomplete === true
    && replannedDrop.openQuestions.some((q) => q.blockingCompose === true && /replan-dropped-musthave/.test(q.context)));
  check('Replan: --replan-from 1 freezes nothing — everything is re-derived',
    mergeReplan(existingForReplan, rederived, 1).lock.mustHaves.find((m) => m.id === 'M1').text === rederived.mustHaves.find((m) => m.id === 'M1').text);

  const passed = results.filter((r) => r.pass).length;
  return { results, passed, total: results.length, ok: passed === results.length };
}

// ===========================================================================
// Orchestration (agents). Guarded so the module is node-importable for selftest.
// ih5.2 runs Phases 1-2 only; ih5.3/ih5.4 append the concern fan-out + reconcile/assemble.
// ===========================================================================
async function main() {
  const A = parsedArgs;
  log(`vision starting — vision=${A.visionPath}${A.skeletonPath ? ` skeleton=${A.skeletonPath}` : ' (headless skeleton)'}${A.replanFrom ? ` [replan-from ${A.replanFrom}]` : ''}${A.dryRun ? ' [dry-run]' : ''}`);

  // ---- Replan pre-load (epic 0ms): /replan --replan-from N loads the existing lock + latest retro so the
  // re-derivation builds on what shipped. The pure-JS mergeReplan (Phase 4) enforces the phase freeze. ----
  let priorLock = null;
  let replan = null;
  if (A.replanFrom) {
    phase('Intake');
    const loadRes = await agent(`
You are the replan-load agent for /vision --replan-from ${A.replanFrom} (epic 0ms). Load what already shipped so the re-derivation builds on it.
1. Read ${A.outPath} (the existing plan.lock.json). Return its parsed JSON object under "lock". If it is missing or not valid JSON, return { "status": "failed", "failedReason": "no existing ${A.outPath} to replan from — run /vision first" }.
2. Find the most recent retro for the just-built phase (look for retros/*.md, a phase-${A.replanFrom - 1} retro, or decomposeReport.md). Summarize the findings relevant to phases >= ${A.replanFrom} into "retroSummary" (a few sentences). If none exists, set "retroSummary": "".
Return { "status": "ok", "lock": <parsed lock object>, "retroSummary": "<text>" }. Use Read, Bash, Glob.
`, { label: 'replan-load', phase: 'Intake', schema: { type: 'object', required: ['status'], properties: { status: { enum: ['ok', 'failed'] }, lock: { type: 'object' }, retroSummary: { type: 'string' }, failedReason: { type: 'string' } } } });
    if (!loadRes || loadRes.status !== 'ok' || !isObj(loadRes.lock)) {
      log(`vision: FAILED — replan could not load ${A.outPath}: ${loadRes && loadRes.failedReason ? loadRes.failedReason : 'no lock returned'}`);
      return { status: 'failed', reason: (loadRes && loadRes.failedReason) ? loadRes.failedReason : 'replan-load failed' };
    }
    priorLock = loadRes.lock;
    const frozenPhases = (isArr(priorLock.phases) ? priorLock.phases : []).filter((p) => isObj(p) && p.id < A.replanFrom);
    replan = { from: A.replanFrom, note: `Frozen (built) phases < ${A.replanFrom}: ${JSON.stringify(frozenPhases)}\nPrior must-haves: ${JSON.stringify(isArr(priorLock.mustHaves) ? priorLock.mustHaves : [])}\nRetro / build outcomes: ${nonEmptyStr(loadRes.retroSummary) ? loadRes.retroSummary : '(none found)'}` };
    log(`vision: replan-from ${A.replanFrom} — loaded prior lock (${isArr(priorLock.phases) ? priorLock.phases.length : 0} phase(s), ${isArr(priorLock.mustHaves) ? priorLock.mustHaves.length : 0} must-have(s)).`);
  }

  // ---- Phase 1: intake + validate ----
  phase('Intake');
  const intakeRaw = await agent(intakePrompt(A), { label: 'intake', phase: 'Intake', schema: INTAKE_SCHEMA });
  const intake = validateIntake(intakeRaw);
  if (intake.status === 'failed') {
    log(`vision: FAILED — ${intake.reason}`);
    return { status: 'failed', reason: intake.reason };
  }
  if (intake.status === 'needs-input') {
    log(`vision: NEEDS-INPUT — unfilled load-bearing section(s): ${intake.missing.join(', ')}. Fill vision.md and re-run.`);
    return buildNeedsInput(intake.missing);
  }
  log(`vision: intake ok — ${intake.mustHaves.length} must-have(s), headless=${intake.headless}`);

  // ---- Phase 2: skeleton + applicability ----
  phase('Skeleton');
  const skelRaw = await agent(skeletonPrompt(intake, A, replan), { label: 'skeleton', phase: 'Skeleton', schema: SKELETON_SCHEMA });
  const { skeleton, errors } = normalizeSkeleton(skelRaw && skelRaw.skeleton);
  if (errors.length) {
    log(`vision: FAILED — skeleton malformed: ${errors.slice(0, 6).join('; ')}`);
    return { status: 'failed', reason: 'skeleton malformed', errors };
  }
  const applicability = deriveApplicability(skelRaw && skelRaw.signals);
  const frozen = deepFreeze(skeleton);

  // Carry Phase-2 blocks (no-matching-formula etc) forward to Phase 4 (do not stop here — T7).
  const blocks = isArr(skelRaw && skelRaw.blocks) ? skelRaw.blocks.slice() : [];
  for (const o of detectOffEnumPicks(frozen.featureOrder)) {
    blocks.push({ token: 'no-matching-formula', note: `feature "${o.feature}" binds generic formula ${o.formula} with off-enum ${o.var}=${o.value} — pick the stack-native variant (DEFAULT_STACK §Stack-native formulas; defect autonomous-build-3fr.1).` });
  }

  const applicable = applicableConcerns(applicability);
  log(`vision: skeleton frozen — ${frozen.featureOrder.length} feature(s), ${applicable.length}/${CONCERN_IDS.length} concern(s) applicable${blocks.length ? `, ${blocks.length} carried block(s)` : ''}.`);

  // ---- Phase 3: concern fan-out (1 agent per applicable concern, parallel over the frozen skeleton) ----
  // Each agent decides ONE concern against the frozen skeleton with ONLY its own concernBar; the runtime
  // fan-out is the isolation (no agent sees another's contract or output). excluded-by-default concerns are
  // NOT spawned — Phase 4 folds them in directly. Any error/skip becomes a 'failed' (undecided) result, never
  // a silent drop (T7): a thunk that rejects is caught here; a user-skip (null) is backfilled in the map.
  phase('Concerns');
  const inputs = concernInputs(frozen, applicability, intake.sections);
  log(`vision: fanning out ${inputs.length} concern agent(s): ${inputs.map((i) => i.concernId).join(', ') || '(none)'}`);
  const concerns = (await parallel(inputs.map((C) => () =>
    agent(concernPrompt(C), { label: `concern:${C.concernId}`, phase: 'Concerns', schema: CONCERN_SCHEMA })
      .then((raw) => normalizeConcernResult(raw, C.concernId, C.applicability))
      .catch((e) => ({
        concernId: C.concernId, applicability: C.applicability, status: 'failed',
        blockingQuestion: concernBlock(C.concernId, `concern ${C.concernId} agent errored: ${(e && e.message) ? e.message : String(e)}`)
      }))
  ))).map((r, i) => r || ({
    concernId: inputs[i].concernId, applicability: inputs[i].applicability, status: 'failed',
    blockingQuestion: concernBlock(inputs[i].concernId, `concern ${inputs[i].concernId} agent returned no result (skipped)`)
  }));

  const undecided = concerns.filter((r) => !isDecided(r));
  log(`vision: concerns decided — ${concerns.length - undecided.length}/${concerns.length} decided${undecided.length ? `, ${undecided.length} undecided (concern-decidedness): ${undecided.map((r) => r.concernId).join(', ')}` : ''}.`);

  // ---- Phase 4: reconcile + four gates + decidedness verdict + assemble (pure JS; agent only writes) ----
  phase('Assemble');
  const asm = reconcileAndAssemble({ frozen, applicability, concerns, blocks, sections: intake.sections });

  // A schema-invalid assembled lock is a workflow bug (the workflow built it, not an agent) — fail LOUD,
  // write nothing (T7). There is no agent to retry an object we assembled, so we surface the errors instead.
  if (!asm.ok) {
    log(`vision: FAILED — assembled lock is schema-invalid (workflow bug): ${asm.validationErrors.slice(0, 6).join('; ')}`);
    return { status: 'failed', incomplete: asm.incomplete, lock: asm.lock, validationErrors: asm.validationErrors, openQuestions: asm.openQuestions, dryRun: A.dryRun };
  }

  // Replan merge (epic 0ms): freeze phases < N from the prior lock, keep re-derived phases >= N. The
  // freeze is enforced here in pure JS, so it holds regardless of what the skeleton agent re-proposed.
  let final = asm;
  if (A.replanFrom && priorLock) {
    const { lock: mergedLock, dropped } = mergeReplan(priorLock, asm.lock, A.replanFrom);
    const v = validateLock(mergedLock);
    if (!v.ok) {
      log(`vision: FAILED — merged replan lock is schema-invalid (workflow bug): ${v.errors.slice(0, 6).join('; ')}`);
      return { status: 'failed', incomplete: mergedLock.incomplete, lock: mergedLock, validationErrors: v.errors, openQuestions: mergedLock.openQuestions, dryRun: A.dryRun };
    }
    final = { ok: true, validationErrors: [], incomplete: mergedLock.incomplete, lock: mergedLock, openQuestions: mergedLock.openQuestions, tenetsMd: asm.tenetsMd, planMd: renderPlanMd(mergedLock) };
    log(`vision: replan merged — froze phases < ${A.replanFrom}, re-derived >= ${A.replanFrom}${dropped.length ? `; ${dropped.length} dropped must-have(s) gated for human decision: ${dropped.map((d) => d.id).join(', ')}` : ''}.`);
  }

  const verdict = final.incomplete ? 'needs-input' : 'ok';
  const tokens = final.openQuestions.map((q) => String(q.context || '').split(':')[0]).filter(Boolean);
  const planMdPath = siblingPath(A.outPath, 'plan.md');
  const tenetsPath = siblingPath(A.outPath, 'tenets.md');
  const reportPaths = { planLock: A.outPath, planMd: planMdPath, tenets: tenetsPath };

  // Dry-run: return the would-be lock + verdict without writing (the --no-file inspection path).
  if (A.dryRun) {
    log(`vision: ${final.incomplete ? 'NEEDS-INPUT' : 'COMPLETE'} (dry-run, nothing written) — ${final.lock.concerns.length} concern(s) decided, ${final.lock.coverage.length}/${final.lock.mustHaves.length} must-have(s) covered${final.incomplete ? `, ${final.openQuestions.length} blocking question(s): ${tokens.join(', ')}` : ''}.`);
    return { status: verdict, incomplete: final.incomplete, lock: final.lock, openQuestions: final.openQuestions, reportPaths, dryRun: true };
  }

  // Write the three files via the lone Phase-4 agent (the sandbox has no filesystem). The lock is incomplete:true
  // when blocked, so /decompose pre-flight refuses it cleanly — the same gate the must-have path uses.
  const writeRes = await agent(
    assemblePrompt({ outPath: A.outPath, planMdPath, tenetsPath, lockJson: JSON.stringify(final.lock, null, 2), planMd: final.planMd, tenetsMd: final.tenetsMd }),
    { label: 'assemble', phase: 'Assemble', schema: ASSEMBLE_SCHEMA }
  );
  const written = (writeRes && isArr(writeRes.written)) ? writeRes.written : [];
  if (!writeRes || writeRes.status !== 'ok') {
    log(`vision: assemble agent did not confirm all writes — ${writeRes && writeRes.failedReason ? writeRes.failedReason : 'no ok status'} (wrote: ${written.join(', ') || 'none'}).`);
  }
  log(`vision: ${final.incomplete ? 'NEEDS-INPUT' : 'COMPLETE'} — wrote ${written.length} file(s)${final.incomplete ? `; incomplete:true, ${final.openQuestions.length} blocking question(s): ${tokens.join(', ')}` : `; ${final.lock.concerns.length} concerns decided, ${final.lock.coverage.length}/${final.lock.mustHaves.length} must-have(s) covered`}.`);

  return { status: verdict, incomplete: final.incomplete, lock: final.lock, openQuestions: final.openQuestions, reportPaths, written, dryRun: false };
}

// Entry point — guarded so `node`/`import` (for the selftest harness) never triggers agent calls.
if (typeof agent === 'function') {
  if (parsedArgs.selftest) {
    const r = runSelftest();
    log(`vision --selftest: ${r.passed}/${r.total} checks passed${r.ok ? '' : ' — FAILURES:'}`);
    for (const c of r.results) if (!c.pass) log(`  FAIL: ${c.name}`);
  } else {
    await main();
  }
} else {
  // node-only bridge: the runtime forbids `export` other than `meta`, so the pure checkers can't be
  // ESM-exported. Under node (`agent` undefined) we expose them on globalThis for tests/vision/selftest.mjs.
  globalThis.__vision = {
    extractJson, deepFreeze, hasContent, stripBullet, mkBlocking,
    validateIntake, buildNeedsInput, deriveApplicability, applicableConcerns,
    normalizeSkeleton, detectOffEnumPicks, runSelftest,
    concernBlock, isDecided, concernInputs, normalizeConcernResult,
    standardExclusion, reconcileConcerns, buildCoverage, reverseTraceOrphans,
    phaseOf, featurePhase, deriveFeatureTier, FEATURE_TIERS, derivePhases, mergeReplan,
    musthaveNongoalConflicts, parseEscalationBudget, mapStack, runGatesV4,
    assembleLock, validateLock, renderTenets, renderPlanMd, reconcileAndAssemble, siblingPath,
    intakePrompt, skeletonPrompt, concernPrompt, assemblePrompt, parseArgs,
    CONCERN_IDS, CONCERN_BARS, EVIDENCE_BAR, GATE_TOKENS, DEFAULT_STACK, SIGNAL_NAMES, LOAD_BEARING,
    STANDARD_EXCLUSIONS, DECIDE_ONLY_CONCERNS, STACK_ENUM, STACK_KEY_MAP, TENETS_INHERITED_MD,
    INTAKE_SCHEMA, SKELETON_SCHEMA, CONCERN_SCHEMA, ASSEMBLE_SCHEMA
  };
}
